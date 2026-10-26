import { screenState } from '@shared/input'
import { texToText } from '@shared/tex'
import {
  activateSelection,
  activeAgentKey,
  carryPane,
  closeTab,
  enterInsert,
  focusPane,
  focusSidebar,
  focusedKey,
  interruptAgent,
  killRequest,
  launchDraft,
  leaveInsert,
  leaveScroll,
  moveInGrid,
  movePaneInGrid,
  moveSelection,
  newWindow,
  nudgeSelection,
  renameSelection,
  restoreHidden,
  resumeAgent,
  selectedNode,
  sendEsc,
  stepWindow,
  swapTabs,
  targetFolder
} from './actions'
import { cmdKey, isMac, printableMods } from './platform'
import { get, removeFolder, removeProject, set, toast, toggleCollapsed, toggleFolder, updateSettings } from './store'
import { copyTerminalSelection, pageAgent, reattach, screenLines, termFont, terminalEntry, writeToAgent } from './terminals'

const DOUBLE_ESC_MS = 500
let lastEsc = 0

export function isPrintable(ev: KeyboardEvent): boolean {
  return ev.key.length === 1 && printableMods(ev)
}

function stop(ev: KeyboardEvent): void {
  ev.preventDefault()
  ev.stopPropagation()
}

/**
 * A single Esc for the agent, as in a terminal: it closes Claude Code's menus
 * and panels (/config, /usage, the slash list) and answers "no" to a prompt.
 * Not while it is working, where Esc would interrupt the turn (⌘. does that on
 * purpose), unless a panel or question on its screen takes the Esc (/config
 * opened mid-turn); in tmux scroll mode it leaves scroll mode.
 */
function escToAgent(key: string | undefined): void {
  const agent = key ? get().agents[key] : undefined
  if (!key || !agent) return
  if (leaveScroll(key)) return
  const busy = agent.status === 'working' || agent.status === 'background' || agent.status === 'starting'
  if (busy && !panelOnScreen(key)) return
  sendEsc(key)
}

/** A question, permission prompt or panel (/config, /usage…) on the agent's screen: Esc, Enter and the arrows are its. */
export function panelOnScreen(key: string): boolean {
  const state = screenState(screenLines(key))
  return state === 'question' || state === 'menu'
}

/** Returns true on the second Esc of a double press; the first shows a hint. */
function escPressed(): boolean {
  const now = Date.now()
  if (now - lastEsc < DOUBLE_ESC_MS) {
    lastEsc = 0
    set({ escHint: false })
    return true
  }
  lastEsc = now
  set({ escHint: true })
  setTimeout(() => {
    if (Date.now() - lastEsc >= DOUBLE_ESC_MS) set({ escHint: false })
  }, DOUBLE_ESC_MS + 20)
  return false
}

/**
 * ⌘← ⌘→ (⌥⌘ too), which go between windows in navigate. Elsewhere they are
 * Ctrl+Shift+← → and Ctrl+Alt+← →, since Ctrl+Shift+Alt (⇧⌘) moves the tab.
 */
function isWindowKey(ev: KeyboardEvent): boolean {
  if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return false
  if (isMac) return ev.metaKey && !ev.ctrlKey && !ev.shiftKey
  return ev.ctrlKey && !ev.metaKey && ev.shiftKey !== ev.altKey
}

/** ⌘← ⌘→: the previous / next window; ⌥⌘← ⌥⌘→ on a pane carry it there. */
function windowKey(ev: KeyboardEvent, onPane: boolean): void {
  stop(ev)
  const dir = ev.key === 'ArrowLeft' ? -1 : 1
  if (!(isMac ? ev.altKey : !ev.shiftKey)) stepWindow(dir)
  else if (onPane) void carryPane(dir)
}

function globalShortcut(ev: KeyboardEvent): boolean {
  const s = get()
  const cmd = cmdKey(ev)

  if (ev.ctrlKey && !ev.metaKey && !cmd && ev.key.toLowerCase() === 'x') {
    killRequest()
    return true
  }
  if (!cmd) return false
  const k = cmd.key.toLowerCase()
  const shift = cmd.shift

  if (k === 'c' && !shift && s.zone !== 'prompt') {
    // the text selected in an agent (Option+drag), whatever has the focus; else the usual copy
    if (copyTerminalSelection(s.zone === 'pane' ? focusedKey() : undefined)) return true
    if (isMac) return false
    // Ctrl+Shift+C is no copy shortcut of the page's (and the terminal would take it as Ctrl+C)
    document.execCommand('copy')
    return true
  }
  if (k === 'w' && shift) {
    // the window; its agents keep running
    window.kuna.windows.close()
    return true
  }
  if (k === 'w' && !shift) {
    const key = s.zone === 'pane' ? focusedKey() : activeAgentKey()
    if (key && s.tabs.includes(key)) closeTab(key)
    return true
  }
  if (k === '.') {
    interruptAgent()
    return true
  }
  if (k === 'r') {
    // ⌘R renames; ⇧⌘R resumes an exited agent (respawns a background session)
    if (shift) void resumeAgent()
    else renameSelection()
    return true
  }
  if (k === 's') {
    // left: sidebar + launch box
    const hidden = !(s.sidebarHidden && !s.sidebarPeek)
    set({ sidebarHidden: hidden, sidebarPeek: false })
    if (hidden && s.zone !== 'pane' && s.tabs.length) focusPane(s.paneIndex)
    return true
  }
  if (k === 'z' && !shift && s.mode === 'nav' && s.zone !== 'prompt') {
    // bring back the session Ctrl+X Ctrl+X took off the list last
    restoreHidden()
    return true
  }
  if (k === 'e') {
    renameSelection()
    return true
  }
  // typing to an agent, a Mac's ⌘V pastes into its terminal by itself; Ctrl+Shift+V doesn't
  if (k === 'v' && !shift && s.zone !== 'prompt' && (s.mode !== 'insert' || !isMac)) {
    pasteShortcut()
    return true
  }
  if (k === 'b' || k === 'i') {
    // right: inspector (a panel that only slid in goes away again)
    updateSettings({ inspector: !(s.settings.inspector || s.inspectorPeek) })
    set({ inspectorPeek: false })
    return true
  }
  if (k === 'k') {
    const node = selectedNode()
    const key = activeAgentKey()
    const host = key ? s.agents[key]?.host : node?.project.host
    set({ overlay: { kind: 'claude', host }, mode: 'nav' })
    return true
  }
  if (k === 'n' && !shift) {
    set({ overlay: { kind: 'project' }, mode: 'nav' })
    return true
  }
  if (k === 'n' && shift) {
    newWindow()
    return true
  }
  if (k === 'o') {
    const node = selectedNode()
    const project = node?.project ?? s.projects[0]
    const suggest = node?.kind === 'agent' && node.folder.id === '__other' ? node.agent.cwd : undefined
    if (!project) set({ overlay: { kind: 'project' } })
    else set({ overlay: { kind: 'folder', projectId: project.id, path: suggest }, mode: 'nav' })
    return true
  }
  if (k === ',') {
    set({ overlay: { kind: 'settings' }, mode: 'nav' })
    return true
  }
  if (k === '/' || k === '?') {
    set({ overlay: { kind: 'help' }, mode: 'nav' })
    return true
  }
  if (/^[1-9]$/.test(k)) {
    const i = Number(k) - 1
    if (i < s.tabs.length) {
      if (s.mode === 'insert') leaveInsert(false)
      focusPane(i)
    }
    return true
  }
  if ((k === '=' || k === '+' || k === '-') && !shift) {
    const size = Math.max(8, Math.min(24, termFont().size + (k === '-' ? -1 : 1)))
    updateSettings({ termFontSize: size })
    return true
  }
  if (shift && (cmd.key === 'ArrowLeft' || cmd.key === 'ArrowRight') && s.zone === 'pane') {
    swapTabs(s.paneIndex, s.paneIndex + (cmd.key === 'ArrowLeft' ? -1 : 1))
    return true
  }
  return false
}

/**
 * Sidebar and launch box share one keyboard: arrows only navigate, typing and
 * Backspace edit the launch box (whatever row is selected), and Enter starts
 * an agent with what was typed, or with nothing typed rolls the selected
 * project/folder out or in (an agent row opens).
 */
/**
 * ⌘V where no text field has the caret: in the sidebar the text goes into the
 * launch box (to start an agent with it); on a pane it goes to the agent.
 */
function pasteShortcut(): void {
  const s = get()
  void window.kuna.clipboardText().then((text) => {
    if (!text) return
    if (s.zone === 'pane') {
      const key = focusedKey()
      const e = key ? terminalEntry(key) : undefined
      if (!e?.ptyId) return
      if (get().mode !== 'insert') enterInsert()
      e.term.paste(text)
      return
    }
    if (!targetFolder(selectedNode())) {
      toast('Select a folder to start an agent in, then paste.', 'warn')
      return
    }
    set({ zone: 'prompt', mode: 'insert', prompt: get().prompt + text })
  })
}

function sidebarKey(ev: KeyboardEvent): void {
  const s = get()
  const node = selectedNode()
  const draft = s.prompt
  if (isWindowKey(ev)) return windowKey(ev, false)
  switch (ev.key) {
    case 'ArrowUp':
    case 'ArrowDown':
      // ⌥ (as on panes) or ⇧ carries the selected row up or down
      if (ev.altKey || ev.shiftKey) nudgeSelection(ev.key === 'ArrowUp' ? -1 : 1)
      else moveSelection(ev.key === 'ArrowUp' ? -1 : 1)
      return stop(ev)
    // arrows never roll rows out or in (Enter, Space or a click does)
    case 'ArrowRight':
      if (s.tabs.length) focusPane(s.paneIndex)
      return stop(ev)
    case 'ArrowLeft':
      // up to the parent row
      if (node?.kind === 'folder') set({ sel: `p:${node.project.id}` })
      else if (node?.kind === 'agent') set({ sel: `f:${node.project.id}:${node.folder.id}` })
      return stop(ev)
    case 'Enter':
      if (draft.trim()) {
        if (ev.shiftKey) set({ zone: 'prompt', mode: 'insert', prompt: draft + '\n' })
        else launchDraft()
      } else activateSelection()
      return stop(ev)
    case 'Escape':
      if (draft && escPressed()) set({ prompt: '' })
      // a sidebar that only slid in goes away again
      else if (!draft && s.sidebarPeek && s.tabs.length) focusPane(s.paneIndex)
      return stop(ev)
    case ' ':
      if (draft) break // part of the text
      if (node?.kind === 'agent') set({ overlay: { kind: 'media', key: node.agent.key } })
      else if (node?.kind === 'project') toggleCollapsed(node.project.id)
      else if (node?.kind === 'folder') toggleFolder(node.project.id, node.folder.id)
      return stop(ev)
    case 'Backspace':
    case 'Delete':
      if (cmdKey(ev) && !draft && node?.kind === 'folder' && !node.virtual) {
        set({
          overlay: {
            kind: 'confirm',
            title: `Remove ${texToText(node.folder.name)}?`,
            body: 'The folder is removed from the sidebar. Agents running there keep running and show up under "Other agents".',
            action: () => removeFolder(node.project.id, node.folder.id)
          }
        })
      } else if (cmdKey(ev) && !draft && node?.kind === 'project') {
        set({
          overlay: {
            kind: 'confirm',
            title: `Remove project ${texToText(node.project.name)}?`,
            body: 'Its folders are removed from Kuna. Nothing on the host is deleted and running agents keep running.',
            action: () => removeProject(node.project.id)
          }
        })
      } else if (draft) {
        // edit the launch box from here, like typing does
        const cut = cmdKey(ev) ? draft.slice(0, draft.lastIndexOf('\n') + 1) : ev.altKey ? draft.replace(/\S*\s*$/, '') : draft.slice(0, -1)
        set({ prompt: cut, zone: 'prompt', mode: 'insert' })
      }
      return stop(ev)
  }
  if (isPrintable(ev)) {
    if (!targetFolder(node)) {
      toast(node ? 'Select a folder to start an agent in, or add one with ⌘O.' : 'Create a project first (⌘N).', 'warn')
      return stop(ev)
    }
    set({ zone: 'prompt', mode: 'insert', prompt: draft + ev.key })
    return stop(ev)
  }
}

function paneKey(ev: KeyboardEvent): void {
  const s = get()
  const key = focusedKey()
  if (s.inspectorPeek && ev.key !== 'ArrowRight' && !['Shift', 'Meta', 'Alt', 'Control'].includes(ev.key)) {
    // the right panel that slid in goes away; ← and Esc do only that
    set({ inspectorPeek: false })
    if (ev.key === 'ArrowLeft' || ev.key === 'Escape') return stop(ev)
  }
  if (isWindowKey(ev)) return windowKey(ev, true)
  if (ev.altKey && !ev.metaKey && !ev.ctrlKey && ev.key.startsWith('Arrow')) {
    // ⌥ arrows carry the pane that way, swapping it with the one there
    stop(ev)
    return movePaneInGrid(ev.key === 'ArrowLeft' ? 'left' : ev.key === 'ArrowRight' ? 'right' : ev.key === 'ArrowUp' ? 'up' : 'down')
  }
  switch (ev.key) {
    case 'ArrowLeft':
      stop(ev)
      return moveInGrid('left')
    case 'ArrowRight':
      stop(ev)
      return moveInGrid('right')
    case 'ArrowUp':
      stop(ev)
      return moveInGrid('up')
    case 'ArrowDown':
      stop(ev)
      return moveInGrid('down')
    case 'Enter':
      stop(ev)
      if (key && !terminalEntry(key)?.ptyId) reattach(key)
      else enterInsert()
      return
    case ' ':
      stop(ev)
      if (key) set({ overlay: { kind: 'media', key } })
      return
    case 'PageUp':
    case 'PageDown':
      stop(ev)
      return pageKey(key, ev)
    case 'Tab':
      // Shift+Tab cycles Claude Code's permission mode without entering typing mode
      stop(ev)
      if (key && ev.shiftKey) writeToAgent(key, '\x1b[Z')
      return
    case 'Escape':
      stop(ev)
      return escToAgent(key)
  }
  if (isPrintable(ev)) {
    stop(ev)
    const agent = key ? s.agents[key] : undefined
    // answer a permission prompt with a single digit, staying in navigation
    if (agent?.status === 'waiting' && /^[1-9]$/.test(ev.key)) {
      writeToAgent(key!, ev.key)
      return
    }
    enterInsert(ev.key)
  }
}

function insertKey(ev: KeyboardEvent): void {
  const key = focusedKey()
  if (ev.key === 'Escape') {
    stop(ev)
    // a panel or question on screen takes every Esc (/config: one clears its search, the next closes it)
    if (key && panelOnScreen(key)) return sendEsc(key)
    // the first goes to the agent; a second one right after leaves typing mode
    if (escPressed()) leaveInsert(true)
    else escToAgent(key)
    return
  }
  if ((ev.key === 'PageUp' || ev.key === 'PageDown') && !ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey) {
    stop(ev)
    return pageKey(key, ev)
  }
  if (key) typeToAgent(key, ev, insertEnter)
  // everything else goes to the terminal
}

/**
 * The keys typed into an agent's terminal that Kuna handles itself, on a pane
 * and in the plot viewer: ⌘← ⌘→, keys that have to take tmux out of scroll
 * mode first, and Enter (`enter`). True when it took the key; everything
 * else goes to the terminal.
 */
export function typeToAgent(key: string, ev: KeyboardEvent, enter: (key: string, shift: boolean) => void): boolean {
  if (ev.metaKey && !ev.shiftKey && !ev.ctrlKey && !ev.altKey && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
    // ⌘← ⌘→: start / end of the line, as Ctrl+A / Ctrl+E (iTerm's natural text editing)
    stop(ev)
    writeToAgent(key, ev.key === 'ArrowLeft' ? '\x01' : '\x05')
    return true
  }
  // after the wheel or PageUp, tmux's scroll mode would take these: leave it, then send them
  const plain = !ev.metaKey && !ev.ctrlKey && !ev.altKey
  const leaving = plain && (ev.key === 'Enter' || ev.key === 'Backspace' || isPrintable(ev)) ? leaveScroll(key) : null
  if (leaving) {
    stop(ev)
    const e = terminalEntry(key)
    const k = ev.key
    const shift = ev.shiftKey
    void leaving.then(() => {
      if (k === 'Enter') return enter(key, shift)
      writeToAgent(key, k === 'Backspace' ? '\x7f' : k)
      if (e) e.typed = k === 'Backspace' ? Math.max(0, e.typed - 1) : e.typed + 1
    })
    return true
  }
  if (ev.key === 'Enter' && plain) {
    stop(ev)
    enter(key, ev.shiftKey)
    return true
  }
  return false
}

function insertEnter(key: string, shift: boolean): void {
  if (shift) {
    writeToAgent(key, '\x1b\r') // newline in Claude Code's input
    return
  }
  const answering = panelOnScreen(key)
  writeToAgent(key, '\r')
  if (answering) stayWhileAsked(key)
  else leaveInsert(false)
}

/** PageUp / PageDown: a page of the agent's history, as the mouse wheel scrolls it. */
function pageKey(key: string | undefined, ev: KeyboardEvent): void {
  if (!key) return
  pageAgent(key, ev.key === 'PageUp' ? -1 : 1, Boolean(get().agents[key]?.inCopyMode || terminalEntry(key)?.paged))
}

/**
 * Enter answered a question or picked in a panel (/config): Claude Code may
 * ask the next one right away (several in a row, then "Submit answers"), and a
 * panel stays open, so typing mode stays while one is on screen and ends once
 * none is, unless the user has started typing again.
 */
function stayWhileAsked(key: string): void {
  const e = terminalEntry(key)
  if (e) e.typed = 0
  const started = Date.now()
  const check = (): void => {
    const s = get()
    if (s.mode !== 'insert' || focusedKey() !== key) return
    if (!panelOnScreen(key)) {
      if (!terminalEntry(key)?.typed) leaveInsert(false)
      return
    }
    // still a question: the next one, or the screen hasn't caught up yet (slow host)
    if (Date.now() - started < 3000) setTimeout(check, 300)
  }
  setTimeout(check, 300)
}

/**
 * The launch box has the caret: it edits the text natively and Enter launches.
 * With text in it ← → move through the text and ↑ ↓ between its lines; ↑ ↓
 * past the first or last line (or with nothing typed, any arrow) pick the folder.
 */
function promptKey(ev: KeyboardEvent): void {
  const s = get()
  if (ev.key === 'Escape') {
    stop(ev)
    if (!s.prompt || escPressed()) set({ prompt: '', zone: 'sidebar', mode: 'nav' })
    return
  }
  if (ev.key === 'Enter' && !ev.shiftKey) {
    stop(ev)
    if (s.prompt.trim()) launchDraft()
    return
  }
  // with text in the box ⌘← ⌘→ move the caret; with none they go to another window
  if (!s.prompt && isWindowKey(ev)) return windowKey(ev, false)
  if (ev.key.startsWith('Arrow') && !ev.metaKey && !ev.altKey && !ev.shiftKey) {
    const box = document.activeElement instanceof HTMLTextAreaElement ? document.activeElement : null
    if (box && s.prompt) {
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') return // the caret moves
      const firstLine = box.value.lastIndexOf('\n', box.selectionStart - 1) === -1
      const lastLine = box.value.indexOf('\n', box.selectionEnd) === -1
      if (ev.key === 'ArrowUp' ? !firstLine : !lastLine) return
    }
    // picking the folder: the text stays and goes wherever Enter is pressed
    focusSidebar()
    sidebarKey(ev)
  }
}

export function installKeys(): () => void {
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.isComposing) return
    const s = get()
    if (s.overlay) return // overlays own the keyboard while open
    if (globalShortcut(ev)) return stop(ev)
    if (s.zone === 'prompt') return promptKey(ev)
    if (s.mode === 'insert' && s.zone === 'pane') return insertKey(ev)
    if (s.zone === 'sidebar') return sidebarKey(ev)
    if (s.zone === 'pane') return paneKey(ev)
  }
  window.addEventListener('keydown', onKey, true)
  return () => window.removeEventListener('keydown', onKey, true)
}


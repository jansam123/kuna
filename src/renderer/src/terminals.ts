import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import { get, toast } from './store'
import { TERMINAL_FACE } from './fonts'
import { themeById } from './themes'

/**
 * Live terminals, one per open tab, kept outside React so they survive
 * re-layout: the pane component only re-parents `el` into its slot.
 */
export interface TermEntry {
  key: string
  term: Terminal
  fit: FitAddon
  el: HTMLDivElement
  ptyId?: string
  /** characters typed during the current typing session (for Esc Esc) */
  typed: number
  attaching: boolean
  retries: number
  disposed: boolean
  gotData?: boolean
  /** ms timestamp of the last output, to tell when the screen has settled */
  lastData?: number
  /** ms timestamps of the user's last input to and mouse release in this terminal (clipboard writes) */
  lastInput?: number
  lastMouseUp?: number
  /** PageUp took it into tmux's scroll mode: what is typed next leaves that first */
  paged?: boolean
  /** when Kuna last left tmux's scroll mode: the host's report of it lags behind */
  leftScroll?: number
  slowTimer?: ReturnType<typeof setTimeout>
}

const entries = new Map<string, TermEntry>()
const byPty = new Map<string, TermEntry>()

/** OSC 52 payloads past this size are dropped */
const MAX_CLIPBOARD = 512 * 1024

/**
 * A program in a pane may set the clipboard (OSC 52) only right after the user
 * did something there: a mouse selection that tmux copies (released ≤1.5 s
 * ago) or a command they typed, like Claude Code's /copy (≤10 s ago).
 * Otherwise any output (a file being printed, a build script) could swap what
 * the next ⌘V pastes.
 */
function clipboardWrite(e: TermEntry, data: string): void {
  const b64 = data.slice(data.indexOf(';') + 1)
  if (!b64 || b64 === '?') return // a query: never answered
  const now = Date.now()
  if (now - (e.lastMouseUp ?? 0) > 1500 && now - (e.lastInput ?? 0) > 10_000) {
    toast('Output in an agent pane tried to set your clipboard; Kuna ignored it.', 'warn')
    return
  }
  if (b64.length > (MAX_CLIPBOARD * 4) / 3) return
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    window.kuna.copyText(new TextDecoder().decode(bytes))
  } catch {
    /* malformed payload */
  }
}
/** the terminal where text was last selected, for ⌘C */
let lastSelected: string | undefined

/** Put the terminal's selection on the clipboard; false when nothing is selected. */
function copyFrom(e: TermEntry | undefined): boolean {
  const text = e?.term.hasSelection() ? e.term.getSelection() : ''
  if (!text) return false
  window.kuna.copyText(text)
  return true
}

/** ⌘C: the text selected in an agent terminal (the given one's, else the last selected). */
export function copyTerminalSelection(key?: string): boolean {
  return copyFrom(key ? entries.get(key) : undefined) || copyFrom(lastSelected ? entries.get(lastSelected) : undefined)
}
let wired = false

function wire(): void {
  if (wired) return
  wired = true
  window.kuna.pty.onData((id, data) => {
    const e = byPty.get(id)
    if (!e) return
    e.gotData = true
    e.lastData = Date.now()
    e.term.write(data)
  })
  window.kuna.pty.onExit((id) => {
    const e = byPty.get(id)
    byPty.delete(id)
    if (!e || e.disposed) return
    e.ptyId = undefined
    const agent = get().agents[e.key]
    if (agent?.alive && e.retries < 3) {
      e.retries++
      e.term.write('\r\n\x1b[2m[kuna] connection dropped, reattaching…\x1b[0m\r\n')
      setTimeout(() => void attach(e), 1500 * e.retries)
    } else {
      e.term.write('\r\n\x1b[2m[kuna] detached. Press Enter on this tab to reattach.\x1b[0m\r\n')
    }
  })
}

const SLOW_CONNECT_MS = 12_000

async function attach(e: TermEntry): Promise<void> {
  if (e.disposed || e.ptyId || e.attaching) return
  e.attaching = true
  const agent = get().agents[e.key]
  const where = agent && agent.host !== 'local' ? ` to ${agent.host}` : ''
  e.term.write(`\x1b[2m[kuna] connecting${where}…\x1b[0m\r\n`)
  e.gotData = false
  clearTimeout(e.slowTimer)
  e.slowTimer = setTimeout(() => {
    if (!e.disposed && !e.gotData)
      e.term.write(
        `\x1b[2m[kuna] still connecting${where} — the host (or its login node) is slow to accept a new ssh connection. It keeps trying; ⌘W gives up.\x1b[0m\r\n`
      )
  }, SLOW_CONNECT_MS)
  try {
    const id = await window.kuna.pty.attach(e.key, e.term.cols, e.term.rows)
    if (e.disposed) {
      window.kuna.pty.close(id)
      return
    }
    e.ptyId = id
    byPty.set(id, e)
  } finally {
    e.attaching = false
  }
}

/** The text of a terminal's bottom screen, top to bottom. */
export function screenLines(key: string): string[] {
  const e = entries.get(key)
  if (!e) return []
  const b = e.term.buffer.active
  const out: string[] = []
  for (let i = 0; i < e.term.rows; i++) out.push(b.getLine(b.baseY + i)?.translateToString(true) ?? '')
  return out
}

export function reattach(key: string): void {
  const e = entries.get(key)
  if (!e || e.ptyId) return
  e.retries = 0
  e.term.reset()
  void attach(e)
}

/**
 * The agent terminals' font: the one Claude Code runs in for the user (iTerm2's
 * default profile, else VS Code's terminal), at the size chosen with ⌘+ / ⌘−.
 */
export function termFont(): { family: string; size: number; lineHeight: number; letterSpacing: number } {
  const { fonts, settings } = get()
  const t = fonts?.terminal
  return {
    family: t ? (t.faces ? `"${TERMINAL_FACE}", ${t.family}` : t.family) : 'Menlo, Consolas, monospace',
    size: settings.termFontSize ?? t?.size ?? 12,
    lineHeight: t?.lineHeight ?? 1,
    letterSpacing: t?.letterSpacing ?? 0
  }
}

export function getTerminal(key: string): TermEntry {
  wire()
  let e = entries.get(key)
  if (e) return e
  const { settings } = get()
  const el = document.createElement('div')
  el.className = 'term-host'
  const font = termFont()
  const term = new Terminal({
    fontFamily: font.family,
    fontSize: font.size,
    lineHeight: font.lineHeight,
    letterSpacing: font.letterSpacing,
    fontWeight: 'normal',
    fontWeightBold: 'bold',
    cursorBlink: false,
    cursorStyle: 'bar',
    cursorInactiveStyle: 'none',
    allowProposedApi: true,
    scrollback: 5000,
    macOptionIsMeta: true,
    // tmux owns the mouse (wheel scrolls its history); Option+drag selects in xterm
    macOptionClickForcesSelection: true,
    theme: themeById(settings.theme).terminal,
    // keys only reach xterm in typing mode; app shortcuts are handled first
    disableStdin: false
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(el)
  try {
    const gl = new WebglAddon()
    gl.onContextLoss(() => gl.dispose())
    term.loadAddon(gl)
  } catch {
    /* falls back to the DOM renderer */
  }
  e = { key, term, fit, el, typed: 0, attaching: false, retries: 0, disposed: false }
  const entry = e
  // OSC 52: tmux copy-mode selections (mouse drag) and /copy reach the macOS clipboard
  term.parser.registerOscHandler(52, (data) => {
    clipboardWrite(entry, data)
    return true
  })
  // copy on select, as in iTerm: letting go of an Option+drag (a plain drag is
  // tmux's, copied through OSC 52 above) puts the selection on the clipboard
  term.onSelectionChange(() => {
    if (term.hasSelection()) lastSelected = key
  })
  el.addEventListener(
    'mousedown',
    () => {
      const up = (): void => {
        window.removeEventListener('mouseup', up, true)
        entry.lastMouseUp = Date.now()
        setTimeout(() => copyFrom(entry), 0)
      }
      window.addEventListener('mouseup', up, true)
    },
    true
  )
  term.onData((data) => {
    if (!entry.ptyId) return
    window.kuna.pty.write(entry.ptyId, data)
    // count typed characters only: not terminal reports (focus, cursor position) or arrow keys, but pastes
    const text = data.startsWith('\x1b[200~') ? data.slice(6).replace(/\x1b\[201~$/, '') : data.startsWith('\x1b') ? '' : data
    // the user's own keys, not replies a program can provoke (cursor position, focus)
    if (text) entry.lastInput = Date.now()
    for (const ch of text) {
      if (ch === '\x7f') entry.typed = Math.max(0, entry.typed - 1)
      else if (ch >= ' ') entry.typed++
    }
  })
  term.onResize(({ cols, rows }) => {
    if (entry.ptyId) window.kuna.pty.resize(entry.ptyId, cols, rows)
  })
  entries.set(key, e)
  // attach once the element has a real size (see fitTerminal)
  return e
}

export function fitTerminal(key: string): void {
  const e = entries.get(key)
  if (!e || !e.el.isConnected || e.el.clientWidth < 20 || e.el.clientHeight < 20) return
  try {
    e.fit.fit()
  } catch {
    return
  }
  if (!e.ptyId && !e.attaching && e.retries === 0) void attach(e)
}

export function writeToAgent(key: string, data: string): boolean {
  const e = entries.get(key)
  if (!e?.ptyId) return false
  e.lastInput = Date.now()
  window.kuna.pty.write(e.ptyId, data)
  return true
}

/** tmux scrolls this many lines per wheel notch (copy mode's WheelUpPane) */
const WHEEL_LINES = 5

/**
 * PageUp / PageDown on a pane: a page of the agent's history, the way the
 * mouse wheel scrolls it. With tmux in between (it has the mouse): wheel
 * notches, which tmux scrolls five lines each, the first only entering its
 * scroll mode (`scrolling`: already in it); scrolling back to the bottom
 * leaves it. Without (a background session): the terminal's own history.
 */
export function pageAgent(key: string, dir: -1 | 1, scrolling: boolean): void {
  const e = entries.get(key)
  if (!e) return
  const { term } = e
  if (term.modes.mouseTrackingMode === 'none') {
    if (term.buffer.active.type === 'normal') term.scrollPages(dir)
    else writeToAgent(key, dir < 0 ? '\x1b[5~' : '\x1b[6~')
    return
  }
  const screen = term.element?.querySelector('.xterm-screen')
  if (!term.element || !screen) return
  const r = screen.getBoundingClientRect()
  const notches = Math.max(1, Math.ceil((term.rows - 1) / WHEEL_LINES)) + (dir < 0 && !scrolling ? 1 : 0)
  const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }
  for (let i = 0; i < notches; i++) {
    term.element.dispatchEvent(new WheelEvent('wheel', { deltaY: dir, deltaMode: WheelEvent.DOM_DELTA_LINE, ...at, bubbles: true, cancelable: true }))
  }
  if (dir < 0) e.paged = true
}

export function disposeTerminal(key: string): void {
  const e = entries.get(key)
  if (!e) return
  e.disposed = true
  clearTimeout(e.slowTimer)
  if (e.ptyId) {
    window.kuna.pty.close(e.ptyId)
    byPty.delete(e.ptyId)
  }
  e.term.dispose()
  e.el.remove()
  entries.delete(key)
  if (lastSelected === key) lastSelected = undefined
}

export function terminalEntry(key: string): TermEntry | undefined {
  return entries.get(key)
}

export function restyleTerminals(): void {
  const { settings } = get()
  const theme = themeById(settings.theme).terminal
  for (const e of entries.values()) {
    const font = termFont()
    e.term.options.theme = theme
    e.term.options.fontFamily = font.family
    e.term.options.fontSize = font.size
    e.term.options.lineHeight = font.lineHeight
    e.term.options.letterSpacing = font.letterSpacing
    fitTerminal(e.key)
  }
}

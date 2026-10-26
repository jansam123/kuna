import { useEffect } from 'react'
import type { AgentRuntime, AgentStatus } from '@shared/types'
import { killing, openTab, windowCommand } from './actions'
import { Inspector } from './components/Inspector'
import { Overlays } from './components/Overlays'
import { PaneGrid } from './components/PaneGrid'
import { PromptBar } from './components/PromptBar'
import { Sidebar } from './components/Sidebar'
import { Splitter } from './components/Splitter'
import { StatusBar } from './components/StatusBar'
import { Toasts } from './components/Toasts'
import { agentTitle } from './format'
import { installKeys } from './keys'
import { applyRemote, flushState, get, isHidden, loadState, noteReported, noteHostnames, pruneArrangement, pruneHidden, pruneLastSeen, reopenTabs, resolveCwds, resolveFolders, seedSeen, set, useKuna, withRealCwds } from './store'
import { restyleTerminals } from './terminals'
import { applyFonts } from './fonts'
import { applyTheme, themeById } from './themes'
import { localName } from './platform'

const prevStatus = new Map<string, AgentStatus>()

/**
 * macOS notification when an agent finishes a turn or asks for input while
 * Kuna is in the background. Every window sees the change; the one used last
 * posts it.
 */
function notifyTransitions(list: AgentRuntime[]): void {
  const s = get()
  for (const a of list) {
    const before = prevStatus.get(a.key)
    prevStatus.set(a.key, a.status)
    if (!before || before === a.status || !s.settings.notify || s.windows.anyFocused || !s.windows.notifier) continue
    const done = before === 'working' && a.status === 'idle'
    const asks = a.status === 'waiting'
    const failed = a.status === 'failed'
    if (!done && !asks && !failed) continue
    const title = agentTitle(a, s.details[a.key])
    const n = new Notification(asks ? `${title} needs you` : failed ? `${title} failed` : `${title} is done`, {
      body: `${a.cwd} on ${a.host === 'local' ? localName : a.host}`,
      silent: !asks
    })
    n.onclick = () => {
      // its pane may be in another window: openTab goes there
      if (!get().windows.elsewhere[a.key]) window.focus()
      openTab(a.key)
    }
  }
}

function wireMain(): () => void {
  const offs = [
    window.kuna.hosts.onState((states) => {
      set({ hosts: Object.fromEntries(states.map((h) => [h.host, h])) })
      noteHostnames(states)
      for (const h of states) if (h.status === 'ready') void resolveFolders(h.host)
    }),
    window.kuna.agents.onUpdate((all: AgentRuntime[]) => {
      noteReported(all)
      pruneHidden(all)
      const list = withRealCwds(all.filter((a) => !killing.has(a.key) && !isHidden(a)))
      const agents = Object.fromEntries(list.map((a) => [a.key, a]))
      void resolveCwds(list)
      notifyTransitions(list)
      set({ agents })
      seedSeen(list)
      pruneLastSeen()
      pruneArrangement()
      reopenTabs()
    }),
    window.kuna.agents.onDetails((key, details) => set((s) => ({ details: { ...s.details, [key]: details } }))),
    window.kuna.usage.onUpdate((usage) => set({ usage })),
    window.kuna.state.onChange(applyRemote),
    window.kuna.windows.onInfo((windows) => set({ windows })),
    window.kuna.windows.onCommand(windowCommand)
  ]
  void window.kuna.usage.get().then((usage) => set({ usage }))
  // a window opened after the others has missed what was read from transcripts so far
  void window.kuna.agents.allDetails().then((details) => set((s) => ({ details: { ...details, ...s.details } })))
  return () => offs.forEach((off) => off())
}

/** Tell the main process which agents are in view (open panes + the selected one). */
function useInterest(): void {
  const tabs = useKuna((s) => s.tabs)
  const sel = useKuna((s) => s.sel)
  useEffect(() => {
    const keys = new Set(tabs)
    if (sel?.startsWith('a:')) keys.add(sel.slice(2))
    const t = setTimeout(() => window.kuna.agents.interest([...keys]), 250)
    return () => clearTimeout(t)
  }, [tabs, sel])
}

/** The window's title (Window menu, Mission Control, ⌘`): the focused pane's agent. */
function useTitle(): void {
  const title = useKuna((s) => {
    const key = s.tabs[s.paneIndex]
    const a = key ? s.agents[key] : undefined
    return a ? agentTitle(a, s.details[a.key]) : 'Kuna'
  })
  useEffect(() => {
    document.title = title
  }, [title])
}

export function App(): React.JSX.Element {
  const loaded = useKuna((s) => s.loaded)
  const theme = useKuna((s) => s.settings.theme)
  const termFontSize = useKuna((s) => s.settings.termFontSize)
  const uiFont = useKuna((s) => s.settings.uiFont)
  const fonts = useKuna((s) => s.fonts)
  const inspector = useKuna((s) => s.settings.inspector)
  const sidebarHidden = useKuna((s) => s.sidebarHidden)
  const sidebarPeek = useKuna((s) => s.sidebarPeek)
  const inspectorPeek = useKuna((s) => s.inspectorPeek)
  const fullOverlay = useKuna((s) => s.overlay?.kind === 'media')
  const sidebarWidth = useKuna((s) => s.settings.sidebarWidth)
  const inspectorWidth = useKuna((s) => s.settings.inspectorWidth)
  const mode = useKuna((s) => s.mode)
  useInterest()
  useTitle()

  useEffect(() => {
    const off = wireMain()
    void loadState()
    const offKeys = installKeys()
    // ⌘Q right after a change: save it before the window goes
    window.addEventListener('beforeunload', flushState)
    return () => {
      off()
      offKeys()
      window.removeEventListener('beforeunload', flushState)
    }
  }, [])

  useEffect(() => {
    void window.kuna.fonts().then((f) => set({ fonts: f }))
  }, [])

  useEffect(() => {
    applyTheme(themeById(theme))
    restyleTerminals()
  }, [theme, termFontSize])

  useEffect(() => {
    if (fonts) void applyFonts(fonts, uiFont).then(restyleTerminals)
  }, [fonts, uiFont])

  // the macOS window buttons only over the sidebar (and not over the plot viewer)
  useEffect(() => {
    window.kuna.windowButtons(loaded && (!sidebarHidden || sidebarPeek) && !fullOverlay)
  }, [loaded, sidebarHidden, sidebarPeek, fullOverlay])

  if (!loaded) return <div className="boot" />

  return (
    <div
      className={`app mode-${mode} ${sidebarHidden && sidebarPeek ? 'peek' : ''} ${!inspector && inspectorPeek ? 'peek-right' : ''}`}
      style={
        {
          '--sidebar-w': `${sidebarHidden ? 0 : sidebarWidth}px`,
          '--peek-w': `${sidebarWidth}px`,
          '--inspector-w': `${inspectorWidth ?? 300}px`
        } as React.CSSProperties
      }
    >
      <div className="titlebar" />
      {(!sidebarHidden || sidebarPeek) && (
        <aside className="left">
          <Sidebar />
          <PromptBar />
        </aside>
      )}
      <main className="main">
        <PaneGrid />
      </main>
      {(inspector || inspectorPeek) && <Inspector />}
      {!sidebarHidden && <Splitter side="left" />}
      {inspector && <Splitter side="right" />}
      <StatusBar />
      <Overlays />
      <Toasts />
    </div>
  )
}

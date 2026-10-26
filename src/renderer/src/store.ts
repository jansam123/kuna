import { create } from 'zustand'
import type {
  AgentDetails,
  AgentRuntime,
  Folder,
  FontPrefs,
  HostState,
  PlanUsage,
  Project,
  Settings,
  SharedState,
  SshHostEntry,
  WindowLayout,
  WindowsInfo
} from '@shared/types'
import { pruneArranged } from '@shared/arrange'
import { wslPath } from '@shared/paths'
import { applyPatch, diffShared, mergePatch, type SharedPatch } from '@shared/sync'
import { REPO_COLORS } from './themes'
import { keyLabel } from './platform'

export type Zone = 'sidebar' | 'prompt' | 'pane'

export type Overlay =
  | { kind: 'media'; key: string }
  | { kind: 'claude'; host?: string }
  | { kind: 'project'; editId?: string }
  | { kind: 'folder'; projectId: string; path?: string }
  | { kind: 'folder-edit'; projectId: string; folderId: string }
  | { kind: 'agent-rename'; key: string }
  | { kind: 'settings' }
  | { kind: 'help' }
  | { kind: 'login'; host: string }
  | { kind: 'confirm'; title: string; body: string; action: () => void }

export interface Toast {
  id: number
  text: string
  tone: 'info' | 'error' | 'warn'
}

interface KunaState {
  loaded: boolean
  projects: Project[]
  settings: Settings
  lastSeen: Record<string, number>
  hostnames: Record<string, string>
  agents: Record<string, AgentRuntime>
  details: Record<string, AgentDetails>
  hosts: Record<string, HostState>
  sshHosts: SshHostEntry[]
  /** Claude plan usage (5-hour and weekly windows), freshest across hosts */
  usage: PlanUsage | null

  tabs: string[]
  zone: Zone
  paneIndex: number
  mode: 'nav' | 'insert'
  /** selected sidebar row id (p:…, f:…, a:…) */
  sel: string | null
  prompt: string
  overlay: Overlay | null
  armedKill: { key: string; until: number } | null
  /** agents a Compact is being typed into (the button waits) */
  compacting: Record<string, true>
  toasts: Toast[]
  sidebarHidden: boolean
  /** the hidden sidebar shown for a moment (← from the leftmost pane); hides again on the way back */
  sidebarPeek: boolean
  /** the hidden right panel shown for a moment (→ from the rightmost pane); ← or Esc hides it */
  inspectorPeek: boolean
  /** first Esc of a double-Esc was pressed */
  escHint: boolean
  /** fonts from the user's VS Code / iTerm2 settings (null until read) */
  fonts: FontPrefs | null
  /** background sessions stopped and taken off the list → when (⌘Z or bringing one back elsewhere shows it again) */
  hidden: Record<string, number>
  /** agent key → the name given to it in Kuna (⌘R) */
  names: Record<string, string>
  /** the other Kuna windows, as far as this one needs to know */
  windows: WindowsInfo
}

export const useKuna = create<KunaState>(() => ({
  loaded: false,
  projects: [],
  settings: { theme: 'cherenkov', inspector: true, sidebarWidth: 280, notify: true },
  fonts: null,
  hidden: {},
  names: {},
  lastSeen: {},
  hostnames: {},
  agents: {},
  details: {},
  hosts: {},
  sshHosts: [],
  usage: null,
  tabs: [],
  zone: 'sidebar',
  paneIndex: 0,
  mode: 'nav',
  sel: null,
  prompt: '',
  overlay: null,
  armedKill: null,
  compacting: {},
  toasts: [],
  sidebarHidden: false,
  sidebarPeek: false,
  inspectorPeek: false,
  escHint: false,
  windows: { index: 0, count: 1, anyFocused: true, notifier: true, elsewhere: {} }
}))

export const get = useKuna.getState
export const set = useKuna.setState

const uid = (): string => Math.random().toString(36).slice(2, 10)

// ------------------------------------------------------------ persistence --

let saveTimer: ReturnType<typeof setTimeout> | undefined

/** This window's panes, as saved. */
function layout(): WindowLayout {
  const s = get()
  // panes still waiting to be reopened count as open
  const tabs = [...s.tabs, ...(pendingTabs?.keys.filter((k) => !s.tabs.includes(k)) ?? [])]
  const focus = s.zone === 'pane' ? s.tabs[s.paneIndex] : pendingTabs?.focus
  return { tabs, focus, sidebarHidden: s.sidebarHidden }
}

function shared(s: KunaState): SharedState {
  return { projects: s.projects, settings: s.settings, lastSeen: s.lastSeen, hostnames: s.hostnames, hidden: s.hidden, names: s.names }
}

/** changes to the shared state made here since the last save */
let pending: SharedPatch | null = null
/** applying another window's change: not one of ours to send */
let fromElsewhere = false

/** Another window changed the shared state (projects, settings, names…). */
export function applyRemote(patch: SharedPatch): void {
  fromElsewhere = true
  try {
    set(applyPatch(shared(get()), patch))
  } finally {
    fromElsewhere = false
  }
}

// ------------------------------------------------------------- reopening --

/** panes open at the last quit that have not come back yet */
let pendingTabs: { keys: string[]; focus?: string } | null = null

/**
 * Reopen the panes that were open when Kuna quit, as their agents show up
 * running (each host reports in its own time). Agents that are gone or
 * stopped are left closed: attaching would start a stopped background
 * session again.
 */
export function reopenTabs(): void {
  if (!pendingTabs) return
  const s = get()
  const running = (k: string): boolean => !!s.agents[k]?.alive
  const settled = (k: string): boolean => !!s.hosts[k.slice(0, k.lastIndexOf('::'))]?.synced
  const keep = pendingTabs.keys.filter((k) => running(k) || !settled(k))
  const now = keep.filter(running)
  if (now.length) {
    const tabs = [...keep.filter((k) => running(k) || s.tabs.includes(k)), ...s.tabs.filter((k) => !keep.includes(k))]
    const focus = pendingTabs.focus && tabs.includes(pendingTabs.focus) && running(pendingTabs.focus) ? pendingTabs.focus : undefined
    set(focus && s.zone !== 'prompt' ? { tabs, zone: 'pane', paneIndex: tabs.indexOf(focus), mode: 'nav' } : { tabs })
  }
  const left = keep.filter((k) => !running(k))
  pendingTabs = left.length ? { ...pendingTabs, keys: left } : null
}

// what changes here goes to the other windows; panes opened, closed or moved are part of what is saved
useKuna.subscribe((s, prev) => {
  // the load itself is no change
  if (!prev.loaded) return
  const change = fromElsewhere ? null : diffShared(shared(prev), shared(s))
  if (change) pending = pending ? mergePatch(pending, change) : change
  if (change || s.tabs !== prev.tabs || s.sidebarHidden !== prev.sidebarHidden) persist()
})

function persist(): void {
  // nothing to save before the saved state is loaded (it would overwrite it with an empty one)
  if (!get().loaded) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = undefined
    const patch = pending
    pending = null
    void window.kuna.state.save(patch, layout())
  }, 250)
}

/** Save right away (the window is closing): also where the focus is, which is not saved as it moves. */
export function flushState(): void {
  if (!get().loaded) return
  clearTimeout(saveTimer)
  saveTimer = undefined
  const patch = pending
  pending = null
  window.kuna.state.saveNow(patch, layout())
}

export async function loadState(): Promise<void> {
  const [boot, sshHosts] = await Promise.all([window.kuna.state.load(), window.kuna.ssh.hosts()])
  const { state, layout } = boot
  const first = state.projects[0]
  set({
    loaded: true,
    // "a//b/" as typed is "a/b"
    projects: state.projects.map((p) => ({
      ...p,
      folders: p.folders.map((f) => {
        const path = wslPath(f.path).replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1')
        // a name taken from the Windows path it was added with becomes the folder's own
        const name = f.name !== path && wslPath(f.name).replace(/\/+$/, '') === path ? path.split('/').pop() || path : f.name
        if (wslPath(f.path) === f.path) return { ...f, path, name }
        // a Windows path that became WSL's is asked about again (its old lookup failed)
        return { ...f, path, name, real: undefined }
      })
    })),
    settings: state.settings,
    lastSeen: state.lastSeen,
    hostnames: state.hostnames,
    hidden: state.hidden,
    names: state.names,
    sidebarHidden: layout?.sidebarHidden ?? false,
    sshHosts,
    // a new window starts on the row selected where it was opened from
    sel: boot.sel ?? (first ? `p:${first.id}` : null)
  })
  pendingTabs = layout?.tabs.length ? { keys: layout.tabs, focus: layout.focus } : null
  syncHosts()
}

/** Tell the main process which hosts to keep connections to. */
export function syncHosts(): void {
  const hosts = [...new Set(get().projects.map((p) => p.host))]
  void window.kuna.hosts.watch(hosts)
}

// ---------------------------------------------------------------- toasts --

let toastSeq = 0
export function toast(text: string, tone: Toast['tone'] = 'info'): void {
  const id = ++toastSeq
  set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text: keyLabel(text), tone }] }))
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), tone === 'info' ? 3500 : 7000)
}

// --------------------------------------------------------------- projects --

export function addProject(p: { name: string; host: string; agentCommand: string }): Project {
  const used = new Set(get().projects.map((x) => x.color))
  const color = REPO_COLORS.find((c) => !used.has(c)) ?? REPO_COLORS[get().projects.length % REPO_COLORS.length]
  const project: Project = { id: uid(), name: p.name, host: p.host, agentCommand: p.agentCommand, color, folders: [] }
  set((s) => ({ projects: [...s.projects, project], sel: `p:${project.id}` }))
  persist()
  syncHosts()
  return project
}

export function updateProject(id: string, patch: Partial<Project>): void {
  set((s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)) }))
  persist()
  if (patch.host) syncHosts()
}

export function removeProject(id: string): void {
  set((s) => ({ projects: s.projects.filter((p) => p.id !== id), sel: null }))
  persist()
  syncHosts()
}

export function moveProject(id: string, delta: number): void {
  set((s) => {
    const i = s.projects.findIndex((p) => p.id === id)
    const j = i + delta
    if (i < 0 || j < 0 || j >= s.projects.length) return {}
    const projects = [...s.projects]
    ;[projects[i], projects[j]] = [projects[j], projects[i]]
    return { projects }
  })
  persist()
}

// --------------------------------------------------- sessions off the list --

/** hidden sessions seen stopped since; one of them running again was brought back elsewhere */
const stoppedWhileHidden = new Set<string>()
/** everything the hosts reported last, hidden ones included (to show one again right away) */
let reported: AgentRuntime[] = []

export function noteReported(all: AgentRuntime[]): void {
  reported = all
}

export function hideAgent(key: string): void {
  // already stopped: running again later means it was brought back
  if (get().agents[key]?.alive === false) stoppedWhileHidden.add(key)
  set((s) => ({ hidden: { ...s.hidden, [key]: Math.floor(Date.now() / 1000) } }))
  persist()
}

export function unhideAgent(key: string): void {
  const hidden = { ...get().hidden }
  if (!(key in hidden)) return
  delete hidden[key]
  stoppedWhileHidden.delete(key)
  const a = reported.find((x) => x.key === key)
  set((s) => ({ hidden, agents: a && !s.agents[key] ? { ...s.agents, [key]: withRealCwds([a])[0] } : s.agents }))
  persist()
}

/**
 * Whether a session stays off the list. One that runs again after it was
 * stopped (from `claude agents` or `claude attach`) comes back by itself.
 */
export function isHidden(a: AgentRuntime): boolean {
  if (!(a.key in get().hidden)) return false
  if (!a.alive) {
    stoppedWhileHidden.add(a.key)
    return true
  }
  if (stoppedWhileHidden.has(a.key)) {
    unhideAgent(a.key)
    return false
  }
  return true
}

/** Forget hidden sessions and names of agents that no longer exist (once their host reported a full list). */
export function pruneHidden(all: AgentRuntime[]): void {
  const s = get()
  const live = new Set(all.map((a) => a.key))
  const keep = (k: string): boolean => live.has(k) || !s.hosts[k.slice(0, k.lastIndexOf('::'))]?.synced
  const hidden = Object.entries(s.hidden).filter(([k]) => keep(k))
  const names = Object.entries(s.names).filter(([k]) => keep(k))
  if (hidden.length !== Object.keys(s.hidden).length || names.length !== Object.keys(s.names).length) {
    set({ hidden: Object.fromEntries(hidden), names: Object.fromEntries(names) })
    persist()
  }
}

/** Give an agent a name of your own in Kuna; an empty one goes back to its own title. */
export function renameAgent(key: string, name: string): void {
  const names = { ...get().names }
  if (name.trim()) names[key] = name.trim()
  else delete names[key]
  set({ names })
  persist()
}

/** ⌘Z: the session taken off the list last comes back (still stopped; Enter opens it). */
export function undoHide(): string | undefined {
  const last = Object.entries(get().hidden).sort((a, b) => b[1] - a[1])[0]
  if (!last) return undefined
  unhideAgent(last[0])
  return last[0]
}

/** Apply a rearrangement of the sidebar (see @shared/arrange) and save it. */
export function arrange(next: Project[]): void {
  if (next === get().projects) return
  set({ projects: next })
  persist()
}

/** Drop hand placements of agents that are gone (once their host reported a full list). */
export function pruneArrangement(): void {
  const s = get()
  const next = pruneArranged(s.projects, new Set(Object.keys(s.agents)), (h) => !!s.hosts[h]?.synced)
  if (next !== s.projects) arrange(next)
}

export function addFolder(projectId: string, path: string, name?: string): Folder {
  const all = get().projects.flatMap((p) => p.folders.map((f) => f.color))
  const color = REPO_COLORS.find((c) => !all.includes(c)) ?? REPO_COLORS[all.length % REPO_COLORS.length]
  const clean = wslPath(path.trim()).replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/'
  const folder: Folder = { id: uid(), path: clean, name: name?.trim() || (clean === '~' ? 'home' : clean.split('/').pop() || clean), color }
  set((s) => ({
    projects: s.projects.map((p) => (p.id === projectId ? { ...p, collapsed: false, folders: [...p.folders, folder] } : p)),
    sel: `f:${projectId}:${folder.id}`
  }))
  persist()
  const host = get().projects.find((p) => p.id === projectId)?.host
  if (host) void resolveFolders(host)
  return folder
}

const resolving = new Set<string>()

/** `${host}\0${cwd}` → the agent directory with symlinks resolved ("" when it is gone) */
const realCwds = new Map<string, string>()
const cwdsAsked = new Set<string>()

/** Agents with their resolved working directory attached, as far as it is known. */
export function withRealCwds(agents: AgentRuntime[]): AgentRuntime[] {
  return agents.map((a) => {
    const real = realCwds.get(`${a.host}\0${a.cwd}`)
    return real && real !== a.cwd ? { ...a, realCwd: real } : a
  })
}

/**
 * Resolve the working directories of agents (once each, one call per host):
 * folders added through a symlink then match whichever way the link points.
 */
export async function resolveCwds(agents: AgentRuntime[]): Promise<void> {
  const byHost = new Map<string, string[]>()
  for (const a of agents) {
    const k = `${a.host}\0${a.cwd}`
    if (!a.cwd || cwdsAsked.has(k) || get().hosts[a.host]?.status !== 'ready') continue
    cwdsAsked.add(k)
    byHost.set(a.host, [...(byHost.get(a.host) ?? []), a.cwd])
  }
  await Promise.all(
    [...byHost].map(async ([host, cwds]) => {
      try {
        const real = await window.kuna.fs.realPaths(host, cwds)
        for (const c of cwds) realCwds.set(`${host}\0${c}`, real[c] ?? '')
      } catch {
        for (const c of cwds) cwdsAsked.delete(`${host}\0${c}`)
      }
    })
  )
  if (byHost.size) set((s) => ({ agents: Object.fromEntries(withRealCwds(Object.values(s.agents)).map((a) => [a.key, a])) }))
}

/**
 * Ask the host for the physical path of folders that don't have one yet
 * (once per folder): agents report their working directory with symlinks
 * resolved, e.g. /project/exp/Users/… for a folder added as /project/exp/users/….
 */
export async function resolveFolders(host: string): Promise<void> {
  const todo = get()
    .projects.filter((p) => p.host === host)
    .flatMap((p) => p.folders.filter((f) => f.real === undefined).map((f) => f.path))
  if (!todo.length || resolving.has(host)) return
  resolving.add(host)
  try {
    const real = await window.kuna.fs.realPaths(host, [...new Set(todo)])
    set((s) => ({
      projects: s.projects.map((p) =>
        // "": not there (or not a directory); not asked again
        p.host !== host ? p : { ...p, folders: p.folders.map((f) => (f.real === undefined && todo.includes(f.path) ? { ...f, real: real[f.path] ?? '' } : f)) }
      )
    }))
    persist()
  } catch {
    // host not reachable: try again on the next connect
  } finally {
    resolving.delete(host)
  }
}

export function updateFolder(projectId: string, folderId: string, patch: Partial<Folder>): void {
  set((s) => ({
    projects: s.projects.map((p) =>
      p.id === projectId ? { ...p, folders: p.folders.map((f) => (f.id === folderId ? { ...f, ...patch } : f)) } : p
    )
  }))
  persist()
}

export function removeFolder(projectId: string, folderId: string): void {
  set((s) => ({
    projects: s.projects.map((p) => (p.id === projectId ? { ...p, folders: p.folders.filter((f) => f.id !== folderId) } : p)),
    sel: `p:${projectId}`
  }))
  persist()
}

export function toggleCollapsed(projectId: string, collapsed?: boolean): void {
  set((s) => ({
    projects: s.projects.map((p) => (p.id === projectId ? { ...p, collapsed: collapsed ?? !p.collapsed } : p))
  }))
  persist()
}

export function toggleFolder(projectId: string, folderId: string, collapsed?: boolean): void {
  set((s) => ({
    projects: s.projects.map((p) => {
      if (p.id !== projectId) return p
      if (folderId === '__other') return { ...p, otherCollapsed: collapsed ?? !p.otherCollapsed }
      return { ...p, folders: p.folders.map((f) => (f.id === folderId ? { ...f, collapsed: collapsed ?? !f.collapsed } : f)) }
    })
  }))
  persist()
}

/**
 * The first time Kuna sees a host, everything already finished there counts as
 * seen — otherwise every old session would show up as unread.
 */
export function seedSeen(agents: AgentRuntime[]): void {
  const s = get()
  const next = { ...s.lastSeen }
  let changed = false
  const hostsWithHistory = new Set(Object.keys(s.lastSeen).map((k) => k.slice(0, k.lastIndexOf('::'))))
  const now = Math.floor(Date.now() / 1000)
  for (const a of agents) {
    if (hostsWithHistory.has(a.host) || !s.hosts[a.host]?.synced) continue
    if (next[a.key] == null) {
      next[a.key] = now
      changed = true
    }
  }
  if (changed) {
    set({ lastSeen: next })
    persist()
  }
}

export function updateSettings(patch: Partial<Settings>): void {
  set((s) => ({ settings: { ...s.settings, ...patch } }))
  persist()
}

// ---------------------------------------------------------------- agents --

export function markSeen(key: string): void {
  const now = Math.floor(Date.now() / 1000)
  const prev = get().lastSeen[key] ?? 0
  if (now - prev < 1) return
  set((s) => ({ lastSeen: { ...s.lastSeen, [key]: now } }))
  persist()
}

export function isUnread(a: AgentRuntime, lastSeen: Record<string, number>): boolean {
  return a.attnTs > 0 && a.attnTs > (lastSeen[a.key] ?? 0)
}

/** Forget lastSeen entries for agents that no longer exist anywhere. */
export function pruneLastSeen(): void {
  const s = get()
  const live = new Set(Object.keys(s.agents))
  const watched = new Set(s.projects.map((p) => p.host))
  const next: Record<string, number> = {}
  let changed = false
  for (const [k, v] of Object.entries(s.lastSeen)) {
    const host = k.slice(0, k.lastIndexOf('::'))
    // only forget an agent once its host has reported a full list without it
    if (live.has(k) || !watched.has(host) || !s.hosts[host]?.synced) next[k] = v
    else changed = true
  }
  if (changed) {
    set({ lastSeen: next })
    persist()
  }
}

/**
 * Aliases like `lxplus` resolve to a different machine on each login, and tmux
 * sessions live on one machine. Warn when an alias lands somewhere new.
 */
export function noteHostnames(states: HostState[]): void {
  const known = get().hostnames
  let next: Record<string, string> | undefined
  for (const h of states) {
    if (h.status !== 'ready' || !h.hostname || h.host === 'local') continue
    const before = known[h.host]
    if (before === h.hostname) continue
    if (before) {
      toast(
        `${h.host} now reaches ${h.hostname} instead of ${before}. Agents started on ${before} are only visible from there — point the project at a fixed node in ~/.ssh/config.`,
        'warn'
      )
    }
    next = { ...(next ?? known), [h.host]: h.hostname }
  }
  if (next) {
    set({ hostnames: next })
    persist()
  }
}

import type {
  AgentDetails,
  AgentRuntime,
  ClaudeFileEntry,
  FontPrefs,
  HostId,
  HostState,
  MediaPage,
  PlanUsage,
  SpawnRequest,
  SshHostEntry,
  WindowBoot,
  WindowLayout,
  WindowsInfo
} from './types'
import type { SharedPatch } from './sync'
import type { DirListing, GitBlob, GitCompare, GitInfo, GitRepo, GitSide, GitStatus } from './git'
import type { VscodeLook } from './vscode'

/** What the main process asks a window to do. */
export type WindowCommand =
  /** open this agent's pane here and focus it (carried over from another window) */
  | { kind: 'adopt'; key: string }
  /** focus this agent's pane (opened from another window, or a notification) */
  | { kind: 'focus'; key: string }
  /** close this agent's pane (it was stopped from another window) */
  | { kind: 'close'; key: string }
  /** ⌘← ⌘→ landed here */
  | { kind: 'arrive' }
  /** the New Window menu item */
  | { kind: 'new-window' }

/** The API exposed to the renderer as `window.kuna`. */
export interface KunaApi {
  platform: string
  state: {
    load(): Promise<WindowBoot>
    /** a change to what all windows share (null: none), and this window's panes */
    save(patch: SharedPatch | null, layout: WindowLayout): Promise<void>
    /** synchronous save, for when the window is closing */
    saveNow(patch: SharedPatch | null, layout: WindowLayout): void
    /** a change another window made */
    onChange(cb: (patch: SharedPatch) => void): () => void
  }
  windows: {
    /** a new window, with this sidebar row selected */
    open(sel: string | null): void
    /** close this window */
    close(): void
    /** go to the previous / next window; false when there is no other */
    step(dir: -1 | 1): Promise<boolean>
    /** move an agent's pane from this window to the previous / next one; false when there is no other */
    carry(key: string, dir: -1 | 1): Promise<boolean>
    /** go to the window that has the agent's pane; false when no other window has it */
    reveal(key: string): Promise<boolean>
    /** close the agent's pane in whichever other window has it */
    closePane(key: string): void
    onInfo(cb: (info: WindowsInfo) => void): () => void
    onCommand(cb: (cmd: WindowCommand) => void): () => void
  }
  ssh: {
    hosts(): Promise<SshHostEntry[]>
  }
  /** fonts from the user's VS Code and iTerm2 settings */
  fonts(): Promise<FontPrefs>
  hosts: {
    /** Make sure we watch exactly these hosts. */
    watch(hosts: HostId[]): Promise<void>
    reconnect(host: HostId): Promise<void>
    onState(cb: (states: HostState[]) => void): () => void
  }
  agents: {
    spawn(req: SpawnRequest): Promise<{ key: string } | { error: string }>
    /** Kill a Kuna agent; stop (or, once stopped, remove) a Claude background session. */
    kill(key: string): Promise<{ error?: string; stopped?: boolean }>
    respawn(key: string): Promise<{ error?: string }>
    /** Agents currently in view; only their transcripts are followed. */
    interest(keys: string[]): void
    key(key: string, keys: string[]): Promise<void>
    /** Type a line into a Kuna (tmux) agent and press Enter. */
    send(key: string, text: string): Promise<{ error?: string }>
    onUpdate(cb: (agents: AgentRuntime[]) => void): () => void
    details(key: string): Promise<AgentDetails | null>
    /** every agent's details read so far (a window that just opened) */
    allDetails(): Promise<Record<string, AgentDetails>>
    onDetails(cb: (key: string, details: AgentDetails) => void): () => void
  }
  usage: {
    get(): Promise<PlanUsage | null>
    onUpdate(cb: (usage: PlanUsage | null) => void): () => void
  }
  pty: {
    /** Attach a terminal to an agent's tmux session. */
    attach(key: string, cols: number, rows: number): Promise<string>
    /** Interactive `ssh <host>` used to sign in when keys are not enough. */
    login(host: HostId, cols: number, rows: number): Promise<string>
    write(ptyId: string, data: string): void
    resize(ptyId: string, cols: number, rows: number): void
    close(ptyId: string): void
    onData(cb: (ptyId: string, data: string) => void): () => void
    onExit(cb: (ptyId: string, code: number) => void): () => void
  }
  media: {
    /** the latest reply's plots; `before` an earlier reply's, `scan` the folder scan */
    list(key: string, page?: { before?: number; scan?: boolean }): Promise<MediaPage>
    fetch(host: HostId, path: string, stamp?: string): Promise<{ data: Uint8Array; mime: string } | { error: string }>
    openExternal(host: HostId, path: string, stamp?: string): Promise<void>
    /** a copy in ~/Downloads (renamed "x (1).pdf" if taken): its path, or why not */
    save(host: HostId, path: string, stamp?: string): Promise<{ file: string } | { error: string }>
    /** where an HTML page is shown (a `kuna-page:` address, its folder's own origin), or why not */
    page(host: HostId, path: string): Promise<{ url: string } | { error: string }>
    /** Esc typed into such a page, whose keys the window doesn't see */
    onPageEscape(cb: () => void): () => void
  }
  claude: {
    list(host: HostId, cwds: string[]): Promise<ClaudeFileEntry[]>
    read(host: HostId, path: string): Promise<string>
  }
  /** the clipboard's text (⌘V where no text field has the caret) */
  clipboardText(): Promise<string>
  copyText(text: string): void
  /** show or hide the macOS close/minimize/zoom buttons (only over the sidebar) */
  windowButtons(visible: boolean): void
  /** the review view (⌘G): read-only git on any host */
  git: {
    /** the repository a folder is in, and those up to three levels below it, most recently active first */
    repos(host: HostId, dir: string): Promise<GitRepo[] | { error: string }>
    overview(host: HostId, dir: string): Promise<{ info: GitInfo; status: GitStatus } | { error: string }>
    /** base...head as a pull request shows it; head null: the working tree */
    compare(host: HostId, dir: string, base: string, head: string | null): Promise<GitCompare | { error: string }>
    /** every file at a commit, or in the working tree (null) */
    files(host: HostId, dir: string, rev: string | null): Promise<string[] | { error: string }>
    read(host: HostId, dir: string, sides: GitSide[]): Promise<GitBlob[] | { error: string }>
    /** the Folder tab: one folder's entries, and one file, git or not */
    listDir(host: HostId, path: string): Promise<DirListing | { error: string }>
    readFile(host: HostId, path: string): Promise<GitBlob | { error: string }>
  }
  /** the user's VS Code: theme, editor settings, icons */
  vscode: {
    look(refresh?: boolean): Promise<VscodeLook>
    icon(id: string): Promise<string | null>
  }
  fs: {
    dirs(host: HostId, dir: string): Promise<string[]>
    /** path → physical path (symlinks resolved) for the directories that exist */
    realPaths(host: HostId, paths: string[]): Promise<Record<string, string>>
  }
}

export const IPC = {
  stateLoad: 'state:load',
  stateSave: 'state:save',
  stateSaveSync: 'state:save-sync',
  stateChanged: 'state:changed',
  windowOpen: 'window:open',
  windowClose: 'window:close',
  windowStep: 'window:step',
  windowCarry: 'window:carry',
  windowReveal: 'window:reveal',
  windowClosePane: 'window:close-pane',
  windowInfo: 'window:info',
  windowCommand: 'window:command',
  sshHosts: 'ssh:hosts',
  fonts: 'app:fonts',
  hostsWatch: 'hosts:watch',
  hostsReconnect: 'hosts:reconnect',
  hostsState: 'hosts:state',
  agentsSpawn: 'agents:spawn',
  agentsKill: 'agents:kill',
  agentsRespawn: 'agents:respawn',
  agentsInterest: 'agents:interest',
  agentsKey: 'agents:key',
  agentsSend: 'agents:send',
  agentsUpdate: 'agents:update',
  agentsDetails: 'agents:details',
  agentsAllDetails: 'agents:all-details',
  agentsDetailsUpdate: 'agents:details-update',
  usageGet: 'usage:get',
  usageUpdate: 'usage:update',
  ptyAttach: 'pty:attach',
  ptyLogin: 'pty:login',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyClose: 'pty:close',
  ptyData: 'pty:data',
  ptyExit: 'pty:exit',
  mediaList: 'media:list',
  mediaFetch: 'media:fetch',
  mediaOpen: 'media:open',
  mediaSave: 'media:save',
  mediaPage: 'media:page',
  pageEscape: 'media:page-escape',
  claudeList: 'claude:list',
  claudeRead: 'claude:read',
  gitRepos: 'git:repos',
  gitOverview: 'git:overview',
  gitCompare: 'git:compare',
  gitFiles: 'git:files',
  gitRead: 'git:read',
  gitListDir: 'git:list-dir',
  gitReadFile: 'git:read-file',
  vscodeLook: 'vscode:look',
  vscodeIcon: 'vscode:icon',
  fsDirs: 'fs:dirs',
  fsRealPaths: 'fs:real-paths',
  clipboardText: 'clipboard:text',
  copyText: 'clipboard:write',
  windowButtons: 'window:buttons'
} as const

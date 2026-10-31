/** `local` for this machine, otherwise an alias from ~/.ssh/config. */
export type HostId = string

export const LOCAL_HOST: HostId = 'local'

export interface Folder {
  id: string
  /** Path on the project's host. May start with `~`. */
  path: string
  /** the same directory with symlinks resolved (what agents report as their working directory) */
  real?: string
  /** agents placed here by hand (dragged in the sidebar), in their order */
  agents?: string[]
  name: string
  color: string
  collapsed?: boolean
}

export interface Project {
  id: string
  name: string
  host: HostId
  color: string
  /** Command used to start new agents, e.g. `claude` or `claude --model opus`. */
  agentCommand: string
  /**
   * How new agents run: as Claude Code background sessions (also visible in
   * `claude agents`; default for claude commands) or in Kuna's tmux server.
   */
  launch?: 'background' | 'tmux'
  folders: Folder[]
  collapsed?: boolean
  /** the "Other agents" group is collapsed */
  otherCollapsed?: boolean
}

export interface Settings {
  theme: string
  /** agent terminals' font size when changed with ⌘+ / ⌘−; otherwise the detected one */
  termFontSize?: number
  /** Kuna's own text: VS Code's interface font (default) or its editor font */
  uiFont?: 'system' | 'editor'
  inspector: boolean
  sidebarWidth: number
  inspectorWidth?: number
  /** the agent's column beside a file in the plot viewer */
  viewerChatWidth?: number
  /** the review view (⌘G): the file list's width, the agent's column's, and inline diffs instead of side by side */
  reviewListWidth?: number
  reviewChatWidth?: number
  reviewInline?: boolean
  /** "host:repository" → the branch last compared with there */
  reviewBase?: Record<string, string>
  /** macOS notification when an agent finishes or needs you while Kuna is in the background */
  notify: boolean
}

/** Fonts taken from the user's VS Code and terminal settings. */
export interface FontPrefs {
  /** Kuna's interface: VS Code's workbench font (the system font) at its size */
  ui: { family: string; size: number }
  /** paths, ids, hints: VS Code's editor font */
  mono: { family: string; size: number }
  /** agent panes: the font Claude Code runs in (iTerm2's default profile, else VS Code's terminal) */
  terminal: {
    family: string
    size: number
    lineHeight: number
    letterSpacing: number
    /** PostScript names of the exact faces, for @font-face local() */
    faces?: { regular: string; bold?: string }
    source: string
  }
}

export interface PersistedState {
  version: 1
  projects: Project[]
  settings: Settings
  /** agentKey → epoch seconds the user last looked at the agent. */
  lastSeen: Record<string, number>
  /** host alias → machine it reached last time (load-balanced aliases move around) */
  hostnames?: Record<string, string>
  /** Claude background sessions stopped and taken off the list (Ctrl+X Ctrl+X) → when */
  hidden?: Record<string, number>
  /** agent key → the name the user gave it in Kuna (⌘R) */
  names?: Record<string, string>
  /** the windows open at the last quit, in the order they were opened */
  windows?: WindowLayout[]
  /** before Kuna had several windows: the one window's panes (read once, as the first window) */
  layout?: WindowLayout
}

/** One window's own part of the saved state. */
export interface WindowLayout {
  /** the panes that were open (agent keys, in order) */
  tabs: string[]
  /** the focused one */
  focus?: string
  sidebarHidden?: boolean
  /** where it was on screen (its size and place out of full screen) */
  bounds?: { x: number; y: number; width: number; height: number }
  fullScreen?: boolean
}

/** What every window shows the same: the saved state without the windows. */
export interface SharedState {
  projects: Project[]
  settings: Settings
  lastSeen: Record<string, number>
  hostnames: Record<string, string>
  hidden: Record<string, number>
  names: Record<string, string>
}

/** What a window starts from. */
export interface WindowBoot {
  state: SharedState
  /** its panes, when it is a window Kuna had open at the last quit */
  layout?: WindowLayout
  /** the sidebar row selected in the window it was opened from */
  sel?: string | null
}

/** What a window knows about the others. */
export interface WindowsInfo {
  /** its place in the ⌘← ⌘→ order, and how many windows there are */
  index: number
  count: number
  /** some Kuna window has the focus */
  anyFocused: boolean
  /** the window used last: it posts the notifications */
  notifier: boolean
  /** agents with a pane in another window */
  elsewhere: Record<string, true>
}

/**
 * `background`: between turns but with work of its own pending (a scheduled
 * check-in, a monitor, a background command), so it carries on by itself.
 */
export type AgentStatus = 'starting' | 'working' | 'background' | 'waiting' | 'idle' | 'failed' | 'exited' | 'unknown'

/** What an agent is busy with: the tool call of a running turn, or what it waits on between turns. */
export type Activity =
  | { kind: 'tool'; tool: string; summary?: string }
  | { kind: 'scheduled'; at?: number; reason?: string }
  | { kind: 'monitor'; count: number }
  | { kind: 'jobs'; count: number }

/**
 * `tmux`: started by Kuna in its tmux server (any agent CLI).
 * `claude`: a Claude Code background session (`claude --bg`, `claude agents`),
 * run by Claude Code's own daemon on the host.
 */
export type AgentKind = 'tmux' | 'claude'

/** A question the agent is waiting on (AskUserQuestion), with its choices. */
export interface PendingQuestion {
  question: string
  options: string[]
}

/** What we know about an agent from the host's watch stream. Cheap, always fresh. */
export interface AgentRuntime {
  key: string
  id: string
  kind: AgentKind
  host: HostId
  cwd: string
  projectId?: string
  folderId?: string
  createdAt: number
  prompt?: string
  sessionId?: string
  command?: string
  status: AgentStatus
  /** Tool currently running, if any. */
  tool?: string
  /** Last hook event name. */
  lastEvent?: string
  lastEventTs?: number
  /** Epoch seconds of the last event that wants the user's attention. */
  attnTs: number
  activityTs: number
  attached: boolean
  /** tmux scroll/copy mode is active in the pane */
  inCopyMode?: boolean
  alive: boolean
  exitCode?: number
  paneTitle?: string
  permissionMode?: string
  message?: string
  transcriptPath?: string
  transcriptSize: number
  /** Claude background sessions: display name */
  name?: string
  /** what it is doing right now, in words (Claude background sessions) */
  detail?: string
  /** what it is waiting for, e.g. "approve Bash: make plots" or "answer: …" */
  needs?: string
  questions?: PendingQuestion[]
  /** the end of its last reply */
  lastReply?: string
  tokens?: number
  /** Claude background sessions: tokens in context, read by the host from the end of the transcript */
  contextTokens?: number
  /** the most it has had in context (tells a 1M window apart after a compaction) */
  contextPeak?: number
  /** Claude background sessions: the model of its last reply */
  model?: string
  /** Claude background sessions: the `--model` it was started with, e.g. `sonnet[1m]` */
  modelFlag?: string
  /** git worktree the session works in, if isolated */
  worktree?: string
  /** what it is busy with right now */
  activity?: Activity
  /** cwd with symlinks resolved on the host (filled in by the renderer, for placing it under a folder) */
  realCwd?: string
}

export interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | string
  activeForm?: string
}

export interface SubagentInfo {
  id: string
  description: string
  type?: string
  startedAt?: string
  done: boolean
}

export interface ToolCallInfo {
  id: string
  name: string
  summary: string
  at?: string
  done: boolean
  error?: boolean
}

/** What we know about an agent from its Claude Code transcript. */
export interface AgentDetails {
  sessionId?: string
  title?: string
  model?: string
  permissionMode?: string
  version?: string
  gitBranch?: string
  contextTokens: number
  /** the most it has had in context, including before a compaction */
  contextPeak: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  turns: number
  todos: TodoItem[]
  subagents: SubagentInfo[]
  recentTools: ToolCallInfo[]
  filesTouched: string[]
  /** images, PDFs and Markdown files mentioned, oldest first, with the reply (turn) that mentioned each last */
  mediaRefs: MediaRef[]
  /** AskUserQuestion calls still waiting for an answer */
  pendingQuestions: PendingQuestion[]
  lastText?: string
  lastPrompt?: string
  updatedAt?: string
}

export type HostStatus = 'idle' | 'connecting' | 'installing' | 'ready' | 'auth' | 'error'

export interface HostState {
  host: HostId
  status: HostStatus
  /** a full agent list has arrived since the last (re)connect */
  synced?: boolean
  error?: string
  home?: string
  hostname?: string
  os?: string
  tmux?: string
  tmuxVersion?: string
  claude?: string
}

export interface SshHostEntry {
  alias: string
  hostName?: string
  user?: string
  proxyJump?: string
}

export interface MediaRef {
  path: string
  turn: number
}

export interface MediaItem {
  path: string
  mtime: number
  size: number
  kind: 'image' | 'pdf' | 'svg' | 'md'
}

/** One step back through an agent's plots: newest reply first, the folder scan last. */
export interface MediaPage {
  items: MediaItem[]
  /** what to load when browsing past the last item: an earlier reply, the folder scan, or nothing */
  next: { before: number } | { scan: true } | null
}

export interface ClaudeFileEntry {
  path: string
  scope: 'global' | 'plugin' | 'project'
  kind: 'skill' | 'agent' | 'command' | 'memory' | 'settings' | 'other'
  name: string
}

/** One plan-usage window (Claude Pro/Max), as reported to status line commands. */
export interface UsageWindow {
  /** 0–100 */
  usedPct: number
  /** epoch seconds */
  resetsAt?: number
}

export interface PlanUsage {
  fiveHour?: UsageWindow
  sevenDay?: UsageWindow
  /** epoch seconds (local clock) when an agent last reported it */
  updatedAt: number
  /** host whose agent reported it */
  host: HostId
}

export interface SpawnRequest {
  projectId: string
  folderId: string
  prompt: string
  cols: number
  rows: number
  /** start with `claude --resume <id>` instead of a new conversation */
  resumeSessionId?: string
}

export const agentKey = (host: HostId, id: string): string => `${host}::${id}`

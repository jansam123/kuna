import { agentKey, type Activity, type AgentRuntime, type AgentStatus, type HostId, type PendingQuestion, type UsageWindow } from './types'

/** One `P` line: a live tmux pane in the kuna server. */
interface PaneRecord {
  busy: boolean
  /** a question or menu is on screen waiting for a choice */
  asking: boolean
  dead: boolean
  activity: number
  created: number
  attached: boolean
  command: string
  /** tmux copy/scroll mode is active (keys go to tmux, not the agent) */
  inMode: boolean
  title: string
}

/** One `A` line: the agent's state directory under ~/.kuna/agents. */
interface AgentRecord {
  attn: number
  transcriptSize: number
  exitCode?: number
  transcriptPath?: string
  eventTs?: number
  event?: string
  tool?: string
  notificationType?: string
  permissionMode?: string
  message?: string
}

interface Meta {
  cwd?: string
  projectId?: string
  folderId?: string
  createdAt?: number
  prompt?: string
  sessionId?: string
  command?: string
}

/** One `J` line: a Claude Code background session (~/.claude/jobs/<id>/state.json). */
export interface BgRecord {
  alive: boolean
  state: string
  tempo: string
  updatedAt: number
  createdAt: number
  tokens?: number
  sessionId?: string
  cwd: string
  worktree?: string
  transcriptPath?: string
  name?: string
  detail?: string
  needs?: string
  lastReply?: string
  /** the `--model` it was started with */
  modelFlag?: string
  questions?: PendingQuestion[]
  /** Claude Code's record of the work it has pending (background tasks, monitors, scheduled check-ins) */
  inFlight?: InFlight
}

export interface InFlight {
  tasks: number
  queued: number
  kinds: string[]
  drainableMonitors?: number
  /** the next scheduled check-in (`at` in ms or s since the epoch) */
  wake?: { at?: number; reason?: string }
}

export interface WatchFrame {
  now: number
  panes: Map<string, PaneRecord>
  agents: Map<string, AgentRecord>
  metas: Map<string, Meta>
  bg: Map<string, BgRecord>
  /** transcript path → size in bytes (for background sessions) */
  sizes: Map<string, number>
  /** transcript path → tokens in context, the most seen and the model (for background sessions) */
  contexts: Map<string, { tokens: number; peak: number; model?: string }>
  /** transcript path → the tool call the session is in the middle of */
  tools: Map<string, { tool: string; summary?: string }>
  /** plan usage last written by an agent's status line on this host */
  usage?: { ts: number; fiveHour?: UsageWindow; sevenDay?: UsageWindow }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function usageWindow(w: any): UsageWindow | undefined {
  if (!w || typeof w !== 'object') return undefined
  const pct = Number(w.used_percentage ?? w.utilization)
  if (!Number.isFinite(pct)) return undefined
  let resetsAt: number | undefined
  if (typeof w.resets_at === 'number') resetsAt = w.resets_at
  else if (typeof w.resets_at === 'string') {
    const n = Number(w.resets_at)
    resetsAt = Number.isFinite(n) ? n : Math.floor(Date.parse(w.resets_at) / 1000) || undefined
  }
  return { usedPct: pct, resetsAt }
}

const isoSec = (s: string | undefined): number => {
  const t = s ? Date.parse(s) : NaN
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0
}

/** `block` from a background session's state: the AskUserQuestion questions. */
export function parseQuestions(json: string): PendingQuestion[] | undefined {
  try {
    const b = JSON.parse(json)
    const qs = Array.isArray(b?.questions) ? b.questions : []
    const out = qs
      .filter((q: any) => q && typeof q.question === 'string')
      .map((q: any) => ({
        question: q.question,
        options: Array.isArray(q.options) ? q.options.map((o: any) => String(o?.label ?? o)).filter(Boolean) : []
      }))
    return out.length ? out : undefined
  } catch {
    return undefined
  }
}

/** Parse Claude Code's `rate_limits` object (five_hour / seven_day windows). */
export function parseRateLimits(json: string): { fiveHour?: UsageWindow; sevenDay?: UsageWindow } | undefined {
  try {
    const r = JSON.parse(json)
    const out = { fiveHour: usageWindow(r?.five_hour), sevenDay: usageWindow(r?.seven_day) }
    return out.fiveHour || out.sevenDay ? out : undefined
  } catch {
    return undefined
  }
}

const num = (s: string | undefined): number => {
  const n = Number(s)
  return Number.isFinite(n) ? n : 0
}

/** Parse the lines of one frame (everything before the `@@END` marker). */
export function parseFrame(lines: string[], now: number): WatchFrame {
  const frame: WatchFrame = { now, panes: new Map(), agents: new Map(), metas: new Map(), bg: new Map(), sizes: new Map(), contexts: new Map(), tools: new Map() }
  for (const line of lines) {
    const f = line.split('\t')
    switch (f[0]) {
      case 'P': {
        // P busy session dead activity created attached command in_mode title...
        const id = (f[2] ?? '').replace(/^kuna_/, '')
        if (!id) break
        frame.panes.set(id, {
          busy: num(f[1]) === 1,
          asking: num(f[1]) === 2,
          dead: f[3] === '1',
          activity: num(f[4]),
          created: num(f[5]),
          attached: num(f[6]) > 0,
          command: f[7] ?? '',
          inMode: f[8] === '1',
          title: f.slice(9).join('\t')
        })
        break
      }
      case 'A': {
        // A id attn size exit transcript ts event tool ntype pmode message
        const id = f[1]
        if (!id) break
        frame.agents.set(id, {
          attn: num(f[2]),
          transcriptSize: num(f[3]),
          exitCode: f[4] ? num(f[4]) : undefined,
          transcriptPath: f[5] || undefined,
          eventTs: f[6] ? num(f[6]) : undefined,
          event: f[7] || undefined,
          tool: f[8] || undefined,
          notificationType: f[9] || undefined,
          permissionMode: f[10] || undefined,
          message: f.slice(11).join('\t') || undefined
        })
        break
      }
      case 'J': {
        // J id alive state tempo updatedAt createdAt tokens sessionId cwd worktree transcript name detail needs lastReply modelFlag
        const id = f[1]
        if (!id) break
        frame.bg.set(id, {
          alive: f[2] === '1',
          state: f[3] ?? '',
          tempo: f[4] ?? '',
          updatedAt: isoSec(f[5]),
          createdAt: isoSec(f[6]),
          tokens: f[7] ? num(f[7]) : undefined,
          sessionId: f[8] || undefined,
          cwd: f[9] ?? '',
          worktree: f[10] || undefined,
          transcriptPath: f[11] || undefined,
          name: f[12] || undefined,
          detail: f[13] || undefined,
          needs: f[14] || undefined,
          lastReply: f[15] || undefined,
          modelFlag: f[16] || undefined
        })
        break
      }
      case 'Q': {
        const rec = frame.bg.get(f[1])
        if (rec) rec.questions = parseQuestions(f.slice(2).join('\t'))
        break
      }
      case 'F': {
        // F id {inFlight json}
        const rec = frame.bg.get(f[1])
        if (rec) rec.inFlight = parseInFlight(f.slice(2).join('\t'))
        break
      }
      case 'T': {
        // T tool summary path
        const path = f.slice(3).join('\t')
        if (path && f[1]) frame.tools.set(path, { tool: f[1], summary: f[2] && f[2] !== '-' ? f[2] : undefined })
        break
      }
      case 'S': {
        // S size path
        const path = f.slice(2).join('\t')
        if (path) frame.sizes.set(path, num(f[1]))
        break
      }
      case 'C': {
        // C tokens peak model path ("-": model not known yet)
        const path = f.slice(4).join('\t')
        if (path) frame.contexts.set(path, { tokens: num(f[1]), peak: num(f[2]), model: f[3] && f[3] !== '-' ? f[3] : undefined })
        break
      }
      case 'U': {
        // U ts {"five_hour":{...},"seven_day":{...}}
        const limits = parseRateLimits(f.slice(2).join('\t'))
        if (limits) frame.usage = { ts: num(f[1]), ...limits }
        break
      }
      case 'M': {
        const id = f[1]
        if (!id) break
        try {
          frame.metas.set(id, JSON.parse(f.slice(2).join('\t')))
        } catch {
          frame.metas.set(id, {})
        }
        break
      }
    }
  }
  return frame
}

const WORKING_EVENTS = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStop', 'PreCompact'])

export interface StatusInput {
  now: number
  alive: boolean
  dead: boolean
  busy: boolean
  asking?: boolean
  createdAt: number
  activityTs: number
  event?: string
  eventTs?: number
  notificationType?: string
  message?: string
}

/** Combine hook events with what is visible on screen into one status. */
export function deriveStatus(s: StatusInput): AgentStatus {
  if (!s.alive || s.dead) return 'exited'
  if (s.asking) return 'waiting'
  if (s.busy) return 'working'
  switch (s.event) {
    case 'PermissionRequest':
      return 'waiting'
    case 'Notification': {
      const text = `${s.notificationType ?? ''} ${s.message ?? ''}`.toLowerCase()
      return text.includes('idle') || text.includes('waiting for your input') ? 'idle' : 'waiting'
    }
    case 'Stop':
    case 'SessionStart':
    case 'SessionEnd':
      return 'idle'
    case undefined:
      if (s.now - s.createdAt < 8) return 'starting'
      return s.now - s.activityTs <= 3 ? 'working' : 'idle'
    default:
      if (WORKING_EVENTS.has(s.event)) return s.now - (s.eventTs ?? 0) < 6 ? 'working' : 'idle'
      return 'unknown'
  }
}

function parseInFlight(text: string): InFlight | undefined {
  try {
    const o = JSON.parse(text) as Partial<InFlight> | null
    if (!o || typeof o !== 'object') return undefined
    return {
      tasks: Number(o.tasks) || 0,
      queued: Number(o.queued) || 0,
      kinds: Array.isArray(o.kinds) ? o.kinds.map(String) : [],
      drainableMonitors: Number(o.drainableMonitors) || 0,
      wake: o.wake && typeof o.wake === 'object' ? { at: Number(o.wake.at) || undefined, reason: o.wake.reason ? String(o.wake.reason) : undefined } : undefined
    }
  } catch {
    return undefined
  }
}

/** Work of its own pending, as Claude Code counts it: queued prompts, running tasks, a scheduled check-in. */
export function pendingWork(f?: InFlight): boolean {
  return !!f && (f.queued > 0 || f.tasks > 0 || f.kinds.includes('session_cron'))
}

/** What a session waits on between turns. */
export function waitingOn(f: InFlight): Activity {
  if (f.kinds.includes('session_cron')) {
    const at = f.wake?.at
    return { kind: 'scheduled', at: at ? (at > 1e12 ? Math.floor(at / 1000) : at) : undefined, reason: f.wake?.reason }
  }
  if ((f.drainableMonitors ?? 0) > 0) return { kind: 'monitor', count: f.drainableMonitors ?? 1 }
  return { kind: 'jobs', count: Math.max(1, f.tasks + f.queued) }
}

/** A turn that has not been heard from for this long, with no worker process, died with its host. */
const STALE_TURN_S = 30 * 60

/**
 * Status of a Claude Code background session, from its own state.json rather
 * than from the daemon roster: sessions between scheduled check-ins, or
 * attached in a terminal, run without a roster entry.
 */
export function bgStatus(r: BgRecord, now?: number): AgentStatus {
  if (r.tempo === 'blocked') return 'waiting'
  // state lags: it stays "blocked" after the question is answered, until the turn ends
  if (r.tempo === 'active') return r.alive || now === undefined || now - r.updatedAt < STALE_TURN_S ? 'working' : 'exited'
  if (r.state === 'blocked') return 'waiting'
  if (r.state === 'failed') return 'failed'
  if (r.state === 'stopped') return 'exited'
  if (pendingWork(r.inFlight)) return 'background'
  return 'idle'
}

function bgAgents(host: HostId, frame: WatchFrame): AgentRuntime[] {
  const out: AgentRuntime[] = []
  for (const [id, r] of frame.bg) {
    const status = bgStatus(r, frame.now)
    let transcriptPath = r.transcriptPath
    if (!transcriptPath && r.sessionId) {
      transcriptPath = [...frame.sizes.keys()].find((p) => p.endsWith(`/${r.sessionId}.jsonl`))
    }
    const ctx = transcriptPath ? frame.contexts.get(transcriptPath) : undefined
    out.push({
      key: agentKey(host, `cc-${id}`),
      id: `cc-${id}`,
      kind: 'claude',
      host,
      cwd: r.cwd,
      createdAt: r.createdAt || r.updatedAt,
      sessionId: r.sessionId,
      status,
      attnTs: status === 'working' ? 0 : r.updatedAt,
      activityTs: r.updatedAt,
      attached: false,
      // running, or carrying on by itself (between check-ins, or attached in a terminal)
      alive: r.alive || status === 'working' || status === 'background' || status === 'waiting',
      transcriptPath,
      transcriptSize: transcriptPath ? (frame.sizes.get(transcriptPath) ?? 0) : 0,
      name: r.name,
      detail: r.detail,
      needs: status === 'waiting' ? r.needs : undefined,
      questions: status === 'waiting' ? r.questions : undefined,
      lastReply: r.lastReply,
      tokens: r.tokens,
      contextTokens: ctx?.tokens,
      contextPeak: ctx?.peak,
      model: ctx?.model,
      modelFlag: r.modelFlag,
      worktree: r.worktree,
      activity: activityOf(status, transcriptPath ? frame.tools.get(transcriptPath) : undefined, r.inFlight),
      message: status === 'waiting' ? r.needs : undefined
    })
  }
  return out
}

function activityOf(status: AgentStatus, tool?: { tool: string; summary?: string }, f?: InFlight): Activity | undefined {
  if (status === 'working' && tool) return { kind: 'tool', tool: tool.tool, summary: tool.summary }
  if (status === 'background' && f) return waitingOn(f)
  return undefined
}

/** Turn a parsed frame into the runtime records the UI renders. */
export function frameToAgents(host: HostId, frame: WatchFrame): AgentRuntime[] {
  const ids = new Set([...frame.panes.keys(), ...frame.agents.keys()])
  const out: AgentRuntime[] = []
  for (const id of ids) {
    const pane = frame.panes.get(id)
    const rec = frame.agents.get(id)
    const meta = frame.metas.get(id) ?? {}
    const createdAt = meta.createdAt ?? pane?.created ?? frame.now
    const activityTs = pane?.activity ?? createdAt
    const status = deriveStatus({
      now: frame.now,
      alive: !!pane,
      dead: pane?.dead ?? false,
      busy: pane?.busy ?? false,
      asking: pane?.asking ?? false,
      createdAt,
      activityTs,
      event: rec?.event,
      eventTs: rec?.eventTs,
      notificationType: rec?.notificationType,
      message: rec?.message
    })
    out.push({
      key: agentKey(host, id),
      id,
      kind: 'tmux',
      host,
      cwd: meta.cwd ?? '',
      projectId: meta.projectId,
      folderId: meta.folderId,
      createdAt,
      prompt: meta.prompt,
      sessionId: meta.sessionId,
      command: meta.command,
      status,
      tool: status === 'working' && rec?.event === 'PreToolUse' ? rec.tool : undefined,
      activity: status === 'working' && rec?.event === 'PreToolUse' && rec.tool ? { kind: 'tool', tool: rec.tool } : undefined,
      lastEvent: rec?.event,
      lastEventTs: rec?.eventTs,
      attnTs: rec?.attn ?? 0,
      activityTs,
      attached: pane?.attached ?? false,
      inCopyMode: pane?.inMode ?? false,
      alive: !!pane && !pane.dead,
      exitCode: rec?.exitCode,
      paneTitle: pane?.title,
      permissionMode: rec?.permissionMode,
      message: rec?.message,
      transcriptPath: rec?.transcriptPath,
      transcriptSize: rec?.transcriptSize ?? 0
    })
  }
  return [...out, ...bgAgents(host, frame)].sort((a, b) => a.createdAt - b.createdAt)
}

/** Agents with the host's timestamps turned into this machine's: `off` is the host's clock minus ours, in seconds. */
export function onLocalClock(agents: AgentRuntime[], off: number): AgentRuntime[] {
  return agents.map((a) => ({
    ...a,
    createdAt: a.createdAt - off,
    attnTs: a.attnTs ? a.attnTs - off : 0,
    activityTs: a.activityTs - off,
    lastEventTs: a.lastEventTs ? a.lastEventTs - off : undefined
  }))
}

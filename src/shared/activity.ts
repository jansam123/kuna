import type { Activity, AgentDetails, AgentRuntime, AgentStatus } from './types'

/**
 * What an agent is busy with, in a few words for the sidebar: the tool call
 * of a running turn ("running python train.py", "editing fit.py"), or what it
 * waits on between turns ("next check 10:40", "watching a job").
 */

const TOOL_VERB: Record<string, string> = {
  Bash: 'running',
  BashOutput: 'checking',
  Edit: 'editing',
  MultiEdit: 'editing',
  Write: 'writing',
  NotebookEdit: 'editing',
  Read: 'reading',
  Grep: 'searching',
  Glob: 'searching',
  WebFetch: 'reading',
  WebSearch: 'searching the web',
  Task: 'running a subagent',
  Agent: 'running a subagent',
  TodoWrite: 'planning',
  TaskCreate: 'planning',
  TaskUpdate: 'planning',
  Monitor: 'watching',
  ScheduleWakeup: 'scheduling',
  AskUserQuestion: 'asking'
}

/** Tools whose summary is a path: show only the file name. */
const ON_FILE = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Read'])

function clock(at: number, now: number): string {
  const d = new Date(at * 1000)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (at - now < 20 * 3600) return hm
  return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${hm}`
}

/** A word or two, for the narrow sidebar column ("running", "next 11:25", "2 jobs"). */
export function shortActivity(a: Activity, now = Date.now() / 1000): string {
  switch (a.kind) {
    case 'tool':
      return a.tool === 'Task' || a.tool === 'Agent' ? 'subagent' : (TOOL_VERB[a.tool]?.split(' ')[0] ?? a.tool)
    case 'scheduled':
      return a.at ? `next ${clock(a.at, now)}` : 'scheduled'
    case 'monitor':
      return 'watching'
    case 'jobs':
      return a.count > 1 ? `${a.count} jobs` : '1 job'
  }
}

export function describeActivity(a: Activity, now = Date.now() / 1000): string {
  switch (a.kind) {
    case 'tool': {
      const verb = TOOL_VERB[a.tool] ?? a.tool
      if (!a.summary || a.tool === 'Task' || a.tool === 'Agent') return verb
      const what = ON_FILE.has(a.tool) ? a.summary.split('/').pop() : a.summary
      return `${verb} ${what}`
    }
    case 'scheduled':
      return a.at ? `next check ${clock(a.at, now)}` : 'waiting for its next check'
    case 'monitor':
      return a.count > 1 ? `watching ${a.count} jobs` : 'watching a job'
    case 'jobs':
      return a.count > 1 ? `${a.count} jobs running` : 'a job running'
  }
}

export const STATUS_LABEL: Record<AgentStatus, string> = {
  starting: 'starting',
  working: 'working',
  background: 'waiting on a job',
  waiting: 'needs you',
  idle: 'idle',
  failed: 'failed',
  exited: 'exited',
  unknown: '—'
}

/**
 * What it is doing, in a few words ("running python train.py", "next check
 * 10:40"), else its status; `short`: a word or two for the sidebar.
 */
export function doingText(a: AgentRuntime, short = false): string {
  if (a.activity) return short ? shortActivity(a.activity) : describeActivity(a.activity)
  if (a.status === 'working' && a.tool) return a.tool
  if (a.status === 'exited' && a.kind === 'claude') return 'stopped'
  return STATUS_LABEL[a.status]
}

/** What the agent is waiting on, in one line ("approve Bash: …", a question). */
export function needsText(a: AgentRuntime, d?: AgentDetails): string | undefined {
  if (a.status !== 'waiting') return undefined
  const q = a.questions?.[0] ?? d?.pendingQuestions?.[0]
  if (q) return q.question
  if (a.needs) return a.needs.replace(/^answer:\s*/, '')
  const pending = d?.recentTools.filter((t) => !t.done).at(-1)
  if (pending) return `approve ${pending.name}${pending.summary ? `: ${pending.summary}` : ''}`
  return a.message || 'waiting for you'
}

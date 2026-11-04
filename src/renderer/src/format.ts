import { describeActivity, shortActivity } from '@shared/activity'
import { contextInfo, modelFlag, type ContextInfo } from '@shared/context'
import type { AgentDetails, AgentRuntime, AgentStatus } from '@shared/types'
import { get } from './store'

export function tokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`
}

export function ago(epochSec: number): string {
  if (!epochSec) return ''
  const d = Math.max(0, Math.floor(Date.now() / 1000 - epochSec))
  if (d < 60) return `${d}s`
  if (d < 3600) return `${Math.floor(d / 60)}m`
  if (d < 86400) return `${Math.floor(d / 3600)}h`
  return `${Math.floor(d / 86400)}d`
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 ** 2).toFixed(1)} MB`
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

/**
 * How full the agent's context is. Background sessions: the host's reading of
 * the transcript end (fresh for every session, open or not); Kuna agents: the
 * transcript Kuna follows.
 */
export function contextOf(a: AgentRuntime, d?: AgentDetails): ContextInfo {
  const tokens = a.contextTokens ?? d?.contextTokens ?? 0
  return contextInfo(tokens, a.model ?? d?.model, Math.max(a.contextPeak ?? 0, d?.contextPeak ?? 0), a.modelFlag ?? modelFlag(a.command))
}

export const MODE_LABEL: Record<string, string> = {
  default: 'ask',
  acceptEdits: 'accept edits',
  plan: 'plan',
  bypassPermissions: 'bypass',
  auto: 'auto',
  dontAsk: "don't ask"
}

export function modeLabel(mode?: string): string | undefined {
  if (!mode) return undefined
  return MODE_LABEL[mode] ?? mode
}

/** Best human title: Claude's session title, then the prompt, then the pane title. */
export function agentTitle(a: AgentRuntime, d?: AgentDetails): string {
  const paneTitle = a.paneTitle?.replace(/^[^\p{L}\p{N}]+/u, '').trim()
  return (
    get().names[a.key] ||
    (a.kind === 'claude' ? a.name : '') ||
    d?.title ||
    a.name ||
    (a.prompt ? a.prompt.split('\n')[0] : '') ||
    (paneTitle && paneTitle !== a.id && !/^(claude|bash|zsh|sh)$/i.test(paneTitle) ? paneTitle : '') ||
    `agent ${a.id}`
  )
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

/** The open question's choices, if the agent asked one. */
export function needsOptions(a: AgentRuntime, d?: AgentDetails): string[] {
  if (a.status !== 'waiting') return []
  return (a.questions?.[0] ?? d?.pendingQuestions?.[0])?.options ?? []
}

/** `/very/long/path/to/repo` → `…/to/repo` */
export function shortPath(path: string, keep = 2): string {
  const parts = path.split('/').filter(Boolean)
  if (parts.length <= keep) return path
  return `…/${parts.slice(-keep).join('/')}`
}

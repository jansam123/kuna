import { extractMediaPaths, mediaKind } from './media'
import type { AgentDetails, SubagentInfo, TodoItem, ToolCallInfo } from './types'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any

const MAX_TOOLS = 40
const MAX_FILES = 60
const MAX_MEDIA = 300

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const AGENT_TOOLS = new Set(['Task', 'Agent'])

function str(v: unknown, max = 120): string {
  if (typeof v !== 'string') return ''
  const one = v.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

function toolSummary(name: string, input: Json): string {
  if (!input || typeof input !== 'object') return ''
  switch (name) {
    case 'Bash':
      return str(input.description) || str(input.command)
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return str(input.file_path ?? input.notebook_path)
    case 'Grep':
    case 'Glob':
      return str(input.pattern)
    case 'WebFetch':
      return str(input.url)
    case 'WebSearch':
      return str(input.query)
    case 'Task':
    case 'Agent':
      return str(input.description)
    default: {
      const first = Object.values(input).find((v) => typeof v === 'string')
      return str(first)
    }
  }
}

function resultText(content: Json): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && c.type === 'text' && typeof c.text === 'string' ? c.text : ''))
      .join('\n')
  }
  return ''
}

function stringsIn(v: Json, out: string[], depth = 0): void {
  if (depth > 4 || out.length > 50) return
  if (typeof v === 'string') out.push(v.length > 20_000 ? v.slice(0, 20_000) : v)
  else if (Array.isArray(v)) for (const x of v) stringsIn(x, out, depth + 1)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) stringsIn(x, out, depth + 1)
}

export function emptyDetails(): AgentDetails {
  return {
    contextTokens: 0,
    contextPeak: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    turns: 0,
    todos: [],
    subagents: [],
    recentTools: [],
    filesTouched: [],
    mediaRefs: [],
    pendingQuestions: []
  }
}

/**
 * Incremental parser for Claude Code transcripts (`~/.claude/projects/…/<session>.jsonl`).
 * Feed it raw chunks as the file grows; it keeps only the summary state.
 */
export class TranscriptParser {
  private carry = ''
  private d: AgentDetails = emptyDetails()
  private usageById = new Map<string, { in: number; out: number; cache: number }>()
  private pendingTasks = new Map<string, TodoItem>()
  private tasks = new Map<string, TodoItem>()
  private taskMode: 'todo' | 'task' = 'todo'
  private tools = new Map<string, ToolCallInfo>()
  private subagents = new Map<string, SubagentInfo>()
  /** path → the reply (turn) that mentioned it last */
  private media = new Map<string, number>()
  private questions = new Map<string, { question: string; options: string[] }[]>()
  private files: string[] = []

  /** Feed raw text. If `fromMiddle`, the first partial line is discarded. */
  feed(chunk: string, fromMiddle = false): void {
    let text = this.carry + chunk
    if (fromMiddle) {
      const nl = text.indexOf('\n')
      text = nl >= 0 ? text.slice(nl + 1) : ''
    }
    const lines = text.split('\n')
    this.carry = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let entry: Json
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      this.entry(entry)
    }
  }

  details(): AgentDetails {
    let input = 0
    let out = 0
    let cache = 0
    for (const u of this.usageById.values()) {
      input += u.in
      out += u.out
      cache += u.cache
    }
    const todos = this.taskMode === 'task' ? [...this.tasks.values()] : this.d.todos
    const tools = [...this.tools.values()].slice(-MAX_TOOLS)
    const subs = [...this.subagents.values()]
    return {
      ...this.d,
      inputTokens: input,
      outputTokens: out,
      cacheReadTokens: cache,
      todos,
      recentTools: tools,
      subagents: subs.slice(-12),
      filesTouched: this.files.slice(-MAX_FILES),
      mediaRefs: [...this.media].slice(-MAX_MEDIA).map(([path, turn]) => ({ path, turn })),
      pendingQuestions: [...this.questions.values()].flat()
    }
  }

  /** `pages`: HTML files count too (from replies and pages the agent wrote; not every index.html it read or edited) */
  private addMedia(text: string, pages = false): void {
    for (const p of extractMediaPaths(text)) {
      if (!pages && mediaKind(p) === 'html') continue
      this.media.delete(p)
      this.media.set(p, this.d.turns)
    }
  }

  private entry(e: Json): void {
    if (!e || typeof e !== 'object') return
    if (e.sessionId) this.d.sessionId = e.sessionId
    if (e.version) this.d.version = e.version
    if (e.gitBranch) this.d.gitBranch = e.gitBranch
    if (e.timestamp) this.d.updatedAt = e.timestamp

    switch (e.type) {
      case 'ai-title':
        if (e.aiTitle) this.d.title = e.aiTitle
        return
      case 'custom-title':
        if (e.customTitle) this.d.title = e.customTitle
        return
      case 'summary':
        if (e.summary && !this.d.title) this.d.title = e.summary
        return
      case 'permission-mode':
        if (e.permissionMode) this.d.permissionMode = e.permissionMode
        return
      case 'system':
        // after /compact (or an auto-compaction) the context starts over from the summary
        if (e.subtype === 'compact_boundary') {
          const m = e.compactMetadata ?? {}
          this.d.contextPeak = Math.max(this.d.contextPeak, m.preTokens ?? 0)
          this.d.contextTokens = m.postTokens ?? 0
        }
        return
      case 'assistant':
        if (!e.isSidechain) this.assistant(e)
        return
      case 'user':
        if (!e.isSidechain) this.user(e)
        return
    }
  }

  private assistant(e: Json): void {
    const m = e.message
    if (!m) return
    if (m.model && m.model !== '<synthetic>') this.d.model = m.model
    const u = m.usage
    if (u) {
      const ctx = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
      if (ctx > 0) {
        this.d.contextTokens = ctx
        this.d.contextPeak = Math.max(this.d.contextPeak, ctx)
      }
      const id = m.id ?? e.uuid
      this.usageById.set(id, {
        in: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        out: u.output_tokens ?? 0,
        cache: u.cache_read_input_tokens ?? 0
      })
    }
    if (!Array.isArray(m.content)) return
    for (const c of m.content) {
      if (!c) continue
      if (c.type === 'text' && typeof c.text === 'string') {
        if (c.text.trim()) this.d.lastText = c.text.slice(-2000)
        this.addMedia(c.text, true)
      } else if (c.type === 'tool_use') {
        this.toolUse(c, e.timestamp)
      }
    }
  }

  private toolUse(c: Json, at?: string): void {
    const name: string = c.name ?? 'tool'
    const input = c.input ?? {}
    this.tools.delete(c.id)
    this.tools.set(c.id, { id: c.id, name, summary: toolSummary(name, input), at, done: false })
    if (this.tools.size > MAX_TOOLS * 2) {
      const first = this.tools.keys().next().value
      if (first) this.tools.delete(first)
    }

    const strings: string[] = []
    stringsIn(input, strings)
    for (const s of strings) this.addMedia(s)
    if ((name === 'Write' || name === 'Artifact') && typeof input.file_path === 'string') this.addMedia(input.file_path, true)

    if (FILE_TOOLS.has(name) && typeof input.file_path === 'string') {
      this.files = this.files.filter((f) => f !== input.file_path)
      this.files.push(input.file_path)
    }

    if (name === 'TodoWrite' && Array.isArray(input.todos)) {
      this.taskMode = 'todo'
      this.d.todos = input.todos.map((t: Json, i: number) => ({
        id: String(t.id ?? i),
        content: String(t.content ?? ''),
        status: String(t.status ?? 'pending'),
        activeForm: t.activeForm
      }))
    } else if (name === 'TaskCreate') {
      this.taskMode = 'task'
      const item: TodoItem = {
        id: c.id,
        content: String(input.subject ?? input.description ?? ''),
        status: 'pending',
        activeForm: input.activeForm
      }
      this.pendingTasks.set(c.id, item)
      this.tasks.set(c.id, item)
    } else if (name === 'TaskUpdate') {
      this.taskMode = 'task'
      const id = String(input.taskId ?? input.id ?? '')
      const t = this.tasks.get(id)
      if (t) {
        if (input.status === 'deleted') this.tasks.delete(id)
        else {
          if (input.status) t.status = input.status
          if (input.subject) t.content = input.subject
          if (input.activeForm) t.activeForm = input.activeForm
        }
      }
    } else if (name === 'AskUserQuestion' && Array.isArray(input.questions)) {
      this.questions.set(
        c.id,
        input.questions
          .filter((q: Json) => q && typeof q.question === 'string')
          .map((q: Json) => ({
            question: q.question,
            options: Array.isArray(q.options) ? q.options.map((o: Json) => String(o?.label ?? o)) : []
          }))
      )
    } else if (AGENT_TOOLS.has(name)) {
      this.subagents.set(c.id, {
        id: c.id,
        description: str(input.description, 80) || str(input.prompt, 80),
        type: input.subagent_type,
        startedAt: at,
        done: false
      })
    }
  }

  private user(e: Json): void {
    const m = e.message
    if (!m) return
    if (typeof m.content === 'string') {
      if (!e.isMeta && !m.content.startsWith('<')) {
        this.d.lastPrompt = m.content.slice(0, 500)
        this.d.turns++
      }
      return
    }
    if (!Array.isArray(m.content)) return
    for (const c of m.content) {
      if (!c) continue
      if (c.type === 'text' && typeof c.text === 'string' && !e.isMeta && !c.text.startsWith('<')) {
        this.d.lastPrompt = c.text.slice(0, 500)
        this.d.turns++
      } else if (c.type === 'tool_result') {
        const text = resultText(c.content)
        this.questions.delete(c.tool_use_id)
        const tool = this.tools.get(c.tool_use_id)
        if (tool) {
          tool.done = true
          tool.error = !!c.is_error
        }
        const pending = this.pendingTasks.get(c.tool_use_id)
        if (pending) {
          this.pendingTasks.delete(c.tool_use_id)
          const m2 = /#?(\d+)/.exec(text)
          if (m2) {
            this.tasks.delete(c.tool_use_id)
            pending.id = m2[1]
            this.tasks.set(m2[1], pending)
          }
        }
        const sub = this.subagents.get(c.tool_use_id)
        if (sub) sub.done = !/running in the background|launched in the background|async agent/i.test(text)
        // command output often announces saved plots ("Saved figure to out/mass.pdf")
        if (tool?.name === 'Bash') this.addMedia(text.slice(0, 50_000))
      }
    }
  }
}

import { TranscriptParser, resultText, toolSummary } from './transcript'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any

/**
 * One row of an agent's conversation as the iPhone app shows it: what you
 * wrote, what it answered, its thinking (shown folded), each tool call as one
 * line, a question it asks, and notes such as a compaction.
 */
export interface ChatItem {
  id: string
  /** `limit`, `error`: what Claude Code says in the agent's place (a usage limit reached; a request that failed) */
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'tools' | 'question' | 'note' | 'limit' | 'error'
  text: string
  /** tool: its name */
  tool?: string
  /** tool: still running, finished, or failed; tools: running if one is, else failed if one did */
  state?: 'running' | 'done' | 'error'
  /** tools: the calls folded into this row (and the thinking between them), oldest first */
  items?: ChatItem[]
  /** question: the choices offered */
  options?: string[]
  /** epoch seconds */
  at?: number
}

/** Claude Code's words for a run of calls of one kind: running, ran, and the thing counted. */
const KINDS: [RegExp, string, string, string, string][] = [
  [/^Bash$/, 'running', 'ran', 'shell command', 'shell commands'],
  [/^Read$/, 'reading', 'read', 'file', 'files'],
  [/^(Grep|Glob)$/, 'searching for', 'searched for', 'pattern', 'patterns'],
  [/^(Edit|Write|MultiEdit|NotebookEdit)$/, 'editing', 'edited', 'file', 'files'],
  [/^(Task|Agent)$/, 'running', 'ran', 'agent', 'agents']
]

/** `Ran 3 shell commands, read 2 files · 1 failed`, as Claude Code's terminal sums up a run of calls. */
export function toolsSummary(tools: ChatItem[]): string {
  const running = tools.some((t) => t.state === 'running')
  const parts = new Map<string, { words: string[]; n: number }>()
  for (const t of tools) {
    const name = t.tool ?? 'tool'
    const kind = KINDS.find(([re]) => re.test(name))
    // another tool is named, as Claude Code names an MCP server: `called WebFetch 2 times`
    const key = kind ? kind[2] + kind[3] : name
    const words = kind ? [kind[1], kind[2], kind[3], kind[4]] : ['calling', 'called', name, name]
    const part = parts.get(key) ?? { words, n: 0 }
    part.n++
    parts.set(key, part)
  }
  const said = [...parts.values()].map(({ words: [now, done, one, many], n }) =>
    one === many ? `${running ? now : done} ${one}${n > 1 ? ` ${n} times` : ''}` : `${running ? now : done} ${n} ${n === 1 ? one : many}`
  )
  const text = said.join(', ')
  const failed = tools.filter((t) => t.state === 'error').length
  return `${text[0].toUpperCase()}${text.slice(1)}${running ? '…' : ''}${failed ? ` · ${failed} failed` : ''}`
}

/**
 * Runs of two or more tool calls in a row as one `tools` row, as Claude Code's terminal folds
 * them: thinking between the calls goes in with them, anything else ends the run.
 */
export function foldTools(items: ChatItem[]): ChatItem[] {
  const out: ChatItem[] = []
  for (let i = 0; i < items.length; ) {
    let end = i
    for (let j = i; j < items.length && (items[j].kind === 'tool' || (items[j].kind === 'thinking' && j > i)); j++) {
      if (items[j].kind === 'tool') end = j + 1
    }
    const run = items.slice(i, end)
    const tools = run.filter((t) => t.kind === 'tool')
    if (tools.length < 2) {
      out.push(items[i++])
      continue
    }
    const state = tools.some((t) => t.state === 'running') ? 'running' : tools.some((t) => t.state === 'error') ? 'error' : 'done'
    // the first call's id: the row stays itself (and unfolded) as calls join it
    out.push({ id: `${run[0].id}:tools`, kind: 'tools', text: toolsSummary(tools), state, items: run.map((t) => ({ ...t })), at: run[run.length - 1].at })
    i = end
  }
  return out
}

const KEEP = 600
const MAX_TEXT = 60_000

const clip = (s: string): string => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n…` : s)

/** `<command-name>/compact</command-name><command-args>…</command-args>` → `/compact …` */
function slashCommand(text: string): string | undefined {
  const name = /<command-name>\s*(\/[^<\s]+)\s*<\/command-name>/.exec(text)?.[1]
  if (!name) return undefined
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim()
  return args ? `${name} ${args}` : name
}

/**
 * A Claude Code transcript as a conversation, fed as the file grows. It is a
 * `TranscriptParser` too, so one pass gives the chat and the details.
 */
export class ChatLog extends TranscriptParser {
  private rows = new Map<string, ChatItem>()

  /** the newest `max` rows, oldest first */
  items(max = 200): ChatItem[] {
    const all = [...this.rows.values()]
    return all.length > max ? all.slice(-max) : all
  }

  private put(item: ChatItem): void {
    this.rows.delete(item.id)
    this.rows.set(item.id, item)
    if (this.rows.size > KEEP) {
      const first = this.rows.keys().next().value
      if (first !== undefined) this.rows.delete(first)
    }
  }

  protected override entry(e: Json): void {
    super.entry(e)
    if (!e || typeof e !== 'object' || e.isSidechain) return
    const at = typeof e.timestamp === 'string' ? Math.floor(Date.parse(e.timestamp) / 1000) || undefined : undefined
    const id = String(e.uuid ?? `${e.type}-${this.rows.size}`)
    if (e.type === 'system' && e.subtype === 'compact_boundary') {
      this.put({ id, kind: 'note', text: 'The conversation was compacted here.', at })
    } else if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
      const said = e.isApiErrorMessage ? (e.error === 'rate_limit' ? 'limit' : 'error') : 'assistant'
      e.message.content.forEach((c: Json, i: number) => this.fromAssistant(c, `${id}:${i}`, at, said))
    } else if (e.type === 'user' && !e.isCompactSummary) {
      const content = e.message?.content
      if (typeof content === 'string') this.fromUser(content, id, at, !!e.isMeta)
      else if (Array.isArray(content)) content.forEach((c: Json, i: number) => this.fromUserBlock(c, `${id}:${i}`, at, !!e.isMeta))
    }
  }

  private fromAssistant(c: Json, id: string, at: number | undefined, said: 'assistant' | 'limit' | 'error'): void {
    if (!c) return
    if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
      this.put({ id, kind: said, text: clip(c.text.trim()), at })
    } else if (c.type === 'thinking' && typeof c.thinking === 'string' && c.thinking.trim()) {
      this.put({ id, kind: 'thinking', text: clip(c.thinking.trim()), at })
    } else if (c.type === 'tool_use') {
      const name = String(c.name ?? 'tool')
      const input = c.input ?? {}
      const tid = String(c.id ?? id)
      if (name === 'AskUserQuestion' && Array.isArray(input.questions)) {
        input.questions.forEach((q: Json, i: number) => {
          if (typeof q?.question !== 'string') return
          this.put({
            id: `${tid}:q${i}`,
            kind: 'question',
            text: q.question,
            options: Array.isArray(q.options) ? q.options.map((o: Json) => String(o?.label ?? o)) : [],
            state: 'running',
            at
          })
        })
      } else if (name === 'ExitPlanMode' && typeof input.plan === 'string' && input.plan.trim()) {
        this.put({ id: tid, kind: 'question', text: clip(input.plan.trim()), options: [], tool: 'Plan', state: 'running', at })
      } else {
        this.put({ id: tid, kind: 'tool', tool: name, text: toolSummary(name, input), state: 'running', at })
      }
    }
  }

  private fromUser(text: string, id: string, at: number | undefined, meta: boolean): void {
    const command = slashCommand(text)
    if (command) return this.put({ id, kind: 'user', text: command, at })
    if (meta || !text.trim() || text.trimStart().startsWith('<')) return
    this.put({ id, kind: 'user', text: clip(text.trim()), at })
  }

  private fromUserBlock(c: Json, id: string, at: number | undefined, meta: boolean): void {
    if (!c) return
    if (c.type === 'text' && typeof c.text === 'string') this.fromUser(c.text, id, at, meta)
    else if (c.type === 'image' && !meta) this.put({ id, kind: 'user', text: '[picture]', at })
    else if (c.type === 'tool_result') {
      const tid = String(c.tool_use_id)
      const state = c.is_error ? 'error' : 'done'
      const tool = this.rows.get(tid)
      if (tool) tool.state = state
      // a question's rows: its answer closes them, and each shows what was answered
      // (Claude Code writes `The user answered: "Which size?"="Large", "Which toppings?"="Cheese, Olives". …`)
      const answers = c.is_error ? '' : resultText(c.content)
      for (let i = 0; ; i++) {
        const q = this.rows.get(`${tid}:q${i}`)
        if (!q) break
        q.state = state
        const at = answers.indexOf(`"${q.text}"="`)
        const answer = at < 0 ? null : /^([\s\S]*?)"(?=,\s"|\.\s|\.?$)/.exec(answers.slice(at + q.text.length + 4))
        if (answer) q.options = [answer[1]]
      }
      if (tool?.kind === 'question' && !c.is_error) {
        const said = resultText(c.content).trim()
        if (said) tool.options = [said.split('\n')[0].slice(0, 200)]
      }
    }
  }
}

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
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'question' | 'note'
  text: string
  /** tool: its name */
  tool?: string
  /** tool: still running, finished, or failed */
  state?: 'running' | 'done' | 'error'
  /** question: the choices offered */
  options?: string[]
  /** epoch seconds */
  at?: number
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
      e.message.content.forEach((c: Json, i: number) => this.fromAssistant(c, `${id}:${i}`, at))
    } else if (e.type === 'user' && !e.isCompactSummary) {
      const content = e.message?.content
      if (typeof content === 'string') this.fromUser(content, id, at, !!e.isMeta)
      else if (Array.isArray(content)) content.forEach((c: Json, i: number) => this.fromUserBlock(c, `${id}:${i}`, at, !!e.isMeta))
    }
  }

  private fromAssistant(c: Json, id: string, at?: number): void {
    if (!c) return
    if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
      this.put({ id, kind: 'assistant', text: clip(c.text.trim()), at })
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
      // a question's rows: its answer closes them
      for (let i = 0; ; i++) {
        const q = this.rows.get(`${tid}:q${i}`)
        if (!q) break
        q.state = state
      }
      if (tool?.kind === 'question' && !c.is_error) {
        const said = resultText(c.content).trim()
        if (said) tool.options = [said.split('\n')[0].slice(0, 200)]
      }
    }
  }
}

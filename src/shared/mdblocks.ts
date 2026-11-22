import { Marked, type Token, type TokenizerAndRendererExtension, type Tokens } from 'marked'
import { texToText } from './tex'

/**
 * LaTeX in Markdown: $…$ and \(…\) inline, $$…$$ and \[…\] displayed. Only
 * the reading; each caller adds its own `renderer` (KaTeX on the Mac and in
 * the phone's web views).
 */
export const MATH_BLOCK = {
  name: 'mathBlock',
  level: 'block',
  start: (src: string) => /^ {0,3}(?:\$\$|\\\[)/m.exec(src)?.index,
  tokenizer(src: string) {
    const m = /^ {0,3}(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n+|$)/.exec(src)
    if (m) return { type: 'mathBlock', raw: m[0], text: (m[1] ?? m[2]).trim() }
    return undefined
  }
} satisfies Partial<TokenizerAndRendererExtension>

export const MATH_INLINE = {
  name: 'mathInline',
  level: 'inline',
  start: (src: string) => /\$|\\\(/.exec(src)?.index,
  tokenizer(src: string) {
    // $$…$$ inside a sentence, then $…$ (no space just inside the dollars, no digit after: "$5 and $10" stays text), then \(…\)
    const m = /^\$\$([^$]+?)\$\$/.exec(src) ?? /^\$(?!\s)((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\d)/.exec(src) ?? /^\\\(([\s\S]+?)\\\)/.exec(src)
    if (m) return { type: 'mathInline', raw: m[0], text: m[1], display: m[0].startsWith('$$') }
    return undefined
  }
} satisfies Partial<TokenizerAndRendererExtension>

/** A run of text in one style: bold, italic, code, struck, math (already as Unicode text), a link. */
export interface MdSpan {
  t: string
  b?: true
  i?: true
  c?: true
  s?: true
  m?: true
  href?: string
}

/**
 * One block of a reply, for an app that draws Markdown with its own views
 * (the phone's conversation). The blocks come flat, in reading order: a list
 * or a quote is its blocks, each saying how deep it is.
 */
export interface MdBlock {
  kind: 'p' | 'h' | 'code' | 'rule' | 'table' | 'math'
  /** list levels it is inside */
  depth: number
  /** quotes it is inside */
  quote: number
  /** the first block of a list item: `•`, `3.`, `☐`, `☑` */
  mark?: string
  spans?: MdSpan[]
  /** a heading's level, 1–6 */
  level?: number
  /** code as written; displayed math as Unicode text */
  text?: string
  lang?: string
  /** a table: its columns' `left`, `right`, `center` or null, its header's cells, its rows' */
  align?: (string | null)[]
  head?: MdSpan[][]
  rows?: MdSpan[][][]
}

const md = new Marked({ extensions: [MATH_BLOCK, MATH_INLINE] as TokenizerAndRendererExtension[] })

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' }
/** text as a browser would show it: a line break inside a paragraph is a space, the common entities are their characters */
const plain = (s: string): string => s.replace(/\n/g, ' ').replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (_, n: string) => ENTITIES[n])

type Style = Omit<MdSpan, 't'>

function spans(tokens: Token[] | undefined, style: Style, out: MdSpan[] = []): MdSpan[] {
  const add = (t: string, more: Style = {}): void => {
    if (!t) return
    const s = { ...style, ...more }
    const last = out[out.length - 1]
    // one run per style, not per token
    if (last && JSON.stringify({ ...last, t: '' }) === JSON.stringify({ t: '', ...s })) last.t += t
    else out.push({ t, ...s })
  }
  for (const tok of tokens ?? []) {
    switch (tok.type) {
      case 'strong':
        spans((tok as Tokens.Strong).tokens, { ...style, b: true }, out)
        break
      case 'em':
        spans((tok as Tokens.Em).tokens, { ...style, i: true }, out)
        break
      case 'del':
        spans((tok as Tokens.Del).tokens, { ...style, s: true }, out)
        break
      case 'link': {
        const link = tok as Tokens.Link
        // only what a tap may open
        spans(link.tokens, /^(https?:|mailto:)/i.test(link.href) ? { ...style, href: link.href } : style, out)
        break
      }
      case 'image':
        add((tok as Tokens.Image).text || (tok as Tokens.Image).href)
        break
      case 'codespan':
        add((tok as Tokens.Codespan).text, { c: true })
        break
      case 'br':
        add('\n')
        break
      case 'mathInline':
        add(texToText(`$${(tok as Tokens.Generic).text as string}$`), { m: true })
        break
      case 'html':
        add(/^<br\s*\/?>$/i.test(tok.raw.trim()) ? '\n' : tok.raw)
        break
      case 'checkbox':
        break
      default: {
        const inner = (tok as Tokens.Text).tokens
        if (inner?.length) spans(inner, style, out)
        else add(plain((tok as Tokens.Text).text ?? tok.raw))
      }
    }
  }
  return out
}

function walk(tokens: Token[], depth: number, quote: number, out: MdBlock[]): void {
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space':
      case 'def':
      case 'checkbox':
        break
      case 'heading':
        out.push({ kind: 'h', depth, quote, level: (tok as Tokens.Heading).depth, spans: spans((tok as Tokens.Heading).tokens, {}) })
        break
      case 'code':
        out.push({ kind: 'code', depth, quote, text: (tok as Tokens.Code).text, lang: (tok as Tokens.Code).lang || undefined })
        break
      case 'mathBlock':
        out.push({ kind: 'math', depth, quote, text: texToText(`$${(tok as Tokens.Generic).text as string}$`) })
        break
      case 'hr':
        out.push({ kind: 'rule', depth, quote })
        break
      case 'blockquote':
        walk((tok as Tokens.Blockquote).tokens, depth, quote + 1, out)
        break
      case 'list': {
        const list = tok as Tokens.List
        list.items.forEach((item, i) => {
          const at = out.length
          walk(item.tokens, depth + 1, quote, out)
          // an item with nothing in it still shows its mark
          if (out.length === at) out.push({ kind: 'p', depth: depth + 1, quote, spans: [] })
          out[at].mark = item.task ? (item.checked ? '☑' : '☐') : list.ordered ? `${(Number(list.start) || 1) + i}.` : '•'
        })
        break
      }
      case 'table': {
        const t = tok as Tokens.Table
        out.push({ kind: 'table', depth, quote, align: t.align, head: t.header.map((c) => spans(c.tokens, {})), rows: t.rows.map((r) => r.map((c) => spans(c.tokens, {}))) })
        break
      }
      default: {
        // a paragraph, a list item's text, raw HTML: its inline pieces, or itself as written
        const inner = (tok as Tokens.Paragraph).tokens
        const s = inner?.length ? spans(inner, {}) : spans([{ type: 'text', raw: tok.raw, text: tok.raw.trim() } as Tokens.Text], {})
        if (s.length) out.push({ kind: 'p', depth, quote, spans: s })
      }
    }
  }
}

/** Markdown as flat blocks. What it does not know stays as the text it was, never dropped. */
export function markdownBlocks(text: string): MdBlock[] {
  const out: MdBlock[] = []
  walk(md.lexer(text), 0, 0, out)
  return out
}

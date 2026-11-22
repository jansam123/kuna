/**
 * What the iPhone app shows in a web view: a Markdown file, a file's text, a
 * diff. Bundled by scripts/ios-bundle.mjs into one script; the app loads it
 * into a page of its own and calls `KunaWeb.…`. The page talks back through
 * `webkit.messageHandlers.kuna` (a line was tapped). It loads nothing from the
 * network: pictures in Markdown come from the file's own folder on the host,
 * through the app.
 */
import DOMPurify from 'dompurify'
import katex from 'katex'
import { Marked, type TokenizerAndRendererExtension } from 'marked'
import { createHighlighterCoreSync, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import bash from 'shiki/langs/shellscript.mjs'
import c from 'shiki/langs/c.mjs'
import cmake from 'shiki/langs/cmake.mjs'
import cpp from 'shiki/langs/cpp.mjs'
import css from 'shiki/langs/css.mjs'
import diffLang from 'shiki/langs/diff.mjs'
import docker from 'shiki/langs/docker.mjs'
import go from 'shiki/langs/go.mjs'
import html from 'shiki/langs/html.mjs'
import ini from 'shiki/langs/ini.mjs'
import javascript from 'shiki/langs/javascript.mjs'
import json from 'shiki/langs/json.mjs'
import julia from 'shiki/langs/julia.mjs'
import latex from 'shiki/langs/latex.mjs'
import make from 'shiki/langs/make.mjs'
import markdownLang from 'shiki/langs/markdown.mjs'
import python from 'shiki/langs/python.mjs'
import rust from 'shiki/langs/rust.mjs'
import sql from 'shiki/langs/sql.mjs'
import toml from 'shiki/langs/toml.mjs'
import tsx from 'shiki/langs/tsx.mjs'
import typescript from 'shiki/langs/typescript.mjs'
import xml from 'shiki/langs/xml.mjs'
import yaml from 'shiki/langs/yaml.mjs'
import darkPlus from 'shiki/themes/dark-plus.mjs'
import { diffLines, foldUnchanged, splitLines, type DiffRow } from '@shared/linediff'

declare global {
  interface Window {
    webkit?: { messageHandlers?: { kuna?: { postMessage: (m: unknown) => void } } }
  }
}

const post = (m: unknown): void => window.webkit?.messageHandlers?.kuna?.postMessage(m)
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const root = (): HTMLElement => document.getElementById('root')!

// ------------------------------------------------------------- colours ----

const STYLE = `
:root { color-scheme: dark; --ground:#05070c; --panel:#090c14; --raised:#0f1420; --line:#1a2133; --text:#dfe6f5; --dim:#8590a8; --faint:#4a5368; --accent:#4d8dff; --waiting:#ffb547;
  --add: rgba(46,160,67,.20); --del: rgba(248,81,73,.20); --addn: rgba(46,160,67,.35); --deln: rgba(248,81,73,.35) }
* { box-sizing: border-box }
html { -webkit-text-size-adjust: 100% }
body { margin: 0; background: var(--ground); color: var(--text); font: 16px/1.5 -apple-system, system-ui, sans-serif; overflow-wrap: anywhere }
#root.md { padding: 16px 16px 48px; max-width: 760px; margin: 0 auto }
.md h1, .md h2, .md h3 { line-height: 1.25; margin: 1.3em 0 .5em }
.md h1 { font-size: 1.5em } .md h2 { font-size: 1.25em; border-bottom: 1px solid var(--line); padding-bottom: .25em } .md h3 { font-size: 1.1em }
.md a { color: var(--accent) }
.md img { max-width: 100%; height: auto; border-radius: 6px }
.md code { font: .88em ui-monospace, Menlo, monospace; background: var(--raised); padding: .12em .35em; border-radius: 5px }
.md pre { background: var(--raised); padding: 12px; border-radius: 10px; overflow-x: auto; overflow-wrap: normal }
.md pre code { background: none; padding: 0; font-size: 13px; line-height: 1.45 }
.md blockquote { margin: 1em 0; padding: .1em 1em; border-left: 3px solid var(--line); color: var(--dim) }
.md table { border-collapse: collapse; display: block; overflow-x: auto; max-width: 100%; overflow-wrap: normal }
.md th, .md td { border: 1px solid var(--line); padding: 6px 10px; text-align: left }
.md th { background: var(--panel) }
.md hr { border: 0; border-top: 1px solid var(--line); margin: 1.5em 0 }
.md .math-display { overflow-x: auto; margin: 1em 0; text-align: center }
.md li { margin: .2em 0 }
.md input[type=checkbox] { margin-right: .4em }
#root.code { font: 12.5px/1.5 ui-monospace, Menlo, monospace; padding-bottom: 40px }
table.lines { border-collapse: collapse; width: 100%; table-layout: fixed }
.scroll table.lines { width: max-content; min-width: 100%; table-layout: auto }
.scroll { overflow-x: auto }
col.n { width: 3.1em }
td.n { text-align: right; padding: 0 .6em 0 .3em; color: var(--faint); user-select: none; -webkit-user-select: none; vertical-align: top; font-variant-numeric: tabular-nums }
td.c { padding: 0 .6em 0 .5em; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; vertical-align: top }
.scroll td.c { white-space: pre; word-break: normal; overflow-wrap: normal }
tr.add td.c, td.c.add { background: var(--add) } tr.add td.n, td.n.add { background: var(--addn); color: var(--text) }
tr.del td.c, td.c.del { background: var(--del) } tr.del td.n, td.n.del { background: var(--deln); color: var(--text) }
td.c.none, td.n.none { background: var(--panel) }
tr.fold td { text-align: center; color: var(--dim); background: var(--panel); padding: 5px; font: 12px -apple-system, system-ui, sans-serif; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line) }
tr.note td { background: var(--raised); border-left: 3px solid var(--waiting); padding: 8px 10px; font: 14px/1.4 -apple-system, system-ui, sans-serif; white-space: pre-wrap }
tr.hit td.c { outline: 1px solid var(--accent); outline-offset: -1px }
.empty { color: var(--dim); text-align: center; padding: 48px 24px; font: 15px -apple-system, system-ui, sans-serif }
`

export function boot(): void {
  const style = document.createElement('style')
  style.textContent = STYLE
  document.head.append(style)
  post({ type: 'ready' })
}

/** The colour scheme's colours, as the app has them: `{ ground: '#…', … }`. */
export function theme(vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) if (/^#[0-9a-fA-F]{3,8}$/.test(v)) document.documentElement.style.setProperty(`--${k}`, v)
}

// --------------------------------------------------------- highlighting ----

const LANGS = [bash, c, cmake, cpp, css, diffLang, docker, go, html, ini, javascript, json, julia, latex, make, markdownLang, python, rust, sql, toml, tsx, typescript, xml, yaml]
const BY_EXT: Record<string, string> = {
  py: 'python', pyi: 'python', ipynb: 'json', sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', c: 'c', h: 'cpp', hh: 'cpp', hpp: 'cpp', hxx: 'cpp', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', icc: 'cpp',
  C: 'cpp', cmake: 'cmake', css: 'css', diff: 'diff', patch: 'diff', go: 'go', html: 'html', htm: 'html', ini: 'ini', cfg: 'ini', conf: 'ini', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'tsx', json: 'json', jsonc: 'json', jl: 'julia', tex: 'latex', sty: 'latex', bib: 'latex', mk: 'make', md: 'markdown', markdown: 'markdown', rs: 'rust', sql: 'sql', toml: 'toml', ts: 'typescript',
  tsx: 'tsx', xml: 'xml', svg: 'xml', yaml: 'yaml', yml: 'yaml', sub: 'ini', jdl: 'ini'
}
const BY_NAME: Record<string, string> = { Makefile: 'make', makefile: 'make', 'CMakeLists.txt': 'cmake', Dockerfile: 'docker', Snakefile: 'python', '.bashrc': 'shellscript', '.zshrc': 'shellscript' }

let shiki: HighlighterCore | null | undefined
function highlighter(): HighlighterCore | null {
  if (shiki === undefined) {
    try {
      shiki = createHighlighterCoreSync({ themes: [darkPlus], langs: LANGS, engine: createJavaScriptRegexEngine({ forgiving: true }) })
    } catch {
      shiki = null
    }
  }
  return shiki
}

function langOf(path: string): string | undefined {
  const name = path.split('/').pop() ?? path
  return BY_NAME[name] ?? BY_EXT[name.includes('.') ? name.split('.').pop()! : ''] ?? BY_EXT[(name.split('.').pop() ?? '').toLowerCase()]
}

/** Each line of a text as HTML, coloured when its language is known and it is not too long to be worth it. */
function paint(text: string, lang: string | undefined): string[] {
  const lines = splitLines(text)
  const h = lang && text.length < 400_000 && lines.length < 8000 ? highlighter() : null
  if (h && lang) {
    try {
      return h.codeToTokensBase(lines.join('\n'), { lang, theme: 'dark-plus' }).map((line) => line.map((t) => (t.color ? `<span style="color:${t.color}">${esc(t.content)}</span>` : esc(t.content))).join(''))
    } catch {
      /* a grammar this engine cannot run: plain text */
    }
  }
  return lines.map(esc)
}

// -------------------------------------------------------------- markdown ----

const purify = DOMPurify(window)
purify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') ?? ''
    if (/^https?:\/\//i.test(href)) node.setAttribute('target', '_blank')
    else node.removeAttribute('href')
  }
  if (node.tagName === 'IMG') {
    // pictures never load from the network; relative ones come from the file's folder, through the app
    const src = node.getAttribute('src') ?? ''
    if (!/^data:image\//i.test(src) && /^[a-z][a-z0-9+.-]*:|^\/\//i.test(src)) node.removeAttribute('src')
  }
})
const FORBID = {
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'video', 'audio', 'source', 'link', 'meta'],
  FORBID_ATTR: ['style', 'srcset']
}

let math: string[] = []
const slot = (tex: string, displayMode: boolean): string => {
  // MathML: WebKit draws it itself, so no fonts or styles have to come along
  const out = katex.renderToString(tex, { displayMode, throwOnError: false, strict: 'ignore', trust: false, output: 'mathml', maxSize: 20, maxExpand: 1000 })
  return `${math.push(out) - 1}`
}
const mathBlock: TokenizerAndRendererExtension = {
  name: 'mathBlock',
  level: 'block',
  start: (src) => /^ {0,3}(?:\$\$|\\\[)/m.exec(src)?.index,
  tokenizer(src) {
    const m = /^ {0,3}(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n+|$)/.exec(src)
    if (m) return { type: 'mathBlock', raw: m[0], text: (m[1] ?? m[2]).trim() }
    return undefined
  },
  renderer: (t) => `<div class="math-display">${slot(t.text as string, true)}</div>\n`
}
const mathInline: TokenizerAndRendererExtension = {
  name: 'mathInline',
  level: 'inline',
  start: (src) => /\$|\\\(/.exec(src)?.index,
  tokenizer(src) {
    const m = /^\$\$([^$]+?)\$\$/.exec(src) ?? /^\$(?!\s)((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\d)/.exec(src) ?? /^\\\(([\s\S]+?)\\\)/.exec(src)
    if (m) return { type: 'mathInline', raw: m[0], text: m[1], display: m[0].startsWith('$$') }
    return undefined
  },
  renderer: (t) => slot(t.text as string, Boolean(t.display))
}
const md = new Marked({ extensions: [mathBlock, mathInline] })

/** A Markdown file an agent wrote: no scripts, styles or embeds; links open in the browser. */
export function markdown(text: string): void {
  math = []
  const clean = purify.sanitize(md.parse(text, { async: false }) as string, FORBID) as string
  const el = root()
  el.className = 'md'
  el.innerHTML = clean.replace(/(\d+)/g, (_, i: string) => math[Number(i)] ?? '')
  math = []
  for (const code of el.querySelectorAll<HTMLElement>('pre > code[class*="language-"]')) {
    const lang = /language-([\w+-]+)/.exec(code.className)?.[1] ?? ''
    const known = BY_EXT[lang] ?? (LANGS.some((l) => l.some((g) => g.name === lang)) ? lang : undefined)
    if (known) code.innerHTML = paint(code.textContent ?? '', known).join('\n')
  }
}

// ------------------------------------------------------------ code, diff ----

export interface Note {
  side: 'old' | 'new'
  line: number
  text: string
}

interface DiffInput {
  path: string
  old: string
  new: string
  /** side by side (landscape) instead of one column */
  split: boolean
  /** long lines scroll sideways instead of wrapping */
  scroll: boolean
  notes: Note[]
}

let last: DiffInput | undefined
let unfolded = new Set<number>()

/** One file's text with line numbers. */
export function code(path: string, text: string, scroll: boolean): void {
  last = undefined
  const el = root()
  el.className = 'code' + (scroll ? ' scroll' : '')
  const lines = paint(text, langOf(path))
  el.innerHTML = lines.length
    ? `<table class="lines"><colgroup><col class="n"><col></colgroup>${lines.map((l, i) => `<tr><td class="n">${i + 1}</td><td class="c">${l || ' '}</td></tr>`).join('')}</table>`
    : '<div class="empty">This file is empty.</div>'
}

/** A file before and after. Tapping a line tells the app (`{type:'line', side, line, text}`). */
export function diff(input: DiffInput): void {
  if (!last || last.path !== input.path || last.old !== input.old || last.new !== input.new) unfolded = new Set()
  last = input
  draw()
}

/** The comments to show under their lines, after one was added or removed. */
export function notes(list: Note[]): void {
  if (!last) return
  last.notes = list
  draw()
}

function draw(): void {
  const input = last!
  const lang = langOf(input.path)
  const before = paint(input.old, lang)
  const after = paint(input.new, lang)
  const rows = diffLines(splitLines(input.old), splitLines(input.new))
  const el = root()
  el.className = `code${input.scroll ? ' scroll' : ''}${input.split ? ' split' : ''}`
  if (!rows.length) {
    el.innerHTML = '<div class="empty">Both sides are empty.</div>'
    return
  }
  const html = (r: DiffRow): string => (r.kind === 'del' ? before[r.old! - 1] : after[r.new! - 1]) || ' '
  const noteRows = (side: 'old' | 'new', line: number | undefined, span: number): string =>
    line === undefined
      ? ''
      : input.notes
          .filter((n) => n.side === side && n.line === line)
          .map((n) => `<tr class="note"><td colspan="${span}">${esc(n.text)}</td></tr>`)
          .join('')
  const out: string[] = []
  foldUnchanged(rows).forEach((part, index) => {
    if ('folded' in part && !unfolded.has(index)) {
      out.push(`<tr class="fold" data-fold="${index}"><td colspan="${input.split ? 4 : 3}">⋯ ${part.folded.length} unchanged lines</td></tr>`)
      return
    }
    const list = 'rows' in part ? part.rows : part.folded
    if (!input.split) {
      for (const r of list) {
        const side = r.kind === 'del' ? 'old' : 'new'
        const line = r.kind === 'del' ? r.old : r.new
        out.push(`<tr class="${r.kind}" data-side="${side}" data-line="${line}"><td class="n">${r.old ?? ''}</td><td class="n">${r.new ?? ''}</td><td class="c">${html(r)}</td></tr>`)
        out.push(noteRows(side, line, 3))
      }
      return
    }
    // side by side: a run of removed lines beside the added ones that follow it
    for (let i = 0; i < list.length; ) {
      if (list[i].kind === 'same') {
        const r = list[i++]
        out.push(`<tr data-side="new" data-line="${r.new}"><td class="n">${r.old}</td><td class="c">${html(r)}</td><td class="n">${r.new}</td><td class="c">${html(r)}</td></tr>`, noteRows('new', r.new, 4))
        continue
      }
      const dels: DiffRow[] = []
      const adds: DiffRow[] = []
      while (i < list.length && list[i].kind === 'del') dels.push(list[i++])
      while (i < list.length && list[i].kind === 'add') adds.push(list[i++])
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
        const d = dels[k]
        const a = adds[k]
        const left = d ? `<td class="n del" data-side="old" data-line="${d.old}">${d.old}</td><td class="c del" data-side="old" data-line="${d.old}">${html(d)}</td>` : '<td class="n none"></td><td class="c none"></td>'
        const right = a ? `<td class="n add" data-side="new" data-line="${a.new}">${a.new}</td><td class="c add" data-side="new" data-line="${a.new}">${html(a)}</td>` : '<td class="n none"></td><td class="c none"></td>'
        out.push(`<tr>${left}${right}</tr>`, noteRows('old', d?.old, 4), noteRows('new', a?.new, 4))
      }
    }
  })
  // the columns' widths, said once: the first row may be a folded run across all of them
  const cols = input.split ? '<col class="n"><col><col class="n"><col>' : '<col class="n"><col class="n"><col>'
  el.innerHTML = `<table class="lines"><colgroup>${cols}</colgroup>${out.join('')}</table>`
  el.onclick = (e) => {
    const target = e.target as HTMLElement
    const fold = target.closest<HTMLElement>('tr.fold')
    if (fold) {
      unfolded.add(Number(fold.dataset.fold))
      draw()
      return
    }
    const at = target.closest<HTMLElement>('[data-line]')
    if (!at || !at.dataset.line) return
    const side = at.dataset.side === 'old' ? 'old' : 'new'
    const line = Number(at.dataset.line)
    const text = splitLines(side === 'old' ? input.old : input.new)[line - 1] ?? ''
    post({ type: 'line', side, line, text })
  }
}

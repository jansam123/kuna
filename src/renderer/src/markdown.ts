import DOMPurify from 'dompurify'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { Marked, type TokenizerAndRendererExtension } from 'marked'
import { MATH_BLOCK, MATH_INLINE } from '@shared/mdblocks'
import { mediaKind, resolveAgainst } from '@shared/media'

/**
 * Markdown an agent wrote, for the viewer. It can quote anything (a web page,
 * a log), so: no scripts, styles, forms or embeds; links open in the browser
 * (http/https only); pictures never load from the network, and relative ones
 * are marked `data-src` for `loadMarkdownImages` to fetch from the host.
 */
const purify = DOMPurify(window)
purify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') ?? ''
    if (/^https?:\/\//i.test(href)) {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noreferrer')
    } else node.removeAttribute('href')
  }
  if (node.tagName === 'IMG') {
    const src = node.getAttribute('src') ?? ''
    if (/^data:image\//i.test(src)) return
    node.removeAttribute('src')
    if (src && !/^[a-z][a-z0-9+.-]*:/i.test(src)) node.setAttribute('data-src', src)
  }
})

const FORBID = {
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'video', 'audio', 'source', 'link', 'meta'],
  FORBID_ATTR: ['style', 'srcset']
}

/**
 * LaTeX: $…$ and \(…\) inline, $$…$$ and \[…\] displayed. KaTeX renders it
 * with `trust` off (no links, classes or styles from the source), and its
 * output goes in after the sanitiser, which would strip KaTeX's own layout
 * styles. The text holds a private-use placeholder until then.
 */
let math: string[] = []
const slot = (tex: string, displayMode: boolean): string => {
  const html = katex.renderToString(tex, { displayMode, throwOnError: false, strict: 'ignore', trust: false, output: 'html', maxSize: 20, maxExpand: 1000 })
  return `${math.push(html) - 1}`
}

const mathBlock: TokenizerAndRendererExtension = { ...MATH_BLOCK, renderer: (t) => `<div class="math-display">${slot(t.text as string, true)}</div>\n` }
const mathInline: TokenizerAndRendererExtension = { ...MATH_INLINE, renderer: (t) => slot(t.text as string, Boolean(t.display)) }

const md = new Marked({ extensions: [mathBlock, mathInline] })

export function renderMarkdown(text: string): string {
  math = []
  const html = purify.sanitize(md.parse(text, { async: false }) as string, FORBID) as string
  const out = html.replace(/(\d+)/g, (_, i: string) => math[Number(i)] ?? '')
  math = []
  return out
}

/**
 * Fill in the pictures a rendered file refers to, relative to the file, read
 * from its host through the viewer's own checks. Returns the blob URLs to revoke.
 */
export async function loadMarkdownImages(root: HTMLElement, host: string, mdPath: string, isLive: () => boolean): Promise<string[]> {
  const urls: string[] = []
  const dir = mdPath.replace(/\/[^/]*$/, '') || '/'
  const imgs = [...root.querySelectorAll<HTMLImageElement>('img[data-src]')].slice(0, 40)
  await Promise.all(
    imgs.map(async (img) => {
      let rel = img.dataset.src ?? ''
      try {
        rel = decodeURIComponent(rel.replace(/[?#].*$/, ''))
      } catch {
        return
      }
      const path = resolveAgainst(dir, rel)
      const kind = mediaKind(path)
      if (kind !== 'image' && kind !== 'svg') return
      const res = await window.kuna.media.fetch(host, path)
      if ('error' in res || !isLive()) return
      const url = URL.createObjectURL(new Blob([res.data as BlobPart], { type: res.mime }))
      urls.push(url)
      img.src = url
    })
  )
  return urls
}

let mermaidLib: Promise<typeof import('mermaid')> | null = null
let diagramSeq = 0

/**
 * Draw the ```mermaid blocks of a rendered file (flowcharts and the rest) in
 * the colour scheme's colours. Mermaid runs in its strict mode, and each
 * drawing is shown as a picture, so nothing in it can run or restyle Kuna.
 * A block that does not parse stays as code, with the reason under it.
 * Mermaid is loaded the first time a file has a diagram.
 */
export async function renderDiagrams(root: HTMLElement, isLive: () => boolean): Promise<string[]> {
  const blocks = [...root.querySelectorAll<HTMLElement>('pre > code.language-mermaid')].slice(0, 20)
  if (!blocks.length) return []
  const mermaid = (await (mermaidLib ??= import('mermaid'))).default
  const css = getComputedStyle(document.documentElement)
  const v = (name: string): string => css.getPropertyValue(`--${name}`).trim()
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    darkMode: true,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
    flowchart: { htmlLabels: false },
    themeVariables: {
      background: v('panel'),
      primaryColor: v('raised'),
      primaryTextColor: v('text'),
      primaryBorderColor: v('accent'),
      secondaryColor: v('panel'),
      tertiaryColor: v('panel'),
      lineColor: v('dim'),
      textColor: v('text'),
      fontSize: '15px'
    }
  })
  const urls: string[] = []
  for (const code of blocks) {
    const pre = code.parentElement
    if (!pre || !isLive()) break
    try {
      const { svg } = await mermaid.render(`kuna-diagram-${++diagramSeq}`, code.textContent ?? '')
      if (!isLive()) break
      const url = URL.createObjectURL(new Blob([sized(svg)], { type: 'image/svg+xml' }))
      urls.push(url)
      const fig = document.createElement('figure')
      fig.className = 'md-diagram'
      const img = document.createElement('img')
      img.alt = 'diagram'
      img.src = url
      fig.append(img)
      pre.replaceWith(fig)
    } catch (err) {
      const note = document.createElement('p')
      note.className = 'md-diagram-error'
      note.textContent = `This diagram could not be drawn: ${String((err as Error)?.message ?? err).split('\n')[0]}`
      pre.after(note)
    }
  }
  return urls
}

/** Mermaid sizes its drawing to its container; as a picture it needs its own width and height. */
function sized(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const el = doc.documentElement
  const box = el.getAttribute('viewBox')?.split(/[\s,]+/).map(Number)
  if (box?.length === 4 && box.every(Number.isFinite)) {
    el.setAttribute('width', String(Math.ceil(box[2])))
    el.setAttribute('height', String(Math.ceil(box[3])))
    el.style.removeProperty('max-width')
  }
  return new XMLSerializer().serializeToString(el)
}

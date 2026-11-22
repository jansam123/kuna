import type { MediaItem } from './types'

const EXT = 'png|jpe?g|gif|webp|svg|pdf|md|markdown|html?'

// A path-ish token ending in a media (or Markdown) extension, preceded by a delimiter so
// URLs (`https://x/a.png`) and identifiers (`foo.png_bar`) are not matched.
const MEDIA_RE = new RegExp(
  String.raw`(?:^|[\s"'\x60(\[=:,>])((?:~|\.{1,2})?\/?(?:[\w@%+.,~-]+\/)*[\w@%+,~-][\w@%+.,~-]*\.(?:${EXT}))(?=$|[\s"'\x60)\],;:!?.<])`,
  'gi'
)

export function mediaKind(path: string): MediaItem['kind'] | null {
  const m = /\.([a-z0-9]+)$/i.exec(path)
  if (!m) return null
  const ext = m[1].toLowerCase()
  if (ext === 'pdf') return 'pdf'
  if (ext === 'svg') return 'svg'
  if (ext === 'md' || ext === 'markdown') return 'md'
  if (ext === 'html' || ext === 'htm') return 'html'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image'
  return null
}

export function mimeFor(path: string): string {
  const ext = (/\.([a-z0-9]+)$/i.exec(path)?.[1] ?? '').toLowerCase()
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    case 'svg':
      return 'image/svg+xml'
    case 'pdf':
      return 'application/pdf'
    case 'md':
    case 'markdown':
      return 'text/markdown'
    case 'html':
    case 'htm':
      return 'text/html'
    default:
      return 'application/octet-stream'
  }
}

/** Every media path mentioned in a piece of text, in order of appearance. */
export function extractMediaPaths(text: string): string[] {
  const out: string[] = []
  if (!text || text.length > 400_000) return out
  MEDIA_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MEDIA_RE.exec(text))) {
    out.push(m[1])
    // allow back-to-back matches separated by a single delimiter
    MEDIA_RE.lastIndex = m.index + m[0].length
  }
  return out
}

/** The session every web page in the viewer runs in, sign-ins kept, apart from Kuna's own window; the main process lets a guest into no other. */
export const WEB_PARTITION = 'persist:web'

/**
 * The http(s) addresses in a line of terminal text, and where each starts.
 * What ends the sentence or closes a bracket around an address is not part of it.
 */
export function linksIn(line: string): { at: number; url: string }[] {
  return [...line.matchAll(/https?:\/\/[^\s"'<>`\\^{}|]+/gi)].map((m) => {
    let url = m[0]
    while (/[.,;:!?)\]]$/.test(url)) {
      const last = url[url.length - 1]
      const opener = last === ')' ? '(' : last === ']' ? '[' : ''
      // a bracket opened inside the address is its own
      if (opener && url.split(opener).length >= url.split(last).length) break
      url = url.slice(0, -1)
    }
    return { at: m.index, url }
  })
}

/** POSIX normalisation without touching the filesystem. Keeps a leading `~`. */
export function normalizePosix(path: string): string {
  const abs = path.startsWith('/')
  const parts: string[] = []
  for (const seg of path.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (parts.length && parts[parts.length - 1] !== '..' && parts[parts.length - 1] !== '~') parts.pop()
      else if (!abs) parts.push('..')
      continue
    }
    parts.push(seg)
  }
  return (abs ? '/' : '') + parts.join('/')
}

/** Resolve a path mentioned by an agent against the agent's working directory. */
export function resolveAgainst(cwd: string, p: string): string {
  if (p.startsWith('/') || p === '~' || p.startsWith('~/')) return normalizePosix(p)
  return normalizePosix(`${cwd.replace(/\/+$/, '')}/${p}`)
}

/**
 * The viewer's groups of files, in the order it lists them, and what each is
 * called. Slides are PDFs of more than one page; a diagram or a plot is a
 * single-page PDF or an image (`figureClass`). A PDF is in `pdf` for the
 * moment it takes the viewer to read what it is.
 */
export const MEDIA_GROUPS = [
  ['slides', 'Slides'],
  ['diagram', 'Diagrams'],
  ['plot', 'Plots'],
  ['md', 'Markdown'],
  ['html', 'Pages'],
  ['url', 'Web'],
  ['pdf', 'PDFs']
] as const

export type FigureClass = 'slides' | 'diagram' | 'plot'

/** The group a file is listed under: a PDF or an image by what it is (`figure`), once that is known. */
export const mediaGroup = (kind: string, figure?: FigureClass | null): string =>
  kind === 'md' || kind === 'html' || kind === 'url' ? kind : (figure ?? (kind === 'pdf' ? 'pdf' : 'plot'))

/** a name that says diagram: the file's own, or its folder's */
const DIAGRAM_NAME = /diagram|flow-?chart|schem|sketch|workflow|pipeline|architecture|feynman|tikz/i
/** programs that write plots, and programs that draw diagrams, as a PDF's Creator and Producer name them */
const PLOT_MAKER = /matplotlib|\bROOT\b|gnuplot|plotly|ggplot|\bR \d|R Graphics|seaborn/i
const DIAGRAM_MAKER = /tex\b|tikz|graphviz|draw\.io|diagrams\.net|inkscape|mermaid|plantuml|omnigraffle|typst|chrom|skia|cairo|visio|excalidraw/i

/**
 * What a PDF or an image is. A PDF of more than one page is slides. A single
 * page or an image is a diagram when its name (or its folder's) says so, or
 * when a drawing program made the PDF and no plotting program did (a
 * Matplotlib figure set by LaTeX is a plot); anything else is a plot. `pdf`:
 * the page count and the maker (Creator and Producer) of a PDF once read.
 */
export function figureClass(path: string, pdf?: { pages: number; maker: string }): FigureClass {
  if (pdf && pdf.pages > 1) return 'slides'
  if (DIAGRAM_NAME.test(path.split('/').slice(-2).join('/'))) return 'diagram'
  return pdf && !PLOT_MAKER.test(pdf.maker) && DIAGRAM_MAKER.test(pdf.maker) ? 'diagram' : 'plot'
}

/**
 * Which group each file of the viewer's list is in. A PDF is what reading it
 * said (`pdfClass`: its `figureClass` with pages and maker; nothing while it
 * is unread). An image is what the PDF of the same name beside it is (a
 * figure saved as both), else what its name says.
 */
export function fileGroups<T extends { path: string; kind: string }>(items: T[], pdfClass: (it: T) => FigureClass | null | undefined): (it: T) => string {
  const stem = (path: string): string => path.replace(/\.[^./]+$/, '')
  const pdfs = new Map(items.filter((it) => it.kind === 'pdf').map((it) => [stem(it.path), it]))
  return (it) => {
    if (it.kind === 'md' || it.kind === 'html' || it.kind === 'url') return mediaGroup(it.kind)
    if (it.kind === 'pdf') return mediaGroup('pdf', pdfClass(it))
    const twin = pdfs.get(stem(it.path))
    const same = twin && pdfClass(twin)
    return same && same !== 'slides' ? same : figureClass(it.path)
  }
}

/**
 * The order the viewer shows files in: by group (`group` says which a file
 * is in), each in the order given (the order a reply mentions them, left to
 * right; newest first for the folder scan). Before the viewer has read what
 * each figure is, PDFs lead, then images, Markdown and HTML pages.
 */
export function viewerOrder<T extends { kind: string }>(items: T[], group: (it: T) => string = (it) => (it.kind === 'pdf' ? 'slides' : mediaGroup(it.kind))): T[] {
  return MEDIA_GROUPS.flatMap(([g]) => items.filter((it) => group(it) === g))
}

export type MediaPlace = 'folder' | 'claude' | 'tmp' | 'outside'

/**
 * Where a file the viewer lists lives: among the files of the agent's folder
 * `base`, in a `.claude` folder (plans, memory, skills: the folder's own or
 * the one in the home folder), in a temporary folder, or somewhere else.
 */
export function mediaPlace(base: string, path: string): MediaPlace {
  const root = base.replace(/\/+$/, '')
  const inside = path.startsWith(root + '/')
  // an agent working in a worktree below .claude: its files are still its folder's
  if ((inside ? path.slice(root.length) : path).split('/').includes('.claude')) return 'claude'
  if (inside) return 'folder'
  return /^(\/private)?\/(tmp|var\/tmp|var\/folders)\//.test(path) ? 'tmp' : 'outside'
}

/** What a page in the viewer may load, by extension: the files a web page is made of. */
const PAGE_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json',
  geojson: 'application/geo+json',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm'
}

/**
 * The file a page shown in the viewer asks for with a URL path
 * (`/plots/a%20b.png`), below the page's folder `dir`, and its type. None
 * for hidden files and folders, `..` steps, or files a web page is not made of.
 */
export function pageFile(dir: string, urlPath: string): { path: string; mime: string } | null {
  let rel: string
  try {
    rel = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  const segs = rel.split('/').filter(Boolean)
  if (!segs.length || segs.some((s) => s.startsWith('.') || s.includes('\0'))) return null
  const mime = PAGE_TYPES[(/\.([a-z0-9]+)$/i.exec(segs[segs.length - 1])?.[1] ?? '').toLowerCase()]
  return mime ? { path: `${dir}/${segs.join('/')}`, mime } : null
}

/**
 * What a page in the viewer may run and load: its own folder (inline code
 * included) and the CDNs artifacts and plotting libraries load from; no other
 * request to the web. (WebRTC and DNS lookups are beyond a CSP's reach; the
 * window turns WebRTC's UDP off, but this is no guarantee that nothing a page
 * reads gets out, so what it can read is kept to web files inside its folder.)
 */
const CDNS = [
  'https://cdnjs.cloudflare.com',
  'https://cdn.jsdelivr.net',
  'https://unpkg.com',
  'https://cdn.tailwindcss.com',
  'https://code.jquery.com',
  'https://cdn.plot.ly',
  'https://cdn.bokeh.org'
].join(' ')
export const PAGE_CSP = [
  `default-src 'self' data: blob: ${CDNS}`,
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob: ${CDNS}`,
  `style-src 'self' 'unsafe-inline' ${CDNS} https://fonts.googleapis.com`,
  `font-src 'self' data: ${CDNS} https://fonts.gstatic.com`,
  "form-action 'none'",
  "base-uri 'self'"
].join('; ')

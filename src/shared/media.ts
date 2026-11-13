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
 * The order the viewer shows files in: PDFs and HTML pages first, then
 * images, then Markdown, each in the order given (the order a reply mentions
 * them, left to right; newest first for the folder scan).
 */
export function viewerOrder<T extends { kind: string }>(items: T[]): T[] {
  const rank = (it: T): number => (it.kind === 'pdf' || it.kind === 'html' ? 0 : it.kind === 'md' ? 2 : 1)
  return [0, 1, 2].flatMap((r) => items.filter((it) => rank(it) === r))
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

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { gridRows, neighbor, type Direction } from '@shared/layout'
import { MEDIA_GROUPS, WEB_PARTITION, figureClass, fileGroups, mediaGroup, mediaPlace, viewerOrder, type FigureClass, type MediaPlace } from '@shared/media'
import type { MediaItem, MediaPage } from '@shared/types'
import { discardTyped, leaveScroll, sendEsc } from '../actions'
import { agentTitle, ago, bytes, doingText } from '../format'
import { enterToAgent, escPressed, escToAgent, panelOnScreen, typeToAgent } from '../keys'
import { loadMarkdownImages, renderDiagrams, renderMarkdown } from '../markdown'
import { get, updateSettings, useKuna } from '../store'
import { copyTerminalSelection, disposeTerminal, fitTerminal, getTerminal, redrawAfterMove, terminalEntry, writeToAgent } from '../terminals'
import { folderOfAgent } from '@shared/tree'
import { closeOverlay, useOverlayKeys } from './Overlays'
import { QuestionStrip } from './PaneGrid'
import { StatusDot } from './StatusDot'
import { TexText } from './TexText'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/** space around a fitted plot */
const PAD = 28
/** a small image is shown at most this much enlarged when fitted (zooming goes further) */
const MAX_FIT_UPSCALE = 2
const MIN_ZOOM = 0.2
const MAX_ZOOM = 16
/** largest canvas side in device pixels; past it a page is stretched rather than re-rendered */
const MAX_CANVAS = 8192
/** PDF pages are drawn this far above and below the view (in heights of the view); further out they give their pixels back */
const DRAW_AHEAD = '200%'
/** the next file is fetched ahead, unless that would be a large download nobody asked for */
const PREFETCH_MAX = 40 * 1024 * 1024
/** a file this large says it is on its way while it comes */
const SLOW_FILE = 20 * 1024 * 1024
/** the agent's column beside the file: narrowest, and widest as a share of the window */
const MIN_SIDE = 320
const MAX_SIDE_SHARE = 0.7
/** its width until its edge is dragged: room for Claude Code's screen */
const sideWidth = (): number => Math.round(Math.min(640, Math.max(420, window.innerWidth * 0.36)))
/** files side by side, at most (each holds its pixels) */
const MAX_TILES = 6
/** narrowest and lowest a file is dragged to */
const MIN_TILE = 160
/** drag-and-drop type for a file of the viewer (`Dragged`) */
const MEDIA_DRAG = 'application/x-kuna-media'
/** where a file lives, in a word, and in a sentence */
const PLACE: Record<MediaPlace | 'web', [string, string]> = {
  web: ['web', "A web page, opened from the agent's terminal"],
  folder: ['folder', "Among the files of the agent's folder"],
  claude: ['.claude', 'In a .claude folder (plans, memory, skills), not among the files of the project'],
  tmp: ['tmp', 'In a temporary folder: gone after a restart or a cleanup'],
  outside: ['outside', "Outside the agent's folder"]
}

/** One file shown: tiles sit in the rows of `gridRows`, as the agents' panes do. */
interface Tile {
  id: number
  item: MediaItem
  /** its share of its row's width (1 unless dragged) */
  w: number
}
let tileIds = 0
const newTile = (item: MediaItem): Tile => ({ id: ++tileIds, item, w: 1 })
/** each agent's files side by side and the groups rolled out, until Kuna quits: Space brings them back */
const kept = new Map<string, { tiles: Tile[]; heights: number[]; focus: number; opened: string[] }>()
/** the site of a web address: `claude.ai` */
const siteOf = (url: string): string => url.replace(/^https?:\/\//i, '').split(/[/?#]/)[0]
/** the web pages opened from each agent's terminal (⌘click on an address), newest first, until Kuna quits */
const webPages = new Map<string, MediaItem[]>()
interface Loaded {
  path: string
  url?: string
  data?: Uint8Array
  /** a Markdown file, rendered and sanitised, and its source */
  html?: string
  text?: string
  /** an HTML page: the `kuna-page:` address it is shown at, live, in a sandboxed frame */
  page?: string
  error?: string
}

interface PdfDoc {
  doc: pdfjs.PDFDocumentProxy
  /** page sizes in points, every page */
  sizes: { w: number; h: number }[]
}

const stampOf = (it: MediaItem): string => `${it.mtime}:${it.size}`
const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

/**
 * All the pages of a PDF at `scale` CSS pixels per point. Only those in or
 * near view (`root` scrolls them) are drawn, nearest the middle first, at the
 * screen's pixel ratio once the scale settles; until then the previous bitmap
 * is stretched, so zooming stays smooth. Pages far out of view give their
 * pixels back, so a long PDF costs no more memory than a short one.
 */
function PdfPages({ pdf, scale, root }: { pdf: PdfDoc; scale: number; root: HTMLElement | null }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  // the drawing loop's state: pages near the view, the scale each is drawn at
  const live = useRef({ scale, near: new Set<number>(), drawn: new Map<number, number>(), busy: false, gone: false, task: null as pdfjs.RenderTask | null })

  /** Draw what is near the view and not drawn at the current scale yet, one page at a time. */
  const draw = useCallback(async () => {
    const st = live.current
    const el = host.current
    if (st.busy || st.gone || !el || !root) return
    st.busy = true
    try {
      const canvases = el.querySelectorAll('canvas')
      for (;;) {
        const s = st.scale
        const view = root.getBoundingClientRect()
        const middle = view.top + view.height / 2
        let next = -1
        let best = Infinity
        for (const i of st.near) {
          if (st.drawn.get(i) === s) continue
          const r = canvases[i].getBoundingClientRect()
          const d = Math.abs((r.top + r.bottom) / 2 - middle)
          if (d < best) [best, next] = [d, i]
        }
        if (next < 0) return
        const page = await pdf.doc.getPage(next + 1)
        const { w, h } = pdf.sizes[next]
        const vp = page.getViewport({ scale: Math.min(s * (window.devicePixelRatio || 1), MAX_CANVAS / Math.max(w, h)) })
        const off = document.createElement('canvas')
        off.width = Math.floor(vp.width)
        off.height = Math.floor(vp.height)
        st.task = page.render({ canvas: off, viewport: vp })
        try {
          await st.task.promise
        } catch (e) {
          if (st.gone) return
          // a page that cannot be drawn is not tried again; a zoom only cancelled it
          if ((e as Error)?.name !== 'RenderingCancelledException') st.drawn.set(next, s)
          continue
        } finally {
          st.task = null
        }
        if (st.gone) return
        if (!st.near.has(next)) continue // scrolled away meanwhile
        const c = canvases[next]
        c.width = off.width
        c.height = off.height
        c.getContext('2d')?.drawImage(off, 0, 0)
        st.drawn.set(next, s)
      }
    } finally {
      st.busy = false
    }
  }, [pdf, root])

  // which pages are near the view; those far from it give their pixels back
  useEffect(() => {
    const el = host.current
    if (!el || !root) return
    const st = live.current
    const canvases = el.querySelectorAll('canvas')
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          const i = Number((en.target as HTMLElement).dataset.page)
          if (en.isIntersecting) st.near.add(i)
          else {
            st.near.delete(i)
            if (st.drawn.delete(i)) canvases[i].width = canvases[i].height = 0
          }
        }
        void draw()
      },
      { root, rootMargin: `${DRAW_AHEAD} 0px` }
    )
    canvases.forEach((c) => io.observe(c))
    return () => io.disconnect()
  }, [pdf, root, draw])

  // a new scale is drawn once it settles
  useEffect(() => {
    const st = live.current
    if (st.scale === scale) return
    const t = setTimeout(() => {
      st.scale = scale
      st.task?.cancel()
      void draw()
    }, 90)
    return () => clearTimeout(t)
  }, [scale, draw])

  useEffect(() => {
    const st = live.current
    return () => {
      st.gone = true
      st.task?.cancel()
    }
  }, [])

  return (
    <div className="pdf-pages" ref={host}>
      {pdf.sizes.map((s, i) => (
        // no pixels until it is drawn
        <canvas key={i} data-page={i} className="pdf-page" width={0} height={0} style={{ width: s.w * scale, height: s.h * scale }} />
      ))}
    </div>
  )
}

/**
 * The agent beside its files: its own terminal, moved here from its pane
 * while the viewer is open (the pane takes it back after), or one attached
 * for the viewer and closed with it when the agent has no tab. What is typed
 * while it has the keyboard goes straight to the agent. A stopped background session only comes back
 * on Enter (`live`), since attaching starts it again.
 */
export function AgentChat({
  agentKey,
  live,
  hint,
  onTyped,
  autoFocus = true,
  wake = 'Enter'
}: {
  agentKey: string
  live: boolean
  hint: string
  onTyped: (n: number) => void
  /** the terminal takes the keyboard when it comes up (the review view keeps it on its file list) */
  autoFocus?: boolean
  /** the key that brings a stopped session back (the review view's Enter is its file list's) */
  wake?: string
}): React.JSX.Element {
  const a = useKuna((s) => s.agents[agentKey])
  const d = useKuna((s) => s.details[agentKey])
  const projects = useKuna((s) => s.projects)
  const agents = useKuna((s) => s.agents)
  const hosts = useKuna((s) => s.hosts)
  const where = useMemo(() => folderOfAgent(projects, Object.values(agents), hosts).get(agentKey), [projects, agents, hosts, agentKey])
  const slot = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState(false)

  useLayoutEffect(() => {
    if (!live) return
    const e = getTerminal(agentKey)
    const on = (): void => setFocused(true)
    const off = (): void => setFocused(false)
    e.el.addEventListener('focusin', on)
    e.el.addEventListener('focusout', off)
    const cols = e.term.cols
    slot.current?.appendChild(e.el)
    e.typed = 0
    onTyped(0)
    fitTerminal(agentKey)
    // narrower than its pane: Claude Code redraws itself at this column's width
    redrawAfterMove(agentKey, cols)
    if (autoFocus) e.term.focus()
    else e.term.blur()
    // focus events wait while the window is in the background
    setFocused(e.el.contains(document.activeElement))
    const typing = e.term.onData(() => onTyped(e.typed))
    return () => {
      typing.dispose()
      e.el.removeEventListener('focusin', on)
      e.el.removeEventListener('focusout', off)
      e.term.blur()
      e.typed = 0
      // a tab's terminal goes back to its pane; one opened for the viewer closes
      if (!get().tabs.includes(agentKey)) disposeTerminal(agentKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentKey, live, onTyped])

  useEffect(() => {
    const el = slot.current
    if (!el) return
    let t: ReturnType<typeof setTimeout> | undefined
    const ro = new ResizeObserver(() => {
      clearTimeout(t)
      t = setTimeout(() => fitTerminal(agentKey), 40)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      clearTimeout(t)
    }
  }, [agentKey, live])

  return (
    <section className={`pane media-chat ${focused ? 'typing' : ''}`} style={{ '--repo': where?.folder.color ?? 'var(--faint)' } as React.CSSProperties}>
      <div className="pane-head">
        {where && (
          <span className="ph-repo" style={{ color: where.folder.color }}>
            <TexText text={where.folder.name} />
          </span>
        )}
        <span className={`ph-title ${a ? '' : 'dim'}`}>{a ? agentTitle(a, d) : 'Agent is gone'}</span>
        {a && (
          <span className={`ph-status st-${a.status}`} title={[doingText(a), a.detail].filter(Boolean).join('\n')}>
            <StatusDot status={a.status} />
            {doingText(a, true)}
          </span>
        )}
      </div>
      <QuestionStrip agentKey={agentKey} />
      {live ? (
        <div className="pane-body" ref={slot} onMouseDown={() => getTerminal(agentKey).term.focus()} />
      ) : (
        <div className="media-chat-msg">
          {a ? `This session is stopped. ${wake} brings it back here, to talk to it.` : 'This agent is gone.'}
        </div>
      )}
      {focused && <div className="typing-hint">{hint}</div>}
    </section>
  )
}

/** a PDF up to this size is read whole to see what it is (and is then there to show); a larger one in pieces of this size */
const PDF_PIECE = 256 * 1024
/** what each PDF is (slides, a diagram, a plot; null: not read, or unreadable), by host, path and stamp, until Kuna quits */
const pdfKinds = new Map<string, FigureClass | null>()
const pdfKey = (host: string, it: MediaItem): string => `${host}\0${it.path}\0${stampOf(it)}`

/**
 * What a PDF is, from its page count and the program that made it. Only the
 * pieces of the file that hold those are read (pdf.js asks for them), so a
 * long deck on another host costs a few small reads, not a download.
 */
async function readPdfClass(host: string, it: MediaItem): Promise<FigureClass | null> {
  let task: pdfjs.PDFDocumentLoadingTask | undefined
  try {
    if (it.size <= 2 * PDF_PIECE) {
      const res = await window.kuna.media.fetch(host, it.path, stampOf(it))
      if ('error' in res) return null
      task = pdfjs.getDocument({ data: res.data.slice() })
    } else {
      const range = new pdfjs.PDFDataRangeTransport(it.size, null)
      range.requestDataRange = (begin, end) =>
        void window.kuna.media.range(host, it.path, stampOf(it), begin, end).then((piece) => {
          if (piece?.length === end - begin) range.onDataRange(begin, piece)
          else void task?.destroy() // the file changed or is gone: nothing more to learn
        })
      task = pdfjs.getDocument({ range, rangeChunkSize: PDF_PIECE, disableAutoFetch: true, disableStream: true })
    }
    const doc = await task.promise
    const info = (await doc.getMetadata().catch(() => null))?.info as { Creator?: string; Producer?: string } | undefined
    return figureClass(it.path, { pages: doc.numPages, maker: `${info?.Creator ?? ''} ${info?.Producer ?? ''}` })
  } catch {
    return null
  } finally {
    void task?.destroy()
  }
}

/** A group of the list's own mark, in its own colour (`g-<group>` in the styles). */
const GROUP_ICON: Record<string, React.JSX.Element> = {
  // a screen on its stand
  slides: (
    <>
      <rect x="2" y="2.5" width="12" height="8" rx="1" />
      <path d="M8 10.5v3M5.5 13.5h5" />
    </>
  ),
  // axes and a curve
  plot: <path d="M2.5 2.5v11h11M5 10.5l2.5-3 2 1.5 3-4.5" />,
  // two boxes and the line between them
  diagram: (
    <>
      <rect x="2" y="2.5" width="5.5" height="3.5" rx=".8" />
      <rect x="8.5" y="10" width="5.5" height="3.5" rx=".8" />
      <path d="M4.5 6v3.7a2 2 0 0 0 2 2h2" />
    </>
  ),
  pdf: <path d="M4 2h5l3 3v9H4zM9 2v3h3" />,
  html: <path d="M5.5 4.5 2.5 8l3 3.5M10.5 4.5l3 3.5-3 3.5" />,
  // a globe
  url: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M2.5 8h11M8 2.5c-3 3-3 8 0 11M8 2.5c3 3 3 8 0 11" />
    </>
  ),
  md: <path d="M4 2h5l3 3v9H4zM9 2v3h3M6 8.5h4M6 11h4" />
}
function GroupIcon({ group }: { group: string }): React.JSX.Element {
  return (
    <svg className={`g-icon g-${group}`} viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {GROUP_ICON[group]}
    </svg>
  )
}

/** Follow the pointer from a press on a resize edge until it is let go. */
function followPointer(e: React.PointerEvent<HTMLElement>, move: (ev: PointerEvent) => void): void {
  if (e.button !== 0) return
  e.preventDefault()
  const el = e.currentTarget
  try {
    el.setPointerCapture(e.pointerId)
  } catch {
    /* synthetic events have no pointer to capture */
  }
  document.body.classList.add('resizing')
  let frame = 0
  const onMove = (ev: PointerEvent): void => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => move(ev))
  }
  const up = (): void => {
    el.removeEventListener('pointermove', onMove)
    el.removeEventListener('pointerup', up)
    el.removeEventListener('pointercancel', up)
    document.body.classList.remove('resizing')
  }
  el.addEventListener('pointermove', onMove)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)
}

/**
 * The edge between two files side by side (`across`) or two rows of them:
 * drag it and they share their room anew, double-click and they share it
 * evenly. `total` is their two shares together; `onShare` gets the first's.
 */
function TileSplit({ across, total, onShare }: { across: boolean; total: number; onShare: (first: number) => void }): React.JSX.Element {
  return (
    <div
      className={`tile-split ${across ? '' : 'rows'}`}
      title="Drag to resize · double-click to even out"
      onDoubleClick={() => onShare(total / 2)}
      onPointerDown={(e) => {
        const a = e.currentTarget.previousElementSibling?.getBoundingClientRect()
        const b = e.currentTarget.nextElementSibling?.getBoundingClientRect()
        if (!a || !b) return
        const from = across ? a.left : a.top
        const room = across ? b.right - a.left : b.bottom - a.top
        const least = Math.min(0.5, MIN_TILE / room)
        followPointer(e, (ev) => onShare(total * Math.min(1 - least, Math.max(least, ((across ? ev.clientX : ev.clientY) - from) / room))))
      }}
    />
  )
}

/** What the viewer's keys do to the file that has them. */
interface TileApi {
  zoomBy(factor: number): void
  fit(): void
  /** actual pixels of an image; 100% (96 dpi) for a PDF */
  actual(): void
  toggleSource(): void
  stage(): HTMLElement | null
  mdRoot(): HTMLElement | null
}

/** What a file dragged inside the viewer carries: its path, and the tile it was shown in. */
interface Dragged {
  path: string
  tile?: number
}

/** What a tile asks of the viewer around it. */
interface TileHost {
  host: string | undefined
  rel(path: string): string
  place(path: string): MediaPlace | 'web'
  /** the group of the list a file is in */
  group(it: MediaItem): string
  note(text: string): void
  save(it: MediaItem): void
  copyPath(it: MediaItem): void
  drag(e: React.DragEvent, it: MediaItem, tile?: number): void
  dragEnd(): void
  /** an HTML page may have taken the keyboard */
  pageFocus(): void
}

/**
 * One file in the viewer, fitted to its tile: an image or a PDF to zoom and
 * pan, a Markdown file to read, an HTML page running live. The tile's header
 * names it and says where it lives; a click on the path copies it.
 */
function MediaTile({
  tile,
  v,
  focused,
  solo,
  ahead,
  api,
  onFocus,
  onClose,
  onDropped
}: {
  tile: Tile
  v: TileHost
  focused: boolean
  /** the only file shown: nothing to close it for */
  solo: boolean
  /** the file → would show next: fetched ahead */
  ahead: MediaItem | undefined
  api: React.MutableRefObject<TileApi | null>
  onFocus: () => void
  onClose: () => void
  onDropped: (d: Dragged) => void
}): React.JSX.Element {
  const current = tile.item
  const { host } = v
  const [file, setFile] = useState<Loaded | null>(null)
  const [pdf, setPdf] = useState<PdfDoc | null>(null)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [stageSize, setStageSize] = useState({ w: 800, h: 600 })
  const [zoom, setZoom] = useState(1)
  // Markdown as its source text instead of rendered (⌘U)
  const [mdSource, setMdSource] = useState(false)
  const [over, setOver] = useState(false)
  const stage = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const mdRoot = useRef<HTMLElement>(null)
  const anchor = useRef<{ fx: number; fy: number; x: number; y: number } | null>(null)

  const prefetch = (): void => {
    // a page loads itself, from the host, when it is shown
    if (ahead && host && ahead.kind !== 'html' && ahead.kind !== 'url' && ahead.size <= PREFETCH_MAX) void window.kuna.media.fetch(host, ahead.path, stampOf(ahead))
  }

  // the file itself, and the next one in the background
  useEffect(() => {
    let url: string | undefined
    let cancelled = false
    setFile({ path: current.path })
    setPdf(null)
    setNatural(null)
    setZoom(1)
    // a web page loads itself, from the web
    if (!host || current.kind === 'url') return
    if (current.kind === 'html') {
      void window.kuna.media.page(host, current.path).then((res) => {
        if (cancelled) return
        setFile('error' in res ? { path: current.path, error: res.error } : { path: current.path, page: res.url })
        prefetch()
      })
      return () => {
        cancelled = true
      }
    }
    void window.kuna.media.fetch(host, current.path, stampOf(current)).then((res) => {
      if (cancelled) return
      if ('error' in res) return setFile({ path: current.path, error: res.error })
      if (current.kind === 'pdf') return setFile({ path: current.path, data: res.data })
      if (current.kind === 'md') {
        const text = new TextDecoder().decode(res.data)
        setFile({ path: current.path, html: renderMarkdown(text), text })
        prefetch()
        return
      }
      url = URL.createObjectURL(new Blob([res.data as BlobPart], { type: res.mime }))
      setFile({ path: current.path, url })
      prefetch()
    })
    stage.current?.scrollTo(0, 0)
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, host])

  useEffect(() => {
    if (!file?.data) return
    let cancelled = false
    const task = pdfjs.getDocument({ data: file.data.slice() })
    void task.promise
      .then(async (doc) => {
        // every page's size, so the whole document is laid out (and scrolls) from the start
        const sizes = await Promise.all(
          Array.from({ length: doc.numPages }, (_, i) =>
            doc.getPage(i + 1).then((page) => {
              const vp = page.getViewport({ scale: 1 })
              return { w: vp.width, h: vp.height }
            })
          )
        )
        if (!cancelled) setPdf({ doc, sizes })
        prefetch()
      })
      .catch((e: unknown) => !cancelled && setFile((f) => (f ? { ...f, error: `Could not render this PDF: ${String(e)}` } : f)))
    return () => {
      cancelled = true
      void task.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.data])

  // the pictures and diagrams of a Markdown file, once it is on screen
  useEffect(() => {
    const root = mdRoot.current
    if (file?.html == null || mdSource || !root || !host) return
    let live = true
    const urls: string[] = []
    const keep = (u: string[]): void => {
      if (live) urls.push(...u)
      else u.forEach((x) => URL.revokeObjectURL(x))
    }
    void loadMarkdownImages(root, host, file.path, () => live).then(keep)
    void renderDiagrams(root, () => live).then(keep)
    return () => {
      live = false
      urls.forEach((x) => URL.revokeObjectURL(x))
    }
  }, [file?.html, file?.path, host, mdSource])

  useEffect(() => {
    const el = stage.current
    if (!el) return
    const ro = new ResizeObserver(() => setStageSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // size at zoom 1: the whole plot (first page of a PDF) fits the tile
  const base = pdf ? pdf.sizes[0] : natural
  const fit = base ? Math.min((stageSize.w - 2 * PAD) / base.w, (stageSize.h - 2 * PAD) / base.h, pdf ? Infinity : MAX_FIT_UPSCALE) : 1
  const scale = fit * zoom
  const md = current.kind === 'md'
  const web = current.kind === 'url'
  const page = web || current.kind === 'html'

  /** Zoom by `factor`, keeping the point under (x, y) (default: the middle) where it is. */
  const zoomAt = useCallback((factor: number, x?: number, y?: number) => {
    const st = stage.current
    const c = content.current
    if (st && c) {
      const sr = st.getBoundingClientRect()
      const cr = c.getBoundingClientRect()
      const px = x ?? sr.left + sr.width / 2
      const py = y ?? sr.top + sr.height / 2
      anchor.current = { fx: (px - cr.left) / cr.width, fy: (py - cr.top) / cr.height, x: px - sr.left, y: py - sr.top }
    }
    setZoom((z) => clampZoom(z * factor))
  }, [])

  useLayoutEffect(() => {
    const a = anchor.current
    const st = stage.current
    const c = content.current
    anchor.current = null
    if (!a || !st || !c) return
    st.scrollLeft = c.offsetLeft + a.fx * c.offsetWidth - a.x
    st.scrollTop = c.offsetTop + a.fy * c.offsetHeight - a.y
  }, [zoom])

  // pinch on the trackpad (and ⌘/Ctrl + wheel) zooms; plain scrolling pans
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  // the viewer's keys act on the file that has them
  useEffect(() => {
    if (!focused) return
    const mine: TileApi = {
      zoomBy: zoomAt,
      fit: () => setZoom(1),
      actual: () => (md ? setZoom(1) : fit && zoomAt((pdf ? 96 / 72 : 1) / fit / zoom)),
      toggleSource: () => md && setMdSource((s) => !s),
      stage: () => stage.current,
      mdRoot: () => mdRoot.current
    }
    api.current = mine
    return () => {
      if (api.current === mine) api.current = null
    }
  })

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const st = stage.current
    // Markdown is text to select, not a picture to pan
    if (e.button !== 0 || !st || md) return
    const start = { x: e.clientX, y: e.clientY, left: st.scrollLeft, top: st.scrollTop }
    try {
      st.setPointerCapture(e.pointerId)
    } catch {
      /* synthetic events have no pointer to capture */
    }
    st.classList.add('panning')
    const move = (ev: PointerEvent): void => {
      st.scrollLeft = start.left - (ev.clientX - start.x)
      st.scrollTop = start.top - (ev.clientY - start.y)
    }
    const up = (): void => {
      st.removeEventListener('pointermove', move)
      st.removeEventListener('pointerup', up)
      st.classList.remove('panning')
    }
    st.addEventListener('pointermove', move)
    st.addEventListener('pointerup', up)
  }

  const ready = file?.path === current.path
  const path = v.rel(current.path)
  const name = web ? siteOf(path) : path.split('/').pop()
  const place = v.place(current.path)
  // buttons leave the keyboard where it is
  const still = (e: React.MouseEvent): void => e.preventDefault()

  return (
    <section
      className={`media-tile ${focused ? 'focused' : ''} ${over ? 'drop-target' : ''}`}
      data-tile={tile.id}
      style={{ flex: `${tile.w} 1 0` }}
      onMouseDownCapture={onFocus}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(MEDIA_DRAG)) return
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
      }}
      onDrop={(e) => {
        setOver(false)
        const d = e.dataTransfer.getData(MEDIA_DRAG)
        if (!d) return
        e.preventDefault()
        onDropped(JSON.parse(d) as Dragged)
      }}
    >
      <div
        className="tile-head"
        draggable
        title="Drag onto another file to swap them, or onto the agent for its path · ⌥-drag takes a copy out of Kuna"
        onDragStart={(e) => v.drag(e, current, tile.id)}
        onDragEnd={v.dragEnd}
      >
        <GroupIcon group={v.group(current)} />
        <span className={`place place-${place}`} title={PLACE[place][1]}>
          {PLACE[place][0]}
        </span>
        <span className="tile-name">{name}</span>
        <button className="tile-path" title={`${current.path}\nClick to copy the path (⇧⌘C)`} onMouseDown={still} onClick={() => v.copyPath(current)}>
          {path}
        </button>
        <span className="ph-spacer" />
        <span className="media-meta">
          {web ? '⌘O opens it in your browser' : `${ago(current.mtime)} ago · ${bytes(current.size)}`}
          {page ? '' : ` · ${pdf && pdf.sizes.length > 1 ? `${pdf.sizes.length} pages · ` : ''}`}
          {page ? '' : md ? `${Math.round(zoom * 100)}%` : zoom === 1 ? 'fit' : `${zoom < 1 ? zoom.toFixed(2) : zoom.toFixed(1)}×`}
        </span>
        {md && (
          <>
            <button className="media-save" title="Switch between the rendered page and the Markdown source (⌘U)" onMouseDown={still} onClick={() => setMdSource((s) => !s)}>
              {mdSource ? 'Rendered' : 'Source'}
            </button>
            <button
              className="media-save"
              title="Copy the whole file as Markdown (⌘A then ⌘C copies what you see)"
              onMouseDown={still}
              onClick={() => {
                if (file?.text == null) return
                window.kuna.copyText(file.text)
                v.note(`Copied ${name} as Markdown`)
              }}
            >
              Copy
            </button>
          </>
        )}
        {!web && (
          <button className="media-save" title="Save a copy in your Downloads folder (⌘S)" onMouseDown={still} onClick={() => v.save(current)}>
            Save
          </button>
        )}
        {!solo && (
          <button className="media-save tile-close" title="Close this file (⌘W)" onMouseDown={still} onClick={onClose}>
            ×
          </button>
        )}
      </div>
      <div
        className={`media-stage ${base && (base.w * scale > stageSize.w || base.h * scale > stageSize.h) ? 'can-pan' : ''}`}
        ref={stage}
        onPointerDown={onPointerDown}
        // a plot is panned, not selected (Markdown is text to select)
        onMouseDown={(e) => !md && e.preventDefault()}
        onDoubleClick={(e) => !md && (zoom === 1 ? zoomAt(2.5, e.clientX, e.clientY) : setZoom(1))}
      >
        {ready && file?.error && <div className="media-msg">{file.error}</div>}
        {ready && file?.page && (
          <iframe
            key={`${current.path}:${stampOf(current)}`}
            // a page that grabs the keyboard as it loads doesn't keep it: until a second after its load event
            ref={(el) => {
              if (el && !el.dataset.until) el.dataset.until = String(Date.now() + 10_000)
            }}
            className="media-page"
            src={file.page}
            title={path}
            // scripts run, on the folder's own origin; no leaving the frame (top navigation, popups, downloads), no alert() boxes passing for Kuna's
            sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"
            onFocus={v.pageFocus}
            onLoad={(e) => {
              e.currentTarget.dataset.until = String(Date.now() + 1000)
              v.pageFocus()
            }}
          />
        )}
        {web && (
          // the page itself, from the web, in a guest of its own: no way into Kuna's window, and what the main process allows a guest
          <webview key={current.path} className="media-page" src={current.path} partition={WEB_PARTITION} allowpopups onFocus={v.pageFocus} />
        )}
        {ready && current.size > SLOW_FILE &&!file?.error && !file?.url && !file?.page && !pdf && file?.html == null && (
          <div className="media-msg">
            Loading {name}, {bytes(current.size)}
            {host && host !== 'local' ? `, from ${host}` : ''}…
          </div>
        )}
        {ready && (file?.url || pdf || file?.html != null) && (
          <div className="zoom-area" style={{ padding: PAD }}>
            <div className="zoom-content" ref={content}>
              {file?.url && (
                <img
                  className="media-img"
                  src={file.url}
                  alt={current.path}
                  draggable={false}
                  onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth || 800, h: e.currentTarget.naturalHeight || 600 })}
                  style={
                    natural
                      ? { width: natural.w * scale, height: natural.h * scale, imageRendering: scale >= 4 ? 'pixelated' : 'auto' }
                      : { visibility: 'hidden' }
                  }
                />
              )}
              {pdf && <PdfPages pdf={pdf} scale={scale} root={stage.current} />}
              {file?.html != null &&
                (mdSource ? (
                  <article className="md media-md md-source" ref={mdRoot} style={{ zoom, maxWidth: stageSize.w - 2 * PAD }}>
                    <pre>{file.text}</pre>
                  </article>
                ) : (
                  <article className="md media-md" ref={mdRoot} style={{ zoom, maxWidth: stageSize.w - 2 * PAD }} dangerouslySetInnerHTML={{ __html: file.html }} />
                ))}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

const VIEW_KEYS = '← → files · Tab the list · Enter the agent · ⌘Enter beside · Space close'
const LIST_KEYS = '↑ ↓ files · Tab the file · Enter the agent · ⌘Enter beside · Space close'
/** every key, on hover over the short line */
const ALL_KEYS = [
  '← →  the file before, after (→ past the last loads more)',
  'Tab, or a click  the keys are the list’s or the file’s (the blue edge)',
  '↑ ↓  scroll the file · in the list: the file above, below',
  'PgUp PgDn  scroll the file',
  'Enter  write to the agent · Esc Esc back to the files',
  '⌘Enter  another file beside this one · ⌘click in the list too',
  '⌥ arrows  the file beside, above, below · ⌘W closes it',
  '⌘+ ⌘− ⌘0 ⌘1  zoom in, out, fit, actual size',
  "⇧⌘C  copy the file's path · ⌘P  its path into your message",
  '⌘U  Markdown source · ⌘A ⌘C  select all, copy',
  '⌘O open · ⌘S save to Downloads · ⌘R reload · ⌘. interrupt the agent',
  'Space or Esc  close'
].join('\n')
const noTyped = (): void => {}

/**
 * The files an agent made or named: plots, PDFs, HTML pages and Markdown, up
 * to six side by side, with the list of them (by kind) and the agent itself
 * on the right. The keyboard is the files' until Enter or a click on the
 * agent gives it to the agent; Esc Esc (or sending) gives it back.
 */
export function MediaViewer({ agentKey }: { agentKey: string }): React.JSX.Element {
  const agent = useKuna((s) => s.agents[agentKey])
  const host = agent?.host
  const [items, setItems] = useState<MediaItem[] | null>(null)
  const [next, setNext] = useState<MediaPage['next']>(null)
  const [busy, setBusy] = useState<string | null>('Looking at the latest reply…')
  // an arrangement of several files comes back; a single file gives way to the latest reply's first
  const layout = useRef(kept.get(agentKey)).current
  const arranged = layout && layout.tiles.length > 1 ? layout : undefined
  const [tiles, setTiles] = useState<Tile[]>(arranged?.tiles ?? [])
  /** each row's share of the height (1 unless dragged) */
  const [heights, setHeights] = useState<number[]>(arranged?.heights ?? [])
  const [focusAt, setFocus] = useState(arranged?.focus ?? 0)
  /** the groups of the list that are rolled out: none until you open one */
  const [opened, setOpened] = useState<string[]>(layout?.opened ?? [])
  const focus = Math.max(0, Math.min(focusAt, tiles.length - 1))
  const current = tiles[focus]?.item
  const rows = gridRows(tiles.length)
  const rel = (p: string): string => (agent && p.startsWith(agent.cwd + '/') ? p.slice(agent.cwd.length + 1) : p)
  const list = useRef<HTMLElement>(null)
  const active = useRef<TileApi | null>(null)
  // the agent's terminal beside the files: on now unless it is a stopped background session
  const [live, setLive] = useState(() => {
    const a = get().agents[agentKey]
    return !!terminalEntry(agentKey) || (!!a && (a.alive || a.kind === 'tmux'))
  })
  // a stopped session is brought back by Enter, which is also what gives it the keyboard
  const startedLive = useRef(live).current
  const [note, setNote] = useState<string | null>(null)
  const savedSide = useKuna((s) => s.settings.viewerChatWidth)
  const escHint = useKuna((s) => s.escHint)
  // the agent has the keyboard (Enter, or a click on it)
  const [inChat, setInChat] = useState(false)
  const wasTyping = useRef(false)
  // an HTML page has the keyboard (after a click in it): its keys are its own, until Esc
  const [inPage, setInPage] = useState(false)
  // ↑ ↓ are the list's (they walk it) or the file's (they scroll it): where the last click was, or Tab
  const [zone, setZone] = useState<'view' | 'list'>('view')
  const listShare = useKuna((s) => s.settings.viewerListShare)
  // PDFs read so far (`pdfKinds`): a count, so the list regroups as each is known
  const [, setRead] = useState(0)
  // a file is being dragged: pages let the drop through to their tile
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    kept.set(agentKey, { tiles, heights, focus, opened })
  }, [agentKey, tiles, heights, focus, opened])

  const checkFocus = useRef(() => {})
  checkFocus.current = () => {
    const el = document.activeElement
    // an HTML page's frame, or a web page's guest
    const frame = el instanceof HTMLElement && el.classList.contains('media-page') ? el : null
    if (frame && Date.now() < Number(frame.dataset.until)) {
      // grabbed as the page loaded: back to whoever had it
      frame.blur()
      if (wasTyping.current) terminalEntry(agentKey)?.term.focus()
      return setInPage(false)
    }
    if (frame) {
      const at = tiles.findIndex((t) => String(t.id) === frame.closest<HTMLElement>('[data-tile]')?.dataset.tile)
      if (at >= 0) setFocus(at)
    }
    setInPage(!!frame)
  }

  // a frame's keys never reach the window: notice the page taking the keyboard, and its Esc giving it back
  useEffect(() => {
    const check = (): void => checkFocus.current()
    const blur = (): void => void setTimeout(check)
    const back = window.kuna.media.onPageEscape(() => {
      ;(document.activeElement as HTMLElement | null)?.blur()
      check()
    })
    window.addEventListener('blur', blur)
    window.addEventListener('focus', check)
    return () => {
      back()
      window.removeEventListener('blur', blur)
      window.removeEventListener('focus', check)
    }
  }, [])

  /** Load pages until something new turns up (or nothing is left), and append it. */
  const loadMore = useCallback(
    /** returns the first new file, if any */
    async (page: NonNullable<MediaPage['next']> | Record<string, never>, have: MediaItem[]): Promise<MediaItem | undefined> => {
      let p: MediaPage['next'] | Record<string, never> = page
      let fresh: MediaItem[] = []
      while (p && !fresh.length) {
        setBusy('scan' in p ? 'Scanning the folder for plots…' : 'before' in p ? 'Looking at earlier replies…' : 'Looking at the latest reply…')
        const res = await window.kuna.media.list(agentKey, p)
        const seen = new Set(have.map((it) => it.path))
        fresh = res.items.filter((it) => !seen.has(it.path))
        p = res.next
        // nothing in the conversation at all: go straight to the folder scan
        if (!fresh.length && !p) break
      }
      setNext((p as MediaPage['next']) ?? null)
      setBusy(null)
      const web = (webPages.get(agentKey) ?? []).filter((w) => !have.includes(w))
      const all = viewerOrder([...have, ...fresh, ...web])
      setItems(all)
      // the files shown stay, as the list now has them (a re-made plot is read again); with none shown, the first is
      setTiles((ts) => (ts.length ? ts.map((t) => ({ ...t, item: all.find((it) => it.path === t.item.path) ?? t.item })) : all[0] ? [newTile(all[0])] : ts))
      return fresh[0]
    },
    [agentKey]
  )

  const refresh = useCallback(async () => {
    setItems(null)
    await loadMore({}, [])
  }, [loadMore])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // what each PDF is: one at a time, so the file in view keeps one of the host's two command slots
  useEffect(() => {
    if (!host || !items) return
    let live = true
    void (async () => {
      for (const it of items) {
        const k = pdfKey(host, it)
        if (it.kind !== 'pdf' || pdfKinds.has(k)) continue
        pdfKinds.set(k, null) // being read: not read twice
        pdfKinds.set(k, await readPdfClass(host, it))
        if (!live) return
        setRead((n) => n + 1)
      }
    })()
    return () => {
      live = false
    }
  }, [host, items])
  const grouped = fileGroups(items ?? [], (it) => (host ? pdfKinds.get(pdfKey(host, it)) : undefined))
  const groupOf = (it: MediaItem): string => (host ? grouped(it) : mediaGroup(it.kind))

  /** Show a file where the keyboard is (or in tile `at`); `beside`: in a tile of its own, next to it. */
  const show = (it: MediaItem, beside = false, at = focus): void => {
    if (beside && tiles.length >= MAX_TILES) setNote(`At most ${MAX_TILES} files side by side: it took this one's place`)
    if (beside && tiles.length && tiles.length < MAX_TILES) {
      setTiles((ts) => [...ts.slice(0, at + 1), newTile(it), ...ts.slice(at + 1)])
      setFocus(at + 1)
    } else {
      setTiles((ts) => (ts.length ? ts.map((t, i) => (i === at ? { ...t, item: it } : t)) : [newTile(it)]))
      setFocus(at)
    }
  }

  // ⌘click on an address in the agent's terminal (on its pane, or here beside the files): that page, where the keyboard is
  const overlay = useKuna((s) => s.overlay)
  useEffect(() => {
    const url = overlay?.kind === 'media' ? overlay.url : undefined
    if (!url) return
    const mine = webPages.get(agentKey) ?? []
    const it: MediaItem = mine.find((w) => w.path === url) ?? { path: url, kind: 'url', mtime: Date.now(), size: 0 }
    webPages.set(agentKey, [it, ...mine.filter((w) => w !== it)])
    // still loading: the list takes it from `webPages` when it comes
    setItems((have) => (have && !have.includes(it) ? viewerOrder([...have, it]) : have))
    show(it)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentKey, overlay])

  const closeTile = (at: number): void => {
    if (tiles.length <= 1) return closeOverlay()
    setTiles((ts) => ts.filter((_, i) => i !== at))
    if (at < focus) setFocus(focus - 1)
  }

  /** A file dropped on tile `at`: one from the list opens beside it, another tile changes places with it. */
  const dropped = (d: Dragged, at: number): void => {
    const from = tiles.findIndex((t) => t.id === d.tile)
    if (from >= 0) {
      // the files change places; each place keeps its width
      if (from !== at) setTiles((ts) => ts.map((t, i) => (i === at ? { ...ts[from], w: t.w } : i === from ? { ...ts[at], w: t.w } : t)))
      return setFocus(at)
    }
    const it = items?.find((x) => x.path === d.path)
    if (it) show(it, true, at)
  }

  // what ← → walk through: every file in the list's order, also those of groups not rolled out
  const shown = viewerOrder(items ?? [], groupOf)
  const at = shown.findIndex((it) => it.path === current?.path)

  const step = async (d: 1 | -1): Promise<void> => {
    const to = shown[at + d]
    if (to) return show(to)
    if (d < 0 || !items || !next || busy) return
    const fresh = await loadMore(next, items)
    if (fresh) show(fresh)
  }

  /** The list's button: more files now, wherever you are in the list; the files in view stay. */
  const more = async (): Promise<void> => {
    if (!items || !next || busy) return
    const fresh = await loadMore(next, items)
    // once they are in the list, the first new one is in sight
    setTimeout(() => [...(list.current?.querySelectorAll<HTMLElement>('[data-path]') ?? [])].find((b) => b.dataset.path === fresh?.path)?.scrollIntoView({ block: 'nearest' }))
  }

  // the file that has the keyboard stays in sight in the list
  useEffect(() => {
    list.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' })
  }, [current?.path])

  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(null), 4000)
    return () => clearTimeout(t)
  }, [note])

  /** Enter: what is typed goes to the agent; ⇧Enter a new line in it */
  const enter = (key: string, shift: boolean): void => {
    if (shift) {
      writeToAgent(key, '\x1b\r')
      return
    }
    const e = terminalEntry(key)
    // sent: the keyboard is the files' again, as a pane leaves typing (a slash command's panel and a run of questions keep it)
    enterToAgent(
      key,
      () => !!e && e.el.contains(document.activeElement),
      () => e?.term.blur()
    )
  }

  /** Into the agent's input box, out of tmux's scroll mode first. */
  const toAgent = (write: () => void): void => {
    const e = terminalEntry(agentKey)
    if (!e?.ptyId) return
    e.term.focus()
    const leaving = leaveScroll(agentKey)
    if (leaving) void leaving.then(write)
    else write()
  }

  const copyPath = (it: MediaItem): void => {
    window.kuna.copyText(it.path)
    setNote(`Copied the path of ${it.path.split('/').pop()}`)
  }

  const save = (it: MediaItem): void => {
    if (!host) return
    void window.kuna.media.save(host, it.path, stampOf(it)).then((res) => setNote('error' in res ? res.error : `Saved to Downloads as ${res.file.split('/').pop()}`))
  }

  const v: TileHost = {
    host,
    rel,
    place: (p) => (/^https?:\/\//i.test(p) ? 'web' : mediaPlace(agent?.worktree ?? agent?.cwd ?? '', p)),
    group: groupOf,
    note: setNote,
    save,
    copyPath,
    drag: (e, it, tile) => {
      if (e.altKey) {
        // out of Kuna as a file: the system's own drag takes over
        e.preventDefault()
        if (host) void window.kuna.media.drag(host, it.path, stampOf(it)).then((why) => why && setNote(why))
        return
      }
      e.dataTransfer.setData(MEDIA_DRAG, JSON.stringify({ path: it.path, tile } satisfies Dragged))
      e.dataTransfer.effectAllowed = 'copyMove'
      setDragging(true)
    },
    dragEnd: () => setDragging(false),
    pageFocus: () => checkFocus.current()
  }

  /**
   * The keys are the files': ← → walk the list in the tile that has the
   * keyboard, ↑ ↓ scroll it (or walk the list too, once a click on the list or
   * Tab made them the list's), ⌥ arrows go to the tile beside, Space and Esc
   * close. Enter (or a click on the agent) gives the keyboard to the agent,
   * as typing on a pane: Enter sends and gives it back, Esc goes to the agent
   * and Esc Esc gives it back with what was typed taken out. Zoom and the
   * rest are ⌘ keys, as in Preview, wherever the keyboard is.
   */
  useOverlayKeys((ev) => {
    const e = terminalEntry(agentKey)
    const term = e?.ptyId ? e : undefined
    // the agent's terminal has the keyboard
    const typing = !!e && e.el.contains(document.activeElement)
    wasTyping.current = typing
    const tile = active.current
    if (ev.metaKey && !ev.ctrlKey) {
      switch (ev.key.toLowerCase()) {
        case '+':
        case '=':
          tile?.zoomBy(1.25)
          return true
        case '-':
          tile?.zoomBy(0.8)
          return true
        case '0':
          tile?.fit()
          return true
        case '1':
          tile?.actual()
          return true
        case 'c': {
          if (ev.shiftKey) {
            if (current) copyPath(current)
            return true
          }
          // what is selected in a Markdown file, by Kuna itself (as in the panes)
          const sel = getSelection()
          if (sel && !sel.isCollapsed && tile?.mdRoot()?.contains(sel.anchorNode)) {
            window.kuna.copyText(sel.toString())
            return true
          }
          // else the text selected in the agent (Option+drag), or the usual copy
          return copyTerminalSelection(agentKey)
        }
        case 'a': {
          // all of a Markdown file (rendered or source), ready for ⌘C
          const root = tile?.mdRoot()
          if (!root) return true
          e?.term.blur()
          getSelection()?.selectAllChildren(root)
          return true
        }
        case 'v':
          // a paste goes to the agent: the terminal takes it when it has the keyboard
          if (typing) return false
          void window.kuna.clipboardText().then((text) => text && toAgent(() => terminalEntry(agentKey)?.term.paste(text)))
          return true
        case 'p':
          // the file's path, into what you are writing to the agent
          if (current) toAgent(() => terminalEntry(agentKey)?.term.paste(rel(current.path)))
          return true
        case '.':
          // interrupt the agent, as on a pane
          sendEsc(agentKey)
          setNote('Sent Esc to the agent')
          return true
        case 'u':
          tile?.toggleSource()
          return true
        case 'o':
          // a web page: in your browser (the window hands it over)
          if (current?.kind === 'url') window.open(current.path)
          else if (current && host) void window.kuna.media.openExternal(host, current.path, stampOf(current))
          return true
        case 's':
          if (current && current.kind !== 'url') save(current)
          return true
        case 'r':
          void refresh()
          return true
        case 'w':
          closeTile(focus)
          return true
        case 'enter': {
          // another file beside this one: the next in the list that is not shown yet
          const open = new Set(tiles.map((t) => t.item.path))
          const it = [...shown.slice(at + 1), ...shown.slice(0, Math.max(0, at))].find((x) => !open.has(x.path))
          if (it) show(it, true)
          else setNote('Every file in the list is shown already')
          return true
        }
      }
      // ⌘← ⌘→ start and end of the line, as on a pane
      if (term && typing && typeToAgent(agentKey, ev, enter)) return true
      return typing ? false : true // ⌘⌫ … go to the terminal
    }
    switch (ev.key) {
      case 'PageDown':
      case 'PageUp': {
        const st = tile?.stage()
        st?.scrollBy({ top: (ev.key === 'PageUp' ? -0.9 : 0.9) * st.clientHeight })
        return true
      }
    }
    if (typing && e) {
      if (ev.key === 'Escape') {
        // as on a pane: a panel or question takes every Esc; else the first goes to the agent and a second right after leaves it
        if (term && panelOnScreen(agentKey)) sendEsc(agentKey)
        else if (!term || escPressed()) {
          discardTyped(e)
          e.term.blur()
        } else escToAgent(agentKey)
        return true
      }
      // Enter, and keys that take tmux out of scroll mode first; the terminal takes the rest
      return !!term && typeToAgent(agentKey, ev, enter)
    }
    if (ev.altKey && ev.key.startsWith('Arrow')) {
      const to = neighbor(rows, focus, ev.key.slice(5).toLowerCase() as Direction)
      if (typeof to === 'number') setFocus(to)
      return true
    }
    switch (ev.key) {
      case 'ArrowRight':
        void step(1)
        return true
      case 'ArrowLeft':
        void step(-1)
        return true
      case 'ArrowDown':
        if (zone === 'list') void step(1)
        else tile?.stage()?.scrollBy({ top: 160 })
        return true
      case 'ArrowUp':
        if (zone === 'list') void step(-1)
        else tile?.stage()?.scrollBy({ top: -160 })
        return true
      case 'Tab':
        setZone(zone === 'list' ? 'view' : 'list')
        return true
      case 'Enter':
        // to the agent; a stopped background session comes back here first
        if (!live && agent) setLive(true)
        else e?.term.focus()
        return true
      case ' ':
        closeOverlay()
        return true
      case 'Escape':
        return false // closes the viewer
    }
    return true // letters are nobody's until Enter gives the agent the keyboard
  })

  const side = Math.round(Math.min(savedSide ?? sideWidth(), window.innerWidth * MAX_SIDE_SHARE))
  const open = new Set(tiles.map((t) => t.item.path))
  let n = 0

  return (
    <div className={`media-overlay keys-${inPage ? 'page' : inChat ? 'chat' : zone} ${dragging ? 'dragging' : ''}`} style={{ '--side-w': `${side}px` } as React.CSSProperties}>
      <header className="media-head">
        <span className="media-count">{items ? `${items.length}${next ? '+' : ''} file${items.length === 1 ? '' : 's'}` : '…'}</span>
        <span className="media-name">Plots, PDFs, pages & Markdown</span>
        <span className="ph-spacer" />
        {busy && items && <span className="media-meta">{busy}</span>}
        {note ? (
          <span className="media-note">{note}</span>
        ) : (
          <span className="media-keys" title={ALL_KEYS}>
            {inPage
              ? 'the page has the keyboard · Esc gives it back'
              : inChat
                ? escHint
                  ? 'Esc again: back to the files'
                  : 'writing to the agent · Enter sends · ⇧Enter new line · Esc Esc back to the files'
                : zone === 'list'
                  ? LIST_KEYS
                  : VIEW_KEYS}
          </span>
        )}
      </header>
      <div className="media-body">
        <div className="media-tiles">
          {!tiles.length && busy && <div className="media-msg">{busy}</div>}
          {!tiles.length && !busy && (
            <div className="media-msg">
              No plots, PDFs, HTML pages or Markdown files yet. Kuna looks at the paths in the agent's replies and tool calls, newest first, and
              then at plots and notes written in its folder since it started.
            </div>
          )}
          {rows.map((count, r) => {
            const first = n
            n += count
            const sum = (heights[r - 1] ?? 1) + (heights[r] ?? 1)
            return (
              <Fragment key={r}>
                {r > 0 && (
                  <TileSplit
                    across={false}
                    total={sum}
                    onShare={(h) => setHeights(rows.map((_, i) => (i === r - 1 ? h : i === r ? sum - h : (heights[i] ?? 1))))}
                  />
                )}
                <div className="tile-row" style={{ flex: `${heights[r] ?? 1} 1 0` }}>
                  {tiles.slice(first, first + count).map((t, c) => {
                    const i = first + c
                    const both = (tiles[i - 1]?.w ?? 1) + t.w
                    return (
                      <Fragment key={t.id}>
                        {c > 0 && (
                          <TileSplit
                            across
                            total={both}
                            onShare={(w) => setTiles((ts) => ts.map((x, k) => (k === i - 1 ? { ...x, w } : k === i ? { ...x, w: both - w } : x)))}
                          />
                        )}
                        <MediaTile
                          tile={t}
                          v={v}
                          focused={i === focus}
                          solo={tiles.length === 1}
                          ahead={i === focus ? shown[at + 1] : undefined}
                          api={active}
                          onFocus={() => {
                            setFocus(i)
                            setZone('view')
                            // a click on a file takes the keyboard back from the agent
                            terminalEntry(agentKey)?.term.blur()
                          }}
                          onClose={() => closeTile(i)}
                          onDropped={(d) => dropped(d, i)}
                        />
                      </Fragment>
                    )
                  })}
                </div>
              </Fragment>
            )
          })}
        </div>
        <div
          className="media-split"
          onPointerDown={(e) =>
            followPointer(e, (ev) =>
              updateSettings({
                viewerChatWidth: Math.round(Math.max(MIN_SIDE, Math.min(window.innerWidth - ev.clientX, window.innerWidth * MAX_SIDE_SHARE)))
              })
            )
          }
          onDoubleClick={() => updateSettings({ viewerChatWidth: undefined })}
          title="Drag to resize · double-click to reset"
        />
        <aside className="media-side">
          {items && items.length > 0 && (
            <nav
              className="media-files"
              ref={list}
              style={listShare ? { height: `${listShare * 100}%`, maxHeight: 'none' } : undefined}
              onMouseDownCapture={() => setZone('list')}
            >
              {MEDIA_GROUPS.map(([group, label]) => {
                const files = items.filter((it) => groupOf(it) === group)
                if (!files.length) return null
                const shut = !opened.includes(group)
                return (
                  <Fragment key={group}>
                    <button
                      // rolled in, it still says that the file in view is one of its
                      className={`mf-group g-${group} ${current && groupOf(current) === group ? 'has-on' : ''}`}
                      aria-expanded={!shut}
                      onClick={(e) => {
                        e.currentTarget.blur()
                        setOpened((o) => (o.includes(group) ? o.filter((g) => g !== group) : [...o, group]))
                      }}
                    >
                      <span className="mf-fold">{shut ? '▸' : '▾'}</span>
                      <GroupIcon group={group} />
                      {label}
                      <span className="mf-n">{files.length}</span>
                    </button>
                    {!shut &&
                      files.map((it) => {
                        const path = rel(it.path)
                        const cut = path.lastIndexOf('/')
                        // a web page goes by its site, with the rest of its address after
                        const site = it.kind === 'url' ? siteOf(path) : undefined
                        const place = v.place(it.path)
                        return (
                          <button
                            key={it.path}
                            data-path={it.path}
                            className={it.path === current?.path ? 'on' : open.has(it.path) ? 'open' : ''}
                            title={`${it.path}\nClick shows it · ⌘click beside the others · right-click copies its path\nDrag it onto a file to open it beside, onto the agent for its path · ⌥-drag takes a copy out of Kuna`}
                            draggable
                            onDragStart={(e) => v.drag(e, it)}
                            onDragEnd={v.dragEnd}
                            onClick={(e) => {
                              // the keyboard is the files' after a click on one
                              e.currentTarget.blur()
                              show(it, e.metaKey)
                            }}
                            onContextMenu={(e) => {
                              e.preventDefault()
                              copyPath(it)
                            }}
                          >
                            <span className={`place place-${place}`} title={PLACE[place][1]}>
                              {PLACE[place][0]}
                            </span>
                            <span className="mf-name">{site ?? path.slice(cut + 1)}</span>
                            <span className="mf-dir">{site ? path.slice(path.indexOf(site) + site.length) : cut > 0 ? path.slice(0, cut) : ''}</span>
                            <span className="mf-age">{ago(it.mtime)}</span>
                          </button>
                        )
                      })}
                  </Fragment>
                )
              })}
              {next && (
                <button className="mf-more" onClick={(e) => (e.currentTarget.blur(), void more())} disabled={!!busy}>
                  {busy ?? ('scan' in next ? 'Scan the folder for more →' : 'Earlier replies →')}
                </button>
              )}
            </nav>
          )}
          {items && items.length > 0 && (
            <div
              className="tile-split rows side-split"
              title="Drag to give the list or the agent more room · double-click for the list's own height"
              onDoubleClick={() => updateSettings({ viewerListShare: undefined })}
              onPointerDown={(e) => {
                const side = e.currentTarget.parentElement!.getBoundingClientRect()
                followPointer(e, (ev) => updateSettings({ viewerListShare: Math.round(Math.min(0.8, Math.max(0.1, (ev.clientY - side.top) / side.height)) * 1000) / 1000 }))
              }}
            />
          )}
          <div
            className={`media-chat-wrap ${dragging ? 'drop-here' : ''}`}
            onFocus={() => setInChat(true)}
            onBlur={() => setInChat(false)}
            onDragOver={(e) => e.dataTransfer.types.includes(MEDIA_DRAG) && e.preventDefault()}
            onDrop={(e) => {
              const d = e.dataTransfer.getData(MEDIA_DRAG)
              if (!d) return
              e.preventDefault()
              // its path, into what you are writing to the agent
              toAgent(() => terminalEntry(agentKey)?.term.paste(rel((JSON.parse(d) as Dragged).path)))
            }}
          >
            <AgentChat
              agentKey={agentKey}
              live={live}
              onTyped={noTyped}
              autoFocus={!startedLive}
              hint={escHint ? 'Esc again: back to the files' : 'writing to the agent · Enter sends · Esc Esc back to the files'}
            />
          </div>
        </aside>
      </div>
    </div>
  )
}

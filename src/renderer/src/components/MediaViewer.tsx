import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { viewerOrder } from '@shared/media'
import type { MediaItem, MediaPage } from '@shared/types'
import { discardTyped, leaveScroll, sendEsc } from '../actions'
import { agentTitle, ago, bytes, doingText } from '../format'
import { isPrintable, panelOnScreen, typeToAgent } from '../keys'
import { loadMarkdownImages, renderDiagrams, renderMarkdown } from '../markdown'
import { cmdKey, keyLabel } from '../platform'
import { get, updateSettings, useKuna } from '../store'
import { copyTerminalSelection, disposeTerminal, fitTerminal, getTerminal, terminalEntry, writeToAgent } from '../terminals'
import { folderOfAgent } from '../tree'
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
const CURSOR_KEY: Record<string, string> = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D' }

/** What a key sends to the agent's terminal, for the keys the viewer types there itself. */
function keyBytes(ev: KeyboardEvent, appCursor: boolean): string | undefined {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return undefined
  if (CURSOR_KEY[ev.key]) return (appCursor ? '\x1bO' : '\x1b[') + CURSOR_KEY[ev.key]
  if (ev.key === 'Enter') return '\r'
  if (ev.key === 'Tab') return ev.shiftKey ? '\x1b[Z' : '\t'
  if (ev.key === 'Backspace') return '\x7f'
  return ev.key.length === 1 ? ev.key : undefined
}

interface Loaded {
  path: string
  url?: string
  data?: Uint8Array
  /** a Markdown file, rendered and sanitised, and its source */
  html?: string
  text?: string
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
 * goes straight to the agent. A stopped background session only comes back
 * on Enter (`live`), since attaching starts it again.
 */
function AgentChat({
  agentKey,
  live,
  hint,
  onTyped
}: {
  agentKey: string
  live: boolean
  hint: string
  onTyped: (n: number) => void
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
    slot.current?.appendChild(e.el)
    e.typed = 0
    onTyped(0)
    fitTerminal(agentKey)
    e.term.focus()
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
          {a ? 'This session is stopped. Enter brings it back here, to talk to it.' : 'This agent is gone.'}
        </div>
      )}
      {focused && <div className="typing-hint">{hint}</div>}
    </section>
  )
}

export function MediaViewer({ agentKey }: { agentKey: string }): React.JSX.Element {
  const agent = useKuna((s) => s.agents[agentKey])
  const host = agent?.host
  const [items, setItems] = useState<MediaItem[] | null>(null)
  const [next, setNext] = useState<MediaPage['next']>(null)
  const [busy, setBusy] = useState<string | null>('Looking at the latest reply…')
  const [index, setIndex] = useState(0)
  const [file, setFile] = useState<Loaded | null>(null)
  const [pdf, setPdf] = useState<PdfDoc | null>(null)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [stageSize, setStageSize] = useState({ w: 1200, h: 800 })
  const [zoom, setZoom] = useState(1)
  const rel = (p: string): string => (agent && p.startsWith(agent.cwd + '/') ? p.slice(agent.cwd.length + 1) : p)
  const stage = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const mdRoot = useRef<HTMLElement>(null)
  const anchor = useRef<{ fx: number; fy: number; x: number; y: number } | null>(null)
  const list = useRef<HTMLElement>(null)
  // the agent's terminal beside the file: on now unless it is a stopped background session
  const [live, setLive] = useState(() => {
    const a = get().agents[agentKey]
    return !!terminalEntry(agentKey) || (!!a && (a.alive || a.kind === 'tmux'))
  })
  // characters typed to the agent since the viewer opened or last sent: the keys are its then
  const [typed, setTyped] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const savedSide = useKuna((s) => s.settings.viewerChatWidth)
  // Markdown as its source text instead of rendered (⌘U), kept while the viewer is open
  const [mdSource, setMdSource] = useState(false)

  /** Load pages until something new turns up (or nothing is left), and append it. */
  const loadMore = useCallback(
    /** returns where the first new file landed (-1: none) */
    async (page: NonNullable<MediaPage['next']> | Record<string, never>, have: MediaItem[]): Promise<number> => {
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
      // PDFs stay ahead of all images, also as more turn up
      const all = viewerOrder([...have, ...fresh])
      setItems(all)
      return all.indexOf(fresh[0])
    },
    [agentKey]
  )

  const refresh = useCallback(async () => {
    setItems(null)
    setIndex(0)
    await loadMore({}, [])
  }, [loadMore])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const current = items?.[index]
  const prefetch = (it: MediaItem | undefined): void => {
    if (it && host && it.size <= PREFETCH_MAX) void window.kuna.media.fetch(host, it.path, stampOf(it))
  }

  // the file itself, and the next one in the background
  useEffect(() => {
    if (!current || !host) return
    let url: string | undefined
    let cancelled = false
    setFile({ path: current.path })
    setPdf(null)
    setNatural(null)
    setZoom(1)
    void window.kuna.media.fetch(host, current.path, stampOf(current)).then((res) => {
      if (cancelled) return
      if ('error' in res) return setFile({ path: current.path, error: res.error })
      if (current.kind === 'pdf') return setFile({ path: current.path, data: res.data })
      if (current.kind === 'md') {
        const text = new TextDecoder().decode(res.data)
        setFile({ path: current.path, html: renderMarkdown(text), text })
        prefetch(items?.[index + 1])
        return
      }
      url = URL.createObjectURL(new Blob([res.data as BlobPart], { type: res.mime }))
      setFile({ path: current.path, url })
      prefetch(items?.[index + 1])
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
              const v = page.getViewport({ scale: 1 })
              return { w: v.width, h: v.height }
            })
          )
        )
        if (!cancelled) setPdf({ doc, sizes })
        prefetch(items?.[index + 1])
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

  // size at zoom 1: the whole plot (first page of a PDF) fits the window
  const base = pdf ? pdf.sizes[0] : natural
  const fit = base ? Math.min((stageSize.w - 2 * PAD) / base.w, (stageSize.h - 2 * PAD) / base.h, pdf ? Infinity : MAX_FIT_UPSCALE) : 1
  const scale = fit * zoom

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
  const zoomRef = useRef(zoomAt)
  zoomRef.current = zoomAt
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      zoomRef.current(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const st = stage.current
    // Markdown is text to select, not a picture to pan
    if (e.button !== 0 || !st || current?.kind === 'md') return
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

  const older = async (): Promise<void> => {
    if (!items) return
    if (index < items.length - 1) return setIndex(index + 1)
    if (!next || busy) return
    // new files show next, even a PDF that sorts in ahead of the images
    const at = await loadMore(next, items)
    if (at >= 0) setIndex(at)
  }

  // the file in view stays in sight in the list
  useEffect(() => {
    list.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' })
  }, [index, items])

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
    writeToAgent(key, '\r')
    const e = terminalEntry(key)
    if (e) e.typed = 0
    setTyped(0)
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

  /** Drag the edge between the file and the agent; double-click for the default width. */
  const onSplit = (e: React.PointerEvent<HTMLDivElement>): void => {
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
    const move = (ev: PointerEvent): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const w = window.innerWidth - ev.clientX
        updateSettings({ viewerChatWidth: Math.round(Math.max(MIN_SIDE, Math.min(w, window.innerWidth * MAX_SIDE_SHARE))) })
      })
    }
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      document.body.classList.remove('resizing')
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  /** the whole Markdown source on the clipboard */
  const copySource = (): void => {
    if (file?.text == null) return
    window.kuna.copyText(file.text)
    setNote(`Copied ${rel(file.path).split('/').pop()} as Markdown`)
  }

  const save = async (): Promise<void> => {
    if (!current || !host) return
    const res = await window.kuna.media.save(host, current.path, stampOf(current))
    setNote('error' in res ? res.error : `Saved to Downloads as ${res.file.split('/').pop()}`)
  }

  const escAt = useRef(0)
  const [escHint, setEscHint] = useState(false)

  /**
   * Typing goes straight to the agent, beside the file, and Enter sends it.
   * While something is typed the arrows move between its letters; with
   * nothing typed they browse and scroll, and Space and Esc close the viewer.
   * With something typed Space is a space and Esc Esc takes it back out of
   * the agent's input box. While the agent shows a question or a panel
   * (/config, /usage) all keys are its, Esc closes it. Zoom and the rest are
   * ⌘ keys, as in Preview.
   */
  useOverlayKeys((ev) => {
    const n = items?.length ?? 0
    const e = terminalEntry(agentKey)
    const term = e?.ptyId ? e : undefined
    // the agent's terminal has the keyboard (from the start, and after a click on it)
    const typing = !!e && e.el.contains(document.activeElement)
    const writing = (e?.typed ?? 0) > 0
    const cmd = cmdKey(ev)
    if (cmd) {
      switch (cmd.key) {
        case '+':
        case '=':
          zoomAt(1.25)
          return true
        case '-':
          zoomAt(0.8)
          return true
        case '0':
          setZoom(1)
          return true
        case '1':
          // actual pixels of an image; 100% (96 dpi) for a PDF
          if (current?.kind === 'md') setZoom(1)
          else if (fit) zoomAt((pdf ? 96 / 72 : 1) / fit / zoom)
          return true
        case 'c': {
          // what is selected in a Markdown file, by Kuna itself (as in the panes)
          const sel = getSelection()
          if (mdRoot.current && sel && !sel.isCollapsed && mdRoot.current.contains(sel.anchorNode)) {
            window.kuna.copyText(sel.toString())
            return true
          }
          // else the text selected in the agent (Option+drag), or the usual copy
          return copyTerminalSelection(agentKey)
        }
        case 'a': {
          // all of a Markdown file (rendered or source), ready for ⌘C
          const root = mdRoot.current
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
          if (current?.kind === 'md') setMdSource((v) => !v)
          return true
        case 'o':
          if (current && host) void window.kuna.media.openExternal(host, current.path, stampOf(current))
          return true
        case 's':
          void save()
          return true
        case 'r':
          void refresh()
          return true
      }
      // ⌘← ⌘→ start and end of the line, as on a pane
      if (term && typeToAgent(agentKey, ev, enter)) return true
      return typing ? false : true // ⌘⌫ … go to the terminal
    }
    // a question, permission prompt or panel (/config, /usage…) on its screen: the keys are its, Esc closes it
    if (term && panelOnScreen(agentKey)) {
      if (ev.key === 'Escape') {
        sendEsc(agentKey)
        return true
      }
      const bytes = keyBytes(ev, term.term.modes.applicationCursorKeysMode)
      if (!bytes) return typing ? false : true
      // typed here, so a choice is not counted as a message to take back
      writeToAgent(agentKey, bytes)
      term.term.focus()
      return true
    }
    // writing to the agent: the arrows move between its letters
    if (!writing) {
      switch (ev.key) {
        case 'ArrowRight':
          void older()
          return true
        case 'ArrowLeft':
          if (n) setIndex((i) => Math.max(0, i - 1))
          return true
        case 'ArrowDown':
          stage.current?.scrollBy({ top: 160 })
          return true
        case 'ArrowUp':
          stage.current?.scrollBy({ top: -160 })
          return true
      }
    }
    switch (ev.key) {
      case 'PageDown':
        stage.current?.scrollBy({ top: (stage.current?.clientHeight ?? 400) * 0.9 })
        return true
      case 'PageUp':
        stage.current?.scrollBy({ top: -(stage.current?.clientHeight ?? 400) * 0.9 })
        return true
      case 'Escape': {
        if (!writing || !e) return false // closes the viewer
        const now = Date.now()
        if (now - escAt.current < 500) {
          discardTyped(e)
          setTyped(0)
          setEscHint(false)
          escAt.current = 0
        } else {
          escAt.current = now
          setEscHint(true)
          setTimeout(() => setEscHint(false), 520)
        }
        return true
      }
      case ' ':
        if (!writing) {
          closeOverlay()
          return true
        }
        break
      case 'Enter':
        // a stopped background session comes back here
        if (!live && agent) {
          setLive(true)
          return true
        }
        break
    }
    if (!term) return true // nothing to type into yet
    // Enter, and keys that take tmux out of scroll mode first
    if (typeToAgent(agentKey, ev, enter)) return true
    if (typing) return false // the terminal takes it
    // the terminal lost the keyboard (a click on the file): what is typed goes to it from here
    const bytes = keyBytes(ev, term.term.modes.applicationCursorKeysMode)
    if (!bytes) return true
    writeToAgent(agentKey, bytes)
    if (ev.key === 'Backspace') term.typed = Math.max(0, term.typed - 1)
    else if (isPrintable(ev)) term.typed++
    term.term.focus()
    setTyped(term.typed)
    return true
  })

  const ready = file?.path === current?.path
  const side = Math.round(Math.min(savedSide ?? sideWidth(), window.innerWidth * MAX_SIDE_SHARE))
  const md = current?.kind === 'md'

  return (
    <div className="media-overlay" style={{ '--side-w': `${side}px` } as React.CSSProperties}>
      <header className="media-head">
        <span className="media-count">{items ? (items.length ? `${index + 1} / ${items.length}${next ? '+' : ''}` : '0') : '…'}</span>
        <span className="media-name">{current ? rel(current.path).split('/').pop() : 'Plots, PDFs & Markdown'}</span>
        {current && <span className="media-path">{rel(current.path)}</span>}
        <span className="ph-spacer" />
        {busy && items && <span className="media-meta">{busy}</span>}
        {current && (
          <span className="media-meta">
            {ago(current.mtime)} ago · {bytes(current.size)} · {pdf && pdf.sizes.length > 1 ? `${pdf.sizes.length} pages · ` : ''}
            {md ? `${Math.round(zoom * 100)}%` : zoom === 1 ? 'fit' : `${zoom < 1 ? zoom.toFixed(2) : zoom.toFixed(1)}×`}
          </span>
        )}
        {note ? (
          <span className="media-note">{note}</span>
        ) : (
          <span className="media-keys">
            {keyLabel(
              escHint
                ? 'Esc again takes what you typed back out'
                : typed
                  ? '← → move in your message · Enter sends · ⇧Enter new line · Esc Esc takes it back'
                  : `← → files · type to the agent · ⌘P the file's path · ${md ? '⌘U source · ' : ''}pinch or ⌘+ ⌘− zoom · ⌘0 fit · ⌘O open · ⌘S save · Space close`
            )}
          </span>
        )}
        {md && (
          <>
            <button
              className="media-save"
              title="Switch between the rendered page and the Markdown source (⌘U)"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setMdSource((v) => !v)}
            >
              {mdSource ? 'Rendered' : 'Source'}
            </button>
            <button
              className="media-save"
              title="Copy the whole file as Markdown (⌘A then ⌘C copies what you see)"
              onMouseDown={(e) => e.preventDefault()}
              onClick={copySource}
            >
              Copy
            </button>
          </>
        )}
        {current && (
          <button
            className="media-save"
            title="Save a copy in your Downloads folder (⌘S)"
            onMouseDown={(e) => e.preventDefault()} // the agent keeps the keyboard
            onClick={() => void save()}
          >
            Save to Downloads
          </button>
        )}
      </header>
      <div className="media-body">
        <div
          className={`media-stage ${base && (base.w * scale > stageSize.w || base.h * scale > stageSize.h) ? 'can-pan' : ''}`}
          ref={stage}
          onPointerDown={onPointerDown}
          // a plot is panned, not focused: the agent keeps the keyboard (Markdown is text to select)
          onMouseDown={(e) => !md && e.preventDefault()}
          onDoubleClick={(e) => !md && (zoom === 1 ? zoomAt(2.5, e.clientX, e.clientY) : setZoom(1))}
        >
          {!items && <div className="media-msg">{busy}</div>}
          {items && !items.length && !busy && (
            <div className="media-msg">
              No plots, PDFs or Markdown files yet. Kuna looks at the paths in the agent's replies, newest first, and then at files written in its
              folder since it started.
            </div>
          )}
          {ready && file?.error && <div className="media-msg">{file.error}</div>}
          {ready && current && current.size > SLOW_FILE && !file?.error && !file?.url && !pdf && file?.html == null && (
            <div className="media-msg">
              Loading {rel(current.path).split('/').pop()}, {bytes(current.size)}
              {host && host !== 'local' ? `, from ${host}` : ''}…
            </div>
          )}
          {current && ready && (file?.url || pdf || file?.html != null) && (
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
                    <article
                      className="md media-md"
                      ref={mdRoot}
                      style={{ zoom, maxWidth: stageSize.w - 2 * PAD }}
                      dangerouslySetInnerHTML={{ __html: file.html }}
                    />
                  ))}
              </div>
            </div>
          )}
        </div>
        <div className="media-split" onPointerDown={onSplit} onDoubleClick={() => updateSettings({ viewerChatWidth: undefined })} title="Drag to resize · double-click to reset" />
        <aside className="media-side">
          {items && items.length > 0 && (
            <nav className="media-files" ref={list}>
              {items.map((it, i) => {
                const path = rel(it.path)
                const cut = path.lastIndexOf('/')
                return (
                  <button
                    key={it.path}
                    className={i === index ? 'on' : ''}
                    title={it.path}
                    onMouseDown={(e) => e.preventDefault()} // the agent keeps the keyboard
                    onClick={() => setIndex(i)}
                  >
                    <span className={`kind kind-${it.kind}`}>{it.kind === 'image' ? 'img' : it.kind}</span>
                    <span className="mf-name">{path.slice(cut + 1)}</span>
                    <span className="mf-dir">{cut > 0 ? path.slice(0, cut) : ''}</span>
                    <span className="mf-age">{ago(it.mtime)}</span>
                  </button>
                )
              })}
              {next && (
                <button className="mf-more" onMouseDown={(e) => e.preventDefault()} onClick={() => void older()} disabled={!!busy}>
                  {busy ?? ('scan' in next ? 'Scan the folder for more →' : 'Earlier replies →')}
                </button>
              )}
            </nav>
          )}
          <AgentChat
            agentKey={agentKey}
            live={live}
            onTyped={setTyped}
            hint={escHint ? 'Esc again takes it back' : typed ? 'Enter sends · Esc Esc takes it back' : 'typing to the agent · Enter sends'}
          />
        </aside>
      </div>
    </div>
  )
}

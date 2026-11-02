import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  buildTree,
  defaultBase,
  isImagePath,
  repoLabel,
  isSha,
  looksBinary,
  reviewMessage,
  type ChangeKind,
  type FileChange,
  type GitBlob,
  type GitCommit,
  type GitCompare,
  type GitInfo,
  type GitRepo,
  type GitSide,
  type GitStatus,
  type ReviewComment,
  type TreeDir
} from '@shared/git'
import type { VscodeLook } from '@shared/vscode'
import { discardTyped, leaveScroll, sendEsc } from '../actions'
import { ago } from '../format'
import { isPrintable, panelOnScreen, typeToAgent } from '../keys'
import { DiffPane, type Draft, type PaneApi, type Shown } from '../review/DiffPane'
import { FileIcon, vscodeLook } from '../review/look'
import { loadEditor, type EditorEnv } from '../review/monaco'
import { RefOption, refOptions, RefPicker } from '../review/RefPicker'
import { get, updateSettings, useKuna } from '../store'
import { copyTerminalSelection, terminalEntry, writeToAgent } from '../terminals'
import '../review/review.css'
import { AgentChat } from './MediaViewer'
import { closeOverlay, useOverlayKeys } from './Overlays'

type Tab = 'changes' | 'local' | 'files' | 'commits'
const TABS: Tab[] = ['changes', 'local', 'files', 'commits']

interface Entry {
  id: string
  path: string
  oldPath?: string
  kind: ChangeKind | 'file'
  added?: number
  removed?: number
  binary?: boolean
  left: GitSide
  right: GitSide
  mode: 'diff' | 'file'
  /** which diff this is (comments belong to one) and how to say so to the agent */
  anchor: string
  context: string
}

type Row =
  | { type: 'dir'; id: string; path: string; name: string; depth: number; open: boolean }
  | { type: 'file'; id: string; entry: Entry; name: string; depth: number; dir?: string }
  | { type: 'group'; id: string; label: string; count: number }
  | { type: 'commit'; id: string; commit: GitCommit }

/** comments not sent yet, per repository: they survive closing the view */
const pendingComments = new Map<string, ReviewComment[]>()

/** file contents kept for going back and forth, at most this much */
const CACHE_BYTES = 96 * 1024 * 1024
const MIN_LIST = 200
const MIN_CHAT = 320
const chatDefault = (): number => Math.round(Math.min(600, Math.max(400, window.innerWidth * 0.3)))
const EMPTY: GitSide = { kind: 'empty' }

/** a pull request's files: each as it was where the branch left base, and as it is at head */
function compareEntries(c: GitCompare, context: string): Entry[] {
  const anchor = `cmp:${c.base}...${c.head ?? ''}`
  return c.files.map((f) => ({
    id: `c:${f.path}`,
    anchor,
    context,
    ...f,
    left: f.kind === 'A' || f.kind === '?' ? EMPTY : { kind: 'rev', rev: c.mergeBase, path: f.oldPath ?? f.path },
    right: f.kind === 'D' ? EMPTY : c.head === null ? { kind: 'worktree', path: f.path } : { kind: 'rev', rev: c.tip, path: f.path },
    mode: 'diff'
  }))
}

/** uncommitted changes in VS Code's groups: staged (HEAD → index), changes (index → disk), untracked, conflicts */
function localGroups(st: GitStatus, head: string | undefined): { id: string; label: string; entries: Entry[] }[] {
  const CONTEXT: Record<string, string> = {
    u: 'the files in conflict',
    s: 'the staged changes',
    w: 'the unstaged changes (not committed yet)',
    n: 'the new, untracked files'
  }
  const make = (g: string, files: FileChange[], left: (f: FileChange) => GitSide, right: (f: FileChange) => GitSide): Entry[] =>
    files.map((f) => ({ id: `l:${g}:${f.path}`, anchor: `l:${g}`, context: CONTEXT[g], ...f, left: left(f), right: right(f), mode: 'diff' }))
  // HEAD by its commit id, so a cached side never outlives a new commit; none before the first
  const atHead = (path: string): GitSide => (head ? { kind: 'rev', rev: head, path } : EMPTY)
  return [
    { id: 'conflicts', label: 'Merge conflicts', entries: make('u', st.conflicts, (f) => atHead(f.path), (f) => ({ kind: 'worktree', path: f.path })) },
    {
      id: 'staged',
      label: 'Staged changes',
      entries: make(
        's',
        st.staged,
        (f) => (f.kind === 'A' ? EMPTY : atHead(f.oldPath ?? f.path)),
        (f) => (f.kind === 'D' ? EMPTY : { kind: 'index', path: f.path })
      )
    },
    {
      id: 'unstaged',
      label: 'Changes',
      entries: make('w', st.unstaged, (f) => ({ kind: 'index', path: f.path }), (f) => (f.kind === 'D' ? EMPTY : { kind: 'worktree', path: f.path }))
    },
    { id: 'untracked', label: 'Untracked', entries: make('n', st.untracked, () => EMPTY, (f) => ({ kind: 'worktree', path: f.path })) }
  ].filter((g) => g.entries.length)
}

/** a tree as rows, folders open unless `closed` says (or, `openByDefault` false, unless `open` does) */
function treeRows(tree: TreeDir<Entry>, isOpen: (path: string) => boolean): Row[] {
  const rows: Row[] = []
  const walk = (d: TreeDir<Entry>, depth: number): void => {
    for (const sub of d.dirs) {
      const open = isOpen(sub.path)
      rows.push({ type: 'dir', id: `d:${sub.path}`, path: sub.path, name: sub.name, depth, open })
      if (open) walk(sub, depth + 1)
    }
    for (const f of d.files) rows.push({ type: 'file', id: f.item.id, entry: f.item, name: f.name, depth })
  }
  walk(tree, 0)
  return rows
}

/** ⌘P: the letters in order anywhere in the path, a match in the name first */
function fuzzy(path: string, q: string): number {
  const p = path.toLowerCase()
  let at = 0
  let score = 0
  for (const ch of q) {
    const i = p.indexOf(ch, at)
    if (i < 0) return -1
    score += i - at
    at = i + 1
  }
  const name = p.slice(p.lastIndexOf('/') + 1)
  return score + (name.includes(q) ? 0 : 50) + p.length / 100
}

const KIND_LABEL: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed', U: 'conflict', '?': 'untracked' }

function decode(blob: GitBlob | undefined, path: string, urls: string[]): { text?: string | null; image?: string | null; binary?: boolean; tooBig?: boolean; size?: number } {
  if (!blob || blob.missing) return isImagePath(path) ? { image: null } : { text: null }
  if (blob.tooBig) return { tooBig: true, size: blob.size }
  const data = blob.data ?? new Uint8Array()
  if (isImagePath(path)) {
    const type = path.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : `image/${path.split('.').pop()!.toLowerCase().replace('jpg', 'jpeg')}`
    const url = URL.createObjectURL(new Blob([data as BlobPart], { type }))
    urls.push(url)
    return { image: url, size: blob.size }
  }
  if (looksBinary(data)) return { binary: true, size: blob.size }
  return { text: new TextDecoder().decode(data), size: blob.size }
}

/**
 * ⌘G: an agent's work as a pull request would show it, before you open one.
 * The branch against a base branch (base...head, from where it branched off),
 * or the uncommitted changes as VS Code's Source Control lists them, or every
 * file to browse; Monaco shows them with VS Code's own diff, in the user's
 * VS Code theme, font and icons. Comments on lines (C) collect into a review
 * that ⌘↵ sends to the agent, whose terminal sits on the right.
 */
export function ReviewView({ host, dir: folder, agentKey }: { host: string; dir: string; agentKey?: string }): React.JSX.Element {
  const agent = useKuna((s) => (agentKey ? s.agents[agentKey] : undefined))
  const settings = useKuna((s) => s.settings)
  /**
   * The repositories in and below the agent's folder: agents often start a
   * level above their repositories, beside configs, builds and run folders.
   */
  const [repos, setRepos] = useState<GitRepo[] | null>(null)
  const [repo, setRepo] = useState<string | null>(null)
  /** the repository shown (every git call below goes there) */
  const dir = repo ?? ''
  const repoKey = `${host}:${folder}`
  const [look, setLook] = useState<VscodeLook | null>(null)
  const [env, setEnv] = useState<EditorEnv | null>(null)
  const [envError, setEnvError] = useState<string | null>(null)
  const [info, setInfo] = useState<GitInfo | null>(null)
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [base, setBase] = useState<string | undefined>()
  /** null: the working tree; undefined: not decided yet */
  const [head, setHead] = useState<string | null | undefined>()
  /** one commit on its own (from the Commits tab): base and head stay for going back */
  const [commit, setCommit] = useState<GitCommit | null>(null)
  const [compare, setCompare] = useState<GitCompare | null>(null)
  const [compareError, setCompareError] = useState<string | null>(null)
  const [comparing, setComparing] = useState(false)
  const [files, setFiles] = useState<string[] | null>(null)
  const [tab, setTab] = useState<Tab>('changes')
  const [cursor, setCursor] = useState<Partial<Record<Tab, string>>>({})
  const [closedDirs, setClosedDirs] = useState<Set<string>>(new Set())
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [picker, setPicker] = useState<'base' | 'head' | 'repo' | null>(null)
  const [shown, setShown] = useState<Shown | null>(null)
  const [tick, setTick] = useState(0)
  /** readings of the repository so far: each starts one comparison */
  const [seq, setSeq] = useState(0)
  const store = `${host}:${dir}`
  const [comments, setCommentsState] = useState<ReviewComment[]>(() => pendingComments.get(store) ?? [])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [typed, setTyped] = useState(0)
  const [escHint, setEscHint] = useState(false)
  const escAt = useRef(0)
  const pane = useRef<PaneApi | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const urls = useRef<string[]>([])
  const blobCache = useRef(new Map<string, GitBlob>())
  const sideBySide = !settings.reviewInline
  const root = info?.root ?? dir
  const repoRef = useRef(dir)
  repoRef.current = dir
  const [live, setLive] = useState(() => {
    if (!agentKey) return false
    const a = get().agents[agentKey]
    return !!terminalEntry(agentKey) || (!!a && (a.alive || a.kind === 'tmux'))
  })

  const setComments = (next: ReviewComment[]): void => {
    pendingComments.set(store, next)
    setCommentsState(next)
  }

  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(null), 4000)
    return () => clearTimeout(t)
  }, [note])

  // VS Code's look and the editor, while git answers
  useEffect(() => {
    let live = true
    void vscodeLook()
      .then((l) => {
        if (live) setLook(l)
        return loadEditor(l)
      })
      .then((e) => live && setEnv(e))
      .catch((e: unknown) => live && setEnvError(`The editor did not load: ${String(e)}`))
    return () => {
      live = false
    }
  }, [])

  // which repositories: the one the folder is in, else those below it; the one used last here, else the one worked in last
  const scanRepos = useCallback(async () => {
    const res = await window.kuna.git.repos(host, folder)
    if ('error' in res) {
      setRepos([])
      setError(res.error)
      return
    }
    setRepos(res)
    if (!res.length) {
      setError(`No git repository in ${folder}, or in the three levels of folders below it.`)
      return
    }
    const cur = repoRef.current
    if (cur && res.some((r) => r.path === cur)) return
    const saved = get().settings.reviewRepo?.[repoKey]
    if (saved && res.some((r) => r.path === saved)) return setRepo(saved)
    // several and none picked here before: the latest worked in shows, and the list is open to choose from
    setRepo(res[0].path)
    if (res.length > 1) setPicker('repo')
  }, [host, folder, repoKey])

  useEffect(() => {
    void scanRepos()
  }, [scanRepos])

  // another repository: everything about the last one goes
  const lastRepo = useRef(dir)
  useEffect(() => {
    if (lastRepo.current === dir) return
    const first = !lastRepo.current
    lastRepo.current = dir
    if (first) {
      setCommentsState(pendingComments.get(`${host}:${dir}`) ?? [])
      return
    }
    setInfo(null)
    setStatus(null)
    setError(null)
    setBase(undefined)
    setHead(undefined)
    setCommit(null)
    setCompare(null)
    setCompareError(null)
    setFiles(null)
    setTab('changes')
    setCursor({})
    setClosedDirs(new Set())
    setOpenDirs(new Set())
    setFilter('')
    setShown(null)
    setDraft(null)
    setCommentsState(pendingComments.get(`${host}:${dir}`) ?? [])
    chose.current = false
    blobCache.current.clear()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir])

  // the repository: branches, worktrees, uncommitted changes
  const loadOverview = useCallback(async () => {
    if (!dir) return
    const ov = await window.kuna.git.overview(host, dir)
    // another repository was picked meanwhile
    if (repoRef.current !== dir) return
    if ('error' in ov) {
      setError(ov.error)
      return
    }
    setError(null)
    setInfo(ov.info)
    setStatus(ov.status)
    setBase((b) => {
      if (b) return b
      const saved = get().settings.reviewBase?.[`${host}:${ov.info.root}`]
      if (saved && ov.info.refs.some((r) => r.short === saved)) return saved
      // no main, master or origin: the branch itself, until another is picked (⌘B)
      return defaultBase(ov.info) ?? ov.info.branch ?? (ov.info.head ? 'HEAD' : undefined)
    })
    setHead((h) => (h !== undefined ? h : (ov.info.branch ?? (ov.info.head ? 'HEAD' : null))))
    // what follows (the comparison, the file list) goes once per reading of the repository
    setSeq((n) => n + 1)
  }, [host, dir])

  useEffect(() => {
    void loadOverview()
  }, [loadOverview, tick])

  // base...head, or one commit
  const cmpBase = commit ? `${commit.sha}^` : base
  const cmpHead = commit ? commit.sha : head
  const noCommits = !!info && !info.head
  useEffect(() => {
    if (!seq) return
    if (noCommits) {
      setCompare(null)
      setCompareError('No commits yet: what there is shows under Uncommitted.')
      return
    }
    if (!cmpBase || cmpHead === undefined) return
    let live = true
    setComparing(true)
    void window.kuna.git.compare(host, dir, cmpBase, cmpHead).then((res) => {
      if (!live) return
      setComparing(false)
      if ('error' in res) {
        setCompareError(res.error)
        setCompare(null)
      } else {
        setCompareError(null)
        setCompare(res)
      }
    })
    return () => {
      live = false
    }
  }, [seq, noCommits, host, dir, cmpBase, cmpHead])

  // every file, once the Files tab is looked at: what is on disk when head is checked out here
  const filesRev = head === null || (info && head === info.branch) ? null : (compare?.tip ?? null)
  const filesKey = `${dir}:${filesRev ?? 'disk'}:${seq}`
  const filesAsked = useRef<string | null>(null)
  useEffect(() => {
    if (tab !== 'files' || filesAsked.current === filesKey || !info) return
    filesAsked.current = filesKey
    const key = filesKey
    void window.kuna.git.files(host, dir, filesRev).then((res) => {
      // only the answer to the latest question counts
      if (filesAsked.current !== key) return
      if ('error' in res) {
        setFiles([])
        setNote(res.error)
      } else setFiles(res)
    })
  }, [tab, filesKey, filesRev, host, dir, info])

  /** re-read everything (⌘R, or the agent finished a turn) */
  const refresh = useCallback(() => {
    // only a file at a full commit id stays the same; the index, the disk, HEAD and branches move
    for (const k of [...blobCache.current.keys()]) if (!(k.startsWith('G') && isSha(k.slice(1, k.indexOf(':'))))) blobCache.current.delete(k)
    setTick((t) => t + 1)
  }, [])

  const status_ = agent?.status
  const prevStatus = useRef(status_)
  useEffect(() => {
    const was = prevStatus.current
    prevStatus.current = status_
    if (was === 'working' && status_ && status_ !== 'working') refresh()
  }, [status_, refresh])

  // ------------------------------------------------------------ the lists --

  const changeEntries = useMemo(() => {
    if (!compare) return []
    const context =
      commit && compare.head === commit.sha
        ? `commit ${commit.short} ("${commit.subject}")`
        : compare.head === null
          ? `the working tree of \`${info?.branch ?? 'HEAD'}\` (uncommitted changes included), compared with \`${compare.base}\``
          : `\`${compare.head}\` compared with \`${compare.base}\``
    return compareEntries(compare, context)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compare])
  const groups = useMemo(() => (status ? localGroups(status, info?.head) : []), [status, info?.head])
  const localCount = groups.reduce((n, g) => n + g.entries.length, 0)
  const changedKind = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of changeEntries) m.set(e.path, e.kind)
    for (const g of groups) for (const e of g.entries) m.set(e.path, e.kind)
    return m
  }, [changeEntries, groups])
  const fileEntries = useMemo<Entry[]>(
    () =>
      (files ?? []).map((p) => ({
        id: `f:${p}`,
        anchor: `f:${filesRev ?? ''}`,
        context: filesRev ? `the files at commit ${filesRev.slice(0, 7)}` : 'the files as they are on disk',
        path: p,
        kind: 'file',
        left: EMPTY,
        right: filesRev ? { kind: 'rev', rev: filesRev, path: p } : { kind: 'worktree', path: p },
        mode: 'file'
      })),
    [files, filesRev]
  )

  const q = filter.trim().toLowerCase().replace(/\s+/g, '')
  const rows = useMemo<Row[]>(() => {
    const flat = (entries: Entry[]): Row[] =>
      entries
        .map((e) => ({ e, s: fuzzy(e.path, q) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => a.s - b.s)
        .slice(0, 400)
        .map(({ e }) => {
          const cut = e.path.lastIndexOf('/')
          return { type: 'file' as const, id: e.id, entry: e, name: e.path.slice(cut + 1), dir: cut > 0 ? e.path.slice(0, cut) : '', depth: 0 }
        })
    switch (tab) {
      case 'changes':
        if (q) return flat(changeEntries)
        return treeRows(
          buildTree(changeEntries, (e) => e.path),
          (p) => !closedDirs.has(p)
        )
      case 'files':
        if (q) return flat(fileEntries)
        return treeRows(
          buildTree(fileEntries, (e) => e.path, false),
          (p) => openDirs.has(p)
        )
      case 'local': {
        const out: Row[] = []
        for (const g of groups) {
          const hits = q ? g.entries.filter((e) => fuzzy(e.path, q) >= 0) : g.entries
          if (!hits.length) continue
          out.push({ type: 'group', id: `g:${g.id}`, label: g.label, count: hits.length })
          for (const e of hits) {
            const cut = e.path.lastIndexOf('/')
            out.push({ type: 'file', id: e.id, entry: e, name: e.path.slice(cut + 1), dir: cut > 0 ? e.path.slice(0, cut) : '', depth: 0 })
          }
        }
        return out
      }
      case 'commits':
        return (compare?.commits ?? [])
          .filter((c) => !q || `${c.subject} ${c.short} ${c.author}`.toLowerCase().includes(q))
          .map((c) => ({ type: 'commit' as const, id: `k:${c.sha}`, commit: c }))
    }
  }, [tab, q, changeEntries, fileEntries, groups, compare, closedDirs, openDirs])

  // the row the cursor is on: kept, else the first file
  const selectable = rows.filter((r) => r.type !== 'group')
  const curId = cursor[tab]
  const current = selectable.find((r) => r.id === curId) ?? selectable.find((r) => r.type === 'file') ?? selectable[0]
  const currentEntry = current?.type === 'file' ? current.entry : null

  // which tab to open on: the branch's changes, else what is uncommitted, else the files
  const chose = useRef(false)
  useEffect(() => {
    if (chose.current || !status || (!compare && !compareError)) return
    chose.current = true
    if (!changeEntries.length) setTab(localCount ? 'local' : 'files')
  }, [status, compare, compareError, changeEntries.length, localCount])

  useEffect(() => {
    listRef.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' })
  }, [current?.id, tab])

  // ------------------------------------------------------- the file shown --

  const entryKey = currentEntry ? `${currentEntry.id}\0${JSON.stringify(currentEntry.left)}\0${JSON.stringify(currentEntry.right)}\0${tick}` : ''
  useEffect(() => {
    const e = currentEntry
    if (!e) {
      setShown(null)
      return
    }
    let live = true
    const sides = e.mode === 'file' ? [e.right] : [e.left, e.right]
    const ck = (s: GitSide): string => (s.kind === 'rev' ? `G${s.rev}:${s.path}` : s.kind === 'index' ? `I${s.path}` : s.kind === 'worktree' ? `W${s.path}` : '')
    // a short wait, so holding ↓ does not read every file on the way
    const t = setTimeout(async () => {
      setShown((s) => (s?.key === `${e.anchor}|${e.id}` ? s : { key: `${e.anchor}|${e.id}`, anchor: e.anchor, context: e.context, path: e.path, oldPath: e.oldPath, mode: e.mode, loading: true }))
      const missing = sides.filter((s) => s.kind !== 'empty' && !blobCache.current.has(ck(s)))
      if (missing.length) {
        const res = await window.kuna.git.read(host, root, missing)
        if ('error' in res) {
          if (live) setShown({ key: `${e.anchor}|${e.id}`, anchor: e.anchor, context: e.context, path: e.path, mode: e.mode, error: res.error })
          return
        }
        // kept even when the user has moved on: going back is then instant
        missing.forEach((s, i) => blobCache.current.set(ck(s), res[i]))
        let total = 0
        for (const b of blobCache.current.values()) total += b.data?.length ?? 0
        while (blobCache.current.size > 2 && (total > CACHE_BYTES || blobCache.current.size > 400)) {
          const oldest = blobCache.current.keys().next().value!
          total -= blobCache.current.get(oldest)?.data?.length ?? 0
          blobCache.current.delete(oldest)
        }
        if (!live) return
      } else {
        // the newest last, so the cache drops what was looked at longest ago
        for (const s of sides) {
          const b = s.kind !== 'empty' ? blobCache.current.get(ck(s)) : undefined
          if (b) {
            blobCache.current.delete(ck(s))
            blobCache.current.set(ck(s), b)
          }
        }
      }
      const blob = (s: GitSide): GitBlob | undefined => (s.kind === 'empty' ? { size: 0, missing: true } : blobCache.current.get(ck(s)))
      const old = urls.current
      urls.current = []
      const l = e.mode === 'diff' ? decode(blob(e.left), e.oldPath ?? e.path, urls.current) : {}
      const r = decode(blob(e.right), e.path, urls.current)
      old.forEach((u) => URL.revokeObjectURL(u))
      const image = 'image' in l || 'image' in r
      setShown({
        key: `${e.anchor}|${e.id}`, anchor: e.anchor, context: e.context,
        path: e.path,
        oldPath: e.oldPath,
        mode: e.mode,
        left: l.text ?? (e.mode === 'diff' && !image ? null : undefined),
        right: r.text ?? null,
        leftImage: image && e.mode === 'diff' ? (l.image ?? null) : undefined,
        rightImage: image ? (r.image ?? null) : undefined,
        leftSize: l.size,
        rightSize: r.size,
        binary: l.binary || r.binary,
        tooBig: l.tooBig || r.tooBig
      })
    }, 60)
    return () => {
      live = false
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryKey, host, root])

  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), [])

  // ------------------------------------------------------------- actions --

  const move = (delta: number): void => {
    if (!selectable.length) return
    const i = Math.max(0, selectable.findIndex((r) => r.id === current?.id))
    const next = selectable[Math.min(selectable.length - 1, Math.max(0, i + delta))]
    setCursor((c) => ({ ...c, [tab]: next.id }))
  }

  const toggleDir = (path: string, open?: boolean): void => {
    if (tab === 'changes')
      setClosedDirs((s) => {
        const n = new Set(s)
        if (open ?? n.has(path)) n.delete(path)
        else n.add(path)
        return n
      })
    else
      setOpenDirs((s) => {
        const n = new Set(s)
        if (open ?? !n.has(path)) n.add(path)
        else n.delete(path)
        return n
      })
  }

  const pickTab = (t: Tab): void => {
    setTab(t)
    setFilter('')
  }

  const viewCommit = (c: GitCommit): void => {
    setCommit(c)
    setTab('changes')
    setCursor((x) => ({ ...x, changes: undefined }))
  }

  const activate = (r: Row | undefined): void => {
    if (!r) return
    if (r.type === 'dir') toggleDir(r.path)
    else if (r.type === 'commit') viewCommit(r.commit)
    else if (r.type === 'file') pane.current?.focus()
  }

  const pickRef = (which: 'base' | 'head', value: string | null): void => {
    setPicker(null)
    setCommit(null)
    if (which === 'base' && value) {
      setBase(value)
      if (info) updateSettings({ reviewBase: { ...(get().settings.reviewBase ?? {}), [`${host}:${info.root}`]: value } })
    } else if (which === 'head') setHead(value)
    setTab('changes')
    setCursor((x) => ({ ...x, changes: undefined }))
    setTimeout(() => listRef.current?.focus(), 0)
  }

  const pickRepo = (path: string | null): void => {
    setPicker(null)
    setTimeout(() => listRef.current?.focus(), 0)
    if (!path) return
    setRepo(path)
    updateSettings({ reviewRepo: { ...(get().settings.reviewRepo ?? {}), [repoKey]: path } })
  }

  const saveDraft = (): void => {
    if (!draft) return
    const text = pane.current?.draftText().trim() ?? ''
    if (text) {
      if (draft.id) setComments(comments.map((c) => (c.id === draft.id ? { ...c, text } : c)))
      else {
        const { path, side, start, end, code, anchor, context } = draft
        setComments([...comments, { id: Math.random().toString(36).slice(2, 10), path, side, start, end, code, anchor, context, text }])
      }
    }
    setDraft(null)
    setTimeout(() => pane.current?.focus(), 0)
  }

  /** Into the agent's input box, out of tmux's scroll mode first. */
  const toAgent = (write: () => void): void => {
    if (!agentKey) return
    const e = terminalEntry(agentKey)
    if (!e?.ptyId) return
    e.term.focus()
    const leaving = leaveScroll(agentKey)
    if (leaving) void leaving.then(write)
    else write()
  }

  const sendReview = (): void => {
    if (!comments.length) {
      setNote('No comments yet: C on a line in the diff (or a click in its gutter) adds one.')
      return
    }
    const text = reviewMessage(comments)
    const e = agentKey ? terminalEntry(agentKey) : undefined
    if (!agentKey || !e?.ptyId) {
      window.kuna.copyText(text)
      setNote(agentKey ? 'The agent is not attached yet, so the review is on the clipboard.' : 'No agent here: the review is on the clipboard.')
      return
    }
    const n = comments.length
    toAgent(() => {
      e.term.paste(text)
      // Enter on its own, so Claude Code takes it as a key press and not as part of the paste
      setTimeout(() => {
        writeToAgent(agentKey, '\r')
        e.typed = 0
        setTyped(0)
      }, 200)
    })
    setComments([])
    setNote(`Sent ${n} comment${n === 1 ? '' : 's'} to the agent.`)
  }

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

  const focusList = (): void => {
    agentKey && terminalEntry(agentKey)?.term.blur()
    listRef.current?.focus()
  }

  /** Esc twice within half a second: true on the second */
  const doubleEsc = (): boolean => {
    const now = Date.now()
    if (now - escAt.current < 500) {
      escAt.current = 0
      setEscHint(false)
      return true
    }
    escAt.current = now
    setEscHint(true)
    setTimeout(() => setEscHint(false), 520)
    return false
  }

  /** ⌘ keys of the view, wherever the keyboard is */
  const viewKey = (ev: KeyboardEvent): boolean => {
    if (!ev.metaKey || ev.ctrlKey) return false
    const k = ev.key.toLowerCase()
    if (k === 'enter') {
      sendReview()
      return true
    }
    if (k === 'b') {
      setPicker(ev.shiftKey ? 'head' : 'base')
      return true
    }
    if (k === 'o') {
      if ((repos?.length ?? 0) > 1) setPicker('repo')
      else setNote(`The only repository in ${folder}`)
      return true
    }
    if (k === 'r' && !ev.shiftKey) {
      // the repositories too: one may have been cloned or made since
      void scanRepos()
      refresh()
      setNote('Reading the repository again…')
      return true
    }
    if (k === 'u') {
      updateSettings({ reviewInline: sideBySide })
      return true
    }
    if (k === 'p') {
      filterRef.current?.focus()
      filterRef.current?.select()
      return true
    }
    if (k === 'j') {
      const e = agentKey ? terminalEntry(agentKey) : undefined
      if (e && e.el.contains(document.activeElement)) focusList()
      else if (e?.ptyId) e.term.focus()
      else if (agentKey && agent && !live) setLive(true)
      return true
    }
    if (/^[1-4]$/.test(k)) {
      pickTab(TABS[Number(k) - 1])
      focusList()
      return true
    }
    if (k === 'w' && !ev.shiftKey) {
      closeOverlay()
      return true
    }
    if (k === '.' && agentKey) {
      sendEsc(agentKey)
      setNote('Sent Esc to the agent')
      return true
    }
    if (k === 'c' && ev.shiftKey) {
      if (comments.length) {
        window.kuna.copyText(reviewMessage(comments))
        setNote('Copied the review')
      }
      return true
    }
    return false
  }

  useOverlayKeys((ev) => {
    const el = document.activeElement as HTMLElement | null
    // the branch list: its input takes the keys, Esc closes it
    if (picker) {
      if (ev.key === 'Escape') {
        setPicker(null)
        setTimeout(focusList, 0)
        return true
      }
      return 'pass'
    }
    // writing a comment
    if (el?.closest('.rv-draft')) {
      if (ev.key === 'Enter' && ev.metaKey) {
        saveDraft()
        return true
      }
      if (ev.key === 'Escape') {
        if (!pane.current?.draftText().trim() || doubleEsc()) {
          setDraft(null)
          setTimeout(() => pane.current?.focus(), 0)
        }
        return true
      }
      return 'pass'
    }
    // the filter box
    if (el === filterRef.current) {
      if (ev.key === 'Escape') {
        setFilter('')
        focusList()
        return true
      }
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        move(ev.key === 'ArrowDown' ? 1 : -1)
        return true
      }
      if (ev.key === 'Enter') {
        focusList()
        activate(current)
        return true
      }
      return viewKey(ev) || 'pass'
    }
    // the agent's terminal
    const term = agentKey ? terminalEntry(agentKey) : undefined
    if (agentKey && term && term.el.contains(el)) {
      if (viewKey(ev)) return true
      if (ev.metaKey && ev.key.toLowerCase() === 'c') return copyTerminalSelection(agentKey) || 'pass'
      if (term.ptyId && panelOnScreen(agentKey)) {
        if (ev.key === 'Escape') {
          sendEsc(agentKey)
          return true
        }
        return 'pass'
      }
      if (ev.key === 'Escape') {
        if (term.typed > 0) {
          if (doubleEsc()) {
            discardTyped(term)
            setTyped(0)
          }
        } else focusList()
        return true
      }
      if (term.ptyId && typeToAgent(agentKey, ev, enter)) return true
      return 'pass'
    }
    // the diff
    if (pane.current?.hasFocus()) {
      // Monaco's own boxes (find, go to line) are typed into, and their Esc closes them
      if (el?.closest('.find-widget, .quick-input-widget') || (el?.matches('input, textarea') && !el.closest('.rv-zone'))) return viewKey(ev) || 'pass'
      if (viewKey(ev)) return true
      const plain = !ev.metaKey && !ev.ctrlKey && !ev.altKey
      if (ev.key === 'Escape') {
        if (pane.current.findOpen()) return 'pass'
        focusList()
        return true
      }
      if (ev.key === 'Tab' && !ev.metaKey && !ev.altKey && !ev.ctrlKey) {
        // nothing to indent in a review: the next list, as in the file list
        const i = TABS.indexOf(tab)
        pickTab(TABS[(i + (ev.shiftKey ? 3 : 1)) % 4])
        focusList()
        return true
      }
      if (plain && (ev.key === 'c' || ev.key === 'C')) {
        pane.current.commentHere()
        return true
      }
      if ((plain && ev.key === 'n') || (ev.key === 'F7' && !ev.shiftKey)) {
        pane.current.nextChange(1)
        return true
      }
      if ((plain && (ev.key === 'p' || ev.key === 'N')) || (ev.key === 'F7' && ev.shiftKey)) {
        pane.current.nextChange(-1)
        return true
      }
      // a read-only editor: letters do nothing there
      if (isPrintable(ev)) return true
      return 'pass'
    }
    // the file list
    if (viewKey(ev)) return true
    if (ev.metaKey && ev.key.toLowerCase() === 'c' && currentEntry) {
      window.kuna.copyText(currentEntry.path)
      setNote(`Copied ${currentEntry.path}`)
      return true
    }
    switch (ev.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        move(ev.key === 'ArrowDown' ? 1 : -1)
        return true
      case 'PageDown':
      case 'PageUp':
        move(ev.key === 'PageDown' ? 15 : -15)
        return true
      case 'ArrowRight':
        if (current?.type === 'dir' && !current.open) toggleDir(current.path, true)
        else if (current?.type === 'dir') move(1)
        else if (current?.type === 'file') pane.current?.focus()
        return true
      case 'ArrowLeft':
        if (current?.type === 'dir' && current.open) toggleDir(current.path, false)
        else if (current && current.type !== 'commit') {
          // up to the folder it is in
          const i = rows.findIndex((r) => r.id === current.id)
          const depth = current.type === 'dir' || current.type === 'file' ? current.depth : 0
          for (let j = i - 1; j >= 0; j--) {
            const r = rows[j]
            if (r.type === 'dir' && r.depth < depth) {
              setCursor((c) => ({ ...c, [tab]: r.id }))
              break
            }
          }
        }
        return true
      case 'Enter':
      case ' ':
        activate(current)
        return true
      case 'Tab': {
        const i = TABS.indexOf(tab)
        pickTab(TABS[(i + (ev.shiftKey ? 3 : 1)) % 4])
        return true
      }
      case 'Escape':
        if (commit) {
          setCommit(null)
          return true
        }
        // a comment half written: back to it, not away from it
        if (draft && pane.current?.draftText().trim()) {
          pane.current.focusDraft()
          setNote('Finish the comment (⌘↵) or discard it (Esc Esc) first')
          return true
        }
        return false // closes the view
    }
    // typing goes to the agent, as in the plot viewer
    if (agentKey && term?.ptyId && (isPrintable(ev) || ev.key === 'Backspace')) {
      const k = ev.key
      toAgent(() => {
        writeToAgent(agentKey, k === 'Backspace' ? '\x7f' : k)
        term.typed = k === 'Backspace' ? Math.max(0, term.typed - 1) : term.typed + 1
        setTyped(term.typed)
      })
      return true
    }
    if (agentKey && !live && agent && ev.key === 'Enter') {
      setLive(true)
      return true
    }
    return true
  })

  // focus starts on the file list
  useEffect(() => {
    const t = setTimeout(() => listRef.current?.focus(), 50)
    return () => clearTimeout(t)
  }, [])

  // ------------------------------------------------------------ resizing --

  const drag = (e: React.PointerEvent<HTMLDivElement>, set: (x: number) => void): void => {
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
    const moveP = (ev: PointerEvent): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => set(ev.clientX))
    }
    const up = (): void => {
      el.removeEventListener('pointermove', moveP)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      document.body.classList.remove('resizing')
    }
    el.addEventListener('pointermove', moveP)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }
  const listW = Math.max(MIN_LIST, Math.min(settings.reviewListWidth ?? 340, window.innerWidth * 0.4))
  const chatW = agentKey ? Math.max(MIN_CHAT, Math.min(settings.reviewChatWidth ?? chatDefault(), window.innerWidth * 0.55)) : 0

  // ------------------------------------------------------------- drawing --

  const options = useMemo<{ base: RefOption[]; head: RefOption[] }>(
    () => (info ? { base: refOptions(info, false), head: refOptions(info, true) } : { base: [], head: [] }),
    [info]
  )
  const totals = changeEntries.reduce((t, e) => ({ a: t.a + (e.added ?? 0), r: t.r + (e.removed ?? 0) }), { a: 0, r: 0 })
  const repoName = root.split('/').filter(Boolean).pop() ?? root
  const headLabel = head === null ? 'Working tree' : (head ?? '…')
  const counts: Record<Tab, number | null> = {
    changes: compare ? changeEntries.length : null,
    local: status ? localCount : null,
    files: files ? files.length : null,
    commits: compare ? compare.commits.length : null
  }
  const tabName: Record<Tab, string> = { changes: 'Changes', local: 'Uncommitted', files: 'Files', commits: 'Commits' }
  const commentCount = (e: Entry): number => comments.filter((c) => c.path === e.path && c.anchor === e.anchor).length
  const hint = escHint
    ? 'Esc again discards it'
    : typed
      ? 'Enter sends to the agent · Esc Esc takes it back'
      : draft
        ? '⌘↵ add the comment · Esc Esc discard'
        : `↑↓ files · → into the diff · C comment · N next change · ⌘↵ send review${comments.length ? ` (${comments.length})` : ''} · ⌘B base · ⌘P find · ⌘U ${sideBySide ? 'inline' : 'side by side'} · Esc close`

  return (
    <div className="media-overlay rv" style={{ '--rv-list': `${listW}px`, '--side-w': `${chatW}px` } as React.CSSProperties}>
      <header className="media-head rv-head">
        <span className="rv-title">Review</span>
        {repos && repos.length > 1 ? (
          <span className="rv-ref-wrap rv-refs">
            <button className="rv-ref rv-repo" title={`${root}\nAnother repository in ${folder} (⌘O)`} onMouseDown={(e) => e.preventDefault()} onClick={() => setPicker(picker === 'repo' ? null : 'repo')}>
              {dir ? repoLabel(dir, folder) : '…'} <span className="dim">· {repos.length} repos ▾</span>
            </button>
            {picker === 'repo' && (
              <RefPicker
                title={`Repositories in ${folder.split('/').filter(Boolean).pop() ?? folder}`}
                placeholder="Filter repositories"
                typed={false}
                options={repos.map((r) => ({
                  value: r.path,
                  label: repoLabel(r.path, folder),
                  detail: [r.branch ?? (r.head ? `detached at ${r.head}` : 'no commits yet'), r.path === folder ? 'the folder itself' : ''].filter(Boolean).join(' · '),
                  kind: 'repo',
                  time: r.active || undefined
                }))}
                current={dir}
                onPick={pickRepo}
                onClose={() => setPicker(null)}
              />
            )}
          </span>
        ) : (
          <span className="media-name" title={root}>
            {repoName}
          </span>
        )}
        {host !== 'local' && <span className="media-meta">on {host}</span>}
        {commit ? (
          <span className="rv-refs">
            <span className="rv-ref static">commit {commit.short}</span>
            <span className="rv-commit-subject">{commit.subject}</span>
            <button className="rv-ref" onClick={() => setCommit(null)} title="Back to the whole branch (Esc)">
              ← all of {headLabel}
            </button>
          </span>
        ) : (
          <span className="rv-refs">
            <span className="rv-ref-wrap">
              <button className="rv-ref" title="Compare with… (⌘B)" onMouseDown={(e) => e.preventDefault()} onClick={() => setPicker(picker === 'base' ? null : 'base')}>
                <span className="dim">base</span> {base ?? '…'} ▾
              </button>
              {picker === 'base' && (
                <RefPicker title="Compare with (base)" options={options.base} current={base} onPick={(v) => pickRef('base', v)} onClose={() => setPicker(null)} />
              )}
            </span>
            <span className="rv-arrow">←</span>
            <span className="rv-ref-wrap">
              <button className="rv-ref" title="The changes of… (⇧⌘B)" onMouseDown={(e) => e.preventDefault()} onClick={() => setPicker(picker === 'head' ? null : 'head')}>
                <span className="dim">changes in</span> {headLabel} ▾
              </button>
              {picker === 'head' && (
                <RefPicker title="Changes in (head)" options={options.head} current={head} onPick={(v) => pickRef('head', v)} onClose={() => setPicker(null)} />
              )}
            </span>
          </span>
        )}
        {compare && (
          <span className="media-meta">
            {changeEntries.length} file{changeEntries.length === 1 ? '' : 's'} <span className="rv-add">+{totals.a}</span> <span className="rv-del">−{totals.r}</span>
            {compare.commits.length ? ` · ${compare.commits.length} commit${compare.commits.length === 1 ? '' : 's'}` : ''}
          </span>
        )}
        {comparing && <span className="media-meta">comparing…</span>}
        <span className="ph-spacer" />
        {note ? <span className="media-note">{note}</span> : <span className="media-keys">{hint}</span>}
        <button className="media-save" onMouseDown={(e) => e.preventDefault()} onClick={() => updateSettings({ reviewInline: sideBySide })} title="Side by side or inline (⌘U)">
          {sideBySide ? 'Inline' : 'Side by side'}
        </button>
        <button
          className={`media-save ${comments.length ? 'rv-send' : ''}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={sendReview}
          title={agentKey ? 'Send the comments to the agent as one message (⌘↵)' : 'Copy the comments as one message (⌘↵)'}
        >
          {agentKey ? 'Send review' : 'Copy review'}
          {comments.length ? ` (${comments.length})` : ''}
        </button>
      </header>
      <div className="media-body">
        <aside className="rv-side">
          <nav className="rv-tabs">
            {TABS.map((t, i) => (
              <button key={t} className={t === tab ? 'on' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => pickTab(t)} title={`⌘${i + 1}`}>
                {tabName[t]}
                {counts[t] !== null && <span className="rv-count">{counts[t]}</span>}
              </button>
            ))}
          </nav>
          <input
            ref={filterRef}
            className="rv-filter"
            value={filter}
            placeholder={tab === 'commits' ? 'Filter commits (⌘P)' : 'Go to file (⌘P)'}
            spellCheck={false}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="rv-list" ref={listRef} tabIndex={0}>
            {error && <div className="rv-empty">{error}</div>}
            {!error && tab === 'changes' && compareError && <div className="rv-empty">{compareError}</div>}
            {!error && !rows.length && !(tab === 'changes' && compareError) && (
              <div className="rv-empty">
                {(tab === 'changes' && !compare) || (tab === 'local' && !status) || (tab === 'files' && !files) || (tab === 'commits' && !compare)
                  ? 'Reading…'
                  : q
                    ? 'Nothing matches.'
                    : tab === 'changes'
                      ? `No changes: ${headLabel} has nothing that ${base} doesn't.`
                      : tab === 'local'
                        ? 'Nothing uncommitted.'
                        : tab === 'commits'
                          ? `No commits on ${headLabel} that ${base} doesn't have.`
                          : 'No files.'}
              </div>
            )}
            {rows.map((r) => {
              const on = r.id === current?.id
              if (r.type === 'group')
                return (
                  <div key={r.id} className="rv-group">
                    {r.label} <span className="rv-count">{r.count}</span>
                  </div>
                )
              if (r.type === 'commit')
                return (
                  <button
                    key={r.id}
                    className={`rv-row rv-commit ${on ? 'on' : ''}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setCursor((c) => ({ ...c, commits: r.id }))
                      viewCommit(r.commit)
                    }}
                    title={`${r.commit.sha}\n${r.commit.author}`}
                  >
                    <span className="rv-sha">{r.commit.short}</span>
                    <span className="rv-name">{r.commit.subject}</span>
                    <span className="rv-age">{ago(r.commit.time)}</span>
                  </button>
                )
              const pad = { paddingLeft: 8 + r.depth * 12 }
              if (r.type === 'dir')
                return (
                  <button
                    key={r.id}
                    className={`rv-row rv-dir ${on ? 'on' : ''}`}
                    style={pad}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setCursor((c) => ({ ...c, [tab]: r.id }))
                      toggleDir(r.path)
                      listRef.current?.focus()
                    }}
                  >
                    <span className="rv-twist">{r.open ? '▾' : '▸'}</span>
                    <FileIcon look={look} path={r.path} folder open={r.open} />
                    <span className="rv-name">{r.name}</span>
                  </button>
                )
              const e = r.entry
              const kind = e.kind === 'file' ? changedKind.get(e.path) : e.kind
              const n = commentCount(e)
              return (
                <button
                  key={r.id}
                  className={`rv-row rv-file ${on ? 'on' : ''} ${kind ? `k-${kind === '?' ? 'u' : kind}` : ''}`}
                  style={pad}
                  title={e.oldPath ? `${e.oldPath} → ${e.path}` : e.path}
                  onMouseDown={(ev) => ev.preventDefault()}
                  onClick={() => {
                    setCursor((c) => ({ ...c, [tab]: r.id }))
                    listRef.current?.focus()
                  }}
                  onDoubleClick={() => pane.current?.focus()}
                >
                  {r.depth > 0 || tab !== 'local' ? <span className="rv-twist" /> : null}
                  <FileIcon look={look} path={e.path} />
                  <span className={`rv-name ${e.kind === 'D' ? 'gone' : ''}`}>{r.name}</span>
                  {r.dir ? <span className="rv-dir-name">{r.dir}</span> : <span className="ph-spacer" />}
                  {n > 0 && <span className="rv-ccount" title={`${n} comment${n === 1 ? '' : 's'}`}>💬{n}</span>}
                  {e.added !== undefined && (e.added || e.removed) ? (
                    <span className="rv-stat">
                      <span className="rv-add">+{e.added}</span> <span className="rv-del">−{e.removed}</span>
                    </span>
                  ) : null}
                  {kind && (
                    <span className="rv-kind" title={KIND_LABEL[kind]}>
                      {kind === '?' ? 'U' : kind}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          {comments.length > 0 && (
            <div className="rv-review">
              <div className="rv-review-head">
                Review · {comments.length} comment{comments.length === 1 ? '' : 's'}
                <span className="ph-spacer" />
                <button onMouseDown={(e) => e.preventDefault()} onClick={sendReview}>
                  {agentKey ? 'Send ⌘↵' : 'Copy ⌘↵'}
                </button>
              </div>
              {comments.map((c) => (
                <button
                  key={c.id}
                  className="rv-review-item"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    // to the file, in the list of the diff it was written on
                    const t: Tab = c.anchor.startsWith('l:') ? 'local' : c.anchor.startsWith('f:') ? 'files' : 'changes'
                    const id = t === 'changes' ? `c:${c.path}` : t === 'files' ? `f:${c.path}` : `${c.anchor}:${c.path}`
                    setTab(t)
                    setFilter('')
                    setCursor((x) => ({ ...x, [t]: id }))
                    if (t === 'changes' && changeEntries[0]?.anchor !== c.anchor) setNote(`That comment is on ${c.context}`)
                  }}
                >
                  <span className="rv-review-where">
                    {c.path.split('/').pop()}:{c.start === c.end ? c.start : `${c.start}–${c.end}`}
                  </span>
                  <span className="rv-review-text">{c.text}</span>
                </button>
              ))}
            </div>
          )}
        </aside>
        <div
          className="media-split"
          onPointerDown={(e) => drag(e, (x) => updateSettings({ reviewListWidth: Math.round(Math.max(MIN_LIST, Math.min(x, window.innerWidth * 0.4))) }))}
          onDoubleClick={() => updateSettings({ reviewListWidth: undefined })}
          title="Drag to resize · double-click to reset"
        />
        <section className="rv-main">
          {shown && (
            <div className="rv-file-head">
              <FileIcon look={look} path={shown.path} />
              <span className="rv-file-path">
                {shown.oldPath && shown.oldPath !== shown.path ? (
                  <>
                    <span className="dim">{shown.oldPath} → </span>
                    {shown.path}
                  </>
                ) : (
                  shown.path
                )}
              </span>
              {currentEntry && currentEntry.kind !== 'file' && <span className={`rv-kind-word k-${currentEntry.kind === '?' ? 'u' : currentEntry.kind}`}>{KIND_LABEL[currentEntry.kind]}</span>}
              {currentEntry?.mode === 'diff' && (
                <span className="dim rv-sides">
                  {sideLabel(currentEntry.left, compare)} → {sideLabel(currentEntry.right, compare)}
                </span>
              )}
              <span className="ph-spacer" />
              {shown.loading && <span className="dim">loading…</span>}
            </div>
          )}
          {env && look ? (
            <DiffPane
              env={env}
              look={look}
              shown={shown}
              sideBySide={sideBySide}
              comments={comments}
              draft={draft}
              setDraft={setDraft}
              onSave={saveDraft}
              onRemove={(id) => setComments(comments.filter((c) => c.id !== id))}
              api={pane}
            />
          ) : (
            <div className="rv-msg">{envError ?? 'Loading the editor…'}</div>
          )}
        </section>
        {agentKey && (
          <>
            <div
              className="media-split"
              onPointerDown={(e) => drag(e, (x) => updateSettings({ reviewChatWidth: Math.round(Math.max(MIN_CHAT, Math.min(window.innerWidth - x, window.innerWidth * 0.55))) }))}
              onDoubleClick={() => updateSettings({ reviewChatWidth: undefined })}
              title="Drag to resize · double-click to reset"
            />
            <aside className="media-side rv-chat">
              <AgentChat
                agentKey={agentKey}
                live={live}
                autoFocus={false}
                onTyped={setTyped}
                hint={escHint ? 'Esc again takes it back' : typed ? 'Enter sends · Esc Esc takes it back' : 'typing to the agent · Enter sends · Esc back to the files'}
              />
            </aside>
          </>
        )}
      </div>
    </div>
  )
}

/** "main", "index", "disk", "abc1234" */
function sideLabel(s: GitSide, c: GitCompare | null): string {
  if (s.kind === 'empty') return '∅'
  if (s.kind === 'index') return 'staged'
  if (s.kind === 'worktree') return 'on disk'
  const short = (name: string): string => name.replace(/\b[0-9a-f]{40}\b/g, (sha) => sha.slice(0, 7))
  const sha = s.rev.slice(0, 7)
  if (c && s.rev === c.mergeBase) return /^[0-9a-f]{40}/.test(c.base) ? short(c.base) : `${c.base} (${sha})`
  if (c && s.rev === c.tip) return c.head && /^[0-9a-f]{40}$/.test(c.head) ? sha : `${c.head ?? 'HEAD'} (${sha})`
  return short(s.rev)
}

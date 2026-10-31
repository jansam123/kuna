/**
 * Git for the review view (⌘G): what `kuna git …` prints on a host, parsed;
 * which branch to compare with; and the message that carries review comments
 * to the agent. Read-only: Kuna never stages, commits or checks anything out.
 *
 * `kuna git` output is split into sections by `\x1e<name>\x1e` markers; git's
 * own lists inside them are NUL-separated (`-z`), so any path survives.
 */

/** A, M, D, R(enamed), C(opied), T(ype changed), U(nmerged), ?(untracked) */
export type ChangeKind = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | '?'

export interface FileChange {
  path: string
  /** where a renamed or copied file came from */
  oldPath?: string
  kind: ChangeKind
  added?: number
  removed?: number
  /** git counts no lines in it */
  binary?: boolean
}

export interface GitRef {
  /** refs/heads/x, refs/remotes/origin/x, refs/tags/v1 */
  name: string
  /** what git and the pickers call it: x, origin/x, v1 */
  short: string
  kind: 'branch' | 'remote' | 'tag'
  sha: string
  /** committer time, epoch seconds */
  time: number
  subject: string
}

export interface GitWorktree {
  path: string
  /** short branch name; none when detached */
  branch?: string
  head?: string
}

export interface GitInfo {
  root: string
  /** the checked-out branch; none when detached */
  branch?: string
  head?: string
  /** origin's default branch (origin/HEAD), e.g. origin/main */
  defaultBranch?: string
  /** the checked-out branch's upstream, e.g. origin/feat-x */
  upstream?: string
  refs: GitRef[]
  worktrees: GitWorktree[]
}

export interface GitStatus {
  staged: FileChange[]
  unstaged: FileChange[]
  untracked: FileChange[]
  conflicts: FileChange[]
}

export interface GitCommit {
  sha: string
  short: string
  author: string
  time: number
  subject: string
}

/** `base...head` as a pull request shows it: head's changes since it left base. */
export interface GitCompare {
  base: string
  /** what head is compared with: the merge base (base itself when they share no history) */
  mergeBase: string
  /** null: the working tree, uncommitted changes included */
  head: string | null
  /** the commit head points at (HEAD for the working tree) */
  tip: string
  files: FileChange[]
  commits: GitCommit[]
}

/** One side of a diff: a file at a commit, in the index, in the working tree, or nothing. */
export type GitSide =
  | { kind: 'rev'; rev: string; path: string }
  | { kind: 'index'; path: string }
  | { kind: 'worktree'; path: string }
  | { kind: 'empty' }

export interface GitBlob {
  /** bytes; absent when the file does not exist there or is too large */
  data?: Uint8Array
  size: number
  missing?: boolean
  tooBig?: boolean
}

/** How `kuna git cat` names a side: G<rev>:<path>, I<path>, W<path>. */
export function specOf(side: GitSide): string | null {
  switch (side.kind) {
    case 'rev':
      return `G${side.rev}:${side.path}`
    case 'index':
      return `I${side.path}`
    case 'worktree':
      return `W${side.path}`
    case 'empty':
      return null
  }
}

/**
 * Refs Kuna passes to git: names and commits, never an option (`-x`), a range
 * (`a..b`) or anything a shell or git would read as more than a name.
 */
export function validRef(ref: string): boolean {
  return /^[A-Za-z0-9._/@^~+-]{1,250}$/.test(ref) && !ref.startsWith('-') && !ref.includes('..')
}

/** A path inside the repository: relative, no `..` steps, no NULs. */
export function validRepoPath(path: string): boolean {
  if (!path || path.length > 4096 || path.startsWith('/') || path.includes('\0')) return false
  return !path.split('/').some((p) => p === '..')
}

/** `\x1ename\x1e…` sections → name → text. */
export function sections(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /\x1e([a-z]+)\x1e/g
  let m: RegExpExecArray | null
  let name: string | null = null
  let from = 0
  while ((m = re.exec(text))) {
    if (name !== null) out[name] = text.slice(from, m.index)
    name = m[1]
    from = re.lastIndex
  }
  if (name !== null) out[name] = text.slice(from)
  return out
}

const nul = (text: string): string[] => text.split('\0')

function kindOf(code: string): ChangeKind {
  const c = code[0]
  return 'AMDRCTU'.includes(c) ? (c as ChangeKind) : 'M'
}

/** `git diff --name-status -z`: `M\0path\0`, `R100\0old\0new\0`. */
export function parseNameStatus(text: string): FileChange[] {
  const t = nul(text)
  const out: FileChange[] = []
  let i = 0
  while (i < t.length) {
    const code = t[i].replace(/^\n+/, '')
    if (!code) {
      i++
      continue
    }
    if (code[0] === 'R' || code[0] === 'C') {
      if (t[i + 2] === undefined) break
      out.push({ kind: code[0] as ChangeKind, oldPath: t[i + 1], path: t[i + 2] })
      i += 3
    } else {
      if (t[i + 1] === undefined) break
      out.push({ kind: kindOf(code), path: t[i + 1] })
      i += 2
    }
  }
  return out.filter((f) => f.path)
}

/**
 * `git diff --numstat -z`: `added\tremoved\tpath\0`, renames as
 * `added\tremoved\t\0old\0new\0`; `-` counts mean a binary file.
 */
export function parseNumstat(text: string): Map<string, { added?: number; removed?: number; binary?: boolean }> {
  const t = nul(text)
  const out = new Map<string, { added?: number; removed?: number; binary?: boolean }>()
  let i = 0
  while (i < t.length) {
    const rec = t[i].replace(/^\n+/, '')
    const parts = rec.split('\t')
    if (parts.length < 3) {
      i++
      continue
    }
    let path: string
    if (parts[2] === '' && parts.length === 3) {
      path = t[i + 2] ?? ''
      i += 3
    } else {
      path = parts.slice(2).join('\t')
      i++
    }
    if (!path) continue
    const binary = parts[0] === '-' && parts[1] === '-'
    out.set(path, binary ? { binary } : { added: Number(parts[0]) || 0, removed: Number(parts[1]) || 0 })
  }
  return out
}

function withCounts(files: FileChange[], counts: string | undefined): FileChange[] {
  if (!counts) return files
  const n = parseNumstat(counts)
  return files.map((f) => ({ ...f, ...n.get(f.path) }))
}

/**
 * `git status --porcelain -z` (v1, which old cluster gits know too): `XY path\0`,
 * with the original path after a rename (`R  new\0old\0`). X is the index, Y the
 * working tree.
 */
export function parseStatus(text: string, staged?: string, unstaged?: string): GitStatus {
  const t = nul(text)
  const st: GitStatus = { staged: [], unstaged: [], untracked: [], conflicts: [] }
  let i = 0
  while (i < t.length) {
    const rec = t[i]
    i++
    if (rec.length < 4) continue
    const x = rec[0]
    const y = rec[1]
    const path = rec.slice(3)
    let oldPath: string | undefined
    if (x === 'R' || x === 'C') {
      oldPath = t[i]
      i++
    }
    if (x === '?' && y === '?') {
      st.untracked.push({ path, kind: '?' })
      continue
    }
    if (x === '!') continue
    if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
      st.conflicts.push({ path, kind: 'U' })
      continue
    }
    if ('MADRCT'.includes(x)) st.staged.push({ path, kind: x as ChangeKind, ...(oldPath ? { oldPath } : {}) })
    if ('MDTA'.includes(y)) st.unstaged.push({ path, kind: y as ChangeKind })
  }
  st.staged = withCounts(st.staged, staged)
  st.unstaged = withCounts(st.unstaged, unstaged)
  return st
}

/** `for-each-ref` lines: `refname\tsha\t<time> <zone>\tsubject`. */
export function parseRefs(text: string): GitRef[] {
  const out: GitRef[] = []
  for (const line of text.split('\n')) {
    const [name, sha, date, ...rest] = line.split('\t')
    if (!name || !sha) continue
    let kind: GitRef['kind']
    let short: string
    if (name.startsWith('refs/heads/')) [kind, short] = ['branch', name.slice(11)]
    else if (name.startsWith('refs/remotes/')) [kind, short] = ['remote', name.slice(13)]
    else if (name.startsWith('refs/tags/')) [kind, short] = ['tag', name.slice(10)]
    else continue
    // origin/HEAD is only a pointer to the default branch
    if (kind === 'remote' && short.endsWith('/HEAD')) continue
    out.push({ name, short, kind, sha, time: Number((date ?? '').split(' ')[0]) || 0, subject: rest.join('\t') })
  }
  return out
}

/** `git worktree list --porcelain`: blocks of `worktree`, `HEAD`, `branch` lines. */
export function parseWorktrees(text: string): GitWorktree[] {
  const out: GitWorktree[] = []
  let cur: GitWorktree | null = null
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9) }
      out.push(cur)
    } else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5)
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '')
  }
  return out
}

/** `git log -z --format=%H%x09%h%x09%an%x09%at%x09%s` */
export function parseCommits(text: string): GitCommit[] {
  const out: GitCommit[] = []
  for (const rec of nul(text)) {
    const [sha, short, author, time, ...rest] = rec.replace(/^\n+/, '').split('\t')
    if (!sha || !short) continue
    out.push({ sha, short, author: author ?? '', time: Number(time) || 0, subject: rest.join('\t') })
  }
  return out
}

/** `kuna git info` */
export function parseInfo(text: string): GitInfo {
  const s = sections(text)
  const kv: Record<string, string> = {}
  for (const line of (s.info ?? '').split('\n')) {
    const tab = line.indexOf('\t')
    if (tab > 0) kv[line.slice(0, tab)] = line.slice(tab + 1).trim()
  }
  return {
    root: kv.root ?? '',
    branch: kv.branch || undefined,
    head: kv.head || undefined,
    defaultBranch: kv.default || undefined,
    upstream: kv.upstream || undefined,
    refs: parseRefs(s.refs ?? ''),
    worktrees: parseWorktrees(s.worktrees ?? '')
  }
}

/** `kuna git compare` */
export function parseCompare(text: string, base: string, head: string | null): GitCompare {
  const s = sections(text)
  const files = withCounts(parseNameStatus(s.files ?? ''), s.counts)
  // the working tree: files git does not know yet are part of the change too
  const tracked = new Set(files.map((f) => f.path))
  for (const p of nul(s.untracked ?? '')) if (p && !tracked.has(p)) files.push({ path: p, kind: '?' })
  return {
    base,
    mergeBase: (s.base ?? '').trim(),
    head,
    tip: (s.tip ?? '').trim(),
    files: sortChanges(files),
    commits: parseCommits(s.commits ?? '')
  }
}

/** Paths in tree order: a folder's files after its subfolders, as VS Code and GitHub list them. */
export function comparePaths(a: string, b: string): number {
  const pa = a.split('/')
  const pb = b.split('/')
  const n = Math.min(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    if (pa[i] === pb[i]) continue
    const aDir = i < pa.length - 1
    const bDir = i < pb.length - 1
    if (aDir !== bDir) return aDir ? -1 : 1
    return pa[i].localeCompare(pb[i], undefined, { numeric: true, sensitivity: 'base' }) || (pa[i] < pb[i] ? -1 : 1)
  }
  return pa.length - pb.length
}

export function sortChanges(files: FileChange[]): FileChange[] {
  return [...files].sort((a, b) => comparePaths(a.path, b.path))
}

/**
 * What to compare with when the view opens: origin's default branch (as a
 * pull request would), else a local main/master. On that branch itself, its
 * upstream, so unpushed commits show.
 */
export function defaultBase(info: GitInfo): string | undefined {
  const names = new Set(info.refs.map((r) => r.short))
  const def = info.defaultBranch
  const localDef = def?.replace(/^[^/]+\//, '')
  const order = [def, localDef, 'origin/main', 'main', 'origin/master', 'master', 'origin/develop', 'develop'].filter((n): n is string => !!n)
  const current = info.branch
  for (const n of order) if (names.has(n) && n !== current) return n
  if (info.upstream && names.has(info.upstream)) return info.upstream
  return order.find((n) => names.has(n))
}

// ------------------------------------------------------------ the tree ----

export interface TreeDir<T> {
  name: string
  /** path of the folder, '' for the root */
  path: string
  dirs: TreeDir<T>[]
  files: { name: string; item: T }[]
}

/**
 * Paths as a folder tree, with single-child folders chained ("src/main/remote")
 * as VS Code's compact folders do.
 */
export function buildTree<T>(items: T[], pathOf: (it: T) => string, compact = true): TreeDir<T> {
  const root: TreeDir<T> = { name: '', path: '', dirs: [], files: [] }
  const index = new Map<string, TreeDir<T>>([['', root]])
  for (const it of items) {
    const parts = pathOf(it).split('/')
    let dir = root
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join('/')
      let next = index.get(p)
      if (!next) {
        next = { name: parts[i], path: p, dirs: [], files: [] }
        index.set(p, next)
        dir.dirs.push(next)
      }
      dir = next
    }
    dir.files.push({ name: parts[parts.length - 1], item: it })
  }
  const sortDir = (d: TreeDir<T>): void => {
    d.dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    d.files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    d.dirs.forEach(sortDir)
  }
  sortDir(root)
  if (compact) {
    const squash = (d: TreeDir<T>): TreeDir<T> => {
      while (d.files.length === 0 && d.dirs.length === 1 && d.path) {
        const only = d.dirs[0]
        d = { ...only, name: `${d.name}/${only.name}` }
      }
      return { ...d, dirs: d.dirs.map(squash) }
    }
    return { ...root, dirs: root.dirs.map(squash) }
  }
  return root
}

// -------------------------------------------------------- review comments --

export interface ReviewComment {
  id: string
  path: string
  /** old: a line as it was before the change (a removed line); new: as it is now */
  side: 'old' | 'new'
  /** 1-based, inclusive */
  start: number
  end: number
  text: string
  /** the lines commented on, to quote */
  code: string[]
}

const MAX_QUOTE = 6

/**
 * The message that takes review comments to the agent: what was reviewed, then
 * each comment with its place and the lines it is about.
 */
export function reviewMessage(comments: ReviewComment[], what: string): string {
  const sorted = [...comments].sort((a, b) => comparePaths(a.path, b.path) || a.start - b.start)
  const out = [`Review comments on ${what}. Please address each one:`, '']
  sorted.forEach((c, i) => {
    const lines = c.start === c.end ? `${c.start}` : `${c.start}-${c.end}`
    out.push(`${i + 1}. ${c.path}:${lines}${c.side === 'old' ? ' (removed lines, as they were before the change)' : ''}`)
    const quote = c.code.slice(0, MAX_QUOTE)
    if (quote.length) {
      const fence = quote.some((l) => l.includes('```')) ? '~~~' : '```'
      out.push(`   ${fence}`, ...quote.map((l) => `   ${l}`), ...(c.code.length > MAX_QUOTE ? ['   …'] : []), `   ${fence}`)
    }
    out.push(...c.text.trim().split('\n').map((l) => `   ${l}`), '')
  })
  return out.join('\n').trimEnd()
}

/** `kuna git cat` output: per file `\x1e<size>\x1e<bytes>` (bytes only when size <= max), `\x1e-\x1e` when missing. */
export function parseBlobs(buf: Uint8Array, max: number): GitBlob[] {
  const out: GitBlob[] = []
  let i = 0
  while (i < buf.length) {
    if (buf[i] !== 0x1e) break
    const end = buf.indexOf(0x1e, i + 1)
    if (end < 0) break
    const head = String.fromCharCode(...buf.subarray(i + 1, end))
    i = end + 1
    if (head === '-') {
      out.push({ size: 0, missing: true })
      continue
    }
    const size = Number(head) || 0
    if (size > max) {
      out.push({ size, tooBig: true })
      continue
    }
    // a copy: a view would carry the whole output across IPC
    out.push({ size, data: new Uint8Array(buf.subarray(i, i + size)) })
    i += size
  }
  return out
}

/** a file that is shown as a picture rather than text */
export function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i.test(path)
}

/** Binary content: a NUL in the first 8000 bytes, as git decides. */
export function looksBinary(data: Uint8Array): boolean {
  const n = Math.min(data.length, 8000)
  for (let i = 0; i < n; i++) if (data[i] === 0) return true
  return false
}

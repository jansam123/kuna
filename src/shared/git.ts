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
 * Refs Kuna passes to git: any branch, tag or commit name (`issue#12`,
 * `feature/überarbeitung`), but never an option (`-x`), a range (`a..b`), a
 * `rev:path`, or whitespace, control characters or backslashes. They travel
 * base64-encoded and quoted, so only what git itself reads matters.
 */
export function validRef(ref: string): boolean {
  if (!ref || ref.length > 250 || ref.startsWith('-') || ref.includes('..')) return false
  // eslint-disable-next-line no-control-regex
  return !/[\s\x00-\x1f\x7f:\\]/.test(ref)
}

/** A path inside the repository: relative, no `..` steps, no NULs. */
export function validRepoPath(path: string): boolean {
  if (!path || path.length > 4096 || path.startsWith('/') || path.includes('\0')) return false
  return !path.split('/').some((p) => p === '..')
}

/** a full commit id, which always names the same thing (HEAD and branches move) */
export const isSha = (rev: string): boolean => /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(rev)

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
 * Compared with the disk without refreshing the index (which would write it),
 * a file that was only touched shows as modified with nothing changed in it:
 * left out. (A change of mode alone goes with it.)
 */
function dropTouched(files: FileChange[], counts: string | undefined): FileChange[] {
  if (counts === undefined) return files
  // --numstat leaves such a file out, or counts nothing in it
  const n = parseNumstat(counts)
  return files.filter((f) => {
    if (f.kind !== 'M') return true
    const c = n.get(f.path)
    return !!c && (!!c.binary || !!c.added || !!c.removed)
  })
}

/** a nested repository or an empty folder git lists as `dir/`: not a file to show */
const isFile = (p: string): boolean => !!p && !p.endsWith('/')

/**
 * `kuna git status`: staged (diff-index --cached), changes (diff-files),
 * untracked (ls-files -o), each with its counts; files in conflict show as U
 * in both and are listed once, as conflicts.
 */
export function parseStatus(s: Record<string, string>): GitStatus {
  const staged = withCounts(parseNameStatus(s.staged ?? ''), s.stagedcounts)
  const unstaged = withCounts(parseNameStatus(s.unstaged ?? ''), s.unstagedcounts)
  const conflicted = new Set([...staged, ...unstaged].filter((f) => f.kind === 'U').map((f) => f.path))
  return {
    staged: sortChanges(staged.filter((f) => !conflicted.has(f.path))),
    unstaged: sortChanges(dropTouched(unstaged, s.unstagedcounts).filter((f) => !conflicted.has(f.path))),
    untracked: sortChanges(nul(s.untracked ?? '').filter(isFile).map((path) => ({ path, kind: '?' as const }))),
    conflicts: sortChanges([...conflicted].map((path) => ({ path, kind: 'U' as const })))
  }
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
  let files = withCounts(parseNameStatus(s.files ?? ''), s.counts)
  if (head === null) {
    files = dropTouched(files, s.counts)
    // the working tree: files git does not know yet are part of the change too
    const tracked = new Set(files.map((f) => f.path))
    for (const p of nul(s.untracked ?? '')) if (isFile(p) && !tracked.has(p)) files.push({ path: p, kind: '?' })
  }
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
  /** which diff it was written on (a comparison, the staged changes…): it shows only there */
  anchor: string
  /** that diff in words, for the agent: "`feat` compared with `main`", "the staged changes" */
  context: string
}

const MAX_QUOTE = 6

/**
 * The message that takes review comments to the agent: what was reviewed, then
 * each comment with its place, the lines it is about and, when the comments
 * were made on different diffs, which one.
 */
export function reviewMessage(comments: ReviewComment[]): string {
  const sorted = [...comments].sort((a, b) => comparePaths(a.path, b.path) || a.start - b.start)
  const contexts = [...new Set(sorted.map((c) => c.context))]
  const one = contexts.length === 1
  const out = [one ? `Review comments on ${contexts[0]}. Please address each one:` : 'Review comments. Please address each one:', '']
  sorted.forEach((c, i) => {
    const lines = c.start === c.end ? `${c.start}` : `${c.start}-${c.end}`
    const notes = [c.side === 'old' ? 'removed lines, as they were before the change' : '', one ? '' : `in ${c.context}`].filter(Boolean)
    out.push(`${i + 1}. ${c.path}:${lines}${notes.length ? ` (${notes.join('; ')})` : ''}`)
    const quote = c.code.slice(0, MAX_QUOTE)
    if (quote.length) {
      const fence = quote.some((l) => l.includes('```')) ? '~~~' : '```'
      out.push(`   ${fence}`, ...quote.map((l) => `   ${l}`), ...(c.code.length > MAX_QUOTE ? ['   …'] : []), `   ${fence}`)
    }
    out.push(...c.text.trim().split('\n').map((l) => `   ${l}`), '')
  })
  return out.join('\n').trimEnd()
}

/**
 * `kuna git cat` output: per file `\x1e<size>\x1e` and exactly that many bytes,
 * `\x1e+<size>\x1e` (no bytes) when larger than the helper's limit, `\x1e-\x1e`
 * when it is not there.
 */
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
    const size = Number(head.replace(/^\+/, '')) || 0
    if (head.startsWith('+') || size > max) {
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

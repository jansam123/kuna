import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { app, shell } from 'electron'
import { mediaKind, mimeFor, resolveAgainst, viewerOrder } from '@shared/media'
import type { ClaudeFileEntry, HostId, MediaItem, MediaPage } from '@shared/types'
import type { AgentService } from './agents'
import { b64 } from './hosts/exec'

const MB = 1024 * 1024
/** the largest plot or PDF the viewer reads: it is held in memory, here and in the window */
const MAX_MEDIA_BYTES = 1024 * MB
/** a Markdown file past this is not a note to read in the viewer */
const MAX_MD_BYTES = 4 * MB
/** a .claude file past this is not shown */
const MAX_CLAUDE_FILE_BYTES = 2 * MB
/** files kept for going back and forth, at most this much in all (the newest is kept whatever its size) */
const CACHE_BYTES = 512 * MB
const CACHE_FILES = 30
/** reading a file over ssh: two minutes, plus four seconds a megabyte (a slow link, ~250 KB/s) */
const readTimeout = (size: number): number => 120_000 + Math.ceil(size / MB) * 4000
const sizeText = (n: number): string => (n >= 1024 * MB ? `${n / 1024 / MB} GB` : `${n / MB} MB`)

/**
 * Images/PDFs an agent produced or mentioned, and the files behind them.
 * Browsing goes backwards one reply at a time: Space shows what the latest
 * reply mentioned (one `stat` on the host), older replies load only when the
 * user keeps going, and the folder scan (`find`, slow on shared disks) comes last.
 */
export class MediaService {
  private cache = new Map<string, { data: Buffer; at: number }>()

  constructor(private agents: AgentService) {}

  async list(key: string, page: { before?: number; scan?: boolean } = {}): Promise<MediaPage> {
    const agent = this.agents.agent(key)
    if (!agent) return { items: [], next: null }
    const host = this.agents.hostOf(key)
    const base = agent.worktree ?? agent.cwd
    if (page.scan) {
      const res =
        agent.kind === 'claude'
          ? await host.exec(
              ['media', agent.id, b64(base), String(Math.max(5, Math.ceil((Date.now() / 1000 - agent.createdAt) / 60) + 2))],
              { timeoutMs: 30_000 }
            )
          : await host.exec(['media', agent.id, b64(agent.cwd)], { timeoutMs: 30_000 })
      const found = res.code === 0 ? parseStat(res.stdout.toString('utf8')).sort((a, b) => b.mtime - a.mtime) : []
      return { items: viewerOrder(dedupe(found)), next: null }
    }

    // mentions grouped by reply, newest first
    const byTurn = new Map<number, string[]>()
    for (const r of this.agents.details(key)?.mediaRefs ?? []) {
      if (page.before !== undefined && r.turn >= page.before) continue
      const list = byTurn.get(r.turn) ?? []
      list.push(resolveAgainst(base, r.path))
      byTurn.set(r.turn, list)
    }
    const turns = [...byTurn.keys()].sort((x, y) => y - x)
    // the newest replies' files in one `stat` (up to ~80 paths: a whole session
    // so far, usually), so all their PDFs can come before the images
    let i = 0
    while (i < turns.length) {
      const batch: number[] = []
      let count = 0
      while (i < turns.length && (!batch.length || count + byTurn.get(turns[i])!.length <= 80)) {
        batch.push(turns[i])
        count += byTurn.get(turns[i])!.length
        i++
      }
      const paths = batch.flatMap((t) => byTurn.get(t)!)
      const res = await host.exec(['stat', b64(paths.join('\n'))], { timeoutMs: 20_000 })
      if (res.code !== 0) continue
      const found = new Map(parseStat(res.stdout.toString('utf8')).map((it) => [it.path, it]))
      // PDFs first, then images, then Markdown; each newest reply first, in the order the reply names them
      const items = viewerOrder(dedupe(paths.flatMap((p) => found.get(p) ?? [])))
      if (items.length) return { items, next: i < turns.length ? { before: batch[batch.length - 1] } : { scan: true } }
    }
    return { items: [], next: { scan: true } }
  }

  /** `stamp` (mtime:size) keys the cache, so a re-made plot is never served stale. */
  async fetch(hostId: HostId, path: string, stamp = ''): Promise<{ data: Uint8Array; mime: string } | { error: string }> {
    // only plots, PDFs and Markdown: the viewer has no business reading other files
    const kind = typeof path === 'string' ? mediaKind(path) : null
    if (!kind) return { error: 'Not an image, PDF or Markdown file.' }
    const max = kind === 'md' ? MAX_MD_BYTES : MAX_MEDIA_BYTES
    const ck = `${hostId}\0${path}\0${stamp}`
    const hit = this.cache.get(ck)
    if (hit && (stamp || Date.now() - hit.at < 5000)) return { data: hit.data, mime: mimeFor(path) }
    const size = Number(String(stamp).split(':')[1]) || 0
    if (size > max) return { error: `File is larger than ${sizeText(max)}.` }
    const res = await this.agents.host(hostId).exec(['cat', b64(path)], { timeoutMs: readTimeout(size), maxBytes: max })
    if (res.code !== 0) return { error: res.stderr.trim() || `could not read ${path}` }
    if (res.stdout.length > max) return { error: `File is larger than ${sizeText(max)}.` }
    this.cache.delete(ck)
    this.cache.set(ck, { data: res.stdout, at: Date.now() })
    let total = 0
    for (const v of this.cache.values()) total += v.data.length
    while (this.cache.size > 1 && (this.cache.size > CACHE_FILES || total > CACHE_BYTES)) {
      const oldest = this.cache.keys().next().value!
      total -= this.cache.get(oldest)!.data.length
      this.cache.delete(oldest)
    }
    return { data: res.stdout, mime: mimeFor(path) }
  }

  /**
   * Copy the file locally and open it in the default macOS app. SVGs are shown
   * in Finder instead: their default app is a browser, which runs scripts in them.
   */
  async openExternal(hostId: HostId, path: string, stamp = ''): Promise<void> {
    const res = await this.fetch(hostId, path, stamp)
    if ('error' in res) return
    const file = join(mkdtempSync(join(tmpdir(), 'kuna-media-')), basename(path))
    writeFileSync(file, res.data, { flag: 'wx' })
    if (mediaKind(path) === 'svg') shell.showItemInFolder(file)
    else await shell.openPath(file)
  }

  /** Save a copy in ~/Downloads (the viewer's cached bytes, so no second read on the host). */
  async save(hostId: HostId, path: string, stamp = ''): Promise<{ file: string } | { error: string }> {
    const res = await this.fetch(hostId, path, stamp)
    if ('error' in res) return res
    const dir = app.getPath('downloads')
    const ext = extname(basename(path))
    const stem = basename(path, ext)
    let file = join(dir, `${stem}${ext}`)
    for (let n = 1; existsSync(file); n++) file = join(dir, `${stem} (${n})${ext}`)
    try {
      writeFileSync(file, res.data, { flag: 'wx' })
    } catch (err) {
      return { error: `Could not save: ${(err as Error).message}` }
    }
    return { file }
  }
}

/** "mtime<TAB>size<TAB>path" lines from `kuna stat` / `kuna media`, in the order given. */
function parseStat(text: string): MediaItem[] {
  const items: MediaItem[] = []
  for (const line of text.split('\n')) {
    const [mtime, size, ...rest] = line.split('\t')
    const path = rest.join('\t')
    const kind = mediaKind(path)
    if (path && kind) items.push({ path, mtime: Number(mtime) || 0, size: Number(size) || 0, kind })
  }
  return items
}

/**
 * The same file is often reachable by two paths (/tmp vs /private/tmp,
 * symlinked scratch dirs): keep the first of each name+size+mtime.
 */
function dedupe(items: MediaItem[]): MediaItem[] {
  const seen = new Set<string>()
  return items.filter((it) => {
    const id = `${it.path.split('/').pop()}\0${it.size}\0${it.mtime}`
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

function classify(path: string): ClaudeFileEntry['kind'] {
  if (/\/skills\//.test(path)) return 'skill'
  if (/\/agents\//.test(path)) return 'agent'
  if (/\/commands\//.test(path) || /\/output-styles\//.test(path)) return 'command'
  if (/(CLAUDE|AGENTS)(\.local)?\.md$/.test(path)) return 'memory'
  if (/\.json$/.test(path)) return 'settings'
  return 'other'
}

function nameOf(path: string, kind: ClaudeFileEntry['kind']): string {
  const parts = path.split('/')
  const file = parts[parts.length - 1]
  if (kind === 'skill' && /^SKILL\.md$/i.test(file)) return parts[parts.length - 2]
  if (kind === 'skill') {
    // a file inside a skill directory: skillname/relative
    const i = parts.lastIndexOf('skills')
    return parts.slice(i + 1).join('/')
  }
  return file.replace(/\.md$/, '')
}

/** Browse ~/.claude and project .claude directories on any host. */
export class ClaudeFilesService {
  private dirCache = new Map<string, { list: string[]; at: number }>()
  /** per host, the files the last listing showed: only those can be read */
  private listed = new Map<HostId, Set<string>>()

  constructor(private agents: AgentService) {}

  async list(hostId: HostId, cwds: string[]): Promise<ClaudeFileEntry[]> {
    const host = this.agents.host(hostId)
    if (host.state.status !== 'ready') await host.connect()
    const res = await host.exec(['claude-files', b64(cwds.join('\n'))], { timeoutMs: 30_000 })
    const out: ClaudeFileEntry[] = []
    const seen = new Set<string>()
    for (const line of res.stdout.toString('utf8').split('\n')) {
      const [scope, ...rest] = line.split('\t')
      const path = rest.join('\t')
      if (!path || seen.has(path)) continue
      seen.add(path)
      const kind = classify(path)
      out.push({
        path,
        kind,
        name: nameOf(path, kind),
        scope: scope === 'P' ? 'plugin' : scope === 'L' ? 'project' : 'global'
      })
    }
    this.listed.set(hostId, seen)
    return out
  }

  async read(hostId: HostId, path: string): Promise<string> {
    if (!this.listed.get(hostId)?.has(path)) return `Not one of the listed .claude files: ${path}`
    const res = await this.agents.host(hostId).exec(['cat', b64(path)], { timeoutMs: 30_000, maxBytes: MAX_CLAUDE_FILE_BYTES })
    if (res.code !== 0) return `Could not read ${path}\n\n${res.stderr}`
    if (res.stdout.length > MAX_CLAUDE_FILE_BYTES) return `${path} is larger than ${sizeText(MAX_CLAUDE_FILE_BYTES)}; open it in an editor.`
    return res.stdout.toString('utf8')
  }

  async dirs(hostId: HostId, dir: string): Promise<string[]> {
    const ck = `${hostId}\0${dir}`
    const hit = this.dirCache.get(ck)
    if (hit && Date.now() - hit.at < 60_000) return hit.list
    const list = await this.listDirs(hostId, dir)
    this.dirCache.set(ck, { list, at: Date.now() })
    return list
  }

  /** Physical paths of directories on a host (symlinks resolved); missing ones are left out. */
  async realPaths(hostId: HostId, paths: string[]): Promise<Record<string, string>> {
    const host = this.agents.host(hostId)
    if (host.state.status !== 'ready') await host.connect()
    const res = await host.exec(['realpath', b64(paths.join('\n'))], { timeoutMs: 15_000 })
    const out: Record<string, string> = {}
    for (const line of res.stdout.toString('utf8').split('\n')) {
      const [path, real] = line.split('\t')
      if (path && real) out[path] = real
    }
    return out
  }

  private async listDirs(hostId: HostId, dir: string): Promise<string[]> {
    const host = this.agents.host(hostId)
    if (host.state.status !== 'ready') await host.connect()
    const res = await host.exec(['ls', b64(dir || '~')], { timeoutMs: 15_000 })
    return res.stdout
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
  }
}

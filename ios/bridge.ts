/**
 * What the iPhone app calls in Kuna's shared TypeScript. Bundled by
 * scripts/ios-bundle.mjs into one script the app runs in JavaScriptCore, so
 * both apps read hosts, transcripts and git with the same code. Everything
 * crosses as strings (JSON); nothing here may use Node or DOM globals.
 */
import { doingText, needsText } from '@shared/activity'
import { ChatLog } from '@shared/chat'
import { contextInfo, modelFlag, shortModel } from '@shared/context'
import { screenState } from '@shared/input'
import {
  defaultBase,
  parseCompare,
  parseDirListing,
  parseInfo,
  parseRepos,
  parseStatus,
  repoLabel,
  reviewMessage as reviewText,
  sections,
  sortChanges,
  validRef,
  type ReviewComment
} from '@shared/git'
import { mediaKind, pageFile as pageFileOf, resolveAgainst, viewerOrder } from '@shared/media'
import { emptyPhoneState, hostKeyVerdict, knownHostsName, mergeImport, parseExport, type PhoneHost, type PhoneState } from '@shared/phone'
import { REPO_COLORS, THEMES } from '@shared/themes'
import { OTHER_FOLDER_ID, assignAgents } from '@shared/tree'
import type { AgentRuntime, HostId, HostState, MediaItem, Project } from '@shared/types'
import { isHostId } from '@shared/validate'
import { frameToAgents, onLocalClock, parseFrame, titleOf } from '@shared/watch'

declare const __KUNA_SCRIPT__: string
declare const __KUNA_VERSION__: string

/** the helper installed on hosts, and the version it reports (as src/main/hosts/script.ts) */
export const script = __KUNA_SCRIPT__
export const version = __KUNA_VERSION__

// ---------------------------------------------------------------- agents ----

/** One watch frame's lines → the host's agents, with how to call each and what it is doing, in words. */
export function agents(host: string, lines: string[], now: number, offset: number): string {
  return JSON.stringify(
    onLocalClock(frameToAgents(host as HostId, parseFrame(lines, now)), offset).map((a) => ({
      ...a,
      title: titleOf(a),
      doing: doingText(a),
      needs: needsText(a),
      context: a.contextTokens ? contextInfo(a.contextTokens, a.model, a.contextPeak ?? 0, a.modelFlag ?? modelFlag(a.command)) : undefined,
      modelName: shortModel(a.model)
    }))
  )
}

/**
 * Which agents go under which folder, as the Mac's sidebar places them.
 * `lists`: each host's agents as `agents` returned them; `hidden`: sessions
 * taken off the list, shown again only when one is running.
 */
export function tree(projects: string, lists: string[], homes: string, hidden: string): string {
  const ps = JSON.parse(projects) as Project[]
  const gone = JSON.parse(hidden) as Record<string, number>
  const all = lists.flatMap((l) => JSON.parse(l) as AgentRuntime[]).filter((a) => !(a.key in gone) || a.alive)
  const hosts = Object.fromEntries(Object.entries(JSON.parse(homes) as Record<string, string>).map(([h, home]) => [h, { host: h, status: 'ready', home } as HostState]))
  const placed = assignAgents(ps, all, hosts)
  return JSON.stringify(
    ps.map((p) => ({
      id: p.id,
      folders: [...p.folders.map((f) => f.id), OTHER_FOLDER_ID].map((fid) => ({ id: fid, agents: (placed.get(`${p.id}:${fid}`) ?? []).map((a) => a.key) }))
    }))
  )
}

// ---------------------------------------------------------- state, import ----

export const emptyState = (): string => JSON.stringify(emptyPhoneState())

/** A file from the Mac taken into the phone's state; throws with a sentence for the user. */
export function importFile(state: string, file: string): string {
  return JSON.stringify(mergeImport(JSON.parse(state) as PhoneState, parseExport(file)))
}

export const knownName = (host: string): string => knownHostsName(JSON.parse(host) as PhoneHost)
export const keyVerdict = (known: string, offered: string): string => hostKeyVerdict(JSON.parse(known) as string[], offered)
export const validHost = (id: string): boolean => isHostId(id) && id !== 'local'
export const themes = (): string => JSON.stringify(THEMES)
export const repoColors = (): string => JSON.stringify(REPO_COLORS)

// ------------------------------------------------------------------ chat ----

const chats = new Map<string, ChatLog>()

/** Feed a piece of an agent's transcript; `restart`: the file was rewritten, start over. */
export function chatFeed(key: string, chunk: string, fromMiddle: boolean, restart: boolean): void {
  let log = chats.get(key)
  if (!log || restart) {
    log = new ChatLog()
    chats.set(key, log)
  }
  log.feed(chunk, fromMiddle)
}

export function chatState(key: string, max: number): string {
  const log = chats.get(key)
  if (!log) return JSON.stringify({ items: [], details: null })
  const d = log.details()
  return JSON.stringify({
    items: log.items(max),
    details: {
      title: d.title,
      model: shortModel(d.model),
      effort: d.effort,
      permissionMode: d.permissionMode,
      gitBranch: d.gitBranch,
      turns: d.turns,
      todos: d.todos,
      questions: d.pendingQuestions,
      context: d.contextTokens ? contextInfo(d.contextTokens, d.model, d.contextPeak) : undefined
    }
  })
}

export const chatDrop = (key: string): void => void chats.delete(key)

/** What the bottom of an agent's screen shows: `input` (ready for typing), `busy`, `question`, `menu`, `unknown`. */
export const screen = (lines: string[]): string => screenState(lines)

// ----------------------------------------------------------------- media ----

/** Files the agent's replies mentioned, newest reply first, as full paths on the host. */
export function mediaPaths(key: string, base: string, limit: number): string {
  const refs = chats.get(key)?.details().mediaRefs ?? []
  const byTurn = new Map<number, string[]>()
  for (const r of refs) byTurn.set(r.turn, [...(byTurn.get(r.turn) ?? []), resolveAgainst(base, r.path)])
  const out: string[] = []
  for (const turn of [...byTurn.keys()].sort((a, b) => b - a)) {
    for (const p of byTurn.get(turn)!) if (!out.includes(p)) out.push(p)
    if (out.length >= limit) break
  }
  return JSON.stringify(out.slice(0, limit))
}

/** `kuna stat` / `kuna media` output (`mtime\tsize\tpath` lines) → the viewer's list; `order`: the paths in the order to keep, else newest first. */
export function mediaItems(stat: string, order: string): string {
  const found = new Map<string, MediaItem>()
  for (const line of stat.split('\n')) {
    const [mtime, size, ...rest] = line.split('\t')
    const path = rest.join('\t')
    const kind = path ? mediaKind(path) : null
    if (kind && !found.has(path)) found.set(path, { path, mtime: Number(mtime) || 0, size: Number(size) || 0, kind })
  }
  const wanted = JSON.parse(order) as string[]
  const items = wanted.length ? wanted.flatMap((p) => found.get(p) ?? []) : [...found.values()].sort((a, b) => b.mtime - a.mtime)
  return JSON.stringify(viewerOrder(items))
}

/** The file a page asks for below its folder and its type, or `null` (see `pageFile` in src/shared/media.ts). */
export const pageFile = (dir: string, urlPath: string): string => JSON.stringify(pageFileOf(dir, urlPath))

// ------------------------------------------------------------------- git ----

export function gitRepos(text: string, dir: string): string {
  return JSON.stringify(parseRepos(text).map((r) => ({ ...r, label: repoLabel(r.path, dir) })))
}

export function gitOverview(info: string, status: string): string {
  const i = parseInfo(info)
  const s = parseStatus(sections(status))
  return JSON.stringify({
    info: i,
    base: defaultBase(i) ?? null,
    staged: sortChanges(s.staged),
    unstaged: sortChanges([...s.conflicts, ...s.unstaged, ...s.untracked])
  })
}

export function gitCompare(text: string, base: string, head: string): string {
  const c = parseCompare(text, base, head || null)
  return JSON.stringify({ ...c, files: sortChanges(c.files) })
}

export const gitFiles = (text: string): string => JSON.stringify([...new Set(text.split('\0').filter((p) => p && !p.endsWith('/')))].slice(0, 20000))
export const gitDir = (text: string): string => JSON.stringify(parseDirListing(text))
export const gitValidRef = (ref: string): boolean => validRef(ref)
export const reviewMessage = (comments: string): string => reviewText(JSON.parse(comments) as ReviewComment[])

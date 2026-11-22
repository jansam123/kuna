/**
 * What the iPhone app calls in Kuna's shared TypeScript. Bundled by
 * scripts/ios-bundle.mjs into one script the app runs in JavaScriptCore, so
 * both apps read hosts, transcripts and git with the same code. Everything
 * crosses as strings (JSON); nothing here may use Node or DOM globals.
 */
import { doingText, needsText } from '@shared/activity'
import { ChatLog } from '@shared/chat'
import { contextInfo, modelFlag, shortModel } from '@shared/context'
import { screenPanel, screenState } from '@shared/input'
import {
  defaultBase,
  parseCompare,
  parseDirListing,
  parseInfo,
  parseRepos,
  parseStatus,
  refOptions,
  repoLabel,
  reviewMessage as reviewText,
  sections,
  sortChanges,
  validRef,
  type ReviewComment
} from '@shared/git'
import { markdownBlocks } from '@shared/mdblocks'
import { MEDIA_GROUPS, PAGE_CSP, figureClass, fileGroups, mediaKind, mediaPlace, mimeFor, pageFile as pageFileOf, resolveAgainst, viewerOrder, type FigureClass } from '@shared/media'
import { emptyPhoneState, hostKeyVerdict, knownHostsName, mergeImport, parseExport, type PhoneHost, type PhoneState } from '@shared/phone'
import { texToText } from '@shared/tex'
import { slashFromFiles, slashMatches, type SlashCommand } from '@shared/slash'
import { REPO_COLORS, THEMES } from '@shared/themes'
import { OTHER_FOLDER_ID, assignAgents } from '@shared/tree'
import { SHELL_COMMAND, isShell, type AgentRuntime, type HostId, type HostState, type MediaItem, type Project } from '@shared/types'
import { isHostId } from '@shared/validate'
import { frameToAgents, onLocalClock, parseFrame, titleOf } from '@shared/watch'

declare const __KUNA_SCRIPT__: string
declare const __KUNA_VERSION__: string
declare const __KUNA_ICONS__: string

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
      shell: isShell(a),
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
/** the Mac's project icons as drawing steps (see scripts/ios-bundle.mjs), by name, in the picker's order */
export const icons = (): string => __KUNA_ICONS__
/** a project's or folder's name with its `$…$` math in Unicode: the phone has no KaTeX outside its web views */
export const texText = (name: string): string => texToText(name)
/** what a terminal runs in place of an agent */
export const shellCommand = (): string => SHELL_COMMAND
export const repoColors = (): string => JSON.stringify(REPO_COLORS)

// ------------------------------------------------------------------ chat ----

/** A reply's Markdown as flat blocks the app draws with its own views (`markdownBlocks`). */
export const markdown = (text: string): string => JSON.stringify(markdownBlocks(text))


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
/** The question or panel on an agent's screen as text and rows to tap (`screenPanel`), or `null`. */
export const panel = (lines: string[]): string => JSON.stringify(screenPanel(lines))
/** `kuna claude-files` output → the host's own commands and skills, as they are typed. */
export const slashFound = (files: string): string => JSON.stringify(slashFromFiles(files))
/** The slash commands to offer for what is typed so far. */
export const slash = (typed: string, found: string): string => JSON.stringify(slashMatches(typed, JSON.parse(found) as SlashCommand[]))

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

/** the groups' colours, as `.g-<group>` in the Mac's styles.css (`pdf` takes the scheme's dim) */
const GROUP_COLORS: Record<string, string> = { slides: '#ff8a5c', diagram: '#2dd4bf', plot: '#f472b6', md: '#c9d1e3', html: '#a3e635', url: '#60a5fa' }

/**
 * The viewer's list as the Mac shows it: the files by group (Slides, Diagrams,
 * Plots, Markdown, Pages; PDFs not read yet), in that order, each file with
 * where it lives (`folder`, `claude`, `tmp`, `outside`). `classes`: what the
 * PDFs read so far are (`figure`), by path.
 */
export function mediaGroups(items: string, classes: string, base: string): string {
  const list = JSON.parse(items) as MediaItem[]
  const known = JSON.parse(classes) as Record<string, FigureClass>
  const groupOf = fileGroups(list, (it) => known[it.path])
  return JSON.stringify(
    MEDIA_GROUPS.map(([id, label]) => ({
      id,
      label,
      color: GROUP_COLORS[id] ?? null,
      items: list.filter((it) => groupOf(it) === id).map((it) => ({ ...it, place: mediaPlace(base, it.path) }))
    })).filter((g) => g.items.length)
  )
}

/** What a PDF is once read: `slides`, `diagram` or `plot` (its pages; its Creator and Producer as `maker`). */
export const figure = (path: string, pages: number, maker: string): string => figureClass(path, { pages, maker })

/** The file a page asks for below its folder and its type, or `null` (see `pageFile` in src/shared/media.ts). */
export const pageFile = (dir: string, urlPath: string): string => JSON.stringify(pageFileOf(dir, urlPath))
/** what a page in the viewer may run and load, as on the Mac */
export const pageCsp = PAGE_CSP
export const mime = (path: string): string => mimeFor(path)

// ------------------------------------------------------------------- git ----

export function gitRepos(text: string, dir: string): string {
  return JSON.stringify(parseRepos(text).map((r) => ({ ...r, label: repoLabel(r.path, dir) })))
}

/**
 * A repository as the review opens on it: what to compare with what (as the
 * Mac starts: origin's default branch, and what is checked out), the branches
 * each picker offers, and the uncommitted changes in VS Code's groups.
 */
export function gitOverview(info: string, status: string): string {
  const i = parseInfo(info)
  const s = parseStatus(sections(status))
  return JSON.stringify({
    info: i,
    base: defaultBase(i) ?? i.branch ?? (i.head ? 'HEAD' : null),
    head: i.branch ?? (i.head ? 'HEAD' : null),
    bases: refOptions(i, false),
    heads: refOptions(i, true),
    conflicts: sortChanges(s.conflicts),
    staged: sortChanges(s.staged),
    unstaged: sortChanges(s.unstaged),
    untracked: sortChanges(s.untracked)
  })
}

export function gitCompare(text: string, base: string, head: string): string {
  const c = parseCompare(text, base, head || null)
  return JSON.stringify({ ...c, files: sortChanges(c.files) })
}

export const gitFiles = (text: string): string => JSON.stringify([...new Set(text.split('\0').filter((p) => p && !p.endsWith('/')))].slice(0, 20000))
/**
 * `kuna lsdir` → a folder's folders, and its files as the viewer takes them:
 * `kind` is what the viewer shows it as, `file` for anything it shows as text.
 */
export function folder(text: string, dir: string): string {
  const l = parseDirListing(text)
  const at = dir.replace(/\/+$/, '')
  const files = l.entries.filter((e) => !e.dir).map((e) => ({ path: `${at}/${e.name}`, mtime: e.mtime, size: e.size, kind: mediaKind(`${at}/${e.name}`) ?? 'file' }))
  return JSON.stringify({ more: l.more ?? null, folders: l.entries.filter((e) => e.dir).map((e) => e.name), files })
}
export const gitValidRef = (ref: string): boolean => validRef(ref)
export const reviewMessage = (comments: string): string => reviewText(JSON.parse(comments) as ReviewComment[])

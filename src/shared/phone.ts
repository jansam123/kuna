import type { Folder, Project } from './types'
import { isHostId, splitAgentKey } from './validate'

/**
 * What the Mac hands the iPhone app ("Export for iPhone"): projects, folders,
 * agent names, hidden sessions, the colour scheme, and how to reach each
 * project's host. No passwords, no keys, nothing about this Mac's own agents.
 */

/** A host as the iPhone signs in to it: what `ssh -G <alias>` resolves the alias to. */
export interface PhoneHost {
  /** the alias in ~/.ssh/config: the host's name in projects and agent keys */
  alias: string
  hostName: string
  user: string
  port: number
  /** the host it is reached through (ProxyJump): another entry's alias */
  jump?: string
  /** the name its key is kept under in known_hosts (HostKeyAlias), when it is not the address */
  keyName?: string
}

export interface PhoneExport {
  kuna: 'iphone'
  version: 1
  /** epoch seconds */
  exportedAt: number
  projects: Project[]
  names: Record<string, string>
  hidden: Record<string, number>
  theme: string
  hosts: PhoneHost[]
  /** known_hosts name → the keys the Mac trusts for it (`ssh-ed25519 AAAA…`) */
  hostKeys: Record<string, string[]>
}

/** Everything the iPhone app keeps: the export's content, plus what was made on the phone. */
export interface PhoneState {
  projects: Project[]
  names: Record<string, string>
  hidden: Record<string, number>
  theme: string
  hosts: PhoneHost[]
  hostKeys: Record<string, string[]>
  /** what the last import brought: on the next one these are replaced or removed, the rest stays */
  fromMac: { projects: string[]; hosts: string[] }
  /** the colour scheme was picked on the phone: an import no longer changes it */
  themeChosen?: boolean
  /** when the last import was made on the Mac, epoch seconds */
  importedAt?: number
}

export const emptyPhoneState = (): PhoneState => ({
  projects: [],
  names: {},
  hidden: {},
  theme: 'cherenkov',
  hosts: [],
  hostKeys: {},
  fromMac: { projects: [], hosts: [] }
})

/** The name a host's key is kept under, as in known_hosts. */
export const knownHostsName = (h: Pick<PhoneHost, 'hostName' | 'port' | 'keyName'>): string =>
  h.keyName || (h.port === 22 ? h.hostName : `[${h.hostName}]:${h.port}`)

// ------------------------------------------------------------ on the Mac ----

export interface SshResolved {
  hostName: string
  user: string
  port: number
  /** ProxyJump as written: `a`, `user@host:port`, `a,b`; none when unset */
  proxyJump?: string
  hostKeyAlias?: string
  /** the user's and the system's known_hosts files, `~` as written */
  knownHostsFiles: string[]
}

/** `ssh -G <host>`: the options ssh would use, one `key value` per line. */
export function parseSshG(text: string): SshResolved | null {
  const opt = new Map<string, string>()
  for (const line of text.split('\n')) {
    const i = line.indexOf(' ')
    if (i > 0 && !opt.has(line.slice(0, i))) opt.set(line.slice(0, i).toLowerCase(), line.slice(i + 1).trim())
  }
  const hostName = opt.get('hostname')
  const user = opt.get('user')
  if (!hostName || !user) return null
  const jump = opt.get('proxyjump')
  return {
    hostName,
    user,
    port: Number(opt.get('port')) || 22,
    proxyJump: jump && jump.toLowerCase() !== 'none' ? jump : undefined,
    hostKeyAlias: opt.get('hostkeyalias') || undefined,
    knownHostsFiles: [...(opt.get('userknownhostsfile') ?? '').split(/\s+/), ...(opt.get('globalknownhostsfile') ?? '').split(/\s+/)].filter(Boolean)
  }
}

/** One hop of a ProxyJump: `alias`, `host:port`, `user@host`, `user@host:port`, `ssh://user@host:port`. */
export function parseJumpSpec(spec: string): { host: string; user?: string; port?: number } | null {
  const m = /^(?:ssh:\/\/)?(?:([^@\s]+)@)?(\[[0-9a-fA-F:.]+\]|[^:@\s\[\]]+)(?::(\d+))?\/?$/.exec(spec.trim())
  if (!m) return null
  const host = m[2].replace(/^\[|\]$/g, '')
  return isHostId(host) ? { host, user: m[1] || undefined, port: m[3] ? Number(m[3]) : undefined } : null
}

/** `ssh-keygen -F <name>`: the keys known for a host (`ssh-ed25519 AAAA…`), certificate and revoked lines left out. */
export function parseKnownHosts(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/)
    if (f.length < 3 || f[0].startsWith('#') || f[0].startsWith('@')) continue
    if (/^(ssh-|ecdsa-|sk-)/.test(f[1]) && /^[A-Za-z0-9+/=]+$/.test(f[2])) out.push(`${f[1]} ${f[2]}`)
  }
  return [...new Set(out)]
}

/**
 * The export: the projects on ssh hosts (this Mac's own stay here), and of the
 * names and hidden sessions only those of agents on these hosts.
 */
export function makeExport(
  state: { projects: Project[]; names?: Record<string, string>; hidden?: Record<string, number>; theme: string },
  hosts: PhoneHost[],
  hostKeys: Record<string, string[]>,
  now: number
): PhoneExport {
  const reachable = new Set(hosts.map((h) => h.alias))
  const there = (key: string): boolean => {
    const k = splitAgentKey(key)
    return !!k && reachable.has(k.host)
  }
  return {
    kuna: 'iphone',
    version: 1,
    exportedAt: Math.floor(now),
    projects: state.projects
      .filter((p) => reachable.has(p.host))
      .map((p) => ({ ...p, folders: p.folders.map((f) => ({ ...f, agents: f.agents?.filter(there) })) })),
    names: Object.fromEntries(Object.entries(state.names ?? {}).filter(([k]) => there(k))),
    hidden: Object.fromEntries(Object.entries(state.hidden ?? {}).filter(([k]) => there(k))),
    theme: state.theme,
    hosts,
    hostKeys
  }
}

// ---------------------------------------------------------- on the phone ----

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any

const text = (v: unknown, max = 4096): string | undefined => (typeof v === 'string' && v.length <= max && !v.includes('\0') ? v : undefined)
const color = (v: unknown, fallback: string): string => (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : fallback)

function record<T>(v: Json, each: (key: string, value: Json) => T | undefined): Record<string, T> {
  const out: Record<string, T> = {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [k, x] of Object.entries(v).slice(0, 5000)) {
    const y = each(k, x)
    if (y !== undefined) out[k] = y
  }
  return out
}

function folder(v: Json): Folder | undefined {
  const id = text(v?.id, 200)
  const path = text(v?.path)
  if (!id || !path) return undefined
  return {
    id,
    path,
    real: text(v.real),
    agents: Array.isArray(v.agents) ? v.agents.filter((k: unknown) => splitAgentKey(k)).slice(0, 500) : undefined,
    name: text(v.name, 200) || path.split('/').filter(Boolean).pop() || path,
    color: color(v.color, '#6b7280'),
    collapsed: v.collapsed === true ? true : undefined
  }
}

function project(v: Json): Project | undefined {
  const id = text(v?.id, 200)
  const host = v?.host
  if (!id || !isHostId(host) || host === 'local') return undefined
  return {
    id,
    name: text(v.name, 200) || host,
    host,
    color: color(v.color, '#4d8dff'),
    icon: text(v.icon, 40) || undefined,
    agentCommand: text(v.agentCommand, 1000) || 'claude',
    launch: v.launch === 'tmux' ? 'tmux' : v.launch === 'background' ? 'background' : undefined,
    folders: (Array.isArray(v.folders) ? v.folders : []).flatMap((f: Json) => folder(f) ?? []).slice(0, 500),
    collapsed: v.collapsed === true ? true : undefined,
    otherCollapsed: v.otherCollapsed === true ? true : undefined
  }
}

function host(v: Json): PhoneHost | undefined {
  const alias = v?.alias
  const hostName = text(v?.hostName, 255)
  const user = text(v?.user, 255)
  const port = Number(v?.port)
  if (!isHostId(alias) || alias === 'local' || !hostName || !isHostId(hostName) || !user || /\s/.test(user)) return undefined
  return {
    alias,
    hostName,
    user,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 22,
    jump: isHostId(v.jump) && v.jump !== alias ? v.jump : undefined,
    keyName: text(v.keyName, 255) || undefined
  }
}

const hostKeyList = (v: Json): string[] | undefined =>
  Array.isArray(v) ? v.filter((k: unknown): k is string => typeof k === 'string' && /^[a-z0-9@.-]+ [A-Za-z0-9+/=]+$/.test(k)).slice(0, 20) : undefined

/**
 * A file somebody gave the phone: only what Kuna writes is taken from it, each
 * field checked, the rest dropped. Throws with a sentence for the user when it
 * is not an export at all.
 */
export function parseExport(source: string): PhoneExport {
  let v: Json
  try {
    v = JSON.parse(source)
  } catch {
    throw new Error('This file is not a Kuna export (it is not JSON).')
  }
  if (!v || typeof v !== 'object' || v.kuna !== 'iphone') throw new Error('This file is not a Kuna export. Make one on the Mac: Kuna ▸ Export for iPhone…')
  if (v.version !== 1) throw new Error('This export was made by a newer Kuna. Update the iPhone app, then import it again.')
  const hosts = (Array.isArray(v.hosts) ? v.hosts : []).flatMap((h: Json) => host(h) ?? []).slice(0, 200) as PhoneHost[]
  const aliases = new Set(hosts.map((h) => h.alias))
  for (const h of hosts) if (h.jump && !aliases.has(h.jump)) delete h.jump
  return {
    kuna: 'iphone',
    version: 1,
    exportedAt: Number(v.exportedAt) || 0,
    projects: (Array.isArray(v.projects) ? v.projects : []).flatMap((p: Json) => project(p) ?? []).slice(0, 500),
    names: record(v.names, (k, x) => (splitAgentKey(k) ? text(x, 300) : undefined)),
    hidden: record(v.hidden, (k, x) => (splitAgentKey(k) && typeof x === 'number' ? x : undefined)),
    theme: text(v.theme, 60) || 'cherenkov',
    hosts,
    hostKeys: record(v.hostKeys, (k, x) => (k.length <= 300 ? hostKeyList(x) : undefined))
  }
}

/**
 * Take an export into what the phone has. What an earlier import brought is
 * replaced by this one (or removed, when the Mac no longer has it); projects
 * and hosts made on the phone stay, and so does how each list was folded.
 */
export function mergeImport(phone: PhoneState, imp: PhoneExport): PhoneState {
  const wasMac = { projects: new Set(phone.fromMac.projects), hosts: new Set(phone.fromMac.hosts) }
  const had = new Map(phone.projects.map((p) => [p.id, p]))
  const coming = new Set(imp.projects.map((p) => p.id))
  const projects = [
    ...imp.projects.map((p) => {
      const old = had.get(p.id)
      if (!old) return p
      const folded = new Map(old.folders.map((f) => [f.id, f.collapsed]))
      return { ...p, collapsed: old.collapsed, otherCollapsed: old.otherCollapsed, folders: p.folders.map((f) => ({ ...f, collapsed: folded.has(f.id) ? folded.get(f.id) : f.collapsed })) }
    }),
    ...phone.projects.filter((p) => !coming.has(p.id) && !wasMac.projects.has(p.id))
  ]
  const incoming = new Set(imp.hosts.map((h) => h.alias))
  const used = new Set(projects.map((p) => p.host))
  const kept = phone.hosts.filter((h) => !incoming.has(h.alias) && (!wasMac.hosts.has(h.alias) || used.has(h.alias)))
  // a phone host may still jump through one the Mac dropped: keep those too
  const all = [...imp.hosts, ...kept]
  const have = new Set(all.map((h) => h.alias))
  for (const h of phone.hosts) if (!have.has(h.alias) && all.some((x) => x.jump === h.alias)) all.push(h)
  const hostKeys: Record<string, string[]> = { ...phone.hostKeys }
  for (const [name, keys] of Object.entries(imp.hostKeys)) hostKeys[name] = [...new Set([...keys, ...(hostKeys[name] ?? [])])]
  return {
    projects,
    names: { ...phone.names, ...imp.names },
    hidden: { ...phone.hidden, ...imp.hidden },
    theme: phone.themeChosen ? phone.theme : imp.theme,
    themeChosen: phone.themeChosen,
    hosts: all,
    hostKeys,
    fromMac: { projects: imp.projects.map((p) => p.id), hosts: imp.hosts.map((h) => h.alias) },
    importedAt: imp.exportedAt
  }
}

/**
 * Whether to trust a host's key: `trusted` when it is one of those known for
 * the name, `changed` when the name is known with another key of the same type
 * (refuse), `ask` when the name or this type of key was never seen (the Mac may
 * know the host by its RSA key, which the phone's ssh never gets offered).
 */
export function hostKeyVerdict(known: string[] | undefined, offered: string): 'trusted' | 'changed' | 'ask' {
  if (!known?.length) return 'ask'
  if (known.includes(offered)) return 'trusted'
  const type = offered.split(' ')[0]
  return known.some((k) => k.split(' ')[0] === type) ? 'changed' : 'ask'
}

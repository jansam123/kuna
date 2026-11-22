import type { AgentRuntime, Folder, HostState, Project } from './types'

export type TreeNode =
  | { id: string; kind: 'project'; depth: 0; project: Project }
  | { id: string; kind: 'folder'; depth: 1; project: Project; folder: Folder; virtual?: boolean }
  | { id: string; kind: 'agent'; depth: 2; project: Project; folder: Folder; agent: AgentRuntime }

export const OTHER_FOLDER_ID = '__other'

function expandHome(path: string, home?: string): string {
  // "a//b/" as typed is "a/b"
  let p = path.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/'
  if (home && (p === '~' || p.startsWith('~/'))) p = home + p.slice(1)
  // macOS: /tmp and /var are symlinks into /private, and agents report the real path
  return p.replace(/^\/private\/(tmp|var)(?=\/|$)/, '/$1')
}

/**
 * Decide which folder each agent belongs to. Agents carry the project/folder
 * they were spawned from; agents started elsewhere (another machine, or before
 * a folder was re-added) are matched by host + working directory, and anything
 * left over on a project's host lands in that project's "Other agents".
 */
export function assignAgents(
  projects: Project[],
  agents: AgentRuntime[],
  hosts: Record<string, HostState>
): Map<string, AgentRuntime[]> {
  const byFolder = new Map<string, AgentRuntime[]>()
  const put = (pid: string, fid: string, a: AgentRuntime): void => {
    const k = `${pid}:${fid}`
    const list = byFolder.get(k) ?? []
    list.push(a)
    byFolder.set(k, list)
  }
  // placed by hand first, in their order
  const byKey = new Map(agents.map((a) => [a.key, a]))
  const placed = new Set<string>()
  for (const p of projects) {
    for (const f of p.folders) {
      for (const k of f.agents ?? []) {
        const a = byKey.get(k)
        if (!a || a.host !== p.host || placed.has(k)) continue
        placed.add(k)
        put(p.id, f.id, a)
      }
    }
  }
  for (const a of agents) {
    if (placed.has(a.key)) continue
    const own = projects.find((p) => p.id === a.projectId && p.host === a.host)
    const ownFolder = own?.folders.find((f) => f.id === a.folderId)
    if (own && ownFolder) {
      put(own.id, ownFolder.id, a)
      continue
    }
    // the deepest folder containing the agent's directory (sessions often run
    // in a subdirectory or in a worktree under .claude/worktrees)
    const home = hosts[a.host]?.home
    const cwds = [expandHome(a.cwd, home), ...(a.realCwd ? [expandHome(a.realCwd, home)] : [])]
    let best: { pid: string; fid: string; len: number } | undefined
    for (const p of projects) {
      if (p.host !== a.host) continue
      for (const f of p.folders) {
        // as typed, and with symlinks resolved on the host (agents report the physical path)
        for (const fp of new Set([expandHome(f.path, home), ...(f.real ? [expandHome(f.real, home)] : [])])) {
          const inside = cwds.some((cwd) => cwd === fp || cwd.startsWith(fp === '/' ? '/' : `${fp}/`))
          if (inside && fp.length > (best?.len ?? -1)) best = { pid: p.id, fid: f.id, len: fp.length }
        }
      }
    }
    if (best) {
      put(best.pid, best.fid, a)
      continue
    }
    const fallback = own ?? projects.find((p) => p.host === a.host)
    if (fallback) put(fallback.id, OTHER_FOLDER_ID, a)
  }
  return byFolder
}

/** The sidebar as a flat list of visible rows, in display order. */
export function buildTree(
  projects: Project[],
  agents: AgentRuntime[],
  hosts: Record<string, HostState>
): TreeNode[] {
  const byFolder = assignAgents(projects, agents, hosts)
  const out: TreeNode[] = []
  for (const project of projects) {
    out.push({ id: `p:${project.id}`, kind: 'project', depth: 0, project })
    if (project.collapsed) continue
    const folders: { folder: Folder; virtual?: boolean }[] = project.folders.map((folder) => ({ folder }))
    if (byFolder.has(`${project.id}:${OTHER_FOLDER_ID}`)) {
      folders.push({
        folder: { id: OTHER_FOLDER_ID, name: 'Other agents', path: '', color: '#6b7280', collapsed: project.otherCollapsed },
        virtual: true
      })
    }
    for (const { folder, virtual } of folders) {
      out.push({ id: `f:${project.id}:${folder.id}`, kind: 'folder', depth: 1, project, folder, virtual })
      if (folder.collapsed) continue
      for (const agent of byFolder.get(`${project.id}:${folder.id}`) ?? []) {
        out.push({ id: `a:${agent.key}`, kind: 'agent', depth: 2, project, folder, agent })
      }
    }
  }
  return out
}

/** Number of agents under each folder row, including collapsed ones. */
export function agentCounts(projects: Project[], agents: AgentRuntime[], hosts: Record<string, HostState>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const [k, list] of assignAgents(projects, agents, hosts)) counts.set(k, list.length)
  return counts
}

/** The agents under each project, whatever is rolled in: what its row counts as waiting, working and failed. */
export function agentsByProject(projects: Project[], agents: AgentRuntime[], hosts: Record<string, HostState>): Map<string, AgentRuntime[]> {
  const by = new Map<string, AgentRuntime[]>()
  for (const [k, list] of assignAgents(projects, agents, hosts)) {
    // keys are "project:folder"; neither id holds a colon
    const pid = k.slice(0, k.indexOf(':'))
    by.set(pid, [...(by.get(pid) ?? []), ...list])
  }
  return by
}

/** Folder (and its project) an agent is shown under, for colouring tabs. */
export function folderOfAgent(
  projects: Project[],
  agents: AgentRuntime[],
  hosts: Record<string, HostState>
): Map<string, { project: Project; folder: Folder }> {
  const map = new Map<string, { project: Project; folder: Folder }>()
  for (const n of buildTree(
    projects.map((p) => ({ ...p, collapsed: false, otherCollapsed: false, folders: p.folders.map((f) => ({ ...f, collapsed: false })) })),
    agents,
    hosts
  )) {
    if (n.kind === 'agent') map.set(n.agent.key, { project: n.project, folder: n.folder })
  }
  return map
}

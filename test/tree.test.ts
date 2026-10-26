import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentRuntime, Project } from '@shared/types'
import { dropPlan, moveFolderTo, moveProjectTo, placeAgent, pruneArranged, type RowRef } from '@shared/arrange'
import { assignAgents, OTHER_FOLDER_ID } from '../src/renderer/src/tree'

// kuna.sh runs under sh on its hosts; Windows has none (its local host is WSL)
const noSh = process.platform === 'win32'

const agent = (id: string, cwd: string): AgentRuntime => ({
  key: `cluster1::${id}`,
  id,
  kind: 'claude',
  host: 'cluster1',
  cwd,
  createdAt: 0,
  status: 'idle',
  attnTs: 0,
  activityTs: 0,
  attached: false,
  alive: true,
  transcriptSize: 0
})

describe('placing agents under folders', () => {
  const project = (real?: string): Project => ({
    id: 'p',
    name: 'Z(tautau)+j analysis',
    host: 'cluster1',
    agentCommand: 'claude',
    color: '#000',
    folders: [{ id: 'f', path: '/project/exp/users/alice/analysis//fit', real, name: 'Z', color: '#111' }]
  })
  const agents = [
    agent('cc-1', '/project/exp/Users/alice/analysis/fit'),
    agent('cc-2', '/project/exp/Users/alice/analysis/fit/.claude/worktrees/fit'),
    agent('cc-3', '/project/exp/users/alice/analysis/fit/plots'),
    agent('cc-4', '/project/exp/Users/alice/elsewhere')
  ]
  const ids = (m: Map<string, AgentRuntime[]>, k: string): string[] => (m.get(k) ?? []).map((a) => a.id)

  it('matches the path as typed, double slashes and all', () => {
    const m = assignAgents([project()], agents, {})
    expect(ids(m, 'p:f')).toEqual(['cc-3'])
  })

  it('matches the physical path the host resolved', () => {
    const m = assignAgents([project('/project/exp/Users/alice/analysis/fit')], agents, {})
    expect(ids(m, 'p:f')).toEqual(['cc-1', 'cc-2', 'cc-3'])
    expect(ids(m, `p:${OTHER_FOLDER_ID}`)).toEqual(['cc-4'])
  })
})

describe('the home folder as a catch-all', () => {
  it('takes agents anywhere under home, unless a deeper folder fits', () => {
    const p: Project = {
      id: 'p',
      name: 'general',
      host: 'cluster1',
      agentCommand: 'claude',
      color: '#000',
      folders: [
        { id: 'home', path: '~', name: 'home', color: '#111' },
        { id: 'fit', path: '~/ana/fit', name: 'fit', color: '#222' }
      ]
    }
    const hosts = { cluster1: { host: 'cluster1', status: 'ready', home: '/user/me' } } as never
    const m = assignAgents([p], [agent('cc-a', '/user/me/scratch'), agent('cc-b', '/user/me/ana/fit/plots'), agent('cc-c', '/project/exp')], hosts)
    expect((m.get('p:home') ?? []).map((a) => a.id)).toEqual(['cc-a'])
    expect((m.get('p:fit') ?? []).map((a) => a.id)).toEqual(['cc-b'])
    expect((m.get(`p:${OTHER_FOLDER_ID}`) ?? []).map((a) => a.id)).toEqual(['cc-c'])
  })
})

describe('placing agents by their resolved directory', () => {
  it('matches when the agent reports the symlinked path and the folder is the real one', () => {
    const p: Project = {
      id: 'p',
      name: 'x',
      host: 'cluster1',
      agentCommand: 'claude',
      color: '#000',
      folders: [{ id: 'f', path: '/project/exp/users/alice/Calib', real: '/project/exp/users/alice/Calib', name: 'C', color: '#111' }]
    }
    const a = { ...agent('cc-9', '/project/exp/Users/alice/Calib/sub'), realCwd: '/project/exp/users/alice/Calib/sub' }
    expect((assignAgents([p], [a], {}).get('p:f') ?? []).map((x) => x.id)).toEqual(['cc-9'])
    expect(assignAgents([p], [{ ...a, realCwd: undefined }], {}).get('p:f')).toBeUndefined()
  })
})

describe.skipIf(noSh)('kuna ls', () => {
  it('lists subdirectories without doubled slashes', () => {
    const script = join(__dirname, '..', 'src', 'main', 'remote', 'kuna.sh')
    const home = mkdtempSync(join(tmpdir(), 'kuna-ls-'))
    try {
      mkdirSync(join(home, 'proj', 'a'), { recursive: true })
      mkdirSync(join(home, 'proj', 'b'), { recursive: true })
      const ls = (p: string): string[] =>
        execFileSync('sh', [script, 'ls', Buffer.from(p).toString('base64')], { env: { ...process.env, HOME: home } }).toString().trim().split('\n')
      expect(ls(`${home}/proj/`)).toEqual([`${home}/proj/a`, `${home}/proj/b`])
      expect(ls('~/proj//')).toEqual([`${home}/proj/a`, `${home}/proj/b`])
      expect(ls('/').every((p) => !p.startsWith('//'))).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

// (and symlinks there need Developer Mode)
describe.skipIf(noSh)('kuna realpath', () => {
  it('resolves symlinks and skips what is missing', () => {
    const script = join(__dirname, '..', 'src', 'main', 'remote', 'kuna.sh')
    const home = mkdtempSync(join(tmpdir(), 'kuna-real-'))
    try {
      // like /project/exp/users -> Users on the cluster (macOS ignores case, so other names here)
      mkdirSync(join(home, 'Store', 'me', 'work'), { recursive: true })
      symlinkSync(join(home, 'Store'), join(home, 'link'))
      const paths = [`${home}/link/me//work`, '~/link/me', `${home}/nope`].join('\n')
      const out = execFileSync('sh', [script, 'realpath', Buffer.from(paths).toString('base64')], { env: { ...process.env, HOME: home } }).toString()
      const real = realpathSync(home)
      expect(out.trim().split('\n')).toEqual([`${home}/link/me//work\t${real}/Store/me/work`, `~/link/me\t${real}/Store/me`])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('rearranging the sidebar by hand', () => {
  const proj = (id: string, host: string, folders: string[]): Project => ({
    id,
    name: id,
    host,
    agentCommand: 'claude',
    color: '#000',
    folders: folders.map((f) => ({ id: f, path: `/w/${f}`, name: f, color: '#111' }))
  })
  const projects = [proj('A', 'cluster1', ['a1', 'a2', 'a3']), proj('B', 'cluster1', ['b1']), proj('C', 'local', ['c1'])]
  const ids = (ps: Project[]): string => ps.map((p) => `${p.id}[${p.folders.map((f) => f.id + (f.agents ? `(${f.agents.join(',')})` : '')).join(' ')}]`).join(' ')

  it('says where a dragged row can land', () => {
    const p = (projectId: string, host = 'cluster1'): RowRef => ({ kind: 'project', projectId, host })
    const f = (projectId: string, folderId: string, host = 'cluster1', virtual = false): RowRef => ({ kind: 'folder', projectId, folderId, host, virtual })
    const ag = (key: string, folderId = 'a1', host = 'cluster1'): RowRef => ({ kind: 'agent', projectId: 'A', folderId, host, key })
    expect(dropPlan(p('A'), p('B'), true)).toBe('before')
    expect(dropPlan(p('A'), p('A'), true)).toBeNull()
    expect(dropPlan(p('A'), f('B', 'b1'), true)).toBeNull()
    expect(dropPlan(f('A', 'a1'), f('A', 'a3'), false)).toBe('after')
    expect(dropPlan(f('A', 'a1'), p('B'), true)).toBe('into')
    expect(dropPlan(f('A', 'a1'), p('C', 'local'), true)).toBeNull() // another host
    expect(dropPlan(f('A', OTHER_FOLDER_ID, 'cluster1', true), f('A', 'a2'), true)).toBeNull()
    expect(dropPlan(ag('k1'), f('B', 'b1'), true)).toBe('into')
    expect(dropPlan(ag('k1'), ag('k2', 'a2'), false)).toBe('after')
    expect(dropPlan(ag('k1'), p('A'), true)).toBeNull()
    expect(dropPlan(ag('k1'), f('C', 'c1', 'local'), true)).toBeNull()
  })

  it('reorders projects and folders, also into another project', () => {
    expect(ids(moveProjectTo(projects, 'C', 'A', 'before'))).toBe('C[c1] A[a1 a2 a3] B[b1]')
    expect(ids(moveFolderTo(projects, 'A', 'a1', 'A', 'a3', 'after'))).toBe('A[a2 a3 a1] B[b1] C[c1]')
    expect(ids(moveFolderTo(projects, 'A', 'a2', 'B', null, 'into'))).toBe('A[a1 a3] B[b1 a2] C[c1]')
  })

  it('places agents by hand, keeping the others where they were', () => {
    let ps = placeAgent(projects, 'k3', 'A', 'a1', ['k1', 'k2', 'k3'], 'k1', 'before')
    expect(ids(ps)).toBe('A[a1(k3,k1,k2) a2 a3] B[b1] C[c1]')
    ps = placeAgent(ps, 'k1', 'B', 'b1', [], null, 'into')
    expect(ids(ps)).toBe('A[a1(k3,k2) a2 a3] B[b1(k1)] C[c1]')
    // into "Other agents": only taken out
    ps = placeAgent(ps, 'k1', 'B', null, [], null, 'into')
    expect(ids(ps)).toBe('A[a1(k3,k2) a2 a3] B[b1] C[c1]')
    expect(ids(pruneArranged(ps, new Set(['k3']), () => true))).toBe('A[a1(k3) a2 a3] B[b1] C[c1]')
    expect(pruneArranged(ps, new Set(['k3']), () => false)).toBe(ps)
  })

  it('puts hand-placed agents first, in their order, over where they would go by themselves', () => {
    const ps = placeAgent(projects, 'cluster1::cc-2', 'B', 'b1', [], null, 'into')
    const m = assignAgents(ps, [agent('cc-1', '/w/a1'), agent('cc-2', '/w/a1'), agent('cc-3', '/w/b1')], {})
    expect((m.get('A:a1') ?? []).map((a) => a.id)).toEqual(['cc-1'])
    expect((m.get('B:b1') ?? []).map((a) => a.id)).toEqual(['cc-2', 'cc-3'])
  })
})

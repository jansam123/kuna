import {
  parseBlobs,
  parseCompare,
  parseInfo,
  parseStatus,
  sections,
  specOf,
  validRef,
  validRepoPath,
  type GitBlob,
  type GitCompare,
  type GitInfo,
  type GitSide,
  type GitStatus
} from '@shared/git'
import type { HostId } from '@shared/types'
import type { AgentService } from './agents'
import { b64 } from './hosts/exec'

/** the largest file the review view shows (each side of a diff) */
export const MAX_BLOB = 8 * 1024 * 1024

type Result<T> = T | { error: string }

/**
 * The review view's git, on any host: `kuna git …` over the host's shared
 * connection, read-only. Folders and refs come from the window; refs and paths
 * are checked here and again by the helper.
 */
export class GitService {
  constructor(private agents: AgentService) {}

  private async run(hostId: HostId, args: string[], timeoutMs: number, maxBytes?: number): Promise<Result<Buffer>> {
    const host = this.agents.host(hostId)
    if (host.state.status !== 'ready') await host.connect()
    const res = await host.exec(['git', ...args], { timeoutMs, maxBytes })
    if (res.code !== 0) {
      const msg = res.stderr.replace(/^kuna: /gm, '').trim()
      return { error: msg || `git failed (exit ${res.code})` }
    }
    return res.stdout
  }

  async overview(hostId: HostId, dir: string): Promise<Result<{ info: GitInfo; status: GitStatus }>> {
    if (typeof dir !== 'string' || !dir) return { error: 'No folder.' }
    const [info, status] = await Promise.all([
      this.run(hostId, ['info', b64(dir)], 20_000),
      this.run(hostId, ['status', b64(dir)], 30_000)
    ])
    if ('error' in info) return info
    if ('error' in status) return status
    const s = sections(status.toString('utf8'))
    return { info: parseInfo(info.toString('utf8')), status: parseStatus(s.status ?? '', s.staged, s.unstaged) }
  }

  async compare(hostId: HostId, dir: string, base: string, head: string | null): Promise<Result<GitCompare>> {
    if (!validRef(base) || (head !== null && !validRef(head))) return { error: 'Not a branch or commit name.' }
    const out = await this.run(hostId, ['compare', b64(dir), b64(base), head ? b64(head) : ''], 45_000)
    if ('error' in out) return out
    return parseCompare(out.toString('utf8'), base, head)
  }

  /** every file at a commit (rev) or in the working tree (null) */
  async files(hostId: HostId, dir: string, rev: string | null): Promise<Result<string[]>> {
    if (rev !== null && !validRef(rev)) return { error: 'Not a branch or commit name.' }
    const out = await this.run(hostId, ['files', b64(dir), rev ? b64(rev) : ''], 45_000, 17_000_000)
    if ('error' in out) return out
    return [...new Set(out.toString('utf8').split('\0').filter(Boolean))]
  }

  /** both sides of a diff in one round trip */
  async read(hostId: HostId, dir: string, sides: GitSide[]): Promise<Result<GitBlob[]>> {
    const specs: string[] = []
    for (const side of sides) {
      if (side.kind === 'empty') continue
      if (!validRepoPath(side.path) || (side.kind === 'rev' && !validRef(side.rev))) return { error: 'Not a file in the repository.' }
      specs.push(b64(specOf(side)!))
    }
    let blobs: GitBlob[] = []
    if (specs.length) {
      const out = await this.run(hostId, ['cat', b64(dir), String(MAX_BLOB), ...specs], 120_000, specs.length * (MAX_BLOB + 64))
      if ('error' in out) return out
      blobs = parseBlobs(out, MAX_BLOB)
    }
    let i = 0
    return sides.map((side) => (side.kind === 'empty' ? { size: 0, data: new Uint8Array() } : (blobs[i++] ?? { size: 0, missing: true })))
  }
}

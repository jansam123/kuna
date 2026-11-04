import { randomBytes, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import { TranscriptParser } from '@shared/transcript'
import type { AgentDetails, AgentRuntime, HostId, PlanUsage, Project, SpawnRequest } from '@shared/types'
import { agentKey } from '@shared/types'
import { isHostId, isTmuxKeys, splitAgentKey } from '@shared/validate'
import { b64 } from './hosts/exec'
import { Host } from './hosts/host'

const FIRST_READ_MAX = 3 * 1024 * 1024
const DELTA_READ_MAX = 4 * 1024 * 1024
/** a spawned agent no frame has reported by then is dropped rather than left "starting" */
const PENDING_SPAWN_S = 120

interface TranscriptState {
  path: string
  offset: number
  parser: TranscriptParser
  decoder: StringDecoder
  busy: boolean
  again: boolean
  details?: AgentDetails
}

/**
 * Owns the set of hosts and everything agent-shaped on top of them:
 * spawning, killing, the merged runtime list and incremental transcript reads.
 *
 * Events: 'hosts' (HostState[]), 'agents' (AgentRuntime[]), 'details' (key, AgentDetails),
 * 'usage' (PlanUsage — the freshest report from any host)
 */
export class AgentService extends EventEmitter {
  /** the hosts watch() keeps connected */
  private hosts = new Map<HostId, Host>()
  /** hosts only used for one-off commands (a .claude browser or review on a host no project uses): never watched or listed */
  private passing = new Map<HostId, Host>()
  private transcripts = new Map<string, TranscriptState>()
  private pendingSpawns = new Map<string, AgentRuntime>()
  /** agents the user is looking at (open panes, selection); see setInterest */
  private interest = new Set<string>()

  constructor(private projects: () => Project[]) {
    super()
  }

  /** A host to run commands on: the watched one, else one that is never watched. */
  host(id: HostId): Host {
    if (!isHostId(id)) throw new Error(`Not a host: ${JSON.stringify(id)}`)
    let h = this.hosts.get(id) ?? this.passing.get(id)
    if (!h) {
      h = new Host(id, false)
      this.passing.set(id, h)
    }
    return h
  }

  private watched(id: HostId): Host {
    let h = this.hosts.get(id)
    if (!h) {
      this.passing.get(id)?.dispose()
      this.passing.delete(id)
      h = new Host(id)
      h.on('state', () => this.emit('hosts', this.hostStates()))
      h.on('agents', (agents: AgentRuntime[]) => this.onAgents(h!, agents))
      h.on('usage', () => this.emit('usage', this.usage()))
      this.hosts.set(id, h)
    }
    return h
  }

  hostStates() {
    return [...this.hosts.values()].map((h) => h.state)
  }

  /** Keep exactly these hosts connected. */
  watch(ids: HostId[]): void {
    const want = new Set(ids.filter((id) => isHostId(id)))
    for (const [id, h] of this.hosts) {
      if (!want.has(id)) {
        h.dispose()
        this.hosts.delete(id)
      }
    }
    for (const id of want) {
      const h = this.watched(id)
      if (h.state.status === 'idle') void h.connect()
    }
    this.emit('hosts', this.hostStates())
    this.emitAgents()
  }

  reconnect(id: HostId): Promise<void> {
    return this.host(id).connect()
  }

  /** Plan usage is per account; show whichever host heard from Claude last. */
  usage(): PlanUsage | null {
    let best: PlanUsage | null = null
    for (const h of this.hosts.values()) if (h.usage && (!best || h.usage.updatedAt > best.updatedAt)) best = h.usage
    return best
  }

  allAgents(): AgentRuntime[] {
    const live = [...this.hosts.values()].flatMap((h) => h.agents)
    const known = new Set(live.map((a) => a.key))
    return [...live, ...[...this.pendingSpawns.values()].filter((a) => !known.has(a.key))]
  }

  private emitAgents(): void {
    this.emit('agents', this.allAgents())
  }

  /**
   * Transcripts of Claude background sessions are only read for the agents in
   * view — a host can have dozens of sessions and each read is work on the node.
   * Kuna's own agents are few and always followed.
   */
  setInterest(keys: string[]): void {
    const before = this.interest
    this.interest = new Set(keys)
    for (const key of this.interest) {
      if (before.has(key)) continue
      const a = this.agent(key)
      if (a?.transcriptPath) this.pullTranscript(this.hostOf(key), a)
    }
  }

  private wants(a: AgentRuntime): boolean {
    return a.kind !== 'claude' || this.interest.has(a.key)
  }

  private onAgents(host: Host, agents: AgentRuntime[]): void {
    for (const a of agents) this.pendingSpawns.delete(a.key)
    const now = Date.now() / 1000
    for (const [key, a] of this.pendingSpawns) if (now - a.createdAt > PENDING_SPAWN_S) this.pendingSpawns.delete(key)
    this.emitAgents()
    for (const a of agents) {
      if (a.transcriptPath && this.wants(a)) this.pullTranscript(host, a)
    }
    // forget transcripts of agents that are gone from this host
    const alive = new Set(agents.map((a) => a.key))
    for (const key of this.transcripts.keys()) {
      if (key.startsWith(`${host.id}::`) && !alive.has(key)) this.transcripts.delete(key)
    }
  }

  async spawn(req: SpawnRequest): Promise<{ key: string } | { error: string }> {
    const project = this.projects().find((p) => p.id === req.projectId)
    const folder = project?.folders.find((f) => f.id === req.folderId)
    if (!project || !folder) return { error: 'That folder no longer exists.' }
    const host = this.host(project.host)
    if (host.state.status !== 'ready') {
      await host.connect()
      if ((host.state.status as string) !== 'ready') return { error: `${project.host} is not connected: ${host.state.error ?? host.state.status}` }
    }

    const base = project.agentCommand.trim() || 'claude'
    const isClaude = /(^|\/)claude(\s|$)/.test(base)
    const prompt = req.prompt.trim()
    if (isClaude && (project.launch ?? 'background') === 'background' && !req.resumeSessionId) {
      return this.spawnBackground(host, base, folder.path, prompt, project.id, folder.id)
    }

    const id = randomBytes(4).toString('hex')
    const sessionId = randomUUID()
    const resume = isClaude && req.resumeSessionId && /^[\w-]+$/.test(req.resumeSessionId) ? req.resumeSessionId : undefined
    let cmd = base
    if (isClaude) cmd += resume ? ` --resume ${resume}` : ` --session-id ${sessionId}`
    if (isClaude) cmd += ` --settings "$HOME/.kuna/claude-hooks.json"`
    // the helper adds the prompt as the last argument, in the login shell's own syntax
    const createdAt = Math.floor(Date.now() / 1000)
    const meta = {
      id,
      cwd: folder.path,
      projectId: project.id,
      folderId: folder.id,
      createdAt: createdAt + host.clockOffset,
      prompt: prompt.slice(0, 300),
      sessionId: isClaude ? (resume ?? sessionId) : undefined,
      command: base
    }
    const res = await host.exec(
      ['spawn', id, b64(folder.path), b64(cmd), String(Math.max(40, req.cols)), String(Math.max(10, req.rows)), b64(JSON.stringify(meta)), b64(prompt)],
      { timeoutMs: 30_000 }
    )
    if (res.code !== 0) return { error: res.stderr.trim() || `spawn failed (${res.code})` }

    const key = agentKey(project.host, id)
    this.pendingSpawns.set(key, {
      key,
      id,
      kind: 'tmux',
      host: project.host,
      cwd: folder.path,
      projectId: project.id,
      folderId: folder.id,
      createdAt,
      prompt: meta.prompt,
      sessionId: meta.sessionId,
      command: base,
      status: 'starting',
      attnTs: 0,
      activityTs: createdAt,
      attached: false,
      alive: true,
      transcriptSize: 0
    })
    this.emitAgents()
    return { key }
  }

  /**
   * Start a Claude Code background session (`claude --bg`) in the folder. It is
   * run by Claude's own daemon, so it also shows up in `claude agents`.
   */
  private async spawnBackground(
    host: Host,
    base: string,
    cwd: string,
    prompt: string,
    projectId: string,
    folderId: string
  ): Promise<{ key: string } | { error: string }> {
    // the helper adds the prompt as the last argument
    const cmd = `${base} --bg --settings "$HOME/.kuna/claude-hooks.json"`
    const res = await host.exec(['bgspawn', b64(cwd), b64(cmd), b64(prompt)], { timeoutMs: 60_000 })
    const short = res.stdout.toString('utf8').trim()
    if (res.code !== 0 || !/^[0-9a-f]{8}$/.test(short)) {
      return { error: res.stderr.trim() || `claude --bg failed (${res.code})` }
    }
    const key = agentKey(host.id, `cc-${short}`)
    const now = Math.floor(Date.now() / 1000)
    this.pendingSpawns.set(key, {
      key,
      id: `cc-${short}`,
      kind: 'claude',
      host: host.id,
      cwd,
      projectId,
      folderId,
      createdAt: now,
      prompt: prompt.slice(0, 300),
      status: 'starting',
      attnTs: 0,
      activityTs: now,
      attached: false,
      alive: true,
      transcriptSize: 0
    })
    this.emitAgents()
    return { key }
  }

  /** An agent key's host and id; malformed keys never reach a command line. */
  locate(key: string): { host: Host; id: string } {
    const k = splitAgentKey(key)
    if (!k) throw new Error(`Not an agent: ${JSON.stringify(key)}`)
    return { host: this.host(k.host), id: k.id }
  }

  hostOf(key: string): Host {
    return this.locate(key).host
  }

  agent(key: string): AgentRuntime | undefined {
    return this.allAgents().find((a) => a.key === key)
  }

  /**
   * Kuna agents: kill the tmux session. Claude background sessions: `claude
   * stop` while running (the conversation is kept), `claude rm` once stopped.
   */
  async kill(key: string): Promise<{ error?: string; stopped?: boolean }> {
    if (!key) return {}
    const { host, id } = this.locate(key)
    if (id.startsWith('cc-')) {
      // `claude stop`: the conversation is kept and the session can come back
      // (Kuna never runs `claude rm`, which deletes it)
      if (!this.agent(key)?.alive) return {}
      const res = await host.exec(['cc', 'stop', id.slice(3)], { timeoutMs: 60_000 })
      const out = res.stdout.toString('utf8').trim()
      if (res.code !== 0) return { error: out || res.stderr.trim() || 'claude stop failed' }
      return { stopped: true }
    }
    this.pendingSpawns.delete(key)
    host.agents = host.agents.filter((a) => a.key !== key)
    this.transcripts.delete(key)
    this.emitAgents()
    await host.exec(['kill', id], { timeoutMs: 20_000 })
    return {}
  }

  /** `claude respawn`: restart a background session on the current Claude binary. */
  async respawn(key: string): Promise<{ error?: string }> {
    const { host, id } = this.locate(key)
    if (!id.startsWith('cc-')) return { error: 'Only Claude background sessions can be respawned.' }
    const res = await host.exec(['cc', 'respawn', id.slice(3)], { timeoutMs: 60_000 })
    return res.code === 0 ? {} : { error: res.stdout.toString('utf8').trim() || res.stderr.trim() }
  }

  async sendKeys(key: string, keys: string[]): Promise<void> {
    if (!isTmuxKeys(keys)) throw new Error('Those keys are not sent to agents.')
    const { host, id } = this.locate(key)
    await host.exec(['key', id, ...keys], { timeoutMs: 10_000 })
  }

  /** Type a line into a Kuna agent and press Enter. Background sessions only take input through an attached tab. */
  async sendText(key: string, text: string): Promise<{ error?: string }> {
    const { host, id } = this.locate(key)
    if (id.startsWith('cc-')) return { error: 'Open the session to send it input.' }
    const res = await host.exec(['send', id, b64(text)], { timeoutMs: 10_000 })
    return res.code === 0 ? {} : { error: res.stderr.trim() || 'Could not type into the agent.' }
  }

  details(key: string): AgentDetails | null {
    return this.transcripts.get(key)?.details ?? null
  }

  /** Everything read from transcripts so far, for a window that just opened. */
  allDetails(): Record<string, AgentDetails> {
    return Object.fromEntries([...this.transcripts].flatMap(([k, t]) => (t.details ? [[k, t.details] as const] : [])))
  }

  // ------------------------------------------------------- transcripts ----

  private pullTranscript(host: Host, a: AgentRuntime): void {
    const path = a.transcriptPath!
    let t = this.transcripts.get(a.key)
    if (!t || t.path !== path) {
      t = { path, offset: 0, parser: new TranscriptParser(), decoder: new StringDecoder('utf8'), busy: false, again: false }
      this.transcripts.set(a.key, t)
    }
    if (a.transcriptSize < t.offset) {
      // file was rewritten; start over
      t.offset = 0
      t.parser = new TranscriptParser()
      t.decoder = new StringDecoder('utf8')
    }
    if (a.transcriptSize === t.offset) return
    if (t.busy) {
      t.again = true
      return
    }
    void this.readTranscript(host, a.key, t, a.transcriptSize)
  }

  private async readTranscript(host: Host, key: string, t: TranscriptState, size: number): Promise<void> {
    t.busy = true
    try {
      let fromMiddle = false
      if (t.offset === 0 && size > FIRST_READ_MAX) {
        t.offset = size - FIRST_READ_MAX
        fromMiddle = true
      }
      const res = await host.exec(['read', b64(t.path), String(t.offset), String(DELTA_READ_MAX)], {
        timeoutMs: 60_000,
        maxBytes: DELTA_READ_MAX + 1024
      })
      if (this.transcripts.get(key) !== t) return
      if (res.code === 0 && res.stdout.length) {
        // the decoder holds back split UTF-8 sequences, the parser holds back partial lines
        t.parser.feed(t.decoder.write(res.stdout), fromMiddle)
        t.offset += res.stdout.length
        t.details = t.parser.details()
        this.emit('details', key, t.details)
      }
    } finally {
      t.busy = false
      if (t.again) {
        t.again = false
        const a = this.agent(key)
        if (a) this.pullTranscript(host, a)
      }
    }
  }

  dispose(): void {
    for (const h of [...this.hosts.values(), ...this.passing.values()]) h.dispose()
    this.hosts.clear()
    this.passing.clear()
  }
}

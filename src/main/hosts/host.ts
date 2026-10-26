import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LOCAL_HOST, type AgentRuntime, type HostId, type HostState, type PlanUsage } from '@shared/types'
import { frameToAgents, parseFrame, type WatchFrame } from '@shared/watch'
import { looksLikeAuthError, run, shq, type ExecOptions, type ExecResult } from './exec'
import { KUNA_SCRIPT, KUNA_VERSION } from './script'

const LOCAL_KUNA = join(homedir(), '.kuna', 'bin', 'kuna')
const REMOTE_KUNA = '.kuna/bin/kuna' // ssh commands start in $HOME
/**
 * Windows has no tmux, so there "this PC" is WSL: the helper, tmux and the
 * agents live in the default WSL distribution and Kuna talks to it through
 * wsl.exe the way it talks to a remote host through ssh.
 */
const WINDOWS = process.platform === 'win32'
const SSH = WINDOWS ? 'ssh.exe' : 'ssh'
/**
 * `wsl.exe --exec` skips the login, so $SHELL (kuna.sh asks the login shell
 * where tmux and claude are) and $LANG (tmux draws UTF-8 only in a UTF-8
 * locale) may be missing: fill them in, then run the command in $HOME.
 */
const WSL_PRELUDE = ': "${SHELL:=$(getent passwd "$(id -un)" | cut -d: -f7)}"; : "${LANG:=C.UTF-8}"; export SHELL LANG; exec "$@"'
function wslArgs(cmd: string[]): string[] {
  return ['--cd', '~', '--exec', 'sh', '-c', WSL_PRELUDE, 'kuna', ...cmd]
}
/** Writes the helper from stdin into ~/.kuna/bin, replacing the old one in one step. */
const INSTALL_SH =
  'mkdir -p "$HOME/.kuna/bin" && chmod 700 "$HOME/.kuna" && cat > "$HOME/.kuna/bin/kuna.tmp" && chmod 755 "$HOME/.kuna/bin/kuna.tmp" && mv -f "$HOME/.kuna/bin/kuna.tmp" "$HOME/.kuna/bin/kuna"'
const WATCH_STALL_MS = 50_000
/** Commands in flight per host; the rest wait their turn instead of bursting. */
const MAX_PARALLEL_EXEC = 2
const SSH_DIR = join(homedir(), '.kuna', 'ssh')
/**
 * Open panes ride on the control connection, which is already up — opening a
 * pane then never waits for a new ssh login (busy nodes can take minutes to
 * accept one). sshd allows ~10 sessions per connection, so past this many
 * panes on one host the rest go to a second connection.
 */
const PANES_ON_CONTROL = 6

/**
 * Kuna keeps its own shared ssh connections instead of riding on yours: a
 * connection shared with your terminals can run into sshd's MaxSessions (10)
 * and new sessions get refused. Port forwards from your config are dropped so
 * they never collide with the ones your terminals already hold. Jump hosts
 * (ProxyJump) still go through your config, so no extra logins to them are made
 * — login nodes tend to throttle bursts of new connections.
 */
function sshOptions(slot: string): string[] {
  return [
    // Windows' OpenSSH can't share connections (no Unix sockets for ControlPath): each command logs in anew
    ...(WINDOWS ? [] : ['-o', 'ControlMaster=auto', '-o', `ControlPath=${SSH_DIR}/%C-${slot}`, '-o', 'ControlPersist=600']),
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3'
  ]
}

/**
 * One machine we run agents on: this Mac (WSL on Windows) or an SSH alias.
 * Owns the helper install, a long-lived `kuna watch` stream and command execution.
 *
 * Events: 'state' (HostState), 'agents' (AgentRuntime[]), 'usage' (PlanUsage)
 */
export class Host extends EventEmitter {
  readonly local: boolean
  state: HostState
  agents: AgentRuntime[] = []
  usage?: PlanUsage
  /** panes currently attached through this host's connections */
  private openPanes = 0
  private running = 0
  private queue: (() => void)[] = []
  /** remote clock − local clock, in seconds */
  clockOffset = 0

  private watcher?: ChildProcessWithoutNullStreams
  private watchBuf = ''
  private watchLines: string[] = []
  /** the last frame, for re-deriving time-based statuses until the next one */
  private lastFrame?: { frame: WatchFrame; at: number }
  private recheckTimer?: ReturnType<typeof setTimeout>
  private lastWatchData = 0
  private stallTimer?: NodeJS.Timeout
  private retryTimer?: NodeJS.Timeout
  private retries = 0
  private connecting?: Promise<void>
  private disposed = false

  constructor(readonly id: HostId) {
    super()
    this.local = id === LOCAL_HOST
    this.state = { host: id, status: 'idle' }
  }

  private setState(patch: Partial<HostState>): void {
    this.state = { ...this.state, ...patch }
    this.emit('state', this.state)
  }

  /** ssh options for Kuna's control connection (watch stream, commands, sign-in). */
  sshArgs(): string[] {
    return sshOptions('c')
  }

  /** Run `kuna <args>` on the host (queued: at most two at a time per host). */
  async exec(args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    if (this.local) return WINDOWS ? run('wsl.exe', wslArgs(['sh', REMOTE_KUNA, ...args]), opts) : run('sh', [LOCAL_KUNA, ...args], opts)
    if (this.running >= MAX_PARALLEL_EXEC) await new Promise<void>((go) => this.queue.push(go))
    this.running++
    try {
      return await run(SSH, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', ...this.sshArgs(), '--', this.id, ['sh', REMOTE_KUNA, ...args].map(shq).join(' ')], opts)
    } finally {
      this.running--
      this.queue.shift()?.()
    }
  }

  /** A pane closed: free its slot on the shared connection. */
  releasePane(): void {
    this.openPanes = Math.max(0, this.openPanes - 1)
  }

  /** Command line for an interactive terminal attached to an agent. */
  attachCommand(agentId: string): { file: string; args: string[] } {
    // Claude background sessions attach with `claude attach`, Kuna's own through tmux
    const [verb, id] = agentId.startsWith('cc-') ? ['cattach', agentId.slice(3)] : ['attach', agentId]
    if (this.local) return WINDOWS ? { file: 'wsl.exe', args: wslArgs(['sh', REMOTE_KUNA, verb, id]) } : { file: '/bin/sh', args: [LOCAL_KUNA, verb, id] }
    return {
      file: SSH,
      args: ['-tt', '-o', 'ConnectTimeout=20', ...sshOptions(this.openPanes++ < PANES_ON_CONTROL ? 'c' : 'a'), '--', this.id, `sh ${REMOTE_KUNA} ${verb} ${shq(id)}`]
    }
  }

  /** Command line for a sign-in terminal (password / OTP / Kerberos prompts). */
  loginCommand(): { file: string; args: string[] } {
    return {
      file: SSH,
      args: ['-tt', ...this.sshArgs(), '--', this.id, 'echo; echo Signed in to; hostname; sleep 1']
    }
  }

  connect(): Promise<void> {
    if (this.connecting) return this.connecting
    this.connecting = this.doConnect().finally(() => (this.connecting = undefined))
    return this.connecting
  }

  private async doConnect(): Promise<void> {
    clearTimeout(this.retryTimer)
    this.setState({ status: 'connecting', error: undefined, synced: false })
    if (!this.local) mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 })

    const ver = await this.exec(['version'], { timeoutMs: 30_000 })
    if (this.disposed) return
    // 255 is ssh's own failure; anything else means the helper is missing or stale
    if (!this.local && ver.code === 255) return this.fail(ver.stderr)
    if (this.local && WINDOWS && /ENOENT|no installed distributions|WSL_E_/i.test(ver.stderr)) {
      return this.fail(`Kuna runs agents on this PC inside WSL, which is not set up: ${firstLine(ver.stderr)}. Install it with \`wsl --install\`, then install tmux and Claude Code inside it, and reconnect.`, false)
    }

    let doctor: ExecResult
    if (ver.stdout.toString('utf8').trim() !== KUNA_VERSION) {
      this.setState({ status: 'installing' })
      const ok = await this.install()
      if (!ok.ok) return this.fail(ok.error)
      doctor = await this.exec(['setup'], { timeoutMs: 60_000 })
    } else {
      doctor = await this.exec(['doctor'], { timeoutMs: 20_000 })
    }
    if (doctor.code !== 0) return this.fail(doctor.stderr || 'kuna helper failed to run')

    const info: Record<string, string> = {}
    for (const line of doctor.stdout.toString('utf8').split('\n')) {
      const [k, ...v] = line.split('\t')
      if (k) info[k] = v.join('\t')
    }
    if (!info.tmux) {
      if (this.local && WINDOWS) return this.fail('tmux was not found in WSL. Install it there (`sudo apt install tmux` in Ubuntu) and reconnect.', false)
      return this.fail(`tmux was not found on ${this.id}. Install tmux there (e.g. via your package manager or conda) and reconnect.`, false)
    }
    this.retries = 0
    this.setState({
      status: 'ready',
      home: info.home,
      hostname: info.hostname,
      os: info.os,
      tmux: info.tmux,
      tmuxVersion: info.tmuxv,
      claude: info.claude || undefined
    })
    this.startWatch()
  }

  private async install(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.local && WINDOWS) {
      const res = await run('wsl.exe', ['--cd', '~', '--exec', 'sh', '-c', INSTALL_SH], { stdin: KUNA_SCRIPT, timeoutMs: 30_000 })
      return res.code === 0 ? { ok: true } : { ok: false, error: res.stderr || `install in WSL failed (${res.code})` }
    }
    if (this.local) {
      mkdirSync(join(homedir(), '.kuna', 'bin'), { recursive: true, mode: 0o700 })
      writeFileSync(LOCAL_KUNA, KUNA_SCRIPT)
      chmodSync(LOCAL_KUNA, 0o755)
      return { ok: true }
    }
    const cmd = `sh -c '${INSTALL_SH}'`
    const res = await run(SSH, ['-o', 'BatchMode=yes', ...this.sshArgs(), '--', this.id, cmd], {
      stdin: KUNA_SCRIPT,
      timeoutMs: 30_000
    })
    return res.code === 0 ? { ok: true } : { ok: false, error: res.stderr || `install failed (${res.code})` }
  }

  private fail(stderr: string, retry = true): void {
    const msg = stderr.replace(/\[kuna\].*$/gm, '').trim() || 'connection failed'
    if (!this.local && looksLikeAuthError(stderr)) {
      this.setState({ status: 'auth', error: firstLine(msg) })
      return
    }
    this.setState({ status: 'error', error: firstLine(msg) })
    if (retry) this.scheduleRetry()
  }

  private scheduleRetry(): void {
    if (this.disposed) return
    clearTimeout(this.retryTimer)
    // slow, jittered back-off: a struggling login node should not see a stampede
    const delay = Math.min(180_000, 10_000 * 2 ** this.retries++) * (0.8 + Math.random() * 0.4)
    this.retryTimer = setTimeout(() => void this.connect(), delay)
  }

  // ------------------------------------------------------------ watch ----

  private startWatch(): void {
    this.stopWatch()
    const child = this.local
      ? WINDOWS
        ? spawn('wsl.exe', wslArgs(['sh', REMOTE_KUNA, 'watch']))
        : spawn('sh', [LOCAL_KUNA, 'watch'])
      : spawn(SSH, ['-o', 'BatchMode=yes', ...this.sshArgs(), '--', this.id, `sh ${REMOTE_KUNA} watch`])
    this.watcher = child
    this.watchBuf = ''
    this.watchLines = []
    this.lastWatchData = Date.now()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (s: string) => this.onWatchData(s))
    let err = ''
    child.stderr.on('data', (b: Buffer) => (err = (err + b.toString('utf8')).slice(-4000)))
    child.on('close', () => {
      if (this.watcher !== child) return
      this.watcher = undefined
      if (this.disposed) return
      this.fail(err || 'connection to host lost')
    })
    clearInterval(this.stallTimer)
    this.stallTimer = setInterval(() => {
      if (Date.now() - this.lastWatchData > WATCH_STALL_MS) {
        child.kill()
      }
    }, 10_000)
  }

  private stopWatch(): void {
    clearInterval(this.stallTimer)
    const w = this.watcher
    this.watcher = undefined
    w?.kill()
  }

  private onWatchData(s: string): void {
    this.lastWatchData = Date.now()
    this.watchBuf += s
    let nl: number
    while ((nl = this.watchBuf.indexOf('\n')) >= 0) {
      const line = this.watchBuf.slice(0, nl)
      this.watchBuf = this.watchBuf.slice(nl + 1)
      if (line.startsWith('@@END\t')) {
        const remoteNow = Number(line.slice(6)) || Math.floor(Date.now() / 1000)
        this.clockOffset = remoteNow - Math.floor(Date.now() / 1000)
        this.onFrame(this.watchLines, remoteNow)
        this.watchLines = []
      } else {
        this.watchLines.push(line)
      }
    }
    // a frame is a few KB; a stream that never ends one is not Kuna's helper talking
    if (this.watchBuf.length > 1 << 20 || this.watchLines.length > 20_000) {
      this.watchBuf = ''
      this.watchLines = []
    }
  }

  private onFrame(lines: string[], remoteNow: number): void {
    const off = this.clockOffset
    const frame = parseFrame(lines, remoteNow)
    if (frame.usage && frame.usage.ts - off !== this.usage?.updatedAt) {
      const { ts, ...windows } = frame.usage
      this.usage = { ...windows, updatedAt: ts - off, host: this.id }
      this.emit('usage', this.usage)
    }
    this.lastFrame = { frame, at: Date.now() }
    this.agents = this.records(frame)
    this.emit('agents', this.agents)
    this.scheduleRecheck()
    if (!this.state.synced) this.setState({ synced: true })
  }

  private records(frame: WatchFrame): AgentRuntime[] {
    const off = this.clockOffset
    return frameToAgents(this.id, frame).map((a) => ({
      ...a,
      createdAt: a.createdAt - off,
      attnTs: a.attnTs ? a.attnTs - off : 0,
      activityTs: a.activityTs - off,
      lastEventTs: a.lastEventTs ? a.lastEventTs - off : undefined
    }))
  }

  /**
   * "starting" and "working" from a recent event or screen activity expire
   * with time, but a quiet agent sends no new frame (the heartbeat comes every
   * 30 s). Re-derive them from the last frame, locally, until they settle.
   */
  private scheduleRecheck(): void {
    clearTimeout(this.recheckTimer)
    if (!this.agents.some((a) => a.kind === 'tmux' && (a.status === 'starting' || a.status === 'working'))) return
    this.recheckTimer = setTimeout(() => {
      const last = this.lastFrame
      if (!last || this.disposed) return
      const frame = { ...last.frame, now: last.frame.now + Math.floor((Date.now() - last.at) / 1000) }
      const agents = this.records(frame)
      if (agents.some((a, i) => a.status !== this.agents[i]?.status)) {
        this.agents = agents
        this.emit('agents', agents)
      }
      this.scheduleRecheck()
    }, 2000)
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.retryTimer)
    clearTimeout(this.recheckTimer)
    this.stopWatch()
    this.removeAllListeners()
  }
}

function firstLine(s: string): string {
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean)
  return (lines.find((l) => !/^warning:/i.test(l)) ?? lines[0] ?? '').slice(0, 300)
}

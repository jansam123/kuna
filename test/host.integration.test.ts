import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentRuntime } from '@shared/types'

/**
 * Drives the real remote code path (install over "ssh", watch stream, spawn,
 * read, kill) against a fake ssh that runs commands locally in a throwaway
 * HOME and a private tmux socket. Skipped when tmux is not installed.
 */
const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V'])
    return true
  } catch {
    return false
  }
})()

const SOCKET = `kuna-test-${process.pid}`
let home: string
const env = { ...process.env }

describe.skipIf(!hasTmux)('Host over (fake) ssh', () => {
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'kuna-home-'))
    mkdirSync(join(home, 'work'))
    chmodSync(resolve(__dirname, 'fake-ssh/ssh'), 0o755)
    process.env.PATH = `${resolve(__dirname, 'fake-ssh')}:${process.env.PATH}`
    process.env.HOME = home
    process.env.SHELL = '/bin/sh'
    process.env.KUNA_TMUX_SOCKET = SOCKET
  })

  afterAll(() => {
    try {
      execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' })
    } catch {
      /* already gone */
    }
    Object.assign(process.env, env)
    rmSync(home, { recursive: true, force: true })
  })

  it('leaves no watch behind when the host is removed while it installs', async () => {
    const { Host } = await import('../src/main/hosts/host')
    const host = new Host('fakehost')
    host.on('state', (s: { status: string }) => s.status === 'installing' && host.dispose())
    await host.connect()
    expect((host as unknown as { watcher?: unknown }).watcher).toBeUndefined()
  })

  it('installs the helper, streams agents, spawns, reads and kills', async () => {
    const { Host } = await import('../src/main/hosts/host')
    const { b64 } = await import('../src/main/hosts/exec')
    const host = new Host('fakehost')
    const frames: AgentRuntime[][] = []
    host.on('agents', (a: AgentRuntime[]) => frames.push(a))

    await host.connect()
    expect(host.state).toMatchObject({ status: 'ready', home })
    expect(host.state.tmux).toBeTruthy()

    const transcript = join(home, 'work', 't.jsonl')
    writeFileSync(transcript, '{"type":"ai-title","aiTitle":"Fake"}\n')
    const cmd = `printf '%s' '{"hook_event_name":"Stop","transcript_path":"${transcript}"}' | sh "$HOME/.kuna/bin/kuna" hook; echo working; sleep 60`
    const meta = JSON.stringify({ cwd: '~/work', createdAt: Math.floor(Date.now() / 1000) })
    const res = await host.exec(['spawn', 'abc123', b64('~/work'), b64(cmd), '100', '30', b64(meta), b64('')])
    expect(res.stdout.toString()).toContain('ok')

    const deadline = Date.now() + 15_000
    let agent: AgentRuntime | undefined
    while (Date.now() < deadline) {
      agent = frames.at(-1)?.find((a) => a.id === 'abc123' && a.transcriptSize > 0)
      if (agent) break
      await new Promise((r) => setTimeout(r, 200))
    }
    expect(agent).toMatchObject({ key: 'fakehost::abc123', alive: true, cwd: '~/work', lastEvent: 'Stop', status: 'idle', transcriptPath: transcript })
    expect(agent!.attnTs).toBeGreaterThan(0)

    const read = await host.exec(['read', b64(transcript), '0', '1000'])
    expect(read.stdout.toString()).toContain('"aiTitle":"Fake"')

    // send replaces a half-typed draft (the tty's line editing stands in for Claude Code's)
    const echo = 'while IFS= read -r l; do echo "got:$l"; done'
    await host.exec(['spawn', 'snd456', b64('~/work'), b64(echo), '100', '30', b64(meta), b64('')])
    const screen = (): string => execFileSync('tmux', ['-L', SOCKET, 'capture-pane', '-p', '-t', 'kuna_snd456']).toString()
    await new Promise((r) => setTimeout(r, 800))
    await host.exec(['key', 'snd456', '-l', 'half typed'])
    await host.exec(['send', 'snd456', b64('/compact')])
    const sent = Date.now() + 5000
    while (Date.now() < sent && !screen().includes('got:')) await new Promise((r) => setTimeout(r, 100))
    expect(screen()).toMatch(/^got:\/compact$/m)
    await host.exec(['kill', 'snd456'])

    await host.exec(['kill', 'abc123'])
    const gone = Date.now() + 10_000
    while (Date.now() < gone && frames.at(-1)?.some((a) => a.id === 'abc123')) await new Promise((r) => setTimeout(r, 200))
    expect(frames.at(-1)?.some((a) => a.id === 'abc123')).toBe(false)
    host.dispose()
  }, 40_000)

  it('runs one-off commands on a host nobody watches without watching it', async () => {
    const { AgentService } = await import('../src/main/agents')
    const agents = new AgentService(() => [])
    const passing = agents.host('fakehost')
    await passing.connect()
    expect(passing.state.status).toBe('ready')
    expect((passing as unknown as { watcher?: unknown }).watcher).toBeUndefined()
    expect(agents.hostStates()).toEqual([])
    // once a project uses it, it is watched (and listed)
    agents.watch(['fakehost'])
    expect(agents.host('fakehost')).not.toBe(passing)
    expect(agents.hostStates().map((h) => h.host)).toEqual(['fakehost'])
    agents.dispose()
  })
})

describe('the agent command through the login shell', () => {
  const script = resolve(__dirname, '../src/main/remote/kuna.sh')
  const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
  const prompt = `it's "quoted" $HOME \`x\` !hist\n\n  and a line more`
  // stands in for claude: records its arguments, prints what claude --bg prints
  const agent = `sh -c 'printf "%s:%s" "$#" "$1" > "$HOME/got"; echo "claude attach 0123abcd"' agent`
  const shells = ['/bin/sh', '/bin/tcsh'].filter((s) => existsSync(s))

  for (const shell of shells) {
    it(`gives the prompt as one argument (${shell})`, () => {
      const home = mkdtempSync(join(tmpdir(), 'kuna-login-'))
      const env = { ...process.env, HOME: home, SHELL: shell }
      const got = (): string => readFileSync(join(home, 'got'), 'utf8')
      try {
        const d = join(home, '.kuna', 'agents', 'a1')
        mkdirSync(d, { recursive: true })
        writeFileSync(join(d, 'cmd'), agent)
        writeFileSync(join(d, 'prompt'), prompt)
        execFileSync('sh', [script, 'run', 'a1'], { env, stdio: 'ignore' })
        expect(got()).toBe(`1:${prompt}`)
        writeFileSync(join(d, 'prompt'), '')
        execFileSync('sh', [script, 'run', 'a1'], { env, stdio: 'ignore' })
        expect(got()).toBe('0:')
        // a background session: the same, and its id from claude's output
        const out = execFileSync('sh', [script, 'bgspawn', b64(home), b64(agent), b64(prompt)], { env }).toString()
        expect(out).toBe('0123abcd\n')
        expect(got()).toBe(`1:${prompt}`)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })
  }

  it("uses Claude Code's config folder from the login shell", () => {
    const home = mkdtempSync(join(tmpdir(), 'kuna-ccdir-'))
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, SHELL: '/bin/sh', KUNA_TMUX_SOCKET: SOCKET }
    delete env.CLAUDE_CONFIG_DIR
    try {
      const cc = join(home, 'cc')
      mkdirSync(join(cc, 'jobs', 'abcd1234'), { recursive: true })
      writeFileSync(join(cc, 'jobs', 'abcd1234', 'state.json'), JSON.stringify({ state: 'done', sessionId: 's1', cwd: home }))
      writeFileSync(join(cc, 'CLAUDE.md'), 'mine\n')
      // set only for login shells, as in a .zprofile
      writeFileSync(join(home, '.profile'), `CLAUDE_CONFIG_DIR="${cc}"; export CLAUDE_CONFIG_DIR\n`)
      execFileSync('sh', [script, 'setup'], { env, stdio: 'ignore' })
      expect(readFileSync(join(home, '.kuna', 'claude-dir'), 'utf8')).toBe(`${cc}\n`)
      const kuna = (...args: string[]): string => execFileSync('sh', [script, ...args], { env }).toString()
      expect(kuna('bg-snapshot')).toMatch(/^J\tabcd1234\t/)
      expect(kuna('claude-files', b64(''))).toContain(`G\t${join(cc, 'CLAUDE.md')}`)
      // taken out of the login files again: back to the default
      writeFileSync(join(home, '.profile'), '')
      execFileSync('sh', [script, 'setup'], { env, stdio: 'ignore' })
      expect(existsSync(join(home, '.kuna', 'claude-dir'))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('files for an HTML page in the viewer (pcat)', () => {
  const script = resolve(__dirname, '../src/main/remote/kuna.sh')
  const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')

  it('reads only files inside the page folder as it is on disk, never through a symlink', () => {
    const home = mkdtempSync(join(tmpdir(), 'kuna-pcat-'))
    const env = { ...process.env, HOME: home }
    const pcat = (root: string, path: string): { code: number; out: string } => {
      const r = spawnSync('sh', [script, 'pcat', b64(root), b64(path)], { env })
      return { code: r.status ?? -1, out: r.stdout.toString() }
    }
    try {
      const page = join(home, 'work', 'docs')
      mkdirSync(join(page, 'plots'), { recursive: true })
      writeFileSync(join(page, 'plots', 'a.json'), 'inside')
      writeFileSync(join(home, 'secret.json'), 'outside')
      symlinkSync(join(home, 'secret.json'), join(page, 'k.json'))
      symlinkSync(home, join(page, 'up'))
      symlinkSync(join(page, 'plots'), join(page, 'same'))
      expect(pcat(page, join(page, 'plots', 'a.json'))).toEqual({ code: 0, out: 'inside' })
      // a link within the folder is fine; one that leads out, or a linked file, is not
      expect(pcat(page, join(page, 'same', 'a.json'))).toEqual({ code: 0, out: 'inside' })
      expect(pcat(page, join(page, 'k.json')).code).toBe(3)
      expect(pcat(page, join(page, 'up', 'secret.json')).code).toBe(3)
      expect(pcat(page, join(page, 'nope.json')).code).toBe(3)
      // `~` and a folder reached through a symlink of its own
      symlinkSync(page, join(home, 'docs-link'))
      expect(pcat('~/docs-link', '~/docs-link/plots/a.json')).toEqual({ code: 0, out: 'inside' })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
})

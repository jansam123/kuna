import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TranscriptParser } from '@shared/transcript'
import { bgStatus, frameToAgents, parseFrame, parseQuestions, waitingOn } from '@shared/watch'

// kuna.sh runs under sh on its hosts; Windows has none (its local host is WSL)
const noSh = process.platform === 'win32'

describe('Claude background sessions', () => {
  const lines = [
    'J\tc871bf62\t1\tworking\tblocked\t2026-10-20T16:44:33.316Z\t2026-10-20T16:44:20.000Z\t\tc871bf62-4c65\t/private/tmp/kuna-demo\t\t\tkuna-probe-question\tstarting…\tanswer: Do you prefer tea or coffee? (Tea · Coffee)\t',
    'Q\tc871bf62\t{ "questions": [ { "question": "Do you prefer tea or coffee?", "options": [ { "label": "Tea" }, { "label": "Coffee" } ] } ] }',
    'J\t0c580ff4\t1\tdone\tidle\t2026-10-20T16:31:00.984Z\t2026-10-20T10:53:06.045Z\t11692\t0c580ff4-5221\t/project/exp/jobs\t/project/exp/jobs/.claude/worktrees/x\t/h/.claude/projects/p/0c580ff4-5221.jsonl\tmonitor\tchecking jobs\t\t106 running\tsonnet[1m]',
    'J\tdead0001\t0\tdone\tidle\t2026-10-01T00:00:00.000Z\t2026-10-01T00:00:00.000Z\t5\tdead0001-s\t/w\t\t\told one\t\t\t',
    'S\t2048\t/h/.claude/projects/p/0c580ff4-5221.jsonl',
    'S\t77\t/h/.claude/projects/q/c871bf62-4c65.jsonl'
  ]

  it('turns J/Q/S lines into agents with their questions', () => {
    const agents = frameToAgents('cluster1', parseFrame(lines, 1792514700))
    const byId = Object.fromEntries(agents.map((a) => [a.id, a]))
    expect(byId['cc-c871bf62']).toMatchObject({
      kind: 'claude',
      key: 'cluster1::cc-c871bf62',
      status: 'waiting',
      name: 'kuna-probe-question',
      questions: [{ question: 'Do you prefer tea or coffee?', options: ['Tea', 'Coffee'] }],
      // not linked in state.json yet: found by session id
      transcriptPath: '/h/.claude/projects/q/c871bf62-4c65.jsonl',
      transcriptSize: 77
    })
    expect(byId['cc-0c580ff4']).toMatchObject({
      status: 'idle',
      worktree: '/project/exp/jobs/.claude/worktrees/x',
      transcriptSize: 2048,
      lastReply: '106 running',
      modelFlag: 'sonnet[1m]',
      tokens: 11692
    })
    expect(byId['cc-0c580ff4'].attnTs).toBe(Math.floor(Date.parse('2026-10-20T16:31:00.984Z') / 1000))
    // finished and not running: done, not "stopped"
    expect(byId['cc-dead0001']).toMatchObject({ status: 'idle', alive: false })
  })

  it('maps state and tempo to a status', () => {
    const r = { alive: true, state: 'working', tempo: 'active', updatedAt: 1000, createdAt: 0, cwd: '' }
    expect(bgStatus(r, 1060)).toBe('working')
    expect(bgStatus({ ...r, tempo: 'blocked' }, 1060)).toBe('waiting')
    // answered: running again while state still says blocked
    expect(bgStatus({ ...r, state: 'blocked', tempo: 'active' }, 1060)).toBe('working')
    expect(bgStatus({ ...r, state: 'blocked', tempo: '' }, 1060)).toBe('waiting')
    expect(bgStatus({ ...r, tempo: 'idle' }, 1060)).toBe('idle')
    expect(bgStatus({ ...r, state: 'done', tempo: 'idle' }, 1060)).toBe('idle')
    expect(bgStatus({ ...r, state: 'failed', tempo: 'idle' }, 1060)).toBe('failed')
    expect(bgStatus({ ...r, state: 'stopped', tempo: 'idle' }, 1060)).toBe('exited')
    // no worker process: still working while it is heard from (attached in a terminal)…
    expect(bgStatus({ ...r, alive: false }, 1060)).toBe('working')
    // …but a turn silent for half an hour without one died
    expect(bgStatus({ ...r, alive: false }, 1000 + 3600)).toBe('exited')
  })

  it('knows a session waiting on its own work: check-ins, monitors, background jobs', () => {
    const r = { alive: false, state: 'done', tempo: 'idle', updatedAt: 1000, createdAt: 0, cwd: '' }
    const cron = { tasks: 1, queued: 0, kinds: ['session_cron'], wake: { at: 1792573200000, reason: 'next grid check' } }
    expect(bgStatus({ ...r, inFlight: cron }, 1060)).toBe('background')
    expect(waitingOn(cron)).toEqual({ kind: 'scheduled', at: 1792573200, reason: 'next grid check' })
    expect(waitingOn({ tasks: 1, queued: 0, kinds: ['monitor'], drainableMonitors: 1 })).toEqual({ kind: 'monitor', count: 1 })
    expect(waitingOn({ tasks: 2, queued: 0, kinds: ['local_bash'] })).toEqual({ kind: 'jobs', count: 2 })
    expect(bgStatus({ ...r, inFlight: { tasks: 0, queued: 0, kinds: [] } }, 1060)).toBe('idle')
    // the frame carries it, and the agent is alive and busy with it
    const lines = [
      'J\tc0ffee01\t0\tdone\tidle\t2026-10-21T08:30:55.642Z\t2026-10-21T08:00:00.000Z\t5\ts1\t/w\t\t/h/p/s1.jsonl\tgrid watch\tcycle 60: 107 of 205 tasks done\t\t\t',
      'F\tc0ffee01\t' + JSON.stringify(cron),
      'J\tc0ffee02\t1\tworking\tactive\t2026-10-21T08:30:55.642Z\t2026-10-21T08:00:00.000Z\t5\ts2\t/w\t\t/h/p/s2.jsonl\tfit\ttraining\t\t\t',
      'T\tBash\tpython train.py --epochs 5\t/h/p/s2.jsonl'
    ]
    const agents = Object.fromEntries(frameToAgents('cluster1', parseFrame(lines, 1792571500)).map((a) => [a.id, a]))
    expect(agents['cc-c0ffee01']).toMatchObject({ status: 'background', alive: true, activity: { kind: 'scheduled', reason: 'next grid check' } })
    expect(agents['cc-c0ffee02']).toMatchObject({ status: 'working', activity: { kind: 'tool', tool: 'Bash', summary: 'python train.py --epochs 5' } })
  })

  it('carries the context size from C lines', () => {
    const agents = frameToAgents('cluster1', parseFrame([...lines, 'C\t412000\t688009\tclaude-opus-5-5\t/h/.claude/projects/p/0c580ff4-5221.jsonl'], 1792514700))
    const byId = Object.fromEntries(agents.map((a) => [a.id, a]))
    expect(byId['cc-0c580ff4']).toMatchObject({ contextTokens: 412000, contextPeak: 688009, model: 'claude-opus-5-5' })
    expect(byId['cc-c871bf62'].contextTokens).toBeUndefined()
    const unknown = frameToAgents('cluster1', parseFrame([...lines, 'C\t5\t5\t-\t/h/.claude/projects/p/0c580ff4-5221.jsonl'], 1792514700))
    expect(unknown.find((a) => a.id === 'cc-0c580ff4')?.model).toBeUndefined()
  })

  it('reads question blocks', () => {
    expect(parseQuestions('{"questions":[{"question":"Q?","options":[{"label":"A"},"B"]}]}')).toEqual([{ question: 'Q?', options: ['A', 'B'] }])
    expect(parseQuestions('{}')).toBeUndefined()
  })
})

describe.skipIf(noSh)('kuna bg-snapshot context sizes', () => {
  const script = join(__dirname, '..', 'src', 'main', 'remote', 'kuna.sh')
  const home = mkdtempSync(join(tmpdir(), 'kuna-ctx-'))
  const transcript = join(home, '.claude', 'projects', 'p', 'sess-1.jsonl')
  const cache = join(home, '.kuna', 'ctx', 'sess-1.jsonl')
  const usage = (input: number, write: number, read: number, extra: object = {}): string =>
    JSON.stringify({
      type: 'assistant',
      ...extra,
      message: { model: 'claude-opus-5-5', usage: { input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: 9 } }
    }) + '\n'
  const snapshot = (): string[] =>
    execFileSync('sh', [script, 'bg-snapshot'], { env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude') } })
      .toString()
      .split('\n')
  const contextLines = (): string[] => snapshot().filter((l) => l.startsWith('C\t'))
  /** pretend the cached reading is old enough to be redone (the host does it at most every 10 s) */
  const age = (): void => {
    // fields: size tokens peak model time tool summary
    const f = readFileSync(cache, 'utf8').replace(/\n$/, '').split('\t')
    f[4] = '0'
    writeFileSync(cache, f.join('\t') + '\n')
  }

  beforeAll(() => {
    mkdirSync(join(home, '.claude', 'jobs', 'abcd1234'), { recursive: true })
    mkdirSync(join(home, '.claude', 'projects', 'p'), { recursive: true })
    // pretty-printed, like Claude Code writes it
    writeFileSync(
      join(home, '.claude', 'jobs', 'abcd1234', 'state.json'),
      JSON.stringify({ state: 'done', sessionId: 'sess-1', cwd: home, linkScanPath: transcript, respawnFlags: ['--rc', '--model', 'sonnet[1m]', '--effort', 'high'] }, null, 2)
    )
    writeFileSync(transcript, '{"type":"user","message":{"content":"hi"}}\n' + usage(2, 1000, 150_000) + usage(1, 1, 999_999, { isSidechain: true }))
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it('takes the last main-thread reply, and what a compaction left', () => {
    expect(contextLines()).toEqual([`C\t151002\t151002\tclaude-opus-5-5\t${transcript}`])
    // unchanged transcript: answered from the cache
    expect(contextLines()).toEqual([`C\t151002\t151002\tclaude-opus-5-5\t${transcript}`])
    appendFileSync(
      transcript,
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual', preTokens: 420_000, postTokens: 13_365 } }) + '\n'
    )
    // grown, but read less than 10 s ago: still the cached numbers
    expect(contextLines()).toEqual([`C\t151002\t151002\tclaude-opus-5-5\t${transcript}`])
    age()
    expect(contextLines()).toEqual([`C\t13365\t420000\tclaude-opus-5-5\t${transcript}`])
    appendFileSync(transcript, usage(3, 2000, 20_000))
    age()
    expect(contextLines()).toEqual([`C\t22003\t420000\tclaude-opus-5-5\t${transcript}`])
  })

  it('ignores subagent progress records and finds the model wherever it is', () => {
    const nested = { type: 'assistant', message: { model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 12_000, output_tokens: 5 } } }
    appendFileSync(transcript, JSON.stringify({ isSidechain: false, type: 'progress', data: { message: nested, type: 'agent_progress' } }) + '\n')
    age()
    expect(contextLines()).toEqual([`C\t22003\t420000\tclaude-opus-5-5\t${transcript}`])
    // the reply's model after its content, and a tool call naming another model inside it
    const reply = {
      type: 'assistant',
      message: {
        id: 'msg_1',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { model: 'haiku', prompt: 'look' } }],
        model: 'claude-sonnet-4-5-20250929',
        stop_reason: 'tool_use',
        usage: { input_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 30_000 }
      }
    }
    appendFileSync(transcript, JSON.stringify(reply) + '\n')
    age()
    expect(contextLines()).toEqual([`C\t30004\t420000\tclaude-sonnet-4-5-20250929\t${transcript}`])
  })

  it('recovers from a damaged cache line', () => {
    // an empty middle field used to shift the later ones
    writeFileSync(cache, `1\t500\t\tclaude-x\n`)
    expect(contextLines()).toEqual([`C\t30004\t420000\tclaude-sonnet-4-5-20250929\t${transcript}`])
  })

  it('reports the tool call a session is waiting on, until its result', () => {
    const call = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu9', name: 'Bash', input: { command: 'python train.py --epochs 5', description: 'train' } }] } }
    appendFileSync(transcript, JSON.stringify(call) + '\n')
    age()
    const tools = (): string[] => snapshot().filter((l) => l.startsWith('T\t'))
    expect(tools()).toEqual([`T\tBash\tpython train.py --epochs 5\t${transcript}`])
    appendFileSync(transcript, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu9', content: 'done' }] } }) + '\n')
    age()
    expect(tools()).toEqual([])
  })

  it('reports what a session waits on (Claude Code\'s inFlight)', () => {
    const state = join(home, '.claude', 'jobs', 'abcd1234', 'state.json')
    const s = JSON.parse(readFileSync(state, 'utf8'))
    s.inFlight = { tasks: 1, queued: 0, kinds: ['session_cron'], wake: { at: 1792573200000, reason: 'next grid check', fires: 3 } }
    writeFileSync(state, JSON.stringify(s, null, 2))
    const f = snapshot().find((l) => l.startsWith('F\t'))!.split('\t')
    expect(f[1]).toBe('abcd1234')
    expect(JSON.parse(f[2])).toMatchObject({ kinds: ['session_cron'], wake: { reason: 'next grid check' } })
  })

  it('reports the --model a session was started with', () => {
    const j = snapshot().find((l) => l.startsWith('J\t'))!.split('\t')
    expect(j[16]).toBe('sonnet[1m]')
  })
})

describe('pending AskUserQuestion in transcripts', () => {
  it('is open until its tool_result arrives', () => {
    const p = new TranscriptParser()
    const feed = (o: object): void => p.feed(JSON.stringify(o) + '\n')
    feed({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions: [{ question: 'Tea?', options: [{ label: 'Yes' }, { label: 'No' }] }] } }]
      }
    })
    expect(p.details().pendingQuestions).toEqual([{ question: 'Tea?', options: ['Yes', 'No'] }])
    feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'q1', content: 'Yes' }] } })
    expect(p.details().pendingQuestions).toEqual([])
  })
})

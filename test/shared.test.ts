import { describe, expect, it } from 'vitest'
import { describeActivity, shortActivity } from '@shared/activity'
import { baseModelId, contextInfo, contextLevel, contextWindowSize, modelFlag, shortModel } from '@shared/context'
import { compactBlocker, hasInputBox, screenState } from '@shared/input'
import { parseJsonc } from '@shared/jsonc'
import { cleanTypedPath, pastePath } from '@shared/paths'
import { gridRows, neighbor } from '@shared/layout'
import { extractMediaPaths, mediaKind, normalizePosix, pageFile, resolveAgainst, viewerOrder } from '@shared/media'
import { parseSshConfig } from '@shared/sshConfig'
import { applyPatch, diffShared, mergePatch } from '@shared/sync'
import { hasMath, splitMath, texToText } from '@shared/tex'
import { TranscriptParser } from '@shared/transcript'
import { isAgentId, isHostId, isTmuxKeys, splitAgentKey } from '@shared/validate'
import { deriveStatus, frameToAgents, parseFrame, parseRateLimits } from '@shared/watch'
import { cascade, placeOnScreen, stepWindow, windowOrder } from '@shared/windows'
import type { SharedState } from '@shared/types'
import {
  buildTree,
  comparePaths,
  defaultBase,
  isSha,
  looksBinary,
  parseBlobs,
  parseCompare,
  parseDirListing,
  parseInfo,
  parseRepos,
  repoLabel,
  parseStatus,
  reviewMessage,
  specOf,
  touchCache,
  validRef,
  validRepoPath,
  type GitInfo,
  type GitRef
} from '@shared/git'
import { customize, editorPrefs, fileIcon, folderIcon, languageOf, type IconTheme, type LanguageInfo, type VscodeTheme } from '@shared/vscode'

describe('gridRows', () => {
  it('splits panes into balanced rows', () => {
    expect(gridRows(0)).toEqual([])
    expect(gridRows(1)).toEqual([1])
    expect(gridRows(2)).toEqual([2])
    // the third goes below the first two, the fourth splits the bottom row
    expect(gridRows(3)).toEqual([2, 1])
    expect(gridRows(4)).toEqual([2, 2])
    expect(gridRows(5)).toEqual([3, 2])
    expect(gridRows(6)).toEqual([3, 3])
    expect(gridRows(7)).toEqual([3, 3, 1])
    expect(gridRows(8)).toEqual([3, 3, 2])
    expect(gridRows(10)).toEqual([4, 4, 2])
  })
})

describe('neighbor', () => {
  const rows = [3, 2]
  it('moves horizontally and leaves to the sidebar', () => {
    expect(neighbor(rows, 0, 'left')).toBe('sidebar')
    expect(neighbor(rows, 0, 'right')).toBe(1)
    expect(neighbor(rows, 2, 'right')).toBeNull()
    expect(neighbor(rows, 3, 'left')).toBe('sidebar')
  })
  it('moves vertically to the pane underneath', () => {
    expect(neighbor(rows, 0, 'down')).toBe(3)
    expect(neighbor(rows, 2, 'down')).toBe(4)
    expect(neighbor(rows, 4, 'up')).toBe(2)
    expect(neighbor(rows, 3, 'up')).toBe(0)
    expect(neighbor(rows, 0, 'up')).toBeNull()
  })
})

describe('media paths', () => {
  it('finds plots and pdfs but not urls', () => {
    const text = 'Saved plots/mass.png and "/eos/user/s/out.pdf". See https://x.org/a.png, also ~/fig_1.jpeg.'
    expect(extractMediaPaths(text)).toEqual(['plots/mass.png', '/eos/user/s/out.pdf', '~/fig_1.jpeg'])
  })
  it('finds Markdown files, as the viewer renders them', () => {
    expect(extractMediaPaths('Notes are in docs/RESULTS.md and `summary.markdown`; see https://x.org/README.md.')).toEqual([
      'docs/RESULTS.md',
      'summary.markdown'
    ])
    expect(mediaKind('docs/RESULTS.md')).toBe('md')
    expect(mediaKind('a.MARKDOWN')).toBe('md')
    expect(mediaKind('notes.mdx')).toBeNull()
  })
  it('finds HTML pages (artifacts), shown live in the viewer', () => {
    expect(extractMediaPaths('The dashboard is at out/fit.html (and old.htm); https://x.org/index.html is not ours.')).toEqual([
      'out/fit.html',
      'old.htm'
    ])
    expect(mediaKind('a/B.HTML')).toBe('html')
    expect(viewerOrder([{ kind: 'image', path: 'a.png' }, { kind: 'html', path: 'p.html' }, { kind: 'pdf', path: 'f.pdf' }]).map((it) => it.path)).toEqual([
      'p.html',
      'f.pdf',
      'a.png'
    ])
  })
  it('lets a page load only the web files below its folder', () => {
    expect(pageFile('/w/out', '/fit.html')).toEqual({ path: '/w/out/fit.html', mime: 'text/html; charset=utf-8' })
    expect(pageFile('~/r', '/plots/a%20b.png')).toEqual({ path: '~/r/plots/a b.png', mime: 'image/png' })
    expect(pageFile('', '/x.json')?.path).toBe('/x.json')
    for (const bad of ['/../secret.json', '/%2E%2E/a.css', '/a/..%2Fb.js', '/.env', '/.git/config.json', '/id_rsa', '/notes', '/', '/%E0%A4%A.js', '/a%00.js'])
      expect(pageFile('/w/out', bad), bad).toBeNull()
  })
  it('resolves relative paths', () => {
    expect(resolveAgainst('/work/ana/', './plots/../out/a.png')).toBe('/work/ana/out/a.png')
    expect(resolveAgainst('/work', '/abs/b.pdf')).toBe('/abs/b.pdf')
    expect(resolveAgainst('~/proj', 'c.svg')).toBe('~/proj/c.svg')
    expect(normalizePosix('a/../../b')).toBe('../b')
  })
})

describe('parseSshConfig', () => {
  it('collects concrete aliases and follows Include', () => {
    const files: Record<string, string> = {
      '/h/.ssh/config': [
        'Host *',
        '  ControlMaster auto',
        'Include conf.d/*',
        'Host cluster1 alias2',
        '  HostName login1.example.org',
        '  User alice # comment',
        '  ProxyJump bastion',
        'Host *.cern.ch',
        '  User x'
      ].join('\n'),
      '/h/.ssh/conf.d/extra': 'Host hpc\n  HostName=hpc.example.net'
    }
    const hosts = parseSshConfig({
      home: '/h',
      read: (p) => files[p] ?? null,
      glob: (p) => (p === '/h/.ssh/conf.d/*' ? ['/h/.ssh/conf.d/extra'] : [p])
    })
    expect(hosts.map((h) => h.alias)).toEqual(['hpc', 'cluster1', 'alias2'])
    expect(hosts[1]).toMatchObject({ hostName: 'login1.example.org', user: 'alice', proxyJump: 'bastion' })
    expect(hosts[0].hostName).toBe('hpc.example.net')
  })
})

describe('watch frames', () => {
  const lines = [
    'P\t1\tkuna_ab12\t0\t1700000100\t1700000000\t0\tnode\t1\t✳ Fix tests',
    'A\tab12\t1700000050\t2048\t\t/h/.claude/projects/x/s.jsonl\t1700000090\tPreToolUse\tBash\t\tauto\t',
    'M\tab12\t{"cwd":"/work","folderId":"f1","createdAt":1700000000,"prompt":"hi"}',
    'A\tzz99\t0\t0\t0\t\t\t\t\t\t\t',
    'P\t2\tkuna_q1\t0\t1700000100\t1700000000\t0\tclaude\t0\t',
    'M\tzz99\t{"cwd":"/gone","createdAt":1699990000}'
  ]
  it('builds runtime records', () => {
    const agents = frameToAgents('cluster1', parseFrame(lines, 1700000101))
    expect(agents).toHaveLength(3)
    const [gone, live, asking] = agents
    expect(asking.status).toBe('waiting')
    expect(gone.status).toBe('exited')
    expect(live).toMatchObject({
      key: 'cluster1::ab12',
      status: 'working',
      tool: 'Bash',
      cwd: '/work',
      folderId: 'f1',
      paneTitle: '✳ Fix tests',
      inCopyMode: true,
      transcriptSize: 2048,
      attnTs: 1700000050,
      permissionMode: 'auto'
    })
  })
})

describe('deriveStatus', () => {
  const base = { now: 100, alive: true, dead: false, busy: false, createdAt: 0, activityTs: 0 }
  it('maps hook events', () => {
    expect(deriveStatus({ ...base, event: 'PermissionRequest' })).toBe('waiting')
    expect(deriveStatus({ ...base, event: 'Notification', notificationType: 'permission_prompt' })).toBe('waiting')
    expect(deriveStatus({ ...base, event: 'Notification', notificationType: 'idle_prompt' })).toBe('idle')
    expect(deriveStatus({ ...base, event: 'Stop' })).toBe('idle')
    expect(deriveStatus({ ...base, event: 'PreToolUse', eventTs: 98 })).toBe('working')
    expect(deriveStatus({ ...base, event: 'PreToolUse', eventTs: 50 })).toBe('idle')
    expect(deriveStatus({ ...base, busy: true, event: 'Stop' })).toBe('working')
    expect(deriveStatus({ ...base, dead: true })).toBe('exited')
    expect(deriveStatus({ ...base, asking: true, event: 'Stop' })).toBe('waiting')
  })
  it('falls back to screen activity without hooks', () => {
    expect(deriveStatus({ ...base, createdAt: 97 })).toBe('starting')
    expect(deriveStatus({ ...base, activityTs: 99 })).toBe('working')
    expect(deriveStatus({ ...base, activityTs: 10 })).toBe('idle')
  })
})

describe('context fullness', () => {
  it('infers the window and the level', () => {
    expect(contextWindowSize(150_000)).toBe(200_000)
    expect(contextWindowSize(150_000, 'claude-sonnet-4-5-20250929')).toBe(200_000)
    expect(contextWindowSize(150_000, 'claude-opus-4-1-20250805')).toBe(200_000)
    expect(contextWindowSize(150_000, 'claude-3-7-sonnet-20250219')).toBe(200_000)
    expect(contextWindowSize(150_000, 'claude-sonnet-4-5[1m]')).toBe(1_000_000)
    expect(contextWindowSize(150_000, 'claude-opus-4-6')).toBe(1_000_000)
    expect(contextWindowSize(150_000, 'claude-opus-5-5')).toBe(1_000_000)
    // a session that has been past 200k has a 1M window, also after compacting
    expect(contextWindowSize(20_000, undefined, 420_000)).toBe(1_000_000)
    expect(contextLevel(90_000, 200_000)).toBe('ok')
    expect(contextLevel(100_000, 200_000)).toBe('long')
    expect(contextLevel(170_000, 200_000)).toBe('full')
    expect(contextLevel(250_000, 1_000_000)).toBe('ok')
    expect(contextLevel(300_000, 1_000_000)).toBe('long')
    expect(contextInfo(820_000)).toMatchObject({ window: 1_000_000, pct: 82, level: 'full' })
  })

  it('knows provider model ids and the --model a session was started with', () => {
    expect(baseModelId('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('claude-sonnet-4-5-20250929')
    expect(baseModelId('claude-sonnet-4-5@20250929')).toBe('claude-sonnet-4-5-20250929')
    expect(contextWindowSize(170_000, 'us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(200_000)
    expect(contextWindowSize(170_000, 'claude-haiku-4-5@20251001')).toBe(200_000)
    expect(contextWindowSize(170_000, 'global.anthropic.claude-opus-4-6-v1')).toBe(1_000_000)
    // transcripts name the API model; `[1m]` only shows in how it was started
    expect(modelFlag('claude --model sonnet[1m] --effort high')).toBe('sonnet[1m]')
    expect(modelFlag("claude --model='opus'")).toBe('opus')
    expect(modelFlag('claude')).toBeUndefined()
    expect(contextWindowSize(160_000, 'claude-sonnet-4-5-20250929', 0, 'sonnet[1m]')).toBe(1_000_000)
    expect(contextInfo(160_000, 'claude-sonnet-4-5-20250929', 0, 'sonnet[1m]').level).toBe('ok')
  })

  it('names models shortly', () => {
    expect(shortModel('claude-sonnet-4-20250514')).toBe('sonnet 4')
    expect(shortModel('claude-opus-4-5-20251101')).toBe('opus 4.5')
    expect(shortModel('claude-opus-4-1')).toBe('opus 4.1')
    expect(shortModel('claude-sonnet-4-5')).toBe('sonnet 4.5')
    expect(shortModel('claude-sonnet-4-5[1m]')).toBe('sonnet 4.5[1m]')
    expect(shortModel('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('sonnet 4.5')
    expect(shortModel('claude-opus-4-1@20250805')).toBe('opus 4.1')
    expect(shortModel('claude-3-5-haiku-20241022')).toBe('3-5-haiku')
    expect(shortModel(undefined)).toBeUndefined()
  })

  it('starts over after a compaction in a transcript', () => {
    const p = new TranscriptParser()
    const feed = (o: object): void => p.feed(JSON.stringify(o) + '\n')
    feed({ type: 'assistant', message: { usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 400_000 } } })
    feed({ type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 400_010, postTokens: 12_000 } })
    expect(p.details()).toMatchObject({ contextTokens: 12_000, contextPeak: 400_010 })
  })
})

describe('paths typed or pasted in the folder dialog', () => {
  it('collapses doubled slashes', () => {
    expect(cleanTypedPath('/project/exp//users///x/')).toBe('/project/exp/users/x/')
  })
  it('lets a pasted absolute or home path replace the field', () => {
    expect(pastePath('~/', '/project/exp/users/alice/analysis\n', 2, 2)).toEqual({
      value: '/project/exp/users/alice/analysis',
      caret: 33
    })
    expect(pastePath('~/', "'~/work/fit'", 2, 2).value).toBe('~/work/fit')
    expect(pastePath('/x/', 'file:///Users/me/plots', 3, 3).value).toBe('/Users/me/plots')
    // a relative piece is inserted where the caret is
    expect(pastePath('/project/', 'exp/users', 9, 9)).toEqual({ value: '/project/exp/users', caret: 18 })
  })
})

describe('what an agent is busy with', () => {
  it('says it in a few words', () => {
    expect(describeActivity({ kind: 'tool', tool: 'Bash', summary: 'python train.py' })).toBe('running python train.py')
    expect(describeActivity({ kind: 'tool', tool: 'Edit', summary: '/w/src/fit.py' })).toBe('editing fit.py')
    expect(describeActivity({ kind: 'tool', tool: 'Agent', summary: 'look around' })).toBe('running a subagent')
    expect(describeActivity({ kind: 'tool', tool: 'Grep' })).toBe('searching')
    expect(describeActivity({ kind: 'scheduled' })).toBe('waiting for its next check')
    expect(describeActivity({ kind: 'scheduled', at: 1000 + 600 }, 1000)).toMatch(/^next check \d\d:\d\d$/)
    expect(describeActivity({ kind: 'monitor', count: 1 })).toBe('watching a job')
    expect(describeActivity({ kind: 'jobs', count: 3 })).toBe('3 jobs running')
    // the sidebar's word or two
    expect(shortActivity({ kind: 'tool', tool: 'Bash', summary: 'python train.py' })).toBe('running')
    expect(shortActivity({ kind: 'tool', tool: 'WebSearch' })).toBe('searching')
    expect(shortActivity({ kind: 'scheduled', at: 1000 + 600 }, 1000)).toMatch(/^next \d\d:\d\d$/)
    expect(shortActivity({ kind: 'jobs', count: 2 })).toBe('2 jobs')
  })
})

describe('plot order', () => {
  it('shows PDFs first, then images, each in the order the reply mentions them', () => {
    const refs = extractMediaPaths('Done: plots/b.png, plots/a.pdf, plots/c.png and plots/z.pdf')
    const items = refs.map((path) => ({ path, kind: path.endsWith('.pdf') ? 'pdf' : 'image' }))
    expect(viewerOrder(items).map((it) => it.path)).toEqual(['plots/a.pdf', 'plots/z.pdf', 'plots/b.png', 'plots/c.png'])
  })
  it('puts Markdown after the plots', () => {
    const refs = extractMediaPaths('Wrote NOTES.md with plots/b.png and fit.pdf')
    const items = refs.map((path) => ({ path, kind: mediaKind(path)! }))
    expect(viewerOrder(items).map((it) => it.path)).toEqual(['fit.pdf', 'plots/b.png', 'NOTES.md'])
  })
})

describe('plots by reply', () => {
  it('takes a page made with the Artifact tool from its file path', () => {
    const p = new TranscriptParser()
    p.feed(JSON.stringify({ type: 'user', message: { content: 'make a dashboard' } }) + '\n')
    p.feed(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Artifact', input: { file_path: '/home/alice/.claude/jobs/x/tmp/fit.html', icon: 'chart' } }] }
      }) + '\n'
    )
    expect(p.details().mediaRefs).toEqual([{ path: '/home/alice/.claude/jobs/x/tmp/fit.html', turn: 1 }])
  })
  it("takes pages from replies and the pages it wrote, not every HTML file it read, edited or listed", () => {
    const p = new TranscriptParser()
    const feed = (o: object): void => p.feed(JSON.stringify(o) + '\n')
    const tool = (id: string, name: string, input: object): void =>
      feed({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input } ] } })
    feed({ type: 'user', message: { content: 'fix the site and plot it' } })
    tool('t1', 'Read', { file_path: '/w/src/index.html' })
    tool('t2', 'Edit', { file_path: '/w/src/index.html', old_string: 'a', new_string: 'b' })
    tool('t3', 'Bash', { command: 'find . -name "*.html" > list.txt; python plot.py' })
    feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: './a/x.html\n./b/y.html\nsaved out/m.png' }] } })
    tool('t4', 'Write', { file_path: '/w/out/report.html', content: '<img src="m.png">' })
    feed({ type: 'assistant', message: { content: [{ type: 'text', text: 'The dashboard is out/dash.html.' }] } })
    expect(p.details().mediaRefs.map((r) => r.path)).toEqual(['out/m.png', 'm.png', '/w/out/report.html', 'out/dash.html'])
  })
  it('remembers which reply mentioned each file last', () => {
    const p = new TranscriptParser()
    const feed = (o: object): void => p.feed(JSON.stringify(o) + '\n')
    const say = (text: string): void => feed({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
    feed({ type: 'user', message: { content: 'plot it' } })
    say('Saved plots/a.png and plots/b.pdf')
    feed({ type: 'user', message: { content: 'again' } })
    say('Updated plots/a.png')
    expect(p.details().mediaRefs).toEqual([
      { path: 'plots/b.pdf', turn: 1 },
      { path: 'plots/a.png', turn: 2 }
    ])
  })
})

describe('VS Code settings', () => {
  it('reads JSON with comments and trailing commas, leaving strings alone', () => {
    const text = `{
  // "editor.fontFamily": "Fira Code, Menlo for Powerline",
  "editor.fontFamily": "JetBrains Mono",
  /* block */ "editor.fontSize": 11,
  "http.proxy": "http://example.org//x", // not a comment inside a string
  "terminal.integrated.fontFamily": "'RobotoMono Nerd Font', 'PowerlineSymbols'",
}`
    expect(parseJsonc(text)).toEqual({
      'editor.fontFamily': 'JetBrains Mono',
      'editor.fontSize': 11,
      'http.proxy': 'http://example.org//x',
      'terminal.integrated.fontFamily': "'RobotoMono Nerd Font', 'PowerlineSymbols'"
    })
  })
})

describe('math in names', () => {
  it('splits $…$ from text', () => {
    expect(splitMath('$\\tau\\tau$ analysis')).toEqual([
      { text: '\\tau\\tau', math: true },
      { text: ' analysis', math: false }
    ])
    expect(splitMath('plain')).toEqual([{ text: 'plain', math: false }])
    // a lone dollar, an escaped one and an empty pair stay text
    expect(splitMath('costs $5')).toEqual([{ text: 'costs $5', math: false }])
    expect(splitMath('\\$HOME and $x$')).toEqual([
      { text: '$HOME and ', math: false },
      { text: 'x', math: true }
    ])
    expect(hasMath('a $$ b')).toBe(false)
    expect(hasMath('$H\\to\\gamma\\gamma$')).toBe(true)
  })

  it('reads as plain text where markup cannot go', () => {
    expect(texToText('$\\tau\\tau$ analysis')).toBe('ττ analysis')
    expect(texToText('$HH\\to b\\bar{b}\\tau^+\\tau^-$')).toBe('HH → bb̄τ⁺τ⁻')
    expect(texToText('$t\\bar{t}H$, $m_{\\gamma\\gamma}$')).toBe('tt̄H, m_γγ')
    expect(texToText('$\\mathrm{ZZ}^*$ at $\\sqrt{s}=13.6$ TeV')).toBe('ZZ* at √s=13.6 TeV')
    expect(texToText('$x_1^2$')).toBe('x₁²')
  })
})

describe('typing /compact', () => {
  const idle = { key: 'h::a', id: 'a', kind: 'tmux', host: 'h', cwd: '', createdAt: 0, status: 'idle', attnTs: 0, activityTs: 0, attached: false, alive: true, transcriptSize: 0 } as const
  it('waits for an idle agent', () => {
    expect(compactBlocker(idle)).toBeUndefined()
    expect(compactBlocker({ ...idle, status: 'unknown' })).toBeUndefined()
    expect(compactBlocker({ ...idle, status: 'working' })).toMatch(/middle of a turn/)
    expect(compactBlocker({ ...idle, status: 'waiting' })).toMatch(/waiting for you/)
    expect(compactBlocker({ ...idle, status: 'starting' })).toMatch(/starting/)
    expect(compactBlocker({ ...idle, alive: false, status: 'exited' })).toMatch(/exited/)
    // a background session that is not running comes back when its tab opens
    expect(compactBlocker({ ...idle, kind: 'claude', alive: false, status: 'exited' })).toBeUndefined()
  })

  it('finds the input box under a running turn', () => {
    const rule = '─'.repeat(40)
    expect(hasInputBox(['✳ Thinking… (3s)', rule, '❯ ', rule])).toBe(true)
    expect(hasInputBox(['Do you want to proceed?', '❯ 1. Yes'])).toBe(false)
  })

  it('reads the bottom of a Claude Code screen', () => {
    const rule = '─'.repeat(60)
    const box = (prompt: string, footer = '  ⏵⏵ auto mode on (shift+tab to cycle)'): string[] => ['● Done.', '', rule, prompt, rule, footer, '', '']
    expect(screenState(box('❯ Try "fix lint errors"'))).toBe('input')
    expect(screenState(box('❯ '))).toBe('input')
    expect(screenState(['╭' + rule + '╮', '│ > │', '╰' + rule + '╯'])).toBe('input')
    expect(screenState(['✳ Blanching… (7s · ↓ 1.2k tokens)', ...box('❯ ')])).toBe('busy')
    expect(screenState(['Do you want to make this edit?', '❯ 1. Yes', '  2. No', 'Esc to cancel'])).toBe('question')
    expect(screenState(['[kuna] connecting to cluster1…', 'Last login: Tue Oct 20'])).toBe('unknown')
  })

  it('tells a panel Esc closes from a running turn', () => {
    const rule = '─'.repeat(60)
    // /config as Claude Code 2.1 draws it: its search box and ❯ look like an input box
    const config = (footer: string): string[] => [
      '  Settings  Status   Config   Usage',
      '  ╭' + rule + '╮',
      '  │ ⌕ Search settings…  │',
      '  ╰' + rule + '╯',
      '  ❯ Auto-compact                                true',
      '    Verbose output                              false',
      '    ↓ 26 more',
      footer
    ]
    expect(screenState(config('  Type to filter · Enter/↓ to select · ↑ to tabs · Esc to clear'))).toBe('menu')
    expect(screenState(config('  Enter/Space to change · / to search · Esc to close'))).toBe('menu')
    expect(screenState(['  Current session', '  ██████ 12% used', 'Press Esc to go back'])).toBe('menu')
    // opened mid-turn, over the spinner
    expect(screenState(['✳ Blanching… (7s · ↓ 1.2k tokens · esc to interrupt)', ...config('  Esc to close')])).toBe('menu')
    // the spinner's own hint is a running turn, and a reply that names the key is not a panel
    expect(screenState(['✳ Blanching… (7s · esc to interrupt)', rule, '❯ ', rule])).toBe('busy')
    expect(screenState(['● Press the Esc key to close the viewer.', rule, '❯ ', rule, '  ? for shortcuts'])).toBe('input')
  })
})

describe('TranscriptParser', () => {
  const lines = [
    { type: 'permission-mode', permissionMode: 'plan' },
    { type: 'user', message: { role: 'user', content: 'make the mass plot' }, timestamp: 't1' },
    {
      type: 'assistant',
      message: {
        id: 'm1',
        model: 'claude-opus-5-5',
        usage: { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000, output_tokens: 50 },
        content: [
          { type: 'text', text: 'Plotting now.' },
          { type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'Plot', status: 'in_progress' }] } },
          { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'python plot.py', description: 'Make plot' } },
          { type: 'tool_use', id: 't3', name: 'Agent', input: { description: 'Review code', subagent_type: 'reviewer' } }
        ]
      }
    },
    {
      type: 'assistant',
      message: { id: 'm1', usage: { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000, output_tokens: 80 }, content: [] }
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't2', content: 'Saved figure to out/mass.pdf' },
          { type: 'tool_result', tool_use_id: 't3', content: [{ type: 'text', text: 'done' }] }
        ]
      }
    },
    { type: 'ai-title', aiTitle: 'Mass plot' },
    { type: 'assistant', isSidechain: true, message: { id: 'x', usage: { input_tokens: 999999 }, content: [] } }
  ]

  it('summarises a session incrementally, across chunk boundaries', () => {
    const p = new TranscriptParser()
    const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
    p.feed(text.slice(0, 333))
    p.feed(text.slice(333))
    const d = p.details()
    expect(d.title).toBe('Mass plot')
    expect(d.model).toBe('claude-opus-5-5')
    expect(d.permissionMode).toBe('plan')
    expect(d.contextTokens).toBe(6010)
    expect(d.outputTokens).toBe(80)
    expect(d.todos).toEqual([{ id: '0', content: 'Plot', status: 'in_progress', activeForm: undefined }])
    expect(d.recentTools.map((t) => [t.name, t.done])).toEqual([
      ['TodoWrite', false],
      ['Bash', true],
      ['Agent', true]
    ])
    expect(d.subagents[0]).toMatchObject({ description: 'Review code', type: 'reviewer', done: true })
    expect(d.mediaRefs).toEqual([{ path: 'out/mass.pdf', turn: 1 }])
    expect(d.lastPrompt).toBe('make the mass plot')
  })

  it('tracks TaskCreate / TaskUpdate tasks', () => {
    const p = new TranscriptParser()
    const feed = (o: object): void => p.feed(JSON.stringify(o) + '\n')
    feed({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u1', name: 'TaskCreate', input: { subject: 'Write docs' } }] } })
    feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'Task #4 created successfully' }] } })
    feed({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u2', name: 'TaskUpdate', input: { taskId: '4', status: 'completed' } }] } })
    expect(p.details().todos).toMatchObject([{ id: '4', content: 'Write docs', status: 'completed' }])
  })

  it('drops the partial first line when starting mid-file', () => {
    const p = new TranscriptParser()
    p.feed('tle":"cut"}\n{"type":"ai-title","aiTitle":"Whole"}\n', true)
    expect(p.details().title).toBe('Whole')
  })
})

describe('plan usage', () => {
  it('reads the status line rate_limits shape', () => {
    expect(parseRateLimits('{"five_hour":{"used_percentage":23.5,"resets_at":1738425600},"seven_day":{"used_percentage":41.2,"resets_at":1738857600}}')).toEqual({
      fiveHour: { usedPct: 23.5, resetsAt: 1738425600 },
      sevenDay: { usedPct: 41.2, resetsAt: 1738857600 }
    })
  })
  it('accepts utilization + ISO reset times and missing windows', () => {
    expect(parseRateLimits('{"seven_day":{"utilization":10,"resets_at":"2025-02-06T16:00:00Z"}}')).toEqual({
      fiveHour: undefined,
      sevenDay: { usedPct: 10, resetsAt: 1738857600 }
    })
    expect(parseRateLimits('{}')).toBeUndefined()
    expect(parseRateLimits('nope')).toBeUndefined()
  })
  it('comes through the watch frame', () => {
    const f = parseFrame(['U\t1700000000\t{"five_hour":{"used_percentage":5,"resets_at":1700001000}}'], 1700000001)
    expect(f.usage).toEqual({ ts: 1700000000, fiveHour: { usedPct: 5, resetsAt: 1700001000 }, sevenDay: undefined })
  })
})

describe('validate', () => {
  it('accepts hosts that ssh reads as hosts', () => {
    expect(isHostId('local')).toBe(true)
    expect(isHostId('cluster1')).toBe(true)
    expect(isHostId('alice@login1.example.org')).toBe(true)
    expect(isHostId('-oProxyCommand=touch /tmp/x')).toBe(false)
    expect(isHostId('host name')).toBe(false)
    expect(isHostId('host\nx')).toBe(false)
    expect(isHostId('')).toBe(false)
    expect(isHostId(7)).toBe(false)
  })
  it('accepts agent ids and nothing that walks paths', () => {
    expect(isAgentId('1e3b4c75')).toBe(true)
    expect(isAgentId('cc-a0000002')).toBe(true)
    expect(isAgentId('../../Documents')).toBe(false)
    expect(isAgentId('')).toBe(false)
    expect(isAgentId('a b')).toBe(false)
  })
  it('splits agent keys only when both parts are sound', () => {
    expect(splitAgentKey('cluster1::1e3b4c75')).toEqual({ host: 'cluster1', id: '1e3b4c75' })
    expect(splitAgentKey('local::cc-a0000002')).toEqual({ host: 'local', id: 'cc-a0000002' })
    expect(splitAgentKey('local::../../Documents')).toBeNull()
    expect(splitAgentKey('host::')).toBeNull()
    expect(splitAgentKey('-oProxyCommand=x::1e3b4c75')).toBeNull()
    expect(splitAgentKey('no-separator')).toBeNull()
  })
  it('allows only plain tmux keys and leaving scroll mode', () => {
    expect(isTmuxKeys(['Escape'])).toBe(true)
    expect(isTmuxKeys(['-X', 'cancel'])).toBe(true)
    expect(isTmuxKeys(['C-u', 'Enter'])).toBe(true)
    expect(isTmuxKeys(['-t', 'kuna_other', 'Enter'])).toBe(false)
    expect(isTmuxKeys(['-l', 'rm -rf ~'])).toBe(false)
    expect(isTmuxKeys(['-X', 'copy-pipe', 'sh'])).toBe(false)
    expect(isTmuxKeys([])).toBe(false)
  })
})

describe('windows', () => {
  const at = (id: number, x: number, y: number, opened = id) => ({ id, bounds: { x, y, width: 800, height: 600 }, opened })

  it('orders windows left to right, then top to bottom, then by when they opened', () => {
    expect(windowOrder([at(1, 900, 0), at(2, 0, 0)])).toEqual([2, 1])
    expect(windowOrder([at(1, 0, 500), at(2, 0, 0)])).toEqual([2, 1])
    // two full-screen windows, each on its own Space
    expect(windowOrder([at(2, 0, 0, 5), at(1, 0, 0, 3)])).toEqual([1, 2])
  })

  it('steps to the next or previous window, wrapping around', () => {
    expect(stepWindow([2, 1, 3], 1, 1)).toBe(3)
    expect(stepWindow([2, 1, 3], 3, 1)).toBe(2)
    expect(stepWindow([2, 1, 3], 2, -1)).toBe(3)
    // with two windows either way is the other one
    expect(stepWindow([1, 2], 1, -1)).toBe(2)
    expect(stepWindow([1], 1, 1)).toBeNull()
    expect(stepWindow([1, 2], 7, 1)).toBeNull()
  })

  it('cascades a new window, back to the top left when it would run off the screen', () => {
    const area = { x: 0, y: 25, width: 1920, height: 1055 }
    expect(cascade({ x: 100, y: 100, width: 1200, height: 800 }, area)).toEqual({ x: 128, y: 128, width: 1200, height: 800 })
    expect(cascade({ x: 600, y: 200, width: 1300, height: 800 }, area)).toEqual({ x: 0, y: 25, width: 1300, height: 800 })
    expect(cascade({ x: 0, y: 25, width: 3000, height: 800 }, area).width).toBe(1920)
  })

  it('puts a saved window back unless its screen is gone', () => {
    const main = { x: 0, y: 25, width: 1920, height: 1055 }
    const right = { x: 1920, y: 0, width: 2560, height: 1415 }
    const saved = { x: 2100, y: 100, width: 1600, height: 1000 }
    expect(placeOnScreen(saved, [main, right], main)).toEqual(saved)
    // the second display was unplugged: centred on the main one
    expect(placeOnScreen(saved, [main], main)).toEqual({ x: 160, y: 53, width: 1600, height: 1000 })
    // its top edge above the screen can't be dragged
    expect(placeOnScreen({ ...saved, x: 100, y: -400 }, [main], main).y).toBe(53)
  })
})

describe('shared state between windows', () => {
  const base: SharedState = {
    projects: [],
    settings: { theme: 'cherenkov', inspector: true, sidebarWidth: 280, notify: true },
    lastSeen: { 'local::a': 10, 'local::b': 20 },
    hostnames: {},
    hidden: {},
    names: { 'local::a': 'fit' }
  }

  it('sends records key by key and the projects whole', () => {
    expect(diffShared(base, { ...base })).toBeNull()
    const projects = [{ id: 'p', name: 'P', host: 'local', color: '#fff', agentCommand: 'claude', folders: [] }]
    const next = { ...base, projects, lastSeen: { 'local::a': 10, 'local::c': 30 }, settings: { ...base.settings, termFontSize: 14 } }
    expect(diffShared(base, next)).toEqual({
      projects,
      lastSeen: { set: { 'local::c': 30 }, del: ['local::b'] },
      settings: { set: { termFontSize: 14 } }
    })
  })

  it('keeps what another window changed meanwhile', () => {
    // this window marked a seen; the other one, meanwhile, b
    const here = diffShared(base, { ...base, lastSeen: { ...base.lastSeen, 'local::a': 50 } })!
    const there = { ...base, lastSeen: { ...base.lastSeen, 'local::b': 60 } }
    expect(applyPatch(there, here).lastSeen).toEqual({ 'local::a': 50, 'local::b': 60 })
    // fields the patch leaves alone stay the same objects
    expect(applyPatch(there, here).names).toBe(there.names)
  })

  it('merges patches in order', () => {
    const a = { names: { set: { 'local::x': 'one' }, del: ['local::a'] } }
    const b = { names: { set: { 'local::a': 'back' }, del: ['local::x'] } }
    expect(mergePatch(a, b)).toEqual({ names: { set: { 'local::a': 'back' }, del: ['local::x'] } })
    const merged = mergePatch(a, b)
    expect(applyPatch(base, merged).names).toEqual(applyPatch(applyPatch(base, a), b).names)
  })
})

describe('review: git output', () => {
  it('splits sections and parses name-status with renames and numstat', () => {
    const text = '\x1ebase\x1eabc\n\x1etip\x1edef\n\x1efiles\x1eD\0gone.txt\0R100\0move.txt\0moved.txt\0A\0sp ace.txt\0M\0src/a.txt\0\x1ecounts\x1e0\t1\tgone.txt\x000\t0\t\0move.txt\0moved.txt\x001\t0\tsp ace.txt\x00-\t-\tsrc/a.txt\0\x1ecommits\x1eabc123\tabc1\tAlice\t1700000000\tfix: a\ttab\0'
    const c = parseCompare(text, 'main', 'feat')
    expect(c.mergeBase).toBe('abc')
    expect(c.tip).toBe('def')
    expect(c.files.map((f) => [f.kind, f.path, f.oldPath])).toEqual([
      ['M', 'src/a.txt', undefined],
      ['D', 'gone.txt', undefined],
      ['R', 'moved.txt', 'move.txt'],
      ['A', 'sp ace.txt', undefined]
    ])
    expect(c.files.find((f) => f.path === 'moved.txt')).toMatchObject({ added: 0, removed: 0 })
    expect(c.files.find((f) => f.path === 'src/a.txt')).toMatchObject({ binary: true })
    expect(c.commits).toEqual([{ sha: 'abc123', short: 'abc1', author: 'Alice', time: 1700000000, subject: 'fix: a\ttab' }])
  })

  it('adds untracked files when comparing with the working tree', () => {
    const c = parseCompare('\x1ebase\x1ea\n\x1efiles\x1eM\0x.py\0\x1euntracked\x1enew.py\0x.py\0', 'main', null)
    expect(c.files.map((f) => `${f.kind} ${f.path}`)).toEqual(['? new.py', 'M x.py'])
  })

  it('reads status in VS Code groups', () => {
    const st = parseStatus({
      staged: 'M\0staged.ts\0M\0both.ts\0R100\0old.ts\0new.ts\0U\0clash.ts\0',
      stagedcounts: '3\t1\tstaged.ts\x001\t1\tboth.ts\x000\t0\t\0old.ts\0new.ts\0',
      unstaged: 'M\0work.ts\0M\0both.ts\0D\0gone.ts\0M\0touched.ts\0U\0clash.ts\0',
      unstagedcounts: '2\t0\twork.ts\x001\t0\tboth.ts\x000\t3\tgone.ts\x000\t0\ttouched.ts\0',
      untracked: 'un.txt\0vendor/lib/\0'
    })
    expect(st.staged.map((f) => `${f.kind} ${f.path}${f.oldPath ? ` <- ${f.oldPath}` : ''}`)).toEqual(['M both.ts', 'R new.ts <- old.ts', 'M staged.ts'])
    // a file only touched (its stat changed, not its content) is not a change; a nested repository is not a file
    expect(st.unstaged.map((f) => `${f.kind} ${f.path}`)).toEqual(['M both.ts', 'D gone.ts', 'M work.ts'])
    expect(st.untracked.map((f) => f.path)).toEqual(['un.txt'])
    expect(st.conflicts.map((f) => f.path)).toEqual(['clash.ts'])
    expect(st.staged.find((f) => f.path === 'staged.ts')).toMatchObject({ added: 3, removed: 1 })
    expect(st.unstaged.find((f) => f.path === 'work.ts')).toMatchObject({ added: 2, removed: 0 })
  })

  it('reads branches, the default branch and worktrees', () => {
    const info = parseInfo(
      '\x1einfo\x1eroot\t/r\nbranch\tfeat\nhead\tabc\ndefault\torigin/main\nupstream\t\n' +
        '\x1erefs\x1erefs/heads/feat\tabc\t1700000100 +0100\twork\nrefs/heads/main\tdef\t1700000000 +0100\tinit\nrefs/remotes/origin/HEAD\tdef\t1 +0000\tx\nrefs/remotes/origin/main\tdef\t1700000000 +0000\tinit\nrefs/tags/v1\tdef\t1 +0000\tt\n' +
        '\x1eworktrees\x1eworktree /r\nHEAD abc\nbranch refs/heads/feat\n\nworktree /r/.claude/worktrees/x\nHEAD 123\ndetached\n\n'
    )
    expect(info).toMatchObject({ root: '/r', branch: 'feat', head: 'abc', defaultBranch: 'origin/main', upstream: undefined })
    expect(info.refs.map((r) => `${r.kind}:${r.short}`)).toEqual(['branch:feat', 'branch:main', 'remote:origin/main', 'tag:v1'])
    expect(info.worktrees).toEqual([
      { path: '/r', head: 'abc', branch: 'feat' },
      { path: '/r/.claude/worktrees/x', head: '123' }
    ])
    expect(defaultBase(info)).toBe('origin/main')
  })

  it('lists repositories below a folder, the one worked in last first', () => {
    const r = parseRepos('/w/ana\tfeat\tabc1234\t1700000000\t1700000500\n/w/tools\tmain\tdef5678\t1700001000\t0\n/w/new\t\t\t\t0\nnoise\n')
    expect(r.map((x) => x.path)).toEqual(['/w/tools', '/w/ana', '/w/new'])
    expect(r[1]).toEqual({ path: '/w/ana', branch: 'feat', head: 'abc1234', active: 1700000500 })
    expect(r[2]).toEqual({ path: '/w/new', branch: undefined, head: undefined, active: 0 })
    expect(repoLabel('/w/ana/src/x', '/w/')).toBe('ana/src/x')
    expect(repoLabel('/w', '/w/ana')).toBe('w')
  })

  it('reads a folder listing from GNU or BSD stat, folders first', () => {
    const gnu = parseDirListing('directory\t4096\t1700000000\t./run\nregular file\t12\t1700000100\t./b.yaml\nregular empty file\t0\t1700000200\t./a.txt\n')
    expect(gnu.entries.map((e) => `${e.dir ? 'd' : 'f'} ${e.name}`)).toEqual(['d run', 'f a.txt', 'f b.yaml'])
    expect(gnu.entries[2]).toEqual({ name: 'b.yaml', dir: false, size: 12, mtime: 1700000100 })
    const bsd = parseDirListing('more 4000\nDirectory\t64\t1\t./out\nRegular File\t3\t2\t./x\ty.txt\n')
    expect(bsd.more).toBe(4000)
    expect(bsd.entries.map((e) => e.name)).toEqual(['out', 'x\ty.txt'])
  })

  it('picks a base as a pull request would', () => {
    const ref = (short: string): GitRef => ({ name: '', short, kind: short.includes('/') ? 'remote' : 'branch', sha: '', time: 0, subject: '' })
    const info = (branch: string | undefined, refs: string[], def?: string, upstream?: string): GitInfo => ({ root: '/r', branch, defaultBranch: def, upstream, refs: refs.map(ref), worktrees: [] })
    expect(defaultBase(info('feat', ['feat', 'main']))).toBe('main')
    expect(defaultBase(info('feat', ['feat', 'master']))).toBe('master')
    // on main itself: what is not pushed yet
    expect(defaultBase(info('main', ['main', 'origin/main'], 'origin/main'))).toBe('origin/main')
    expect(defaultBase(info('dev', ['dev', 'trunk', 'origin/trunk'], 'origin/trunk'))).toBe('origin/trunk')
    expect(defaultBase(info('main', ['main']))).toBe('main')
  })

  it('reads blobs by size, missing ones and ones too large', () => {
    const enc = new TextEncoder()
    const buf = new Uint8Array([...enc.encode('\x1e3\x1e'), 0x1e, 0, 0x41, ...enc.encode('\x1e-\x1e\x1e+999\x1e\x1e0\x1e\x1e2\x1eok')])
    const b = parseBlobs(buf, 100)
    expect(b).toHaveLength(5)
    expect([...b[0].data!]).toEqual([0x1e, 0, 0x41])
    expect(b[1]).toEqual({ size: 0, missing: true })
    expect(b[2]).toEqual({ size: 999, tooBig: true })
    expect(b[3].data).toHaveLength(0)
    expect(new TextDecoder().decode(b[4].data)).toBe('ok')
    expect(looksBinary(b[0].data!)).toBe(true)
  })

  it('keeps the file cache bounded, dropping what was looked at longest ago but never the file shown', () => {
    const blob = (n: number) => ({ size: n, data: new Uint8Array(n) })
    const cache = new Map([['a', blob(4)], ['b', blob(4)], ['c', blob(4)]])
    // a was cached long ago: shown again, it is the newest, and b goes first
    cache.set('d', blob(4))
    touchCache(cache, ['d', 'a'], 12, 400)
    expect([...cache.keys()]).toEqual(['c', 'd', 'a'])
    // too many files: down to the limit
    touchCache(cache, [], 1000, 1)
    expect([...cache.keys()]).toEqual(['a'])
    // one file larger than the whole cache still stays while it is shown
    cache.set('big', blob(50))
    touchCache(cache, ['big'], 10, 400)
    expect([...cache.keys()]).toEqual(['big'])
  })

  it('only lets names and repository paths through', () => {
    for (const ok of ['main', 'origin/feat-x', 'v1.2', 'abc123^', 'HEAD~2', 'a@b', 'issue#12', 'feature/überarbeitung', 'fix!', 'a,b']) expect(validRef(ok)).toBe(true)
    for (const bad of ['', '-x', '--output=/tmp/x', 'a..b', 'a b', 'a\tb', 'a\nb', 'HEAD:secret', 'a\\b']) expect(validRef(bad)).toBe(false)
    expect(isSha('0123456789abcdef0123456789abcdef01234567')).toBe(true)
    expect(isSha('HEAD')).toBe(false)
    expect(validRepoPath('src/a.ts')).toBe(true)
    expect(validRepoPath('a/../../etc')).toBe(false)
    expect(validRepoPath('/etc/passwd')).toBe(false)
    expect(specOf({ kind: 'rev', rev: 'abc', path: 'a b.ts' })).toBe('Gabc:a b.ts')
    expect(specOf({ kind: 'index', path: 'x' })).toBe('Ix')
    expect(specOf({ kind: 'worktree', path: 'x' })).toBe('Wx')
    expect(specOf({ kind: 'empty' })).toBeNull()
  })

  it('builds a tree with compact folders, folders first', () => {
    const t = buildTree(['src/main/remote/kuna.sh', 'src/main/git.ts', 'README.md', 'docs/a.md'], (p) => p)
    expect(t.dirs.map((d) => d.name)).toEqual(['docs', 'src/main'])
    expect(t.dirs[1].dirs.map((d) => d.name)).toEqual(['remote'])
    expect(t.dirs[1].files.map((f) => f.name)).toEqual(['git.ts'])
    expect(t.files.map((f) => f.name)).toEqual(['README.md'])
    expect(comparePaths('src/z/a.ts', 'src/b.ts')).toBeLessThan(0)
  })

  it('writes the review for the agent', () => {
    const on = { anchor: 'cmp:main...feat', context: '`feat` compared with `main`' }
    const msg = reviewMessage([
      { id: '2', path: 'src/b.ts', side: 'new', start: 7, end: 7, text: 'Name this better', code: ['const x = 1'], ...on },
      { id: '1', path: 'src/a.ts', side: 'old', start: 3, end: 5, text: 'Why remove this?\nIt was needed', code: ['a', 'b', 'c'], ...on }
    ])
    expect(msg).toBe(
      [
        'Review comments on `feat` compared with `main`. Please address each one:',
        '',
        '1. src/a.ts:3-5 (removed lines, as they were before the change)',
        '   ```',
        '   a',
        '   b',
        '   c',
        '   ```',
        '   Why remove this?',
        '   It was needed',
        '',
        '2. src/b.ts:7',
        '   ```',
        '   const x = 1',
        '   ```',
        '   Name this better'
      ].join('\n')
    )
  })

  it('says which diff each comment is on when they differ', () => {
    const msg = reviewMessage([
      { id: '1', path: 'a.ts', side: 'new', start: 1, end: 1, text: 'x', code: [], anchor: 'cmp:main...feat', context: '`feat` compared with `main`' },
      { id: '2', path: 'b.ts', side: 'new', start: 2, end: 2, text: 'y', code: [], anchor: 'l:s', context: 'the staged changes' }
    ])
    expect(msg.split('\n').slice(0, 5)).toEqual([
      'Review comments. Please address each one:',
      '',
      '1. a.ts:1 (in `feat` compared with `main`)',
      '   x',
      ''
    ])
    expect(msg).toContain('2. b.ts:2 (in the staged changes)')
  })
})

describe('review: the VS Code look', () => {
  const langs: LanguageInfo[] = [
    { id: 'typescript', extensions: ['.ts'], filenames: [] },
    { id: 'typescriptreact', extensions: ['.tsx'], filenames: [] },
    { id: 'makefile', extensions: ['.mk'], filenames: ['Makefile'] },
    { id: 'dts', extensions: ['.d.ts'], filenames: [] }
  ]

  it('finds a file language as VS Code does', () => {
    expect(languageOf('src/a.ts', langs)).toBe('typescript')
    expect(languageOf('src/A.TSX', langs)).toBe('typescriptreact')
    expect(languageOf('x/Makefile', langs)).toBe('makefile')
    expect(languageOf('types/x.d.ts', langs)).toBe('dts')
    expect(languageOf('a.C', langs, { '*.C': 'cpp' })).toBe('cpp')
    expect(languageOf('a.unknown', langs)).toBeUndefined()
  })

  it('finds icons: name, then longest extension, then language', () => {
    const t: IconTheme = {
      id: 'm',
      file: 'file',
      folder: 'folder',
      folderExpanded: 'folder-open',
      fileNames: { 'package.json': 'npm' },
      fileExtensions: { ts: 'ts', 'test.ts': 'test' },
      folderNames: { src: 'folder-src' },
      folderNamesExpanded: { src: 'folder-src-open' },
      languageIds: { makefile: 'make' }
    }
    expect(fileIcon(t, 'a/package.json')).toBe('npm')
    expect(fileIcon(t, 'a/x.test.ts')).toBe('test')
    expect(fileIcon(t, 'a/x.ts')).toBe('ts')
    expect(fileIcon(t, 'Makefile', 'makefile')).toBe('make')
    expect(fileIcon(t, 'x.zzz')).toBe('file')
    expect(folderIcon(t, 'a/src', false)).toBe('folder-src')
    expect(folderIcon(t, 'a/src', true)).toBe('folder-src-open')
    expect(folderIcon(t, 'a/lib', true)).toBe('folder-open')
  })

  it('reads editor settings with VS Code defaults', () => {
    const e = editorPrefs({ 'editor.fontFamily': 'JetBrains Mono', 'editor.fontSize': 11, 'editor.fontLigatures': true, 'editor.lineHeight': 1.5, 'editor.minimap.enabled': false, 'editor.wordWrap': 'on' })
    expect(e).toMatchObject({ fontFamily: 'JetBrains Mono', fontSize: 11, fontLigatures: true, lineHeight: 17, minimap: false, wordWrap: 'on', renderSideBySide: true, ignoreTrimWhitespace: true })
    expect(editorPrefs({ 'editor.wordWrap': 'nonsense' }).wordWrap).toBe('off')
  })

  it('applies colour customizations, global and for the theme', () => {
    const theme: VscodeTheme = { name: 'GitHub Dark Default', type: 'dark', colors: { 'editor.background': '#000', a: '#1' }, tokenColors: [] }
    const t = customize(theme, { a: '#2', '[GitHub Dark Default]': { 'editor.background': '#111' }, '[Other]': { a: '#3' } }, { comments: '#888', textMateRules: [{ scope: 'x', settings: { foreground: '#f00' } }] })
    expect(t.colors).toEqual({ 'editor.background': '#111', a: '#2' })
    expect(t.tokenColors).toEqual([
      { scope: 'comment', settings: { foreground: '#888' } },
      { scope: 'x', settings: { foreground: '#f00' } }
    ])
  })
})

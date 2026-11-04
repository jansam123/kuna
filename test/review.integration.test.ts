import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseBlobs, parseCompare, parseDirListing, parseInfo, parseRepos, parseStatus, repoLabel, sections, specOf, type GitSide } from '@shared/git'

/**
 * The review view's git, end to end on the host side: `kuna git …` from the
 * real helper script on a throwaway repository, parsed as the app parses it.
 */
const hasGit = (() => {
  try {
    execFileSync('git', ['--version'])
    return true
  } catch {
    return false
  }
})()

const SCRIPT = resolve(__dirname, '../src/main/remote/kuna.sh')
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
let repo: string
let home: string

/** KUNA_TEST_SH=dash runs the helper in a strictly POSIX shell, as on many cluster nodes */
function kuna(...args: string[]): Buffer {
  return execFileSync(process.env.KUNA_TEST_SH || 'sh', [SCRIPT, 'git', ...args], { env: { ...process.env, HOME: home }, maxBuffer: 64 * 1024 * 1024 })
}

function sh(cmd: string): void {
  execFileSync('sh', ['-c', cmd], { cwd: repo, env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'ignore' })
}

describe.skipIf(!hasGit)('review: kuna git on a repository', () => {
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'kuna-review-home-'))
    repo = join(home, 'repo')
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true })
    sh('git init -q . && git checkout -q -b main && git config user.email t@example.org && git config user.name T')
    writeFileSync(join(repo, 'src/a.txt'), 'a\nb\nc\n')
    writeFileSync(join(repo, 'gone.txt'), 'old\n')
    writeFileSync(join(repo, 'move.txt'), 'mv\nme\nplease\n')
    writeFileSync(join(repo, 'src/deep/x.py'), 'x = 1\n')
    sh('git add -A && git commit -q -m first && git checkout -q -b feat')
    writeFileSync(join(repo, 'src/a.txt'), 'a\nB\nc\nd\n')
    writeFileSync(join(repo, 'sp ace.txt'), 'new\n')
    writeFileSync(join(repo, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]))
    sh('git rm -q gone.txt && git mv move.txt moved.txt && git add -A && git commit -q -m "second: change"')
    // and uncommitted work on top
    writeFileSync(join(repo, 'src/deep/x.py'), 'x = 2\n')
    sh('git add src/deep/x.py')
    writeFileSync(join(repo, 'src/a.txt'), 'a\nB\nc\nd\ne\n')
    writeFileSync(join(repo, 'un.txt'), 'untracked\n')
  })

  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it('tells the branches and what is uncommitted, from a subfolder', () => {
    const dir = b64(join(repo, 'src'))
    const info = parseInfo(kuna('info', dir).toString())
    expect(info.root.endsWith('/repo')).toBe(true)
    expect(info.branch).toBe('feat')
    expect(info.upstream).toBeUndefined()
    expect(info.refs.map((r) => r.short).sort()).toEqual(['feat', 'main'])
    expect(info.worktrees[0].branch).toBe('feat')
    const st = parseStatus(sections(kuna('status', dir).toString()))
    expect(st.staged.map((f) => `${f.kind} ${f.path}`)).toEqual(['M src/deep/x.py'])
    expect(st.unstaged.map((f) => `${f.kind} ${f.path}`)).toEqual(['M src/a.txt'])
    expect(st.untracked.map((f) => f.path)).toEqual(['un.txt'])
  })

  it('compares a branch with its base as a pull request does', () => {
    const c = parseCompare(kuna('compare', b64(repo), b64('main'), b64('feat')).toString(), 'main', 'feat')
    expect(c.files.map((f) => `${f.kind} ${f.path}${f.oldPath ? ` <- ${f.oldPath}` : ''}`)).toEqual([
      'M src/a.txt',
      'D gone.txt',
      'R moved.txt <- move.txt',
      'A pic.png',
      'A sp ace.txt'
    ])
    expect(c.files.find((f) => f.path === 'src/a.txt')).toMatchObject({ added: 2, removed: 1 })
    expect(c.files.find((f) => f.path === 'pic.png')?.binary).toBe(true)
    expect(c.commits.map((k) => k.subject)).toEqual(['second: change'])

    // the working tree: uncommitted changes and new files too
    const w = parseCompare(kuna('compare', b64(repo), b64('main'), '').toString(), 'main', null)
    expect(w.files.map((f) => f.path)).toEqual(['src/deep/x.py', 'src/a.txt', 'gone.txt', 'moved.txt', 'pic.png', 'sp ace.txt', 'un.txt'])
    expect(w.files.find((f) => f.path === 'src/a.txt')).toMatchObject({ added: 3, removed: 1 })
  })

  it('reads both sides of a diff: a commit, the index, the disk', () => {
    const c = parseCompare(kuna('compare', b64(repo), b64('main'), b64('feat')).toString(), 'main', 'feat')
    const sides: GitSide[] = [
      { kind: 'rev', rev: c.mergeBase, path: 'src/a.txt' },
      { kind: 'index', path: 'src/deep/x.py' },
      { kind: 'worktree', path: 'sp ace.txt' },
      { kind: 'rev', rev: c.tip, path: 'pic.png' },
      { kind: 'worktree', path: 'nope.txt' }
    ]
    const out = kuna('cat', b64(repo), '1000', ...sides.map((s) => b64(specOf(s)!)))
    const blobs = parseBlobs(out, 1000)
    const text = (i: number): string => new TextDecoder().decode(blobs[i].data)
    expect(text(0)).toBe('a\nb\nc\n')
    expect(text(1)).toBe('x = 2\n')
    expect(text(2)).toBe('new\n')
    expect([...blobs[3].data!]).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 1, 2])
    expect(blobs[4]).toEqual({ size: 0, missing: true })
    // too large: the size only
    expect(parseBlobs(kuna('cat', b64(repo), '2', b64('Wsp ace.txt')), 2)).toEqual([{ size: 4, tooBig: true }])
  })

  it('lists every file, on disk or at a commit', () => {
    const disk = kuna('files', b64(repo), '').toString().split('\0').filter(Boolean).sort()
    expect(disk).toEqual(['moved.txt', 'pic.png', 'sp ace.txt', 'src/a.txt', 'src/deep/x.py', 'un.txt'])
    const main = kuna('files', b64(repo), b64('main')).toString().split('\0').filter(Boolean).sort()
    expect(main).toEqual(['gone.txt', 'move.txt', 'src/a.txt', 'src/deep/x.py'])
  })

  it('shows the first commit on its own (its parent: nothing)', () => {
    const first = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: repo }).toString().trim()
    const c = parseCompare(kuna('compare', b64(repo), b64(`${first}^`), b64(first)).toString(), `${first}^`, first)
    expect(c.files.map((f) => `${f.kind} ${f.path}`)).toEqual(['A src/deep/x.py', 'A src/a.txt', 'A gone.txt', 'A move.txt'])
    expect(c.commits.map((k) => k.subject)).toEqual(['first'])
  })

  it('keeps the framing whatever the files are called or are', () => {
    writeFileSync(join(repo, '-'), 'dash\n')
    writeFileSync(join(repo, '-n'), 'opt\n')
    symlinkSync(join(home, 'outside.txt'), join(repo, 'link'))
    writeFileSync(join(home, 'outside.txt'), 'SECRET')
    const specs = ['W-', 'W-n', 'Wlink', 'Gfeat:src', 'Wsp ace.txt']
    const blobs = parseBlobs(kuna('cat', b64(repo), '1000', ...specs.map(b64)), 1000)
    const text = (i: number): string => new TextDecoder().decode(blobs[i].data)
    expect(text(0)).toBe('dash\n')
    expect(text(1)).toBe('opt\n')
    // a symlink is its link text, as git keeps it: never the file it points to
    expect(text(2)).toBe(join(home, 'outside.txt'))
    // a folder is not a file
    expect(blobs[3]).toEqual({ size: 0, missing: true })
    expect(text(4)).toBe('new\n')
    rmSync(join(repo, '-'))
    rmSync(join(repo, '-n'))
    rmSync(join(repo, 'link'))
  })

  it('takes branch names git allows, and leaves the index alone', () => {
    sh('git branch "issue#12" feat')
    const c = parseCompare(kuna('compare', b64(repo), b64('main'), b64('issue#12')).toString(), 'main', 'issue#12')
    expect(c.files).toHaveLength(5)
    // a nested repository is not a file; a file only touched is not a change
    mkdirSync(join(repo, 'vendor', 'lib'), { recursive: true })
    sh('cd vendor/lib && git init -q . && echo x > f && cd ../.. && touch moved.txt')
    const index = statSync(join(repo, '.git', 'index')).mtimeMs
    const st = parseStatus(sections(kuna('status', b64(repo)).toString()))
    expect(st.untracked.map((f) => f.path)).toEqual(['un.txt'])
    expect(st.unstaged.map((f) => f.path)).toEqual(['src/a.txt'])
    const w = parseCompare(kuna('compare', b64(repo), b64('main'), '').toString(), 'main', null)
    expect(w.files.map((f) => f.path)).not.toContain('vendor/lib/')
    expect(statSync(join(repo, '.git', 'index')).mtimeMs).toBe(index)
    rmSync(join(repo, 'vendor'), { recursive: true, force: true })
  })

  it('finds the repositories in and below a folder', () => {
    // a folder above its repositories, beside configs and run folders, as agents are often started
    mkdirSync(join(home, 'configs'))
    mkdirSync(join(home, 'run', 'out'), { recursive: true })
    mkdirSync(join(home, 'node_modules', 'pkg'), { recursive: true })
    sh('cd .. && git init -q tools && cd tools && git -c user.email=t@example.org -c user.name=T commit -q --allow-empty -m init')
    sh('cd ../node_modules/pkg && git init -q .')
    const real = (p: string): string => execFileSync('sh', ['-c', 'pwd -P'], { cwd: p }).toString().trim()
    const found = parseRepos(kuna('repos', b64(home)).toString())
    expect(found.map((r) => repoLabel(r.path, real(home))).sort()).toEqual(['repo', 'tools'])
    expect(found.find((r) => r.path.endsWith('/repo'))).toMatchObject({ branch: 'feat' })
    expect(found.every((r) => r.active > 0)).toBe(true)
    // inside a repository: that one
    const inside = parseRepos(kuna('repos', b64(join(repo, 'src'))).toString())
    expect(inside.map((r) => r.path)).toEqual([real(repo)])
    // none at all
    expect(parseRepos(kuna('repos', b64(join(home, 'configs'))).toString())).toEqual([])
    rmSync(join(home, 'tools'), { recursive: true, force: true })
    rmSync(join(home, 'node_modules'), { recursive: true, force: true })
  })

  it('lists and reads the folder itself, git or not', () => {
    const run = join(home, 'run')
    mkdirSync(join(run, 'out'), { recursive: true })
    writeFileSync(join(run, 'config.yaml'), 'bins: 40\n')
    writeFileSync(join(run, '.hidden'), 'h')
    writeFileSync(join(run, '-n'), 'opt')
    symlinkSync(join(run, 'out'), join(run, 'latest'))
    const helper = (...args: string[]): Buffer =>
      execFileSync(process.env.KUNA_TEST_SH || 'sh', [SCRIPT, ...args], { env: { ...process.env, HOME: home }, maxBuffer: 64 * 1024 * 1024 })
    const l = parseDirListing(helper('lsdir', b64(run)).toString())
    // folders (a link to one too) first, hidden files and odd names included
    expect(l.entries.map((e) => `${e.dir ? 'd' : 'f'} ${e.name}`)).toEqual(['d latest', 'd out', 'f -n', 'f .hidden', 'f config.yaml'])
    expect(l.entries.find((e) => e.name === 'config.yaml')).toMatchObject({ size: 9 })
    expect(parseDirListing(helper('lsdir', b64(join(run, 'out'))).toString()).entries).toEqual([])
    const read = (p: string, max = 1000): ReturnType<typeof parseBlobs>[number] => parseBlobs(helper('fread', String(max), b64(p)), max)[0]
    expect(new TextDecoder().decode(read(join(run, 'config.yaml')).data)).toBe('bins: 40\n')
    expect(new TextDecoder().decode(read(join(run, '-n')).data)).toBe('opt')
    expect(read(join(run, 'config.yaml'), 3)).toEqual({ size: 9, tooBig: true })
    expect(read(join(run, 'nope'))).toEqual({ size: 0, missing: true })
    expect(read(join(run, 'out'))).toEqual({ size: 0, missing: true })
    // a run folder with thousands of files: the first 3000, and how many there are
    const many = join(home, 'many')
    mkdirSync(many)
    for (let i = 0; i < 3005; i++) writeFileSync(join(many, `f${i}`), '')
    const big = parseDirListing(helper('lsdir', b64(many)).toString())
    expect(big.more).toBe(3005)
    expect(big.entries).toHaveLength(3000)
    rmSync(many, { recursive: true, force: true })
    rmSync(run, { recursive: true, force: true })
  })

  it('refuses options, ranges and paths out of the repository', () => {
    expect(() => kuna('compare', b64(repo), b64('--output=/tmp/x'), '')).toThrow()
    expect(() => kuna('compare', b64(repo), b64('main..feat'), '')).toThrow()
    // a branch or commit that does not exist, as base or as head: said in words
    for (const [base, head] of [['gone', 'feat'], ['main', 'gone']]) {
      const r = spawnSync(process.env.KUNA_TEST_SH || 'sh', [SCRIPT, 'git', 'compare', b64(repo), b64(base), b64(head)], { env: { ...process.env, HOME: home } })
      expect(r.status).toBe(3)
      expect(r.stderr.toString()).toBe('kuna: unknown branch or commit: gone\n')
    }
    expect(() => kuna('cat', b64(repo), '100', b64('W../outside'))).toThrow()
    expect(() => kuna('cat', b64(repo), '100', b64('G-x:a'))).toThrow()
    expect(() => kuna('info', b64(home))).toThrow()
  })
})

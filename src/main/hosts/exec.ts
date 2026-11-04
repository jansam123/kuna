import { spawn } from 'node:child_process'

export interface ExecResult {
  code: number
  stdout: Buffer
  stderr: string
}

export interface ExecOptions {
  stdin?: string | Buffer
  timeoutMs?: number
  /** Stop reading (and kill the process) after this many bytes; stdout is then longer than this. */
  maxBytes?: number
  /**
   * Run in a process group of its own and kill all of it, so a timeout also
   * stops what it started. Only for local commands: an ssh client's group can
   * hold the jump host connection its shared master still uses.
   */
  group?: boolean
}

/** Run a process to completion and collect its output. Never rejects. */
export function run(file: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: opts.group })
    const kill = (): void => {
      try {
        if (opts.group && child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
    const out: Buffer[] = []
    let outBytes = 0
    let err = ''
    let done = false
    const finish = (code: number): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, stdout: Buffer.concat(out), stderr: err })
    }
    const timer = setTimeout(() => {
      err += `\n[kuna] timed out after ${opts.timeoutMs}ms`
      kill()
      finish(124)
    }, opts.timeoutMs ?? 30_000)

    child.stdout.on('data', (b: Buffer) => {
      out.push(b)
      outBytes += b.length
      if (opts.maxBytes && outBytes > opts.maxBytes) {
        kill()
        finish(0)
      }
    })
    child.stderr.on('data', (b: Buffer) => {
      if (err.length < 20_000) err += b.toString('utf8')
    })
    child.on('error', (e) => {
      err += String(e)
      finish(127)
    })
    child.on('close', (code) => finish(code ?? 1))
    child.stdin.on('error', () => undefined)
    if (opts.stdin != null) child.stdin.end(opts.stdin)
    else child.stdin.end()
  })
}

export const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')

/** Quote an argument for a remote POSIX-ish shell (bash, zsh, and tcsh agree on '…'). */
export function shq(arg: string): string {
  if (/^[\w@%+=:,./-]+$/.test(arg)) return arg
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

const AUTH_PATTERNS = [
  /permission denied/i,
  /host key verification failed/i,
  /too many authentication failures/i,
  /no more authentication methods/i,
  /authentication failed/i,
  /password/i,
  /kerberos|gssapi/i,
  /remote host identification has changed/i
]

export function looksLikeAuthError(stderr: string): boolean {
  return AUTH_PATTERNS.some((re) => re.test(stderr))
}

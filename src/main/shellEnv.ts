import { run } from './hosts/exec'

/**
 * Apps launched from Finder get launchd's minimal PATH (/usr/bin:/bin:…), so
 * Homebrew's tmux or ssh helpers used by ProxyCommand would be missing. Ask the
 * user's login shell for its PATH once at startup, like a terminal would.
 */
export async function adoptLoginShellPath(): Promise<void> {
  if (process.platform === 'win32') return // Windows apps get the user's PATH
  const shell = process.env.SHELL || '/bin/zsh'
  const marker = '__KUNA_PATH__'
  const res = await run(shell, ['-lic', `printf '${marker}%s${marker}' "$PATH"`], { timeoutMs: 4000 })
  const m = new RegExp(`${marker}(.*?)${marker}`).exec(res.stdout.toString('utf8'))
  if (m?.[1]) process.env.PATH = m[1]
}

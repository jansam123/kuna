import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, dialog, shell, type BrowserWindow } from 'electron'
import { knownHostsName, makeExport, parseJumpSpec, parseKnownHosts, parseSshG, type PhoneHost } from '@shared/phone'
import type { PersistedState } from '@shared/types'
import { LOCAL_HOST } from '@shared/types'
import { isHostId } from '@shared/validate'

/** What a command prints, or nothing when it fails: ssh and ssh-keygen answer in a moment or not at all. */
const said = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve) => execFile(file, args, { timeout: 10_000, maxBuffer: 1 << 20 }, (_err, stdout) => resolve(String(stdout ?? ''))))

/**
 * How the phone reaches a host: what the user's own ssh resolves the alias to
 * (`ssh -G`, which reads ~/.ssh/config as ssh does and connects to nothing),
 * and the same for each host it jumps through.
 */
async function resolve(alias: string, args: string[], hosts: Map<string, PhoneHost>, files: Map<string, string[]>, depth = 0): Promise<boolean> {
  if (hosts.has(alias)) return true
  if (depth > 6 || !isHostId(alias)) return false
  const r = parseSshG(await said('ssh', ['-G', ...args]))
  if (!r) return false
  const host: PhoneHost = { alias, hostName: r.hostName, user: r.user, port: r.port, keyName: r.hostKeyAlias }
  hosts.set(alias, host)
  files.set(alias, r.knownHostsFiles)
  let before: string | undefined
  for (const spec of (r.proxyJump ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const hop = parseJumpSpec(spec)
    if (!hop) return false
    const to = hop.user ? `${hop.user}@${hop.host}` : hop.host
    if (!(await resolve(spec, [...(hop.port ? ['-p', String(hop.port)] : []), to], hosts, files, depth + 1))) return false
    // `a,b`: b is reached through a, unless b's own config says otherwise
    const jump = hosts.get(spec)!
    if (before && !jump.jump && before !== spec) jump.jump = before
    before = spec
  }
  host.jump = before
  return true
}

/** The host keys this Mac trusts for a host, from the known_hosts files its ssh would read. */
async function keysOf(host: PhoneHost, files: string[]): Promise<string[]> {
  const out: string[] = []
  for (const f of new Set(files.map((p) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)))) {
    if (existsSync(f)) out.push(...parseKnownHosts(await said('ssh-keygen', ['-F', knownHostsName(host), '-f', f])))
  }
  return [...new Set(out)]
}

/**
 * Kuna ▸ Export for iPhone…: writes the projects on ssh hosts, their folders,
 * agent names, hidden sessions, the colour scheme, each host's address and the
 * host keys this Mac trusts. No passwords and no keys of yours are in it.
 */
export async function exportForPhone(win: BrowserWindow | undefined, state: PersistedState): Promise<void> {
  const hosts = new Map<string, PhoneHost>()
  const files = new Map<string, string[]>()
  const failed: string[] = []
  for (const alias of new Set(state.projects.map((p) => p.host))) {
    if (alias === LOCAL_HOST) continue
    if (!(await resolve(alias, [alias], hosts, files))) {
      failed.push(alias)
      hosts.delete(alias)
    }
  }
  const hostKeys: Record<string, string[]> = {}
  for (const h of hosts.values()) {
    const keys = await keysOf(h, files.get(h.alias) ?? [])
    if (keys.length) hostKeys[knownHostsName(h)] = keys
  }
  const data = makeExport({ projects: state.projects, names: state.names, hidden: state.hidden, theme: state.settings.theme }, [...hosts.values()], hostKeys, Date.now() / 1000)
  const here = state.projects.filter((p) => p.host === LOCAL_HOST).length
  if (!data.projects.length) {
    await dialog.showMessageBox({ type: 'info', message: 'Nothing to export', detail: 'The iPhone app works with projects on ssh hosts, and there are none yet.' })
    return
  }
  const options = { title: 'Export for iPhone', defaultPath: join(app.getPath('desktop'), 'Kuna projects.kuna'), filters: [{ name: 'Kuna export', extensions: ['kuna'] }] }
  const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
  if (picked.canceled || !picked.filePath) return
  await writeFile(picked.filePath, JSON.stringify(data, null, 2))
  shell.showItemInFolder(picked.filePath)
  const notes = [
    `${data.projects.length} project${data.projects.length === 1 ? '' : 's'} on ${hosts.size} host${hosts.size === 1 ? '' : 's'} (the ones they are reached through included).`,
    'Send the file to the iPhone (AirDrop, or save it to Files) and open it with Kuna. It holds no passwords and no keys of yours.',
    ...(here ? [`Left out: ${here} project${here === 1 ? '' : 's'} on this Mac. The iPhone app works with ssh hosts only.`] : []),
    ...(failed.length ? [`Left out: ${failed.join(', ')}. ssh could not work out how to reach ${failed.length === 1 ? 'it' : 'them'}.`] : [])
  ]
  await dialog.showMessageBox({ type: 'info', message: 'Exported for iPhone', detail: notes.join('\n\n') })
}

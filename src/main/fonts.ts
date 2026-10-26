import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { parseJsonc } from '@shared/jsonc'
import type { FontPrefs } from '@shared/types'

const run = promisify(execFile)

const WINDOWS = process.platform === 'win32'
/** VS Code's own interface font (on macOS, on Windows), and its default sizes. */
const SYSTEM_UI = WINDOWS ? '"Segoe UI", sans-serif' : '-apple-system, BlinkMacSystemFont, sans-serif'
/** the system's monospace fonts, behind whatever the user picked */
const MONO = WINDOWS ? '"Cascadia Mono", Consolas, monospace' : 'Menlo, monospace'

/** Where VS Code and its forks keep their settings on this system. */
function settingsDir(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support')
  if (WINDOWS) return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
}

type Json = Record<string, unknown>

async function vscodeSettings(): Promise<Json> {
  for (const app of ['Code', 'Code - Insiders', 'Cursor', 'VSCodium']) {
    try {
      const text = await readFile(join(settingsDir(), app, 'User', 'settings.json'), 'utf8')
      return (parseJsonc(text) as Json) ?? {}
    } catch {
      /* next */
    }
  }
  return {}
}

const ITERM = join(homedir(), 'Library', 'Preferences', 'com.googlecode.iterm2.plist')

async function plist(key: string): Promise<string | undefined> {
  try {
    const { stdout } = await run('plutil', ['-extract', key, 'raw', '-o', '-', ITERM], { timeout: 3000 })
    return stdout.trim()
  } catch {
    return undefined
  }
}

/** iTerm2's default profile: its font ("MesloLGS-NF-Regular 12") and spacing. */
async function itermFont(): Promise<{ face: string; size: number; vertical: number; horizontal: number } | undefined> {
  const guid = await plist('Default Bookmark Guid')
  for (let i = 0; i < 64; i++) {
    const g = await plist(`New Bookmarks.${i}.Guid`)
    if (g === undefined) break
    if (guid && g !== guid) continue
    const font = await plist(`New Bookmarks.${i}.Normal Font`)
    const m = font && /^(.+) (\d+(?:\.\d+)?)$/.exec(font)
    if (!m) return undefined
    return {
      face: m[1],
      size: Number(m[2]),
      vertical: Number(await plist(`New Bookmarks.${i}.Vertical Spacing`)) || 1,
      horizontal: Number(await plist(`New Bookmarks.${i}.Horizontal Spacing`)) || 1
    }
  }
  return undefined
}

/**
 * Windows Terminal's default profile font (`profiles.defaults.font`, or the
 * older `fontFace`/`fontSize`), from the Store or the unpackaged install.
 */
async function windowsTerminalFont(): Promise<{ face: string; size?: number; lineHeight?: number } | undefined> {
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  for (const dir of [join(local, 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState'), join(local, 'Microsoft', 'Windows Terminal')]) {
    try {
      const json = (parseJsonc(await readFile(join(dir, 'settings.json'), 'utf8')) as Json) ?? {}
      const profiles = json.profiles as Json | undefined
      const defaults = (profiles && !Array.isArray(profiles) ? (profiles.defaults as Json) : undefined) ?? {}
      const font = (defaults.font as Json | undefined) ?? {}
      const face = font.face ?? defaults.fontFace
      if (typeof face !== 'string' || !face.trim()) return undefined
      const size = Number(font.size ?? defaults.fontSize) || undefined
      const lineHeight = Number(font.cellHeight) || undefined
      return { face, size, lineHeight: lineHeight && lineHeight < 3 ? lineHeight : undefined }
    } catch {
      /* next */
    }
  }
  return undefined
}

/** "MesloLGS-NF-Regular" → "MesloLGS NF", a guess at the family behind a PostScript name. */
function familyOf(postscript: string): string {
  return postscript.replace(/-(Regular|Book|Roman|Medium)$/i, '').replace(/-/g, ' ')
}

/**
 * The fonts the user reads all day: VS Code's interface and editor fonts for
 * Kuna's own text, and the terminal font Claude Code runs in (iTerm2's default
 * profile, else VS Code's integrated terminal) for the agent panes.
 */
export async function detectFonts(): Promise<FontPrefs> {
  const [vs, iterm, wt] = await Promise.all([
    vscodeSettings(),
    process.platform === 'darwin' ? itermFont() : undefined,
    WINDOWS ? windowsTerminalFont() : undefined
  ])
  const zoom = Math.pow(1.2, Number(vs['window.zoomLevel']) || 0)
  const str = (k: string): string | undefined => (typeof vs[k] === 'string' && (vs[k] as string).trim() ? (vs[k] as string) : undefined)
  const num = (k: string): number | undefined => (typeof vs[k] === 'number' && (vs[k] as number) > 0 ? (vs[k] as number) : undefined)
  const editorFamily = str('editor.fontFamily') ?? (WINDOWS ? 'Consolas, "Courier New", monospace' : 'Menlo, Monaco, "Courier New", monospace')
  const editorSize = num('editor.fontSize') ?? 12
  const prefs: FontPrefs = {
    ui: { family: SYSTEM_UI, size: Math.round(13 * zoom * 10) / 10 },
    mono: { family: editorFamily, size: Math.round(editorSize * zoom * 10) / 10 },
    terminal: { family: MONO, size: 12, lineHeight: 1, letterSpacing: 0, source: 'default' }
  }
  if (iterm) {
    const bold = /-Regular$/i.test(iterm.face) ? iterm.face.replace(/-Regular$/i, '-Bold') : undefined
    prefs.terminal = {
      family: `"${familyOf(iterm.face)}", ${MONO}`,
      faces: { regular: iterm.face, bold },
      size: iterm.size,
      lineHeight: iterm.vertical,
      letterSpacing: Math.round((iterm.horizontal - 1) * iterm.size * 0.6 * 10) / 10,
      source: 'iTerm2'
    }
  } else if (wt) {
    prefs.terminal = {
      family: `"${wt.face}", ${MONO}`,
      size: wt.size ?? 12,
      lineHeight: wt.lineHeight ?? 1,
      letterSpacing: 0,
      source: 'Windows Terminal'
    }
  } else if (str('terminal.integrated.fontFamily') || num('terminal.integrated.fontSize')) {
    prefs.terminal = {
      family: `${str('terminal.integrated.fontFamily') ?? editorFamily}, ${MONO}`,
      size: num('terminal.integrated.fontSize') ?? editorSize,
      lineHeight: num('terminal.integrated.lineHeight') ?? 1,
      letterSpacing: num('terminal.integrated.letterSpacing') ?? 0,
      source: 'VS Code terminal'
    }
  }
  return prefs
}

import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { FontPrefs } from '@shared/types'
import { userSettings } from './vscode'

const run = promisify(execFile)

/** VS Code's own interface font on macOS, and its default sizes. */
const SYSTEM_UI = '-apple-system, BlinkMacSystemFont, sans-serif'

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
  const [{ settings: vs }, iterm] = await Promise.all([userSettings(), process.platform === 'darwin' ? itermFont() : undefined])
  const zoom = Math.pow(1.2, Number(vs['window.zoomLevel']) || 0)
  const str = (k: string): string | undefined => (typeof vs[k] === 'string' && (vs[k] as string).trim() ? (vs[k] as string) : undefined)
  const num = (k: string): number | undefined => (typeof vs[k] === 'number' && (vs[k] as number) > 0 ? (vs[k] as number) : undefined)
  const editorFamily = str('editor.fontFamily') ?? 'Menlo, Monaco, "Courier New", monospace'
  const editorSize = num('editor.fontSize') ?? 12
  const prefs: FontPrefs = {
    ui: { family: SYSTEM_UI, size: Math.round(13 * zoom * 10) / 10 },
    mono: { family: editorFamily, size: Math.round(editorSize * zoom * 10) / 10 },
    terminal: { family: 'Menlo, monospace', size: 12, lineHeight: 1, letterSpacing: 0, source: 'default' }
  }
  if (iterm) {
    const bold = /-Regular$/i.test(iterm.face) ? iterm.face.replace(/-Regular$/i, '-Bold') : undefined
    prefs.terminal = {
      family: `"${familyOf(iterm.face)}", Menlo, monospace`,
      faces: { regular: iterm.face, bold },
      size: iterm.size,
      lineHeight: iterm.vertical,
      letterSpacing: Math.round((iterm.horizontal - 1) * iterm.size * 0.6 * 10) / 10,
      source: 'iTerm2'
    }
  } else if (str('terminal.integrated.fontFamily') || num('terminal.integrated.fontSize')) {
    prefs.terminal = {
      family: `${str('terminal.integrated.fontFamily') ?? editorFamily}, Menlo, monospace`,
      size: num('terminal.integrated.fontSize') ?? editorSize,
      lineHeight: num('terminal.integrated.lineHeight') ?? 1,
      letterSpacing: num('terminal.integrated.letterSpacing') ?? 0,
      source: 'VS Code terminal'
    }
  }
  return prefs
}

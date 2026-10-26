import type { FontPrefs, Settings } from '@shared/types'

/** The family name the terminal's exact faces are registered under. */
export const TERMINAL_FACE = 'Kuna Terminal'

/**
 * Use the fonts from the user's VS Code and iTerm2 settings: CSS variables
 * for Kuna's own text, and @font-face rules that point at the exact
 * terminal faces (by PostScript name, so "MesloLGS-NF-Regular" is that face
 * and no other). Resolves once the terminal font is loaded, so terminals
 * measure the real glyphs.
 */
export async function applyFonts(f: FontPrefs, uiFont: Settings['uiFont']): Promise<void> {
  const root = document.documentElement.style
  const editorUi = uiFont === 'editor'
  root.setProperty('--ui', editorUi ? `${f.mono.family}, ${f.ui.family}` : f.ui.family)
  root.setProperty('--mono', `${f.mono.family}, Menlo, Consolas, monospace`)
  root.setProperty('--fs', `${editorUi ? Math.max(12, f.mono.size + 1) : f.ui.size}px`)
  root.setProperty('--fs-mono', `${f.mono.size}px`)

  const faces = f.terminal.faces
  let style = document.getElementById('kuna-fonts')
  if (!style) {
    style = document.createElement('style')
    style.id = 'kuna-fonts'
    document.head.appendChild(style)
  }
  style.textContent = faces
    ? [
        `@font-face { font-family: '${TERMINAL_FACE}'; src: local('${faces.regular}'); font-weight: 400; }`,
        faces.bold ? `@font-face { font-family: '${TERMINAL_FACE}'; src: local('${faces.bold}'); font-weight: 700; }` : ''
      ].join('\n')
    : ''
  if (faces) {
    try {
      await Promise.all([
        document.fonts.load(`400 ${f.terminal.size}px "${TERMINAL_FACE}"`),
        faces.bold ? document.fonts.load(`700 ${f.terminal.size}px "${TERMINAL_FACE}"`) : null
      ])
    } catch {
      /* falls back to the family list */
    }
  }
}

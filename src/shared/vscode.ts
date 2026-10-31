/**
 * The user's VS Code, as far as the review view copies it: the colour theme,
 * editor settings, file icon theme and which language a file is. Read by the
 * main process from VS Code's settings and extensions (src/main/vscode.ts).
 */

export interface TokenColor {
  name?: string
  scope?: string | string[]
  settings: { foreground?: string; background?: string; fontStyle?: string }
}

export interface VscodeTheme {
  /** as VS Code names it: "GitHub Dark Default" */
  name: string
  type: 'dark' | 'light'
  colors: Record<string, string>
  tokenColors: TokenColor[]
}

export interface EditorPrefs {
  fontFamily: string
  fontSize: number
  fontWeight: string
  /** true, false, or OpenType features ("'calt', 'ss01'") */
  fontLigatures: boolean | string
  /** 0: from the font size, as VS Code does */
  lineHeight: number
  letterSpacing: number
  tabSize: number
  renderWhitespace: 'none' | 'boundary' | 'selection' | 'trailing' | 'all'
  wordWrap: 'off' | 'on' | 'wordWrapColumn' | 'bounded'
  minimap: boolean
  stickyScroll: boolean
  bracketPairs: boolean
  renderSideBySide: boolean
  ignoreTrimWhitespace: boolean
  hideUnchangedRegions: boolean
}

/** A file icon theme (material-icon-theme, Seti…): names and extensions → icon ids. */
export interface IconTheme {
  id: string
  file?: string
  folder?: string
  folderExpanded?: string
  fileExtensions: Record<string, string>
  fileNames: Record<string, string>
  folderNames: Record<string, string>
  folderNamesExpanded: Record<string, string>
  languageIds: Record<string, string>
}

export interface LanguageInfo {
  id: string
  /** with the dot, lower case: ".ts" */
  extensions: string[]
  filenames: string[]
}

export interface VscodeLook {
  /** which app the settings came from (Code, Cursor…); null: none found */
  app: string | null
  themeName: string
  /** null: not found or not readable; a bundled one is used */
  theme: VscodeTheme | null
  editor: EditorPrefs
  icons: IconTheme | null
  languages: LanguageInfo[]
  /** files.associations: "*.C" → "cpp" */
  associations: Record<string, string>
}

export const DEFAULT_EDITOR: EditorPrefs = {
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  fontSize: 12,
  fontWeight: 'normal',
  fontLigatures: false,
  lineHeight: 0,
  letterSpacing: 0,
  tabSize: 4,
  renderWhitespace: 'selection',
  wordWrap: 'off',
  minimap: true,
  stickyScroll: true,
  bracketPairs: true,
  renderSideBySide: true,
  ignoreTrimWhitespace: true,
  hideUnchangedRegions: false
}

type Json = Record<string, unknown>

/** Editor settings from VS Code's settings.json, with VS Code's defaults. */
export function editorPrefs(s: Json): EditorPrefs {
  const zoom = Math.pow(1.2, Number(s['window.zoomLevel']) || 0)
  const str = (k: string): string | undefined => (typeof s[k] === 'string' && (s[k] as string).trim() ? (s[k] as string) : undefined)
  const num = (k: string): number | undefined => (typeof s[k] === 'number' && Number.isFinite(s[k]) ? (s[k] as number) : undefined)
  const bool = (k: string, d: boolean): boolean => (typeof s[k] === 'boolean' ? (s[k] as boolean) : d)
  const d = DEFAULT_EDITOR
  const lig = s['editor.fontLigatures']
  const pick = <T extends string>(k: string, allowed: readonly T[], def: T): T => (allowed.includes(s[k] as T) ? (s[k] as T) : def)
  const lineHeight = num('editor.lineHeight') ?? 0
  const size = (num('editor.fontSize') ?? d.fontSize) * zoom
  return {
    fontFamily: str('editor.fontFamily') ?? d.fontFamily,
    fontSize: Math.round(size * 10) / 10,
    fontWeight: typeof s['editor.fontWeight'] === 'number' ? String(s['editor.fontWeight']) : (str('editor.fontWeight') ?? 'normal'),
    fontLigatures: typeof lig === 'boolean' || typeof lig === 'string' ? lig : false,
    // VS Code: below 8 it is a multiple of the font size
    lineHeight: lineHeight > 0 && lineHeight < 8 ? Math.round(lineHeight * size) : Math.round(lineHeight * zoom),
    letterSpacing: num('editor.letterSpacing') ?? 0,
    tabSize: num('editor.tabSize') ?? d.tabSize,
    renderWhitespace: pick('editor.renderWhitespace', ['none', 'boundary', 'selection', 'trailing', 'all'] as const, d.renderWhitespace),
    wordWrap: pick('editor.wordWrap', ['off', 'on', 'wordWrapColumn', 'bounded'] as const, d.wordWrap),
    minimap: bool('editor.minimap.enabled', d.minimap),
    stickyScroll: bool('editor.stickyScroll.enabled', d.stickyScroll),
    bracketPairs: bool('editor.bracketPairColorization.enabled', d.bracketPairs),
    renderSideBySide: bool('diffEditor.renderSideBySide', d.renderSideBySide),
    ignoreTrimWhitespace: bool('diffEditor.ignoreTrimWhitespace', d.ignoreTrimWhitespace),
    hideUnchangedRegions: bool('diffEditor.hideUnchangedRegions.enabled', d.hideUnchangedRegions)
  }
}

/**
 * workbench.colorCustomizations / editor.tokenColorCustomizations on top of a
 * theme: global entries and the theme's own `[Theme Name]` block.
 */
export function customize(theme: VscodeTheme, colorCustom: unknown, tokenCustom: unknown): VscodeTheme {
  const colors = { ...theme.colors }
  const tokenColors = [...theme.tokenColors]
  const scoped = (o: unknown): Json[] => {
    if (!o || typeof o !== 'object') return []
    const obj = o as Json
    const own = obj[`[${theme.name}]`]
    return [obj, ...(own && typeof own === 'object' ? [own as Json] : [])]
  }
  for (const block of scoped(colorCustom)) {
    for (const [k, v] of Object.entries(block)) if (!k.startsWith('[') && typeof v === 'string') colors[k] = v
  }
  const SHORT: Record<string, string> = {
    comments: 'comment',
    strings: 'string',
    keywords: 'keyword',
    numbers: 'constant.numeric',
    types: 'entity.name.type',
    functions: 'entity.name.function',
    variables: 'variable'
  }
  for (const block of scoped(tokenCustom)) {
    for (const [k, scope] of Object.entries(SHORT)) {
      const v = block[k]
      if (typeof v === 'string') tokenColors.push({ scope, settings: { foreground: v } })
      else if (v && typeof v === 'object') tokenColors.push({ scope, settings: v as TokenColor['settings'] })
    }
    if (Array.isArray(block.textMateRules)) tokenColors.push(...(block.textMateRules as TokenColor[]).filter((r) => r && typeof r === 'object' && r.settings))
  }
  return { ...theme, colors, tokenColors }
}

const base = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** The VS Code language of a file: files.associations, then file names, then the longest extension. */
export function languageOf(path: string, languages: LanguageInfo[], associations: Record<string, string> = {}): string | undefined {
  const name = base(path)
  const lower = name.toLowerCase()
  for (const [glob, id] of Object.entries(associations)) {
    if (glob === name || glob === `**/${name}`) return id
    const m = /^(?:\*\*\/)?\*(\.[^*/?[\]{}]+)$/.exec(glob)
    if (m && name.endsWith(m[1])) return id
  }
  for (const l of languages) if (l.filenames.some((f) => f === name || f.toLowerCase() === lower)) return l.id
  let best: { id: string; len: number } | undefined
  for (const l of languages) {
    for (const ext of l.extensions) {
      if (lower.endsWith(ext) && (!best || ext.length > best.len)) best = { id: l.id, len: ext.length }
    }
  }
  return best?.id
}

/** A file's icon as the icon theme says: its name, then its extensions (longest first), then its language. */
export function fileIcon(t: IconTheme, path: string, langId?: string): string | undefined {
  const name = base(path).toLowerCase()
  if (t.fileNames[name]) return t.fileNames[name]
  // "x.test.ts": test.ts, then ts
  for (let i = name.indexOf('.'); i !== -1; i = name.indexOf('.', i + 1)) {
    const ext = name.slice(i + 1)
    if (ext && t.fileExtensions[ext]) return t.fileExtensions[ext]
  }
  if (langId && t.languageIds[langId]) return t.languageIds[langId]
  return t.file
}

export function folderIcon(t: IconTheme, path: string, open: boolean): string | undefined {
  const name = base(path).toLowerCase()
  if (open) return t.folderNamesExpanded[name] ?? t.folderExpanded ?? t.folder
  return t.folderNames[name] ?? t.folder
}

import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { parseJsonc } from '@shared/jsonc'
import { customize, editorPrefs, type IconTheme, type LanguageInfo, type TokenColor, type VscodeLook, type VscodeTheme } from '@shared/vscode'

type Json = Record<string, unknown>

/** VS Code and its forks: where each keeps its settings, built-in and installed extensions. */
const APPS = [
  { name: 'Code', bundle: 'Visual Studio Code.app', user: '.vscode' },
  { name: 'Code - Insiders', bundle: 'Visual Studio Code - Insiders.app', user: '.vscode-insiders' },
  { name: 'Cursor', bundle: 'Cursor.app', user: '.cursor' },
  { name: 'VSCodium', bundle: 'VSCodium.app', user: '.vscode-oss' }
]

interface Extension {
  dir: string
  pkg: Json
}

async function readJson(path: string): Promise<Json | undefined> {
  try {
    const v = parseJsonc(await readFile(path, 'utf8'))
    return v && typeof v === 'object' ? (v as Json) : undefined
  } catch {
    return undefined
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Installed extensions: VS Code's own list (one version each), else every folder. */
async function userExtensionDirs(root: string): Promise<string[]> {
  const list = await readJson(join(root, 'extensions.json'))
  if (Array.isArray(list)) {
    return (list as Json[])
      .map((e) => {
        const rel = typeof e.relativeLocation === 'string' ? e.relativeLocation : undefined
        const loc = e.location as Json | undefined
        return rel ? join(root, rel) : typeof loc?.path === 'string' ? loc.path : typeof loc?.fsPath === 'string' ? loc.fsPath : undefined
      })
      .filter((d): d is string => !!d)
  }
  try {
    return (await readdir(root)).filter((n) => !n.startsWith('.')).map((n) => join(root, n))
  } catch {
    return []
  }
}

async function extensions(app: (typeof APPS)[number]): Promise<Extension[]> {
  const builtinRoots = [join('/Applications', app.bundle), join(homedir(), 'Applications', app.bundle)].map((b) => join(b, 'Contents', 'Resources', 'app', 'extensions'))
  const dirs: string[] = []
  for (const r of builtinRoots) {
    try {
      dirs.push(...(await readdir(r)).map((n) => join(r, n)))
      break
    } catch {
      /* not there */
    }
  }
  dirs.push(...(await userExtensionDirs(join(homedir(), app.user, 'extensions'))))
  const out = await Promise.all(dirs.map(async (dir) => ({ dir, pkg: await readJson(join(dir, 'package.json')) })))
  return out.filter((e): e is Extension => !!e.pkg)
}

const contributes = (e: Extension, key: string): Json[] => {
  const c = e.pkg.contributes as Json | undefined
  return Array.isArray(c?.[key]) ? (c![key] as Json[]) : []
}

/** A colour theme file and the ones it includes. */
async function loadTheme(path: string, depth = 0): Promise<{ type?: string; colors: Record<string, string>; tokenColors: TokenColor[] }> {
  const j = await readJson(path)
  if (!j || depth > 5) return { colors: {}, tokenColors: [] }
  let colors: Record<string, string> = {}
  let tokenColors: TokenColor[] = []
  let type: string | undefined
  if (typeof j.include === 'string') {
    const inc = await loadTheme(resolve(dirname(path), j.include), depth + 1)
    colors = inc.colors
    tokenColors = inc.tokenColors
    type = inc.type
  }
  if (j.colors && typeof j.colors === 'object') {
    for (const [k, v] of Object.entries(j.colors as Json)) if (typeof v === 'string') colors[k] = v
  }
  if (Array.isArray(j.tokenColors)) tokenColors = [...tokenColors, ...(j.tokenColors as TokenColor[])]
  else if (typeof j.tokenColors === 'string' && extname(j.tokenColors) === '.json') {
    const inc = await readJson(resolve(dirname(path), j.tokenColors))
    if (Array.isArray(inc?.tokenColors)) tokenColors = [...tokenColors, ...(inc.tokenColors as TokenColor[])]
  }
  if (typeof j.type === 'string') type = j.type
  return { type, colors, tokenColors: tokenColors.filter((t) => t && typeof t === 'object' && t.settings) }
}

const uiType = (ui: unknown): 'dark' | 'light' => (ui === 'vs' || ui === 'hc-light' ? 'light' : 'dark')

/**
 * Reads what makes the user's VS Code look like it does. Read once and kept
 * (VS Code settings rarely change mid-review); `refresh` reads again.
 */
export class VscodeService {
  private look?: Promise<VscodeLook>
  /** icon id → file, for the icon theme in use */
  private iconFiles = new Map<string, string>()
  private iconData = new Map<string, string | null>()

  get(refresh = false): Promise<VscodeLook> {
    if (!this.look || refresh) this.look = this.read()
    return this.look
  }

  private async read(): Promise<VscodeLook> {
    let app: (typeof APPS)[number] | undefined
    let settings: Json = {}
    for (const a of APPS) {
      const s = await readJson(join(homedir(), 'Library', 'Application Support', a.name, 'User', 'settings.json'))
      if (s || (await exists(join(homedir(), a.user)))) {
        app = a
        settings = s ?? {}
        break
      }
    }
    const look: VscodeLook = {
      app: app?.name ?? null,
      themeName: typeof settings['workbench.colorTheme'] === 'string' ? (settings['workbench.colorTheme'] as string) : 'Default Dark Modern',
      theme: null,
      editor: editorPrefs(settings),
      icons: null,
      languages: [],
      associations: {}
    }
    const assoc = settings['files.associations']
    if (assoc && typeof assoc === 'object') {
      for (const [k, v] of Object.entries(assoc as Json)) if (typeof v === 'string') look.associations[k] = v
    }
    if (!app) return look
    const exts = await extensions(app)

    // languages: every extension's file extensions and names
    const langs = new Map<string, LanguageInfo>()
    for (const e of exts) {
      for (const l of contributes(e, 'languages')) {
        if (typeof l.id !== 'string') continue
        const info = langs.get(l.id) ?? { id: l.id, extensions: [], filenames: [] }
        if (Array.isArray(l.extensions)) info.extensions.push(...(l.extensions as unknown[]).filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase()))
        if (Array.isArray(l.filenames)) info.filenames.push(...(l.filenames as unknown[]).filter((x): x is string => typeof x === 'string'))
        langs.set(l.id, info)
      }
    }
    look.languages = [...langs.values()]

    // the colour theme: matched by id, else by label, as VS Code does
    const themeName = look.themeName
    for (const e of exts) {
      const t = contributes(e, 'themes').find((t) => (t.id ?? t.label) === themeName || t.label === themeName)
      if (!t || typeof t.path !== 'string') continue
      const loaded = await loadTheme(join(e.dir, t.path))
      if (!loaded.tokenColors.length && !Object.keys(loaded.colors).length) break
      const theme: VscodeTheme = {
        name: themeName,
        type: loaded.type === 'light' || loaded.type === 'dark' ? loaded.type : uiType(t.uiTheme),
        colors: loaded.colors,
        tokenColors: loaded.tokenColors
      }
      look.theme = customize(theme, settings['workbench.colorCustomizations'], settings['editor.tokenColorCustomizations'])
      break
    }

    // the file icon theme
    const iconId = typeof settings['workbench.iconTheme'] === 'string' ? (settings['workbench.iconTheme'] as string) : 'vs-seti'
    for (const e of exts) {
      const t = contributes(e, 'iconThemes').find((t) => t.id === iconId)
      if (!t || typeof t.path !== 'string') continue
      const file = join(e.dir, t.path)
      const j = await readJson(file)
      if (!j) break
      const defs = (j.iconDefinitions ?? {}) as Record<string, Json>
      this.iconFiles.clear()
      this.iconData.clear()
      for (const [id, d] of Object.entries(defs)) if (typeof d?.iconPath === 'string') this.iconFiles.set(id, resolve(dirname(file), d.iconPath))
      const rec = (k: string): Record<string, string> => (j[k] && typeof j[k] === 'object' ? (j[k] as Record<string, string>) : {})
      const lower = (r: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v]))
      look.icons = {
        id: iconId,
        file: typeof j.file === 'string' ? j.file : undefined,
        folder: typeof j.folder === 'string' ? j.folder : undefined,
        folderExpanded: typeof j.folderExpanded === 'string' ? j.folderExpanded : undefined,
        fileExtensions: lower(rec('fileExtensions')),
        fileNames: lower(rec('fileNames')),
        folderNames: lower(rec('folderNames')),
        folderNamesExpanded: lower(rec('folderNamesExpanded')),
        languageIds: rec('languageIds')
      }
      break
    }
    return look
  }

  /** An icon of the icon theme in use, as a data: URL (SVG or PNG); null when it has no file. */
  async icon(id: string): Promise<string | null> {
    await this.get()
    if (this.iconData.has(id)) return this.iconData.get(id)!
    const file = this.iconFiles.get(id)
    let url: string | null = null
    if (file && /\.(svg|png)$/i.test(file)) {
      try {
        const data = await readFile(file)
        if (data.length < 256 * 1024) url = `data:${file.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : 'image/png'};base64,${data.toString('base64')}`
      } catch {
        /* missing */
      }
    }
    this.iconData.set(id, url)
    return url
  }
}

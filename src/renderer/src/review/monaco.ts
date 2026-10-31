import type * as MonacoApi from 'monaco-editor/editor/editor.api.js'
import type { HighlighterCore, ThemeRegistrationAny } from 'shiki/core'
import { languageOf, type VscodeLook } from '@shared/vscode'

export type Monaco = typeof MonacoApi

/**
 * The review view's editor: Monaco (VS Code's own editor) coloured the way
 * VS Code colours code, by Shiki running the same TextMate grammars with the
 * Oniguruma engine, in the user's VS Code colour theme. Loaded on the first
 * ⌘G only; grammars load as files of their language turn up.
 */
export interface EditorEnv {
  monaco: Monaco
  /** the Monaco theme made from the user's VS Code theme */
  theme: string
  /** the theme's colours (editor.background, diffEditor.*…) */
  colors: Record<string, string>
  dark: boolean
  /** the Monaco language for a file, its grammar loaded */
  language(path: string): Promise<string>
}

/** VS Code language ids → Shiki's, where they differ */
const VS_TO_SHIKI: Record<string, string> = {
  typescriptreact: 'tsx',
  javascriptreact: 'jsx',
  shellscript: 'shellscript',
  makefile: 'make',
  dockerfile: 'docker',
  restructuredtext: 'rst',
  'cuda-cpp': 'cpp',
  'objective-c': 'objc',
  'objective-cpp': 'objective-cpp',
  snippets: 'json',
  'git-commit': 'git-commit',
  'git-rebase': 'git-rebase',
  properties: 'ini',
  jupyter: 'json'
}

/** grammars past this many lines are not worth the wait; the file shows plain */
const MAX_LINE = 20_000

let env: Promise<EditorEnv> | undefined

export function loadEditor(look: VscodeLook): Promise<EditorEnv> {
  env ??= create(look).catch((e) => {
    env = undefined
    throw e
  })
  return env
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

const hex = (c: string | undefined): string | undefined => {
  if (!c) return undefined
  let v = c.replace(/^#/, '').toLowerCase()
  if (v.length === 3 || v.length === 4) v = [...v].map((x) => x + x).join('')
  return /^[0-9a-f]{6}([0-9a-f]{2})?$/.test(v) ? v : undefined
}

class LineState implements MonacoApi.languages.IState {
  constructor(readonly stack: unknown) {}
  clone(): LineState {
    return this
  }
  equals(other: MonacoApi.languages.IState): boolean {
    return other instanceof LineState && other.stack === this.stack
  }
}

async function create(look: VscodeLook): Promise<EditorEnv> {
  const [monaco, { createHighlighterCore }, { createOnigurumaEngine }, { bundledLanguages }, { bundledThemes }, { textmateThemeToMonacoTheme }, worker] =
    await Promise.all([
      import('monaco-editor/editor/editor.api.js'),
      import('shiki/core'),
      import('shiki/engine/oniguruma'),
      import('shiki/langs'),
      import('shiki/themes'),
      import('@shikijs/monaco'),
      import('monaco-editor/editor/editor.worker.js?worker')
    ])
  // the parts of VS Code's editor a read-only review uses (the core comes without them)
  await Promise.all([
    import('monaco-editor/features/codicon/register.js'),
    import('monaco-editor/features/diffEditor/register.js'),
    import('monaco-editor/features/find/register.js'),
    import('monaco-editor/features/folding/register.js'),
    import('monaco-editor/features/bracketMatching/register.js'),
    import('monaco-editor/features/stickyScroll/register.js'),
    import('monaco-editor/features/clipboard/register.js'),
    import('monaco-editor/features/cursorUndo/register.js'),
    import('monaco-editor/features/wordOperations/register.js'),
    import('monaco-editor/features/smartSelect/register.js'),
    import('monaco-editor/features/multicursor/register.js'),
    import('monaco-editor/features/lineSelection/register.js'),
    import('monaco-editor/features/gotoLine/register.js'),
    import('monaco-editor/features/unicodeHighlighter/register.js'),
    import('monaco-editor/features/middleScroll/register.js')
  ])
  // the diff is worked out in a worker, as in VS Code
  ;(self as unknown as { MonacoEnvironment: MonacoApi.Environment }).MonacoEnvironment = {
    getWorker: () => new worker.default()
  }

  const shiki: HighlighterCore = await createHighlighterCore({ themes: [], langs: [], engine: createOnigurumaEngine(import('shiki/wasm')) })

  // the user's VS Code theme; without one, Shiki's copy of it (or VS Code's default)
  let reg: ThemeRegistrationAny
  if (look.theme) {
    reg = { name: 'kuna-vscode', type: look.theme.type, colors: look.theme.colors, tokenColors: look.theme.tokenColors } as ThemeRegistrationAny
  } else {
    const id = (slug(look.themeName) in bundledThemes ? slug(look.themeName) : 'dark-plus') as keyof typeof bundledThemes
    reg = { ...(await bundledThemes[id]()).default, name: 'kuna-vscode' }
  }
  await shiki.loadTheme(reg)
  const { colorMap } = shiki.setTheme('kuna-vscode')
  const resolved = shiki.getTheme('kuna-vscode')
  const base = textmateThemeToMonacoTheme(resolved)
  // tokens are named by their colour and style (c<i>, c<i>.ib …): one rule each
  const STYLES = ['', 'i', 'b', 'ib', 'u', 'iu', 'bu', 'ibu', 's', 'is', 'bs', 'ibs', 'us', 'ius', 'bus', 'ibus']
  const styleName: Record<string, string> = { i: 'italic', b: 'bold', u: 'underline', s: 'strikethrough' }
  const rules: MonacoApi.editor.ITokenThemeRule[] = [{ token: '', foreground: hex(colorMap[1]), background: hex(colorMap[2]) }]
  colorMap.forEach((c, i) => {
    const fg = hex(c)
    if (!fg || i === 0) return
    for (const s of STYLES) {
      rules.push({ token: s ? `c${i}.${s}` : `c${i}`, foreground: fg, fontStyle: [...s].map((x) => styleName[x]).join(' ') })
    }
  })
  const dark = resolved.type !== 'light'
  monaco.editor.defineTheme('kuna-vscode', { base: dark ? 'vs-dark' : 'vs', inherit: false, colors: (base as { colors?: Record<string, string> }).colors ?? {}, rules })
  monaco.editor.setTheme('kuna-vscode')

  const ready = new Map<string, Promise<string>>()
  const langs = bundledLanguages as Record<string, () => Promise<unknown>>

  const register = async (id: string): Promise<string> => {
    await shiki.loadLanguage(langs[id] as Parameters<HighlighterCore['loadLanguage']>[0])
    const grammar = shiki.getLanguage(id)
    monaco.languages.register({ id })
    // brackets for VS Code's bracket pair colours and matching
    monaco.languages.setLanguageConfiguration(id, {
      brackets: [
        ['{', '}'],
        ['[', ']'],
        ['(', ')']
      ]
    })
    monaco.languages.setTokensProvider(id, {
      getInitialState: () => new LineState(null),
      tokenize(line: string, state: MonacoApi.languages.IState) {
        const st = state as LineState
        if (line.length >= MAX_LINE) return { endState: st, tokens: [{ startIndex: 0, scopes: '' }] }
        const res = grammar.tokenizeLine2(line, st.stack as Parameters<typeof grammar.tokenizeLine2>[1], 500)
        const tokens: MonacoApi.languages.IToken[] = []
        for (let j = 0; j < res.tokens.length; j += 2) {
          const meta = res.tokens[j + 1]
          // vscode-textmate's packed token: font style in bits 11–14, foreground in 15–23
          const style = (meta >>> 11) & 0xf
          const fg = (meta >>> 15) & 0x1ff
          const s = (style & 1 ? 'i' : '') + (style & 2 ? 'b' : '') + (style & 4 ? 'u' : '') + (style & 8 ? 's' : '')
          tokens.push({ startIndex: res.tokens[j], scopes: s ? `c${fg}.${s}` : `c${fg}` })
        }
        return { endState: new LineState(res.ruleStack), tokens }
      }
    })
    return id
  }

  const language = (path: string): Promise<string> => {
    const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
    const vs = languageOf(path, look.languages, look.associations)
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
    const candidates = [vs && (VS_TO_SHIKI[vs] ?? vs), ext, name].filter((c): c is string => !!c)
    const id = candidates.find((c) => c in langs)
    if (!id) return Promise.resolve('plaintext')
    let p = ready.get(id)
    if (!p) {
      p = register(id).catch(() => 'plaintext')
      ready.set(id, p)
    }
    return p
  }

  return { monaco, theme: 'kuna-vscode', colors: Object.fromEntries(Object.entries(resolved.colors ?? {})), dark, language }
}

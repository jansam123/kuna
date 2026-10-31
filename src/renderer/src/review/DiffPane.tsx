import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type * as MonacoApi from 'monaco-editor/editor/editor.api.js'
import type { ReviewComment } from '@shared/git'
import type { VscodeLook } from '@shared/vscode'
import { bytes } from '../format'
import type { EditorEnv } from './monaco'

type Editor = MonacoApi.editor.IStandaloneCodeEditor
type DiffEditor = MonacoApi.editor.IStandaloneDiffEditor

/** What the pane shows: two versions of a file, or one (browsing). */
export interface Shown {
  /** which list row it is (a file can be in several) */
  key: string
  path: string
  oldPath?: string
  mode: 'diff' | 'file'
  /** text of each side; null: the file does not exist there */
  left?: string | null
  right?: string | null
  /** pictures, as blob: URLs */
  leftImage?: string | null
  rightImage?: string | null
  leftSize?: number
  rightSize?: number
  binary?: boolean
  tooBig?: boolean
  error?: string
  loading?: boolean
}

/** A comment being written: where, and the lines it is about. */
export interface Draft {
  path: string
  side: 'old' | 'new'
  start: number
  end: number
  code: string[]
  /** editing a saved comment */
  id?: string
  text?: string
}

export interface PaneApi {
  focus(): void
  hasFocus(): boolean
  /** Monaco's find box is open (Esc is its) */
  findOpen(): boolean
  /** start a comment on the selected lines (or the cursor's) */
  commentHere(): void
  nextChange(dir: 1 | -1): void
  /** the text in the comment box */
  draftText(): string
  focusDraft(): void
}

function options(look: VscodeLook, env: EditorEnv): MonacoApi.editor.IEditorOptions & MonacoApi.editor.IGlobalEditorOptions {
  const e = look.editor
  return {
    theme: env.theme,
    readOnly: true,
    domReadOnly: true,
    fontFamily: e.fontFamily,
    fontSize: e.fontSize,
    fontWeight: e.fontWeight,
    fontLigatures: e.fontLigatures,
    lineHeight: e.lineHeight,
    letterSpacing: e.letterSpacing,
    renderWhitespace: e.renderWhitespace,
    wordWrap: e.wordWrap,
    minimap: { enabled: e.minimap },
    stickyScroll: { enabled: e.stickyScroll },
    bracketPairColorization: { enabled: e.bracketPairs },
    scrollBeyondLastLine: false,
    contextmenu: false,
    glyphMargin: true,
    folding: true,
    lineNumbersMinChars: 4,
    smoothScrolling: true,
    fixedOverflowWidgets: true,
    automaticLayout: true,
    renderLineHighlightOnlyWhenFocus: true,
    occurrencesHighlight: 'off',
    links: false,
    hover: { enabled: 'off' },
    padding: { top: 6 }
  }
}

/** which editor a model was made for */
const modelOwner = new WeakMap<object, 'diff' | 'file'>()

interface Zone {
  key: string
  editor: Editor
  id: string
  dom: HTMLDivElement
  zone: MonacoApi.editor.IViewZone
  line: number
}

export function DiffPane({
  env,
  look,
  shown,
  sideBySide,
  comments,
  draft,
  setDraft,
  onSave,
  onRemove,
  api
}: {
  env: EditorEnv
  look: VscodeLook
  shown: Shown | null
  sideBySide: boolean
  comments: ReviewComment[]
  draft: Draft | null
  setDraft: (d: Draft | null) => void
  onSave: () => void
  onRemove: (id: string) => void
  api: React.RefObject<PaneApi | null>
}): React.JSX.Element {
  const { monaco } = env
  const diffHost = useRef<HTMLDivElement>(null)
  const fileHost = useRef<HTMLDivElement>(null)
  const diff = useRef<DiffEditor | null>(null)
  const file = useRef<Editor | null>(null)
  const models = useRef<MonacoApi.editor.ITextModel[]>([])
  const shownRef = useRef(shown)
  shownRef.current = shown
  const draftArea = useRef<HTMLTextAreaElement | null>(null)
  /** bumped when new models are in, so the comment boxes go back in */
  const [version, setVersion] = useState(0)
  const [zones, setZones] = useState<Zone[]>([])
  const zonesRef = useRef<Zone[]>([])
  const mode = shown?.mode ?? 'diff'
  const text = !!shown && !shown.loading && !shown.error && !shown.binary && !shown.tooBig && shown.leftImage === undefined && shown.rightImage === undefined

  // the editors, made once
  useEffect(() => {
    const opts = options(look, env)
    const d = monaco.editor.createDiffEditor(diffHost.current!, {
      ...opts,
      originalEditable: false,
      renderSideBySide: sideBySide,
      ignoreTrimWhitespace: look.editor.ignoreTrimWhitespace,
      hideUnchangedRegions: { enabled: look.editor.hideUnchangedRegions },
      renderMarginRevertIcon: false,
      renderGutterMenu: false,
      renderOverviewRuler: true,
      diffAlgorithm: 'advanced',
      enableSplitViewResizing: true
    })
    const f = monaco.editor.create(fileHost.current!, opts)
    diff.current = d
    file.current = f
    // the editor font may still be loading: measure again once it is in
    void document.fonts.ready.then(() => monaco.editor.remeasureFonts())

    // a + in the gutter of the line under the pointer; a click starts a comment there
    const hover = (ed: Editor, side: 'old' | 'new'): MonacoApi.IDisposable[] => {
      const deco = ed.createDecorationsCollection()
      return [
        ed.onMouseMove((e) => {
          const line = e.target.position?.lineNumber
          deco.set(line ? [{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: 'rv-add-glyph' } }] : [])
        }),
        ed.onMouseLeave(() => deco.clear()),
        ed.onMouseDown((e) => {
          if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !e.target.position) return
          const s = shownRef.current
          const model = ed.getModel()
          if (!s || !model) return
          const line = e.target.position.lineNumber
          const sel = ed.getSelection()
          const inSel = sel && !sel.isEmpty() && sel.startLineNumber <= line && line <= sel.endLineNumber
          const start = inSel ? sel.startLineNumber : line
          const end = inSel ? lastLine(sel) : line
          setDraft({ path: s.path, side, start, end, code: linesOf(model, start, end) })
        })
      ]
    }
    const subs = [...hover(d.getModifiedEditor(), 'new'), ...hover(d.getOriginalEditor(), 'old'), ...hover(f, 'new')]
    return () => {
      subs.forEach((s) => s.dispose())
      d.dispose()
      f.dispose()
      models.current.forEach((m) => m.dispose())
      models.current = []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env, look])

  useEffect(() => {
    diff.current?.updateOptions({ renderSideBySide: sideBySide })
  }, [sideBySide])

  // the file's text into the editor (its language's grammar first)
  const lastKey = useRef<string | null>(null)
  useEffect(() => {
    if (!shown || !text) return
    let live = true
    void env.language(shown.path).then((lang) => {
      if (!live) return
      const same = lastKey.current === shown.key
      lastKey.current = shown.key
      // each editor's models go only when that editor has new ones (the other still shows its own)
      const which = shown.mode === 'file' ? 'file' : 'diff'
      const old = models.current.filter((m) => modelOwner.get(m) === which)
      // a new model can pull the keyboard into the editor (when it missed a blur): it stays where it was
      const had = document.activeElement as HTMLElement | null
      const inEditor = !!had && (!!diffHost.current?.contains(had) || !!fileHost.current?.contains(had))
      queueMicrotask(() => {
        if (had && !inEditor && had.isConnected && document.activeElement !== had) had.focus()
      })
      const tab = { tabSize: look.editor.tabSize }
      if (shown.mode === 'file') {
        const ed = file.current!
        const view = same ? ed.saveViewState() : null
        const m = monaco.editor.createModel(shown.right ?? '', lang)
        m.updateOptions(tab)
        ed.setModel(m)
        modelOwner.set(m, 'file')
        models.current = [...models.current.filter((x) => !old.includes(x)), m]
        if (view) ed.restoreViewState(view)
        else ed.setScrollTop(0)
      } else {
        const d = diff.current!
        const view = same ? d.saveViewState() : null
        const o = monaco.editor.createModel(shown.left ?? '', lang)
        const m = monaco.editor.createModel(shown.right ?? '', lang)
        o.updateOptions(tab)
        m.updateOptions(tab)
        d.setModel({ original: o, modified: m })
        modelOwner.set(o, 'diff')
        modelOwner.set(m, 'diff')
        models.current = [...models.current.filter((x) => !old.includes(x)), o, m]
        if (view) d.restoreViewState(view)
        else {
          // to the first change once the diff is worked out
          const once = d.onDidUpdateDiff(() => {
            once.dispose()
            const c = d.getLineChanges()?.[0]
            if (!c) return
            if (c.modifiedEndLineNumber > 0) d.getModifiedEditor().revealLineNearTop(c.modifiedStartLineNumber)
            else d.getOriginalEditor().revealLineNearTop(c.originalStartLineNumber)
          })
        }
      }
      old.forEach((x) => x.dispose())
      setVersion((v) => v + 1)
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, text])

  // comment boxes under their lines: saved comments and the one being written
  const commentsHere = shown ? comments.filter((c) => c.path === shown.path) : []
  const draftHere = shown && draft && draft.path === shown.path ? draft : null
  const items = [
    ...commentsHere.filter((c) => c.id !== draftHere?.id).map((c) => ({ key: c.id, side: c.side, line: c.end })),
    ...(draftHere ? [{ key: 'draft', side: draftHere.side, line: draftHere.end }] : [])
  ]
  const itemsKey = items.map((i) => `${i.key}:${i.side}:${i.line}`).join('|')

  useLayoutEffect(() => {
    const d = diff.current
    const f = file.current
    if (!d || !f) return
    const editorFor = (side: 'old' | 'new'): Editor => (mode === 'file' ? f : side === 'old' ? d.getOriginalEditor() : d.getModifiedEditor())
    for (const z of zonesRef.current) z.editor.changeViewZones((acc) => acc.removeZone(z.id))
    const next: Zone[] = []
    if (text) {
      for (const it of items) {
        const ed = editorFor(it.side)
        const dom = document.createElement('div')
        dom.className = 'rv-zone'
        // the box's own clicks and keys are not the editor's
        for (const t of ['mousedown', 'pointerdown', 'keydown', 'keyup', 'keypress', 'contextmenu', 'dblclick']) dom.addEventListener(t, (e) => e.stopPropagation())
        const zone: MonacoApi.editor.IViewZone = { afterLineNumber: it.line, heightInPx: 96, domNode: dom, suppressMouseDown: true }
        let id = ''
        ed.changeViewZones((acc) => (id = acc.addZone(zone)))
        next.push({ key: it.key, editor: ed, id, dom, zone, line: it.line })
      }
    }
    zonesRef.current = next
    setZones(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsKey, version, mode, sideBySide, text])

  useEffect(
    () => () => {
      for (const z of zonesRef.current) z.editor.changeViewZones((acc) => acc.removeZone(z.id))
    },
    []
  )

  // each box as tall as what is in it
  useEffect(() => {
    const ros = zones.map((z) => {
      const ro = new ResizeObserver(() => {
        const inner = z.dom.firstElementChild as HTMLElement | null
        const h = Math.ceil((inner?.offsetHeight ?? 80) + 8)
        if (h === z.zone.heightInPx) return
        z.zone.heightInPx = h
        z.editor.changeViewZones((acc) => acc.layoutZone(z.id))
      })
      const inner = z.dom.firstElementChild
      if (inner) ro.observe(inner)
      return ro
    })
    return () => ros.forEach((r) => r.disconnect())
  }, [zones])

  const editorWithFocus = (): Editor | null => {
    if (mode === 'file') return file.current?.hasTextFocus() ? file.current : null
    const d = diff.current
    if (!d) return null
    if (d.getOriginalEditor().hasTextFocus()) return d.getOriginalEditor()
    if (d.getModifiedEditor().hasTextFocus()) return d.getModifiedEditor()
    return null
  }

  api.current = {
    focus: () => {
      if (mode === 'file') file.current?.focus()
      else {
        const d = diff.current
        // a deleted file has only its old side
        if (d && shownRef.current?.right == null && sideBySide) d.getOriginalEditor().focus()
        else d?.getModifiedEditor().focus()
      }
    },
    hasFocus: () => {
      const el = document.activeElement
      return !!el && (diffHost.current?.contains(el) || fileHost.current?.contains(el) || false) && !el.closest('.rv-zone')
    },
    findOpen: () => !!(mode === 'file' ? fileHost : diffHost).current?.querySelector('.find-widget.visible'),
    commentHere: () => {
      const s = shownRef.current
      if (!s || !text) return
      const ed = editorWithFocus() ?? (mode === 'file' ? file.current : diff.current?.getModifiedEditor()) ?? null
      const model = ed?.getModel()
      const sel = ed?.getSelection()
      if (!ed || !model || !sel) return
      const side: 'old' | 'new' = mode === 'diff' && ed === diff.current?.getOriginalEditor() ? 'old' : 'new'
      const start = sel.startLineNumber
      const end = lastLine(sel)
      setDraft({ path: s.path, side, start, end, code: linesOf(model, start, end) })
    },
    nextChange: (dir) => {
      const d = diff.current
      if (mode !== 'diff' || !d) return
      d.goToDiff(dir > 0 ? 'next' : 'previous')
    },
    draftText: () => draftArea.current?.value ?? '',
    focusDraft: () => draftArea.current?.focus()
  }

  const msg = (() => {
    if (!shown) return 'Pick a file on the left.'
    if (shown.loading) return null
    if (shown.error) return shown.error
    if (shown.tooBig) return `Too large to show here (${bytes(Math.max(shown.leftSize ?? 0, shown.rightSize ?? 0))}).`
    if (shown.binary) return `A binary file${shown.rightSize != null ? `, ${bytes(shown.rightSize)}` : ''}: nothing to show as text.`
    return null
  })()
  const images = !!shown && !shown.loading && (shown.leftImage !== undefined || shown.rightImage !== undefined)

  return (
    <div className="rv-editor">
      <div ref={diffHost} className="rv-monaco" style={{ display: text && mode === 'diff' ? 'block' : 'none' }} />
      <div ref={fileHost} className="rv-monaco" style={{ display: text && mode === 'file' ? 'block' : 'none' }} />
      {images && shown && (
        <div className={`rv-images ${shown.mode === 'file' ? 'single' : ''}`}>
          {shown.mode === 'diff' && (
            <figure>
              <figcaption>Before{shown.leftSize != null && shown.leftImage ? ` · ${bytes(shown.leftSize)}` : ''}</figcaption>
              {shown.leftImage ? <img src={shown.leftImage} alt="before" draggable={false} /> : <div className="rv-img-none">not there</div>}
            </figure>
          )}
          <figure>
            <figcaption>{shown.mode === 'diff' ? 'After' : shown.path.split('/').pop()}{shown.rightSize != null && shown.rightImage ? ` · ${bytes(shown.rightSize)}` : ''}</figcaption>
            {shown.rightImage ? <img src={shown.rightImage} alt="after" draggable={false} /> : <div className="rv-img-none">deleted</div>}
          </figure>
        </div>
      )}
      {msg && <div className="rv-msg">{msg}</div>}
      {zones.map((z) => {
        if (z.key === 'draft' && draftHere) {
          return createPortal(
            <DraftBox key={`draft:${draftHere.id ?? ''}:${draftHere.start}:${draftHere.end}`} draft={draftHere} area={draftArea} onSave={onSave} onCancel={() => setDraft(null)} />,
            z.dom
          )
        }
        const c = commentsHere.find((x) => x.id === z.key)
        return c
          ? createPortal(
              <div className="rv-comment" key={c.id}>
                <div className="rv-c-head">
                  <span className="rv-c-where">{c.start === c.end ? `line ${c.start}` : `lines ${c.start}–${c.end}`}{c.side === 'old' ? ' (before)' : ''}</span>
                  <span className="ph-spacer" />
                  <button onClick={() => setDraft({ path: c.path, side: c.side, start: c.start, end: c.end, code: c.code, id: c.id, text: c.text })}>Edit</button>
                  <button onClick={() => onRemove(c.id)}>Delete</button>
                </div>
                <div className="rv-c-text">{c.text}</div>
              </div>,
              z.dom
            )
          : null
      })}
    </div>
  )
}

function DraftBox({
  draft,
  area,
  onSave,
  onCancel
}: {
  draft: Draft
  area: React.RefObject<HTMLTextAreaElement | null>
  onSave: () => void
  onCancel: () => void
}): React.JSX.Element {
  useEffect(() => {
    // after the editor has let go of the focus
    const t = setTimeout(() => area.current?.focus(), 30)
    return () => clearTimeout(t)
  }, [area])
  return (
    <div className="rv-comment rv-draft">
      <div className="rv-c-head">
        <span className="rv-c-where">
          {draft.id ? 'Edit comment' : 'Comment'} on {draft.start === draft.end ? `line ${draft.start}` : `lines ${draft.start}–${draft.end}`}
          {draft.side === 'old' ? ' (before)' : ''}
        </span>
      </div>
      <textarea ref={area} defaultValue={draft.text ?? ''} rows={3} placeholder="What should the agent change here?" spellCheck />
      <div className="rv-c-actions">
        <span className="rv-c-hint">⌘↵ add · Esc Esc discard</span>
        <span className="ph-spacer" />
        <button onClick={onCancel}>Cancel</button>
        <button className="primary" onClick={onSave}>
          {draft.id ? 'Save' : 'Add comment'}
        </button>
      </div>
    </div>
  )
}

/** the last line a selection covers (one ending at a line's start does not cover it) */
function lastLine(sel: MonacoApi.Selection): number {
  return sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber
}

function linesOf(model: MonacoApi.editor.ITextModel, start: number, end: number): string[] {
  const out: string[] = []
  for (let i = start; i <= Math.min(end, model.getLineCount()); i++) out.push(model.getLineContent(i))
  return out
}

import { useEffect, useRef, useState } from 'react'
import type { Settings } from '@shared/types'
import { updateSettings, useKuna } from '../store'
import { zenColumns, zenFontSize } from '../terminals'
import { THEMES, type Theme } from '../themes'
import { closeOverlay, useOverlayKeys } from './Overlays'

/**
 * One setting, as a row. A new setting is one entry in `sections` below: the
 * row, its control and its keys (← → change it) come from its kind.
 */
type Item = { label: string; hint?: string } & (
  | { kind: 'toggle'; on: boolean; set: (on: boolean) => void }
  | { kind: 'choice'; value: string; options: { id: string; label: string }[]; set: (id: string) => void }
  | { kind: 'number'; value: number; unit: string; min: number; max: number; step?: number; set: (v: number) => void; reset?: { label: string; run: () => void } }
  | { kind: 'themes'; value: string; set: (id: string) => void }
  | { kind: 'action'; button: string; run: () => void }
)

/** ← → on a row: the other state, the next choice, a step down or up. */
function step(it: Item, d: 1 | -1): void {
  if (it.kind === 'action') return
  if (it.kind === 'toggle') it.set(!it.on)
  else if (it.kind === 'number') it.set(Math.max(it.min, Math.min(it.max, it.value + d * (it.step ?? 1))))
  else {
    const ids = it.kind === 'themes' ? THEMES.map((t) => t.id) : it.options.map((o) => o.id)
    it.set(ids[(Math.max(0, ids.indexOf(it.value)) + d + ids.length) % ids.length])
  }
}

function ThemeCard({ t, on, pick }: { t: Theme; on: boolean; pick: () => void }): React.JSX.Element {
  return (
    <button className={`theme-card ${on ? 'on' : ''}`} style={{ background: t.ground, borderColor: on ? t.accent : t.line, color: t.text }} onClick={pick}>
      <div className="tc-preview" style={{ borderColor: t.line }}>
        <div className="tc-side" style={{ background: t.panel, borderColor: t.line }}>
          <i style={{ background: t.working }} />
          <i style={{ background: t.waiting }} />
          <i style={{ background: t.idle }} />
          <i style={{ background: t.unread }} />
        </div>
        <div className="tc-pane" style={{ borderColor: t.accent }}>
          <span style={{ color: t.accent }}>●</span> <span style={{ color: t.dim }}>agent working…</span>
        </div>
        <div className="tc-pane" style={{ borderColor: t.insert }}>
          <span style={{ color: t.insert }}>▍</span>
        </div>
      </div>
      <div className="tc-name">{t.name}</div>
      <div className="tc-blurb" style={{ color: t.dim }}>
        {t.blurb}
      </div>
    </button>
  )
}

function Control({ it }: { it: Item }): React.JSX.Element {
  if (it.kind === 'themes') {
    return (
      <div className="themes">
        {THEMES.map((t) => (
          <ThemeCard key={t.id} t={t} on={t.id === it.value} pick={() => it.set(t.id)} />
        ))}
      </div>
    )
  }
  if (it.kind === 'action') {
    return (
      <div className="set-control">
        <button onClick={it.run}>{it.button}</button>
      </div>
    )
  }
  if (it.kind === 'toggle') {
    return (
      <div className="set-control" role="radiogroup" aria-label={it.label}>
        <button className={it.on ? '' : 'on'} role="radio" aria-checked={!it.on} onClick={() => it.set(false)}>
          Off
        </button>
        <button className={it.on ? 'on' : ''} role="radio" aria-checked={it.on} onClick={() => it.set(true)}>
          On
        </button>
      </div>
    )
  }
  if (it.kind === 'choice') {
    return (
      <div className="set-control" role="radiogroup" aria-label={it.label}>
        {it.options.map((o) => (
          <button key={o.id} className={o.id === it.value ? 'on' : ''} role="radio" aria-checked={o.id === it.value} onClick={() => it.set(o.id)}>
            {o.label}
          </button>
        ))}
      </div>
    )
  }
  return (
    <div className="set-control">
      {it.reset && (
        <button className="quiet" onClick={it.reset.run}>
          {it.reset.label}
        </button>
      )}
      <button onClick={() => step(it, -1)} aria-label={`${it.label}: less`}>
        −
      </button>
      <span className="mono">
        {it.value}
        {it.unit}
      </span>
      <button onClick={() => step(it, 1)} aria-label={`${it.label}: more`}>
        +
      </button>
    </div>
  )
}

export function SettingsDialog(): React.JSX.Element {
  const settings = useKuna((s) => s.settings)
  const fonts = useKuna((s) => s.fonts)
  const [at, setAt] = useState(0)
  const rows = useRef<(HTMLDivElement | null)[]>([])
  const put = (patch: Partial<Settings>): void => updateSettings(patch)

  const termSize = settings.termFontSize ?? fonts?.terminal.size ?? 12
  const editorFont = fonts?.mono.family.split(',')[0].replace(/['"]/g, '') ?? 'Editor font'
  const sections: { title: string; items: Item[] }[] = [
    {
      title: 'Look',
      items: [
        { kind: 'themes', label: 'Colour scheme', hint: 'Applies at once. Terminals stay pure black in all of them.', value: settings.theme, set: (theme) => put({ theme }) },
        {
          kind: 'choice',
          label: 'Interface font',
          hint: 'The editor font and the sizes come from your VS Code settings.',
          value: settings.uiFont ?? 'system',
          options: [
            { id: 'system', label: 'System, like VS Code' },
            { id: 'editor', label: editorFont }
          ],
          set: (id) => put({ uiFont: id as Settings['uiFont'] })
        }
      ]
    },
    {
      title: 'Sidebar and panels',
      items: [
        {
          kind: 'toggle',
          label: 'Project strip',
          hint: "A column of the projects' icons beside the list. Click one to jump to its project; a number counts the agents waiting for you.",
          on: !!settings.projectStrip,
          set: (projectStrip) => put({ projectStrip })
        },
        { kind: 'toggle', label: 'Details panel', hint: "The focused agent's context, tasks and tools, at the right. ⌘B anywhere.", on: settings.inspector, set: (inspector) => put({ inspector }) }
      ]
    },
    {
      title: 'Agents',
      items: [
        {
          kind: 'number',
          label: 'Text size',
          hint: `${fonts?.terminal.faces?.regular ?? fonts?.terminal.family ?? '…'}, from ${fonts?.terminal.source ?? '…'}. ⌘+ / ⌘− anywhere.`,
          value: termSize,
          unit: 'px',
          min: 8,
          max: 24,
          set: (termFontSize) => put({ termFontSize }),
          reset:
            settings.termFontSize !== undefined && fonts && settings.termFontSize !== fonts.terminal.size
              ? { label: `Use ${fonts.terminal.source}'s ${fonts.terminal.size}px`, run: () => put({ termFontSize: undefined }) }
              : undefined
        },
        {
          kind: 'number',
          label: 'Zen mode: text size',
          hint: 'One agent alone, to read (⇧⌘Enter). A little larger than the panes unless set. ⌘+ / ⌘− in zen.',
          value: zenFontSize(),
          unit: 'px',
          min: 10,
          max: 32,
          set: (zenFontSize) => put({ zenFontSize }),
          reset: settings.zenFontSize !== undefined ? { label: 'Follow the panes', run: () => put({ zenFontSize: undefined }) } : undefined
        },
        {
          kind: 'number',
          label: 'Zen mode: column width',
          hint: 'In characters. ⌘[ / ⌘] in zen.',
          value: zenColumns(),
          unit: '',
          min: 80,
          max: 400,
          step: 10,
          set: (zenColumns) => put({ zenColumns }),
          reset: settings.zenColumns !== undefined && settings.zenColumns !== 160 ? { label: 'Back to 160', run: () => put({ zenColumns: undefined }) } : undefined
        }
      ]
    },
    {
      title: 'Review',
      items: [
        {
          kind: 'choice',
          label: 'Diffs',
          hint: 'How the review view (⌘G) shows a changed file.',
          value: settings.reviewInline ? 'inline' : 'side',
          options: [
            { id: 'side', label: 'Side by side' },
            { id: 'inline', label: 'Inline' }
          ],
          set: (id) => put({ reviewInline: id === 'inline' })
        }
      ]
    },
    {
      title: 'Notifications',
      items: [{ kind: 'toggle', label: 'Notify me', hint: 'When an agent finishes or needs you while Kuna is in the background.', on: settings.notify, set: (notify) => put({ notify }) }]
    },
    {
      title: 'iPhone',
      items: [
        {
          kind: 'action',
          label: 'Export for iPhone',
          hint: 'A file with your projects on ssh hosts, their folders and how to reach each host, to open in Kuna on the iPhone. No passwords, no keys.',
          button: 'Export…',
          run: () => window.kuna.phoneExport()
        }
      ]
    }
  ]
  const items = sections.flatMap((s) => s.items)

  useEffect(() => {
    // in braces: scrollIntoView returns a promise in this Chromium, which React would take for a cleanup
    rows.current[at]?.scrollIntoView({ block: 'nearest' })
  }, [at])

  useOverlayKeys((ev) => {
    const cur = items[at]
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') setAt((i) => Math.max(0, Math.min(items.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1))))
    else if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') step(items[at], ev.key === 'ArrowRight' ? 1 : -1)
    else if (ev.key === ' ' && items[at].kind === 'toggle') step(items[at], 1)
    else if (ev.key === 'Enter' && cur.kind === 'action') cur.run()
    else if (ev.key === 'Enter') closeOverlay()
    else return false
    return true
  })

  let n = 0
  return (
    <div className="scrim" onMouseDown={closeOverlay}>
      <div className="dialog wide" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <p className="dim">↑ ↓ pick a setting, ← → change it, Enter runs a button. Everything applies at once.</p>
        {sections.map((sec) => (
          <div key={sec.title}>
            <div className="set-section">{sec.title}</div>
            {sec.items.map((it) => {
              const i = n++
              return (
                <div key={it.label} ref={(el) => void (rows.current[i] = el)} className={`set-row ${i === at ? 'on' : ''} ${it.kind === 'themes' ? 'tall' : ''}`} onMouseDown={() => setAt(i)}>
                  <div className="set-text">
                    <div>{it.label}</div>
                    {it.hint && <div className="set-hint">{it.hint}</div>}
                  </div>
                  <Control it={it} />
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

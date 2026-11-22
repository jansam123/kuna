import { useEffect, useMemo, useRef, useState } from 'react'
import { refOptions, validRef, type RefOption } from '@shared/git'
import { ago } from '../format'

export { refOptions, type RefOption }

/**
 * A branch list that drops down from its button: type to narrow it, ↑ ↓ and
 * Enter to pick, Esc to leave it. A commit or ref not in the list can be typed.
 */
export function RefPicker({
  options,
  current,
  onPick,
  onClose,
  title,
  typed = true,
  placeholder = 'Filter branches, or type a commit'
}: {
  options: RefOption[]
  current: string | null | undefined
  onPick: (value: string | null) => void
  onClose: () => void
  title: string
  /** a name typed that is not in the list can be picked (a commit) */
  typed?: boolean
  placeholder?: string
}): React.JSX.Element {
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    const hits = options.filter((o) => words.every((w) => `${o.label} ${o.detail ?? ''}`.toLowerCase().includes(w)))
    const name = q.trim()
    if (typed && name && validRef(name) && !options.some((o) => o.value === name)) hits.push({ value: name, label: name, detail: 'a branch, tag or commit by name', kind: 'commit' })
    return hits
  }, [q, options, typed])

  useEffect(() => {
    input.current?.focus()
    const i = options.findIndex((o) => o.value === current)
    setAt(Math.max(0, i))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    list.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' })
  }, [at, shown])

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = shown.length
      if (n) setAt((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + n) % n)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const o = shown[Math.min(at, shown.length - 1)]
      if (o) onPick(o.value)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div className="rv-picker" onMouseDown={(e) => e.stopPropagation()}>
      <div className="rv-picker-title">{title}</div>
      <input
        ref={input}
        value={q}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => {
          setQ(e.target.value)
          setAt(0)
        }}
        onKeyDown={onKey}
        onBlur={() => setTimeout(onClose, 120)}
      />
      <div className="rv-picker-list" ref={list}>
        {shown.map((o, i) => (
          <button
            key={`${o.kind}:${o.value ?? ''}`}
            className={`${i === at ? 'on' : ''} ${o.value === current ? 'current' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(o.value)}
          >
            <span className={`rv-ref-kind k-${o.kind}`}>{o.kind === 'repo' ? '▣' : o.kind === 'worktree' ? '◉' : o.kind === 'remote' ? '☁' : o.kind === 'tag' ? '#' : o.kind === 'commit' ? '•' : '⎇'}</span>
            <span className="rv-ref-name">{o.label}</span>
            <span className="rv-ref-detail">{o.detail}</span>
            {o.time ? <span className="rv-ref-age">{ago(o.time)}</span> : null}
          </button>
        ))}
        {!shown.length && <div className="rv-picker-none">Nothing matches.</div>}
      </div>
    </div>
  )
}

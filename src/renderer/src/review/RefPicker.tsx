import { useEffect, useMemo, useRef, useState } from 'react'
import { validRef, type GitInfo } from '@shared/git'
import { ago } from '../format'

export interface RefOption {
  /** null: the working tree */
  value: string | null
  label: string
  detail?: string
  kind: 'worktree' | 'branch' | 'remote' | 'tag' | 'commit'
  time?: number
}

/** Branches to compare: local ones first (newest first), then remote ones and tags. */
export function refOptions(info: GitInfo, withWorktree: boolean): RefOption[] {
  const out: RefOption[] = []
  if (withWorktree) out.push({ value: null, label: 'Working tree', detail: 'what is on disk, uncommitted changes included', kind: 'worktree' })
  const here = new Map(info.worktrees.filter((w) => w.branch).map((w) => [w.branch!, w.path]))
  const order = { branch: 0, remote: 1, tag: 2 }
  const refs = [...info.refs].sort((a, b) => order[a.kind] - order[b.kind] || b.time - a.time)
  for (const r of refs) {
    const wt = r.kind === 'branch' ? here.get(r.short) : undefined
    const marks = [r.short === info.branch ? 'checked out' : wt ? `in ${wt.split('/').pop()}` : '', r.subject].filter(Boolean)
    out.push({ value: r.short, label: r.short, detail: marks.join(' · '), kind: r.kind, time: r.time })
  }
  if (!info.branch && info.head) out.splice(withWorktree ? 1 : 0, 0, { value: 'HEAD', label: 'HEAD', detail: `detached at ${info.head.slice(0, 8)}`, kind: 'commit' })
  return out
}

/**
 * A branch list that drops down from its button: type to narrow it, ↑ ↓ and
 * Enter to pick, Esc to leave it. A commit or ref not in the list can be typed.
 */
export function RefPicker({
  options,
  current,
  onPick,
  onClose,
  title
}: {
  options: RefOption[]
  current: string | null | undefined
  onPick: (value: string | null) => void
  onClose: () => void
  title: string
}): React.JSX.Element {
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    const hits = options.filter((o) => words.every((w) => `${o.label} ${o.detail ?? ''}`.toLowerCase().includes(w)))
    const typed = q.trim()
    if (typed && validRef(typed) && !options.some((o) => o.value === typed)) hits.push({ value: typed, label: typed, detail: 'a branch, tag or commit by name', kind: 'commit' })
    return hits
  }, [q, options])

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
        placeholder="Filter branches, or type a commit"
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
            <span className={`rv-ref-kind k-${o.kind}`}>{o.kind === 'worktree' ? '◉' : o.kind === 'remote' ? '☁' : o.kind === 'tag' ? '#' : o.kind === 'commit' ? '•' : '⎇'}</span>
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

import { useEffect, useMemo, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { LOCAL_HOST, type ClaudeFileEntry } from '@shared/types'
import { useKuna } from '../store'
import { useOverlayKeys } from './Overlays'
import { localName } from '../platform'

/**
 * Markdown from .claude files (plugins included) is someone else's text: no
 * styles, forms or embeds that could restyle or overlay Kuna's own UI.
 */
const SANITIZE = {
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed'],
  FORBID_ATTR: ['style']
}

const GROUPS: { title: string; match: (e: ClaudeFileEntry) => boolean }[] = [
  { title: 'Memory & settings', match: (e) => e.scope === 'global' && (e.kind === 'memory' || e.kind === 'settings') },
  { title: 'Skills', match: (e) => e.scope === 'global' && e.kind === 'skill' },
  { title: 'Agents', match: (e) => e.scope === 'global' && e.kind === 'agent' },
  { title: 'Commands', match: (e) => e.scope === 'global' && (e.kind === 'command' || e.kind === 'other') },
  { title: 'In project folders', match: (e) => e.scope === 'project' },
  { title: 'From plugins', match: (e) => e.scope === 'plugin' }
]

function splitFrontmatter(text: string): { meta: [string, string][]; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { meta: [], body: text }
  const meta: [string, string][] = []
  for (const line of m[1].split('\n')) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line)
    if (kv) meta.push([kv[1], kv[2].replace(/^["']|["']$/g, '')])
  }
  return { meta, body: text.slice(m[0].length) }
}

/** Browse ~/.claude (and project .claude folders) on this Mac and on any project host. */
export function ClaudeBrowser({ initialHost }: { initialHost?: string }): React.JSX.Element {
  const projects = useKuna((s) => s.projects)
  const hostList = useMemo(() => [...new Set([LOCAL_HOST, ...projects.map((p) => p.host)])], [projects])
  const [host, setHost] = useState(initialHost ?? LOCAL_HOST)
  const [entries, setEntries] = useState<ClaudeFileEntry[] | null>(null)
  const [cursor, setCursor] = useState(0)
  const [filter, setFilter] = useState('')
  const [content, setContent] = useState<{ path: string; text: string } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setEntries(null)
    setCursor(0)
    const cwds = projects.filter((p) => p.host === host).flatMap((p) => p.folders.map((f) => f.path))
    void window.kuna.claude.list(host, cwds).then((list) => !cancelled && setEntries(list))
    return () => {
      cancelled = true
    }
  }, [host, projects])

  const flat = useMemo(() => {
    const f = filter.toLowerCase()
    const out: { group: string; entry: ClaudeFileEntry }[] = []
    for (const g of GROUPS) {
      for (const e of entries ?? []) {
        if (!g.match(e)) continue
        if (f && !e.name.toLowerCase().includes(f) && !e.path.toLowerCase().includes(f)) continue
        out.push({ group: g.title, entry: e })
      }
    }
    return out
  }, [entries, filter])

  const current = flat[Math.min(cursor, flat.length - 1)]?.entry

  useEffect(() => {
    if (!current) return setContent(null)
    let cancelled = false
    const t = setTimeout(() => {
      void window.kuna.claude.read(host, current.path).then((text) => !cancelled && setContent({ path: current.path, text }))
    }, 60)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [current, host])

  useEffect(() => {
    listRef.current?.querySelector('.cb-item.on')?.scrollIntoView({ block: 'nearest' })
    viewRef.current?.scrollTo(0, 0)
  }, [cursor])

  useOverlayKeys((ev) => {
    switch (ev.key) {
      case 'ArrowDown':
        setCursor((c) => Math.min(flat.length - 1, c + 1))
        return true
      case 'ArrowUp':
        setCursor((c) => Math.max(0, c - 1))
        return true
      case 'PageDown':
        viewRef.current?.scrollBy({ top: 300 })
        return true
      case 'PageUp':
        viewRef.current?.scrollBy({ top: -300 })
        return true
      case 'Tab': {
        const i = hostList.indexOf(host)
        setHost(hostList[(i + (ev.shiftKey ? hostList.length - 1 : 1)) % hostList.length])
        return true
      }
      case 'Escape':
        if (!filter) return false
        setFilter('')
        return true
    }
    return false
  })

  const rendered = useMemo(() => {
    if (!content) return null
    if (/\.json$/.test(content.path)) return { meta: [], html: null, raw: content.text }
    const { meta, body } = splitFrontmatter(content.text)
    return { meta, html: DOMPurify.sanitize(marked.parse(body, { async: false }) as string, SANITIZE), raw: null }
  }, [content])

  let lastGroup = ''
  return (
    <div className="scrim">
      <div className="claude-browser">
        <header className="cb-head">
          <h2>.claude</h2>
          <div className="cb-hosts">
            {hostList.map((h) => (
              <button key={h} className={h === host ? 'on' : ''} onClick={() => setHost(h)}>
                {h === LOCAL_HOST ? localName.toLowerCase() : h}
              </button>
            ))}
          </div>
          <input autoFocus className="cb-filter" placeholder="Filter skills, agents, commands…" value={filter} onChange={(e) => {
              setFilter(e.target.value)
              setCursor(0)
            }}
          />
          <span className="media-keys">↑ ↓ select · Tab switch host · PgUp/PgDn scroll · Esc close</span>
        </header>
        <div className="cb-body">
          <div className="cb-list" ref={listRef}>
            {!entries && <div className="dim pad">Reading {host === LOCAL_HOST ? '~/.claude' : `${host}:~/.claude`}…</div>}
            {entries && !flat.length && <div className="dim pad">Nothing here{filter ? ' matches the filter' : ''}.</div>}
            {flat.map(({ group, entry }, i) => {
              const head = group !== lastGroup ? <div className="cb-group">{group}</div> : null
              lastGroup = group
              return (
                <div key={entry.path}>
                  {head}
                  <div className={`cb-item ${i === cursor ? 'on' : ''}`} onClick={() => setCursor(i)} title={entry.path}>
                    <span className={`cb-kind k-${entry.kind}`}>{entry.kind}</span>
                    <span className="cb-name">{entry.name}</span>
                  </div>
                </div>
              )
            })}
          </div>
          <div className="cb-view" ref={viewRef}>
            {current && <div className="cb-path">{current.path}</div>}
            {rendered?.meta.length ? (
              <dl className="cb-meta">
                {rendered.meta.map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {rendered?.raw != null && <pre className="cb-raw">{rendered.raw}</pre>}
            {rendered?.html != null && <article className="md" dangerouslySetInnerHTML={{ __html: rendered.html }} />}
          </div>
        </div>
      </div>
    </div>
  )
}

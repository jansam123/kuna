import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { gridRows } from '@shared/layout'
import { focusPane, swapTabs } from '../actions'
import { agentTitle, contextOf, doingText, modeLabel, needsOptions, needsText, shortModel, tokens } from '../format'
import { isUnread, set, useKuna } from '../store'
import { fitTerminal, getTerminal, terminalEntry } from '../terminals'
import { folderOfAgent } from '../tree'
import { StatusDot } from './StatusDot'
import { TexText } from './TexText'
import { keyLabel } from '../platform'

/** drag-and-drop type for a pane header (its tab index) */
const TAB_DRAG = 'application/x-kuna-tab'

/**
 * How many PDFs and images Space would show for this agent: those in its
 * newest replies that name any. Looked up when the pane opens and again when
 * a reply lands (never while it works), so a host sees one quick `stat` per
 * reply, and none if no reply mentions a figure.
 */
function MediaCount({ agentKey }: { agentKey: string }): React.JSX.Element | null {
  const status = useKuna((s) => s.agents[agentKey]?.status)
  const reply = useKuna((s) => s.agents[agentKey]?.lastReply)
  const turns = useKuna((s) => s.details[agentKey]?.turns)
  const [count, setCount] = useState<{ pdf: number; img: number; md: number } | null>(null)
  const settled = status !== undefined && status !== 'working' && status !== 'starting'
  useEffect(() => {
    if (!settled) return
    let live = true
    window.kuna.media
      .list(agentKey)
      .then((page) => {
        if (!live) return
        const pdf = page.items.filter((it) => it.kind === 'pdf').length
        const md = page.items.filter((it) => it.kind === 'md').length
        setCount({ pdf, md, img: page.items.length - pdf - md })
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [agentKey, settled, reply, turns])
  if (!count || count.pdf + count.img + count.md === 0) return null
  const what = [
    count.pdf && `${count.pdf} PDF${count.pdf > 1 ? 's' : ''}`,
    count.img && `${count.img} image${count.img > 1 ? 's' : ''}`,
    count.md && `${count.md} Markdown file${count.md > 1 ? 's' : ''}`
  ]
    .filter(Boolean)
    .join(', ')
  return (
    <span className="chip media-count" title={`${what} from its latest replies · Space shows them`} onClick={() => set({ overlay: { kind: 'media', key: agentKey } })}>
      {count.pdf > 0 && (
        <span>
          <b>{count.pdf}</b> pdf
        </span>
      )}
      {count.img > 0 && (
        <span>
          <b>{count.img}</b> img
        </span>
      )}
      {count.md > 0 && (
        <span>
          <b>{count.md}</b> md
        </span>
      )}
    </span>
  )
}

function PaneHeader({ agentKey, index, unread }: { agentKey: string; index: number; unread: boolean }): React.JSX.Element {
  const a = useKuna((s) => s.agents[agentKey])
  const d = useKuna((s) => s.details[agentKey])
  const projects = useKuna((s) => s.projects)
  const agents = useKuna((s) => s.agents)
  const hosts = useKuna((s) => s.hosts)
  const armed = useKuna((s) => s.armedKill?.key === agentKey)
  useKuna((s) => s.names[agentKey])
  const where = useMemo(() => folderOfAgent(projects, Object.values(agents), hosts).get(agentKey), [projects, agents, hosts, agentKey])

  if (!a) {
    return (
      <div className="pane-head">
        <span className="ph-index">{index + 1}</span>
        <span className="ph-title dim">Agent is gone</span>
        <span className="ph-spacer" />
        <span className="ph-hint">{keyLabel('⌘W closes this tab')}</span>
      </div>
    )
  }
  const ctx = contextOf(a, d)
  const todos = d?.todos ?? []
  const doneTodos = todos.filter((t) => t.status === 'completed').length
  const subs = d?.subagents.filter((s) => !s.done).length ?? 0
  const mode = modeLabel(d?.permissionMode ?? a.permissionMode)
  return (
    <div
      className="pane-head"
      draggable
      title="Drag onto another pane to swap them"
      onDragStart={(e) => {
        e.dataTransfer.setData(TAB_DRAG, String(index))
        e.dataTransfer.effectAllowed = 'move'
      }}
    >
      <span className="ph-index">{index + 1}</span>
      {where && (
        <span className="ph-repo" style={{ color: where.folder.color }}>
          <TexText text={where.folder.name} />
        </span>
      )}
      <span className="ph-title">{armed ? 'Press Ctrl+X again to kill this agent' : agentTitle(a, d)}</span>
      <MediaCount agentKey={agentKey} />
      {unread && (
        <span className="ph-unread" title="New since you last looked · landing on this tab again clears it">
          <span className="unread-mark" />
          new
        </span>
      )}
      {subs > 0 && <span className="chip" title="Subagents running">{subs} sub</span>}
      {todos.length > 0 && (
        <span className="chip" title="Tasks done">
          {doneTodos}/{todos.length}
        </span>
      )}
      {mode && <span className={`chip mode mode-${d?.permissionMode ?? a.permissionMode}`}>{mode}</span>}
      {ctx.tokens > 0 && (
        <span className={`chip ctx ctx-${ctx.level}`} title={`${tokens(ctx.tokens)} of ${tokens(ctx.window)} tokens in context`}>
          <span className="ctx-bar">
            <span style={{ width: `${ctx.pct}%` }} />
          </span>
          {tokens(ctx.tokens)}
        </span>
      )}
      {d?.model && <span className="chip dim">{shortModel(d.model)}</span>}
      {a.status === 'exited' && <span className="ph-hint">{a.kind === 'claude' ? 'stopped · Enter reopens' : keyLabel('⇧⌘R resume')}</span>}
      {/* one word here; what it is doing in full is in the tooltip and the inspector */}
      <span className={`ph-status st-${a.status}`} title={[doingText(a), a.detail].filter(Boolean).join('\n')}>
        <StatusDot status={a.status} />
        {doingText(a, true)}
      </span>
    </div>
  )
}

/** What the agent is waiting on, right under the header, with its numbered choices. */
export function QuestionStrip({ agentKey }: { agentKey: string }): React.JSX.Element | null {
  const a = useKuna((s) => s.agents[agentKey])
  const d = useKuna((s) => s.details[agentKey])
  if (!a) return null
  const text = needsText(a, d)
  if (!text) return null
  const options = needsOptions(a, d)
  return (
    <div className="question-strip">
      <span className="qs-mark">needs you</span>
      <span className="qs-text">{text}</span>
      {options.length > 0 ? (
        <span className="qs-options">
          {options.map((o, i) => (
            <span key={i}>
              <kbd>{i + 1}</kbd> {o}
            </span>
          ))}
        </span>
      ) : (
        <span className="qs-hint">answer with the number shown below, or Enter to type</span>
      )}
    </div>
  )
}

function AgentPane({ agentKey, index }: { agentKey: string; index: number }): React.JSX.Element {
  const slot = useRef<HTMLDivElement>(null)
  const focused = useKuna((s) => s.zone === 'pane' && s.paneIndex === index)
  const typing = useKuna((s) => s.zone === 'pane' && s.paneIndex === index && s.mode === 'insert')
  const unread = useKuna((s) => !!s.agents[agentKey] && isUnread(s.agents[agentKey], s.lastSeen))
  const escHint = useKuna((s) => s.escHint)
  // the plot viewer has the terminal while it shows this agent's files; it comes back after
  const lent = useKuna((s) => s.overlay?.kind === 'media' && s.overlay.key === agentKey)
  const projects = useKuna((s) => s.projects)
  const agents = useKuna((s) => s.agents)
  const hosts = useKuna((s) => s.hosts)
  const [dropping, setDropping] = useState(false)
  const color = useMemo(
    () => folderOfAgent(projects, Object.values(agents), hosts).get(agentKey)?.folder.color ?? 'var(--faint)',
    [projects, agents, hosts, agentKey]
  )

  useLayoutEffect(() => {
    if (lent) return
    const e = getTerminal(agentKey)
    slot.current?.appendChild(e.el)
    fitTerminal(agentKey)
  }, [agentKey, lent])

  useEffect(() => {
    const el = slot.current
    if (!el) return
    let t: ReturnType<typeof setTimeout> | undefined
    const ro = new ResizeObserver(() => {
      clearTimeout(t)
      t = setTimeout(() => fitTerminal(agentKey), 40)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      clearTimeout(t)
    }
  }, [agentKey])

  return (
    <section
      className={`pane ${focused ? 'focused' : ''} ${typing ? 'typing' : ''} ${unread ? 'unread' : ''} ${dropping ? 'drop-target' : ''}`}
      style={{ '--repo': color } as React.CSSProperties}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(TAB_DRAG)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDropping(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
      }}
      onDrop={(e) => {
        setDropping(false)
        const from = Number(e.dataTransfer.getData(TAB_DRAG))
        if (e.dataTransfer.types.includes(TAB_DRAG) && Number.isInteger(from)) {
          e.preventDefault()
          swapTabs(from, index)
        }
      }}
      onMouseDown={() => {
        if (!focused) focusPane(index)
      }}
      onDoubleClick={() => {
        const e = terminalEntry(agentKey)
        if (e?.ptyId) {
          set({ mode: 'insert' })
          e.typed = 0
          e.term.focus()
        }
      }}
    >
      <PaneHeader agentKey={agentKey} index={index} unread={unread} />
      <QuestionStrip agentKey={agentKey} />
      <div className="pane-body" ref={slot} />
      {typing && <div className="typing-hint">{escHint ? 'Esc again to stop typing' : 'typing · Enter sends · Esc Esc stops'}</div>}
    </section>
  )
}

function EmptyMain(): React.JSX.Element {
  const hasProjects = useKuna((s) => s.projects.length > 0)
  return (
    <div className="empty-main">
      <h1>No agents open</h1>
      {hasProjects ? (
        <p>Pick a folder in the sidebar and start typing to launch an agent, or select a running agent and press Enter to open it.</p>
      ) : (
        <p>{keyLabel('Create a project with ⌘N, add a folder with ⌘O, then type a task to launch your first agent.')}</p>
      )}
      <dl className="keys-mini">
        <dt>↑ ↓ ← →</dt>
        <dd>move between sidebar and tabs</dd>
        <dt>type</dt>
        <dd>write to the selected agent, or launch one</dd>
        <dt>Esc Esc</dt>
        <dd>stop typing</dd>
        <dt>Space</dt>
        <dd>preview the agent's latest plot or PDF</dd>
        <dt>{keyLabel('⌘W')} · Ctrl+X</dt>
        <dd>close tab · kill agent</dd>
        <dt>{keyLabel('⌘/')}</dt>
        <dd>all shortcuts</dd>
      </dl>
    </div>
  )
}

export function PaneGrid(): React.JSX.Element {
  const tabs = useKuna((s) => s.tabs)
  const rows = gridRows(tabs.length)
  if (!tabs.length) return <EmptyMain />
  let i = 0
  return (
    <div className="panes">
      {rows.map((count, r) => (
        <div className="pane-row" key={r}>
          {Array.from({ length: count }, () => {
            const index = i++
            const key = tabs[index]
            return <AgentPane key={key} agentKey={key} index={index} />
          })}
        </div>
      ))}
    </div>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { dropPlan, moveFolderTo, moveProjectTo, placeAgent, type DropWhere, type RowRef } from '@shared/arrange'
import { LOCAL_HOST, type HostState } from '@shared/types'
import { activateSelection } from '../actions'
import { agentTitle, ago, contextOf, doingText, needsText, shortPath, tokens } from '../format'
import { arrange, get, isUnread, set, toggleCollapsed, toggleFolder, useKuna } from '../store'
import { OTHER_FOLDER_ID, agentCounts, assignAgents, buildTree, type TreeNode } from '../tree'
import { StatusDot } from './StatusDot'
import { TexText } from './TexText'
import { keyLabel, localName } from '../platform'

/** Roll-out arrow of a project or folder row, in the project's colour; turns down when open. */
function Chevron({ open, color, small, hidden }: { open: boolean; color: string; small?: boolean; hidden?: boolean }): React.JSX.Element {
  return (
    <svg className={`chev ${small ? 'small' : ''} ${open ? 'open' : ''}`} viewBox="0 0 10 10" style={{ color, visibility: hidden ? 'hidden' : undefined }} aria-hidden>
      <path d="M3.2 1.6 L6.8 5 L3.2 8.4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function HostBadge({ host, state }: { host: string; state?: HostState }): React.JSX.Element {
  const status = state?.status ?? 'idle'
  const label = host === LOCAL_HOST ? localName.toLowerCase() : host
  const title =
    status === 'ready'
      ? `${state?.hostname ?? host} · ${state?.tmuxVersion ?? 'tmux'}`
      : status === 'auth'
        ? `Sign-in needed: ${state?.error ?? ''}`
        : (state?.error ?? status)
  return (
    <span className={`host-badge host-${status}`} title={title}>
      <i />
      {label}
    </span>
  )
}

/** drag-and-drop type for a sidebar row */
const ROW_DRAG = 'application/x-kuna-row'
// the row being dragged (a drag's data can't be read while it is over a row)
let dragging: RowRef | null = null

function refOf(n: TreeNode): RowRef {
  if (n.kind === 'project') return { kind: 'project', projectId: n.project.id, host: n.project.host }
  if (n.kind === 'folder') return { kind: 'folder', projectId: n.project.id, folderId: n.folder.id, host: n.project.host, virtual: n.virtual }
  return { kind: 'agent', projectId: n.project.id, folderId: n.folder.id, host: n.project.host, key: n.agent.key }
}

/** Reorder projects or folders, or place an agent by hand where it was dropped. */
function applyDrop(drag: RowRef, target: RowRef, where: DropWhere): void {
  const s = get()
  if (drag.kind === 'project' && target.kind === 'project' && where !== 'into') {
    arrange(moveProjectTo(s.projects, drag.projectId, target.projectId, where))
  } else if (drag.kind === 'folder' && target.kind !== 'agent') {
    arrange(moveFolderTo(s.projects, drag.projectId, drag.folderId, target.projectId, target.kind === 'folder' ? target.folderId : null, where))
  } else if (drag.kind === 'agent' && target.kind !== 'project') {
    const other = target.folderId === OTHER_FOLDER_ID
    const shown = (assignAgents(s.projects, Object.values(s.agents), s.hosts).get(`${target.projectId}:${target.folderId}`) ?? []).map((a) => a.key)
    arrange(placeAgent(s.projects, drag.key, target.projectId, other ? null : target.folderId, shown, target.kind === 'agent' ? target.key : null, where))
    // show it where it went
    if (target.kind === 'folder' && !other) toggleFolder(target.projectId, target.folderId, false)
    set({ sel: `a:${drag.key}` })
  }
}

type RowDnd = React.HTMLAttributes<HTMLDivElement> & { draggable: boolean }

function Row({
  node,
  selected,
  focused,
  count,
  dnd,
  drop
}: {
  node: TreeNode
  selected: boolean
  focused: boolean
  count?: number
  dnd: RowDnd
  drop?: DropWhere
}): React.JSX.Element {
  const hosts = useKuna((s) => s.hosts)
  const lastSeen = useKuna((s) => s.lastSeen)
  const details = useKuna((s) => (node.kind === 'agent' ? s.details[node.agent.key] : undefined))
  const armed = useKuna((s) => node.kind === 'agent' && s.armedKill?.key === node.agent.key)
  const open = useKuna((s) => (node.kind !== 'agent' ? null : s.tabs.includes(node.agent.key) ? 'here' : s.windows.elsewhere[node.agent.key] ? 'elsewhere' : null))
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const cls = ['row', `row-${node.kind}`, selected && 'sel', selected && focused && 'sel-focus', armed && 'armed', drop && `drop-${drop}`]
    .filter(Boolean)
    .join(' ')
  const onClick = (): void => {
    set({ sel: node.id, zone: 'sidebar', mode: 'nav' })
    // a click on a project or folder rolls it out or in
    if (node.kind === 'project') toggleCollapsed(node.project.id)
    else if (node.kind === 'folder') toggleFolder(node.project.id, node.folder.id)
  }
  const onDouble = (): void => {
    set({ sel: node.id })
    activateSelection()
  }

  if (node.kind === 'project') {
    const h = hosts[node.project.host]
    return (
      <div ref={ref} className={cls} onClick={onClick} {...dnd}>
        <Chevron open={!node.project.collapsed} color={node.project.color} />
        <span className="proj-name">
          <TexText text={node.project.name} bold />
        </span>
        <HostBadge host={node.project.host} state={h} />
        {h?.status === 'auth' && (
          <button className="mini" onClick={(e) => (e.stopPropagation(), set({ overlay: { kind: 'login', host: node.project.host } }))}>
            Sign in
          </button>
        )}
        {h?.status === 'error' && (
          <button className="mini" onClick={(e) => (e.stopPropagation(), void window.kuna.hosts.reconnect(node.project.host))}>
            Retry
          </button>
        )}
        <span className="row-actions">
          <button title="Add folder (⌘O)" onClick={(e) => (e.stopPropagation(), set({ overlay: { kind: 'folder', projectId: node.project.id } }))}>
            +
          </button>
          <button title="Rename or edit the project (⌘R)" onClick={(e) => (e.stopPropagation(), set({ overlay: { kind: 'project', editId: node.project.id } }))}>
            ⋯
          </button>
        </span>
      </div>
    )
  }

  if (node.kind === 'folder') {
    return (
      <div ref={ref} className={cls} onClick={onClick} title={node.folder.path} {...dnd}>
        <Chevron open={!node.folder.collapsed} color={node.project.color} small hidden={!count} />
        <span className="swatch" style={{ background: node.folder.color }} />
        <span className="folder-name">
          <TexText text={node.folder.name} />
        </span>
        {!node.virtual && <span className="folder-path">{shortPath(node.folder.path)}</span>}
        {node.folder.collapsed && count ? <span className="folder-count">{count}</span> : null}
        {!node.virtual && (
          <span className="row-actions">
            <button
              title="Rename folder (⌘R)"
              onClick={(e) => (e.stopPropagation(), set({ overlay: { kind: 'folder-edit', projectId: node.project.id, folderId: node.folder.id } }))}
            >
              ⋯
            </button>
          </span>
        )}
      </div>
    )
  }

  const a = node.agent
  const unread = isUnread(a, lastSeen)
  const need = needsText(a, details)
  const ctx = contextOf(a, details)
  // what it is doing in full lives in the tooltip, the pane header and the inspector; the row stays one line
  const tip = [agentTitle(a, details), a.activity ? doingText(a) : '', a.detail, a.cwd, a.kind === 'claude' ? `claude background session ${a.id.slice(3)}` : `kuna agent ${a.id}`]
    .filter(Boolean)
    .join('\n')
  return (
    <>
      <div ref={ref} className={`${cls} st-${a.status}`} onClick={onClick} onDoubleClick={onDouble} title={tip} {...dnd}>
        <StatusDot status={a.status} />
        <span className={`agent-name ${unread ? 'unread' : ''}`}>
          {armed ? (a.kind === 'claude' && a.alive ? 'Ctrl+X again to stop' : 'Ctrl+X again to remove') : agentTitle(a, details)}
        </span>
        {open && <span className={`open-mark ${open}`} title={open === 'here' ? 'Open in a pane' : 'Open in another window'} />}
        {unread && <span className="unread-mark" title="New output you haven't seen" />}
        {a.status !== 'exited' && a.status !== 'failed' && ctx.level !== 'ok' && (
          <span
            className={`ctx-gauge ctx-${ctx.level}`}
            title={`${tokens(ctx.tokens)} of ${tokens(ctx.window)} tokens in context. Compact it from the right panel.`}
          >
            <i>
              <b style={{ width: `${ctx.pct}%` }} />
            </i>
            {ctx.pct.toFixed(0)}%
          </span>
        )}
        <span className="agent-age">
          {a.status === 'idle' || a.status === 'waiting' || a.status === 'starting' ? ago(Math.max(a.activityTs, a.attnTs)) : doingText(a, true)}
        </span>
      </div>
      {need && (
        <div className="agent-need" onClick={onClick} onDoubleClick={onDouble} title={need}>
          {need}
        </div>
      )}
    </>
  )
}

export function Sidebar(): React.JSX.Element {
  const projects = useKuna((s) => s.projects)
  const agents = useKuna((s) => s.agents)
  const hosts = useKuna((s) => s.hosts)
  const sel = useKuna((s) => s.sel)
  const zone = useKuna((s) => s.zone)
  // names given in Kuna (⌘R) change the titles
  useKuna((s) => s.names)
  const nodes = useMemo(() => buildTree(projects, Object.values(agents), hosts), [projects, agents, hosts])
  const counts = useMemo(() => agentCounts(projects, Object.values(agents), hosts), [projects, agents, hosts])

  // where a dragged row would land: a line above/below a row, or the row lit up ("into")
  const [dropAt, setDropAt] = useState<{ id: string; where: DropWhere } | null>(null)
  const planFor = (n: TreeNode, e: React.DragEvent<HTMLDivElement>): DropWhere | null => {
    if (!dragging || !e.dataTransfer.types.includes(ROW_DRAG)) return null
    const r = e.currentTarget.getBoundingClientRect()
    return dropPlan(dragging, refOf(n), e.clientY < r.top + r.height / 2)
  }
  const dndFor = (n: TreeNode): RowDnd => ({
    draggable: !(n.kind === 'folder' && n.virtual),
    onDragStart: (e) => {
      dragging = refOf(n)
      e.dataTransfer.setData(ROW_DRAG, n.id)
      e.dataTransfer.effectAllowed = 'move'
    },
    onDragOver: (e) => {
      const where = planFor(n, e)
      if (!where) return setDropAt((d) => (d?.id === n.id ? null : d))
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDropAt((d) => (d?.id === n.id && d.where === where ? d : { id: n.id, where }))
    },
    onDragLeave: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt((d) => (d?.id === n.id ? null : d))
    },
    onDrop: (e) => {
      const where = planFor(n, e)
      if (dragging && where) {
        e.preventDefault()
        applyDrop(dragging, refOf(n), where)
      }
      setDropAt(null)
      dragging = null
    },
    onDragEnd: () => {
      setDropAt(null)
      dragging = null
    }
  })

  // keep the selection valid when rows disappear
  useEffect(() => {
    if (nodes.length && !nodes.some((n) => n.id === sel)) set({ sel: nodes[0].id })
  }, [nodes, sel])

  return (
    <div className="sidebar">
      <div className="brand">
        <span className="brand-mark">kuna</span>
      </div>
      <div className="tree" role="tree">
        {nodes.map((n) => (
          <Row
            key={n.id}
            node={n}
            selected={n.id === sel}
            focused={zone === 'sidebar'}
            count={n.kind === 'folder' ? counts.get(`${n.project.id}:${n.folder.id}`) : undefined}
            dnd={dndFor(n)}
            drop={dropAt?.id === n.id ? dropAt.where : undefined}
          />
        ))}
        {!projects.length && (
          <div className="empty-side">
            <p>No projects yet.</p>
            <p>
              Press <kbd>{keyLabel('⌘N')}</kbd> to create one on {localName} or on any host from your SSH config.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { LOCAL_HOST } from '@shared/types'
import { cleanTypedPath, pastePath } from '@shared/paths'
import { hasMath, texToText } from '@shared/tex'
import { agentTitle } from '../format'
import { addFolder, addProject, removeFolder, removeProject, renameAgent, set, toast, updateFolder, updateProject, useKuna } from '../store'
import { REPO_COLORS } from '../themes'
import { closeOverlay, useOverlayKeys } from './Overlays'
import { TexText } from './TexText'
import { LocalName, localName } from '../platform'

export function ProjectDialog({ editId }: { editId?: string }): React.JSX.Element {
  const sshHosts = useKuna((s) => s.sshHosts)
  const editing = useKuna((s) => s.projects.find((p) => p.id === editId))
  const [name, setName] = useState(editing?.name ?? '')
  const [host, setHost] = useState(editing?.host ?? LOCAL_HOST)
  const [hostFilter, setHostFilter] = useState('')
  const [command, setCommand] = useState(editing?.agentCommand ?? 'claude')
  const [color, setColor] = useState(editing?.color ?? '')
  const [launch, setLaunch] = useState<'background' | 'tmux'>(editing?.launch ?? 'background')
  const listRef = useRef<HTMLDivElement>(null)

  const hosts = useMemo(() => {
    const all = [{ alias: LOCAL_HOST, label: LocalName, detail: 'agents run locally' }].concat(
      sshHosts.map((h) => ({
        alias: h.alias,
        label: h.alias,
        detail: [h.user && `${h.user}@`, h.hostName ?? '', h.proxyJump ? ` via ${h.proxyJump}` : ''].filter(Boolean).join('')
      }))
    )
    const f = hostFilter.toLowerCase()
    return f ? all.filter((h) => h.label.toLowerCase().includes(f) || h.detail.toLowerCase().includes(f)) : all
  }, [sshHosts, hostFilter])

  useEffect(() => {
    listRef.current?.querySelector('.host-opt.on')?.scrollIntoView({ block: 'nearest' })
  }, [host])

  const save = (): void => {
    const n = name.trim() || (host === LOCAL_HOST ? 'Local' : host)
    if (editing) {
      updateProject(editing.id, { name: n, host, agentCommand: command.trim() || 'claude', launch, ...(color ? { color } : {}) })
    } else {
      const p = addProject({ name: n, host, agentCommand: command.trim() || 'claude' })
      updateProject(p.id, { launch, ...(color ? { color } : {}) })
      set({ overlay: { kind: 'folder', projectId: p.id } })
      return
    }
    closeOverlay()
  }

  useOverlayKeys((ev) => {
    const target = ev.target as HTMLElement
    if (ev.key === 'Enter' && !ev.shiftKey) {
      save()
      return true
    }
    if (target?.dataset?.role === 'host-filter' && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) {
      const i = Math.max(0, hosts.findIndex((h) => h.alias === host))
      const j = ev.key === 'ArrowDown' ? Math.min(hosts.length - 1, i + 1) : Math.max(0, i - 1)
      if (hosts[j]) setHost(hosts[j].alias)
      return true
    }
    return false
  })

  return (
    <div className="scrim" onMouseDown={closeOverlay}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{editing ? 'Edit project' : 'New project'}</h2>
        <label>
          Name
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. $HH\to b\bar{b}\tau\tau$ analysis" />
        </label>
        <TexPreview text={name} />
        <label>
          Host
          <input
            data-role="host-filter"
            value={hostFilter}
            onChange={(e) => {
              setHostFilter(e.target.value)
            }}
            placeholder="Filter hosts from ~/.ssh/config — ↑ ↓ to choose"
          />
        </label>
        <div className="host-list" ref={listRef}>
          {hosts.map((h) => (
            <div key={h.alias} className={`host-opt ${h.alias === host ? 'on' : ''}`} onClick={() => setHost(h.alias)}>
              <span>{h.label}</span>
              <span className="dim">{h.detail}</span>
            </div>
          ))}
          {!hosts.length && <div className="dim pad">No host matches “{hostFilter}”.</div>}
        </div>
        <label>
          Agent command
          <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="claude" spellCheck={false} />
          <span className="field-note">
            Runs through your login shell on the host. Add flags like <code>--model opus</code> or <code>--permission-mode plan</code>.
          </span>
        </label>
        <div className="launch-choice" role="radiogroup" aria-label="Run new agents as">
          <button className={launch === 'background' ? 'on' : ''} onClick={() => setLaunch('background')} role="radio" aria-checked={launch === 'background'}>
            <strong>Claude background sessions</strong>
            <span>Run by Claude Code's own daemon; also listed in <code>claude agents</code> and on your phone.</span>
          </button>
          <button className={launch === 'tmux' ? 'on' : ''} onClick={() => setLaunch('tmux')} role="radio" aria-checked={launch === 'tmux'}>
            <strong>tmux sessions</strong>
            <span>Kuna's own tmux server. Works with any agent CLI and old Claude versions.</span>
          </button>
        </div>
        <div className="swatches">
          {REPO_COLORS.map((c) => (
            <button key={c} className={`swatch-btn ${(color || editing?.color) === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={`Colour ${c}`} />
          ))}
        </div>
        <div className="dialog-actions">
          {editing && (
            <button
              className="danger-text"
              onClick={() =>
                set({
                  overlay: {
                    kind: 'confirm',
                    title: `Remove project ${texToText(editing.name)}?`,
                    body: 'Its folders are removed from Kuna. Nothing on the host is deleted and running agents keep running.',
                    action: () => removeProject(editing.id)
                  }
                })
              }
            >
              Remove project
            </button>
          )}
          <span className="ph-spacer" />
          <button onClick={closeOverlay}>Cancel</button>
          <button className="primary" onClick={save}>
            {editing ? 'Save' : 'Create and add a folder'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function FolderDialog({ projectId, initialPath }: { projectId: string; initialPath?: string }): React.JSX.Element {
  const project = useKuna((s) => s.projects.find((p) => p.id === projectId))
  const hostState = useKuna((s) => (project ? s.hosts[project.host] : undefined))
  const [path, setPath] = useState(initialPath ? `${initialPath.replace(/\/+$/, '')}/` : '~/')
  const [name, setName] = useState('')
  // the listing and the directory it is of: a stale one is not shown under a new path
  const [listing, setListing] = useState<{ of: string; dirs: string[] }>({ of: '', dirs: [] })
  const [pick, setPick] = useState(-1)
  const [loading, setLoading] = useState(false)
  const list = useRef<HTMLDivElement>(null)
  const pathInput = useRef<HTMLInputElement>(null)
  const host = project?.host ?? LOCAL_HOST
  const home = hostState?.home

  // the picked folder stays in view when ↑ ↓ go past the visible part of the list
  useEffect(() => {
    list.current?.querySelector('.host-opt.on')?.scrollIntoView({ block: 'nearest' })
  }, [pick])

  // list the parent directory of what has been typed so far
  const parent = path.endsWith('/') ? path : path.slice(0, path.lastIndexOf('/') + 1) || '~/'
  const leaf = path.slice(parent.length).toLowerCase()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const t = setTimeout(() => {
      void window.kuna.fs.dirs(host, parent).then((list) => {
        if (cancelled) return
        setListing({ of: parent, dirs: list })
        setLoading(false)
      })
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [host, parent])

  const display = (abs: string): string => {
    const p = cleanTypedPath(abs)
    return home && p.startsWith(home + '/') ? '~' + p.slice(home.length) : p
  }
  const dirs = listing.of === parent ? listing.dirs : []
  const matches = useMemo(
    () => dirs.map(display).filter((d) => d.slice(d.lastIndexOf('/') + 1).toLowerCase().startsWith(leaf)).slice(0, 200),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [listing, parent, leaf, home]
  )

  const submit = (p: string): void => {
    const clean = p.trim()
    // the home folder (~/) is a folder like any other: a catch-all for the host
    if (!clean || !project) return
    addFolder(project.id, clean, name)
    set({ overlay: null, zone: 'sidebar', mode: 'nav' })
    toast(`Added ${clean}. Start typing to launch an agent there.`)
  }

  /** A listed folder into the path: its folders are listed next, and Enter adds it. */
  const fill = (d: string): void => {
    setPath(cleanTypedPath(d + '/'))
    setPick(-1)
  }

  useOverlayKeys((ev) => {
    if ((ev.target as HTMLElement)?.dataset?.role !== 'path') {
      if (ev.key === 'Enter') {
        submit(path)
        return true
      }
      return false
    }
    switch (ev.key) {
      case 'ArrowDown':
        setPick((i) => Math.min(matches.length - 1, i + 1))
        return true
      case 'ArrowUp':
        setPick((i) => Math.max(-1, i - 1))
        return true
      case 'Tab': {
        const m = matches[pick >= 0 ? pick : 0]
        if (m) fill(m)
        return true
      }
      case 'Enter':
        // a folder picked with ↑ ↓ is filled in first; the next Enter adds it
        if (pick >= 0 && matches[pick]) fill(matches[pick])
        else submit(path)
        return true
    }
    return false
  })

  if (!project) return <></>
  return (
    <div className="scrim" onMouseDown={closeOverlay}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h2>
          Add a folder to <TexText text={project.name} />
        </h2>
        <p className="dim">
          A folder is usually a repository on {host === LOCAL_HOST ? localName : host}. Agents you launch from it start there.
        </p>
        <label>
          Path
          <input
            ref={pathInput}
            autoFocus
            data-role="path"
            spellCheck={false}
            value={path}
            onChange={(e) => {
              setPath(cleanTypedPath(e.target.value))
              setPick(-1)
            }}
            onPaste={(e) => {
              const el = e.currentTarget
              const { value, caret } = pastePath(el.value, e.clipboardData.getData('text'), el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length)
              e.preventDefault()
              setPath(value)
              setPick(-1)
              requestAnimationFrame(() => pathInput.current?.setSelectionRange(caret, caret))
            }}
          />
          <span className="field-note">Tab completes · ↑ ↓ pick, Enter fills it in · Enter adds</span>
        </label>
        <div className="host-list dirs" ref={list}>
          {loading && !dirs.length && <div className="dim pad">Listing {parent} on {host === LOCAL_HOST ? localName : host}…</div>}
          {!loading && !matches.length && <div className="dim pad">No folders here.</div>}
          {matches.map((d, i) => (
            <div key={d} className={`host-opt ${i === pick ? 'on' : ''}`} onClick={() => fill(d)} onDoubleClick={() => submit(d)}>
              <span>{d.slice(d.lastIndexOf('/') + 1)}</span>
              <span className="dim">{d}</span>
            </div>
          ))}
        </div>
        <label>
          Display name <span className="dim">(optional)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={path.replace(/\/+$/, '').split('/').pop()} />
        </label>
        <TexPreview text={name} />
        <div className="dialog-actions">
          <span className="ph-spacer" />
          <button onClick={closeOverlay}>Cancel</button>
          <button className="primary" onClick={() => submit(pick >= 0 && matches[pick] ? matches[pick] : path)}>
            Add folder
          </button>
        </div>
      </div>
    </div>
  )
}

/** How a name with `$…$` math will look. */
function TexPreview({ text }: { text: string }): React.JSX.Element | null {
  if (!hasMath(text)) return null
  return (
    <div className="tex-preview">
      <span className="dim">Shows as</span> <TexText text={text} />
    </div>
  )
}

/** Rename a folder (the path stays), recolour it, or remove it from the sidebar. */
export function FolderEditDialog({ projectId, folderId }: { projectId: string; folderId: string }): React.JSX.Element | null {
  const folder = useKuna((s) => s.projects.find((p) => p.id === projectId)?.folders.find((f) => f.id === folderId))
  const [name, setName] = useState(folder?.name ?? '')
  const [color, setColor] = useState(folder?.color ?? '')
  const input = useRef<HTMLInputElement>(null)

  // the name is selected, so typing replaces it
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  const save = (): void => {
    if (folder) updateFolder(projectId, folderId, { name: name.trim() || folder.path.split('/').pop() || folder.path, color: color || folder.color })
    closeOverlay()
  }

  useOverlayKeys((ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      save()
      return true
    }
    return false
  })

  if (!folder) return null
  return (
    <div className="scrim" onMouseDown={closeOverlay}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Edit folder</h2>
        <p className="dim mono">{folder.path}</p>
        <label>
          Name
          <input ref={input} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <TexPreview text={name} />
        <div className="swatches">
          {REPO_COLORS.map((c) => (
            <button
              key={c}
              className={`swatch-btn ${(color || folder.color) === c ? 'on' : ''}`}
              style={{ background: c }}
              onClick={() => setColor(c)}
              aria-label={`Colour ${c}`}
            />
          ))}
        </div>
        <div className="dialog-actions">
          <button
            className="danger-text"
            onClick={() =>
              set({
                overlay: {
                  kind: 'confirm',
                  title: `Remove ${texToText(folder.name)}?`,
                  body: 'The folder is removed from the sidebar. Agents running there keep running and show up under "Other agents".',
                  action: () => removeFolder(projectId, folderId)
                }
              })
            }
          >
            Remove folder
          </button>
          <span className="ph-spacer" />
          <button onClick={closeOverlay}>Cancel</button>
          <button className="primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

/** A name of your own for an agent (kept by Kuna; the session itself keeps its title). Empty: back to its own. */
export function AgentRenameDialog({ agentKey }: { agentKey: string }): React.JSX.Element | null {
  const agent = useKuna((s) => s.agents[agentKey])
  const details = useKuna((s) => s.details[agentKey])
  const [name, setName] = useState(() => (agent ? agentTitle(agent, details) : ''))
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  const save = (): void => {
    renameAgent(agentKey, name)
    closeOverlay()
  }

  useOverlayKeys((ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      save()
      return true
    }
    return false
  })

  if (!agent) return null
  return (
    <div className="scrim" onMouseDown={closeOverlay}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Rename agent</h2>
        <p className="dim">The name is kept by Kuna. Leave it empty to go back to the agent's own title.</p>
        <label>
          Name
          <input ref={input} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="dialog-actions">
          <span className="ph-spacer" />
          <button onClick={closeOverlay}>Cancel</button>
          <button className="primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

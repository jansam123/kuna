import { useEffect, useRef } from 'react'
import { set, useKuna } from '../store'
import { ClaudeBrowser } from './ClaudeBrowser'
import { AgentRenameDialog, FolderDialog, FolderEditDialog, ProjectDialog } from './Dialogs'
import { HelpDialog } from './HelpDialog'
import { LoginDialog } from './LoginDialog'
import { MediaViewer } from './MediaViewer'
import { ReviewView } from './ReviewView'
import { SettingsDialog } from './SettingsDialog'

export function closeOverlay(): void {
  set({ overlay: null })
}

/**
 * Keyboard handling for an open overlay. The handler sees every keydown first;
 * return true to swallow the key, 'pass' to leave it to whatever has the focus
 * (an editor's own Esc). Esc closes the overlay unless handled.
 */
export function useOverlayKeys(handler: (ev: KeyboardEvent) => boolean | void | 'pass'): void {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      const r = ref.current(ev)
      if (r === 'pass') return
      if (r) {
        ev.preventDefault()
        ev.stopPropagation()
        return
      }
      if (ev.key === 'Escape') {
        ev.preventDefault()
        ev.stopPropagation()
        closeOverlay()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}

function ConfirmDialog({ title, body, action }: { title: string; body: string; action: () => void }): React.JSX.Element {
  useOverlayKeys((ev) => {
    if (ev.key === 'Enter') {
      closeOverlay()
      action()
      return true
    }
    return false
  })
  return (
    <div className="scrim" onMouseDown={closeOverlay}>
      <div className="dialog small" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <p className="dim">{body}</p>
        <div className="dialog-actions">
          <button onClick={closeOverlay}>Cancel</button>
          <button
            className="primary danger"
            onClick={() => {
              closeOverlay()
              action()
            }}
          >
            Remove
          </button>
        </div>
      </div>
    </div>
  )
}

export function Overlays(): React.JSX.Element | null {
  const overlay = useKuna((s) => s.overlay)
  if (!overlay) return null
  switch (overlay.kind) {
    case 'media':
      return <MediaViewer agentKey={overlay.key} />
    case 'review':
      return <ReviewView host={overlay.host} dir={overlay.dir} agentKey={overlay.key} />
    case 'claude':
      return <ClaudeBrowser initialHost={overlay.host} />
    case 'project':
      return <ProjectDialog editId={overlay.editId} />
    case 'folder':
      return <FolderDialog projectId={overlay.projectId} initialPath={overlay.path} />
    case 'folder-edit':
      return <FolderEditDialog projectId={overlay.projectId} folderId={overlay.folderId} />
    case 'agent-rename':
      return <AgentRenameDialog agentKey={overlay.key} />
    case 'settings':
      return <SettingsDialog />
    case 'help':
      return <HelpDialog />
    case 'login':
      return <LoginDialog host={overlay.host} />
    case 'confirm':
      return <ConfirmDialog title={overlay.title} body={overlay.body} action={overlay.action} />
  }
}

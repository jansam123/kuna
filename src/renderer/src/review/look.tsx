import { useEffect, useState } from 'react'
import { fileIcon, folderIcon, languageOf, type VscodeLook } from '@shared/vscode'

/** The user's VS Code look, read once per window. */
let look: Promise<VscodeLook> | undefined
export function vscodeLook(): Promise<VscodeLook> {
  look ??= window.kuna.vscode.look()
  return look
}

const urls = new Map<string, string | null>()
const pending = new Map<string, Promise<string | null>>()

function iconUrl(id: string): Promise<string | null> {
  if (urls.has(id)) return Promise.resolve(urls.get(id)!)
  let p = pending.get(id)
  if (!p) {
    p = window.kuna.vscode.icon(id).then((u) => {
      urls.set(id, u)
      pending.delete(id)
      return u
    })
    pending.set(id, p)
  }
  return p
}

function useIcon(id: string | undefined): string | null | undefined {
  const [url, setUrl] = useState<string | null | undefined>(() => (id ? urls.get(id) : null))
  useEffect(() => {
    if (!id) return setUrl(null)
    if (urls.has(id)) return setUrl(urls.get(id)!)
    let live = true
    void iconUrl(id).then((u) => live && setUrl(u))
    return () => {
      live = false
    }
  }, [id])
  return url
}

/** A file's or folder's icon from the user's VS Code icon theme (material-icon-theme, Seti…). */
export function FileIcon({ look, path, folder, open }: { look: VscodeLook | null; path: string; folder?: boolean; open?: boolean }): React.JSX.Element {
  const t = look?.icons
  const id = !t ? undefined : folder ? folderIcon(t, path, !!open) : fileIcon(t, path, languageOf(path, look.languages, look.associations))
  const url = useIcon(id)
  if (url) return <img className="rv-icon" src={url} alt="" draggable={false} />
  return <span className={`rv-icon rv-icon-none ${folder ? 'folder' : ''}`}>{folder ? (open ? '▾' : '▸') : ''}</span>
}

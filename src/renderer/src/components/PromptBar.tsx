import { useEffect, useMemo, useRef } from 'react'
import { targetFolder } from '../actions'
import { set, useKuna } from '../store'
import { buildTree } from '@shared/tree'
import { TexText } from './TexText'

/** The "new agent" composer under the sidebar. Enter launches an agent in the target folder. */
export function PromptBar(): React.JSX.Element {
  const zone = useKuna((s) => s.zone)
  const prompt = useKuna((s) => s.prompt)
  const sel = useKuna((s) => s.sel)
  const projects = useKuna((s) => s.projects)
  const agents = useKuna((s) => s.agents)
  const hosts = useKuna((s) => s.hosts)
  const ref = useRef<HTMLTextAreaElement>(null)
  const active = zone === 'prompt'

  // the agent starts in the folder of the selected row, wherever the arrows went while typing
  const target = useMemo(() => {
    const node = buildTree(projects, Object.values(agents), hosts).find((n) => n.id === sel)
    const t = targetFolder(node)
    if (!t) return null
    const project = projects.find((p) => p.id === t!.projectId)
    const folder = project?.folders.find((f) => f.id === t!.folderId)
    return project && folder ? { project, folder } : null
  }, [sel, projects, agents, hosts])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (active) {
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    } else el.blur()
  }, [active])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    // + 2: the box is measured with its border, scrollHeight without
    el.style.height = `${Math.min(220, el.scrollHeight + 2)}px`
  }, [prompt])

  return (
    <div className={`promptbar ${active ? 'active' : ''}`}>
      <div className="prompt-target">
        {target ? (
          <>
            <span className="swatch" style={{ background: target.folder.color }} />
            <span className="pt-folder">
              <TexText text={target.folder.name} />
            </span>
            <span className="pt-host">{target.project.host === 'local' ? 'this mac' : target.project.host}</span>
          </>
        ) : (
          <span className="pt-none">Select a folder to launch agents</span>
        )}
      </div>
      <textarea
        ref={ref}
        rows={1}
        value={prompt}
        spellCheck={false}
        placeholder={target ? 'Type to start a new agent here…' : ''}
        onChange={(e) => set({ prompt: e.target.value })}
        onFocus={() => {
          if (zone !== 'prompt') set({ zone: 'prompt', mode: 'insert' })
        }}
      />
    </div>
  )
}

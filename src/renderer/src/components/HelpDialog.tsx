import { closeOverlay, useOverlayKeys } from './Overlays'
import { cmdKey, isMac, keyLabel, localName } from '../platform'

const SECTIONS: { title: string; keys: [string, string][] }[] = [
  {
    title: 'Moving around',
    keys: [
      ['↑ ↓', 'move in the sidebar'],
      ['→ / ←', 'from the sidebar into the tabs and back'],
      ['← → ↑ ↓', 'move between tabs'],
      ['⌘1 … ⌘9', 'jump to tab'],
      ['⌥ arrows', 'move the pane that way, swapping it with the one there'],
      ['⇧⌘← / ⇧⌘→', 'move the tab left / right'],
      ['⌘S', 'hide or show the left sidebar (← from the first pane peeks)'],
      ['⌘B', 'hide or show the right inspector (→ from the last pane peeks)'],
      ['⇧⌘N · ⇧⌘W', 'new window · close it (its agents keep running)'],
      ['⌘← / ⌘→', 'the previous / next window'],
      ['⌥⌘← / ⌥⌘→', 'carry the pane to the previous / next window']
    ]
  },
  {
    title: 'Agents',
    keys: [
      ['type', 'on a folder: write a task for a new agent'],
      ['type, Enter', 'in the sidebar: start an agent in the selected folder (↑ ↓ pick it, ← → move in the text)'],
      ['Enter', 'nothing typed: roll a project/folder out or in · on an agent: open it'],
      ['type', 'on a tab: write to the agent (arrows edit the text)'],
      ['Enter', 'send and return to navigation'],
      ['⇧Enter', 'new line in the message'],
      ['Esc', "for the agent: closes Claude Code's menus, /usage (not while it works)"],
      ['Esc Esc', 'stop typing and clear what you typed'],
      [isMac ? '⌘← ⌘→' : 'Home End', 'while typing: start / end of the line'],
      ['1 … 9', 'answer a permission prompt'],
      ['⇧Tab', "cycle the agent's permission mode"],
      ['⌘V', 'paste: into the launch box (sidebar) or the agent (pane)'],
      ['⌘.', 'interrupt the agent (sends Esc)'],
      ['⌘R', 'rename the selected project, folder or agent'],
      ['⇧⌘R', 'resume an exited agent’s conversation'],
      ['⌘W', 'close the tab — the agent keeps running; back to where you opened it'],
      ['Ctrl+X Ctrl+X', 'kill the agent · a background session: stop it, off the list'],
      ['⌘Z', 'bring back the session taken off the list last']
    ]
  },
  {
    title: 'Looking at things',
    keys: [
      ['Space', "plots, PDFs and Markdown files of the agent's latest reply"],
      ['→ / ←', 'older / newer file (→ keeps going into earlier replies)'],
      ['⌘+ ⌘− ⌘0', 'zoom in, out, fit (or pinch; drag to pan)'],
      ['type, Enter', 'in the preview: write to the agent beside the file'],
      ['⌘P', 'in the preview: the file’s path, into your message'],
      ['PgUp PgDn', 'scroll the agent’s conversation a page, as the wheel does'],
      ['⌘O · ⌘S', `in the preview: open in ${isMac ? 'Preview' : 'its app'} · save to Downloads`],
      ['⌘U', 'in the preview: a Markdown file as source or rendered'],
      ['⌥ drag', 'select text in an agent; copied when you let go, ⌘C too'],
      ['⌘K', 'browse skills, agents, commands and CLAUDE.md'],
      ['⌘,', 'colour scheme and fonts']
    ]
  },
  {
    title: 'Projects',
    keys: [
      ['⌘N', `new project (${localName} or an SSH host)`],
      ['⌘O', 'add a folder to the selected project'],
      ['⌥↑ / ⌥↓', 'move a project, folder or agent up or down (⇧ too, or drag it)'],
      ['⌘⌫', 'remove the selected folder or project'],
      ['drag', 'a pane header onto another pane swaps them; panel edges resize']
    ]
  }
]

export function HelpDialog(): React.JSX.Element {
  useOverlayKeys((ev) => {
    if (ev.key === 'Enter' || ev.key === '?' || cmdKey(ev)?.key === '/') {
      closeOverlay()
      return true
    }
    return false
  })
  return (
    <div className="scrim" onMouseDown={closeOverlay}>
      <div className="dialog wide help" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Keyboard</h2>
        <div className="help-grid">
          {SECTIONS.map((s) => (
            <section key={s.title}>
              <h3>{s.title}</h3>
              <dl>
                {s.keys.map(([k, v], i) => (
                  <div key={i}>
                    <dt>
                      <kbd>{keyLabel(k)}</kbd>
                    </dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}

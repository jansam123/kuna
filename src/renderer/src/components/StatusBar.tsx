import { useEffect, useState } from 'react'
import type { PlanUsage, UsageWindow } from '@shared/types'
import { useKuna } from '../store'
import { keyLabel, localName } from '../platform'

/**
 * A report older than this is shown as such: it only refreshes when an agent
 * started from Kuna replies, so use in background sessions or elsewhere since
 * then isn't in it.
 */
const STALE_S = 15 * 60

function resetLabel(at: number): string {
  const d = new Date(at * 1000)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (at - Date.now() / 1000 < 20 * 3600) return time
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

function Meter({ label, w }: { label: string; w?: UsageWindow }): React.JSX.Element | null {
  if (!w) return null
  // a window whose reset time has passed starts again from zero
  const reset = w.resetsAt != null && w.resetsAt < Date.now() / 1000
  const pct = reset ? 0 : Math.max(0, Math.min(100, w.usedPct))
  const tone = pct >= 90 ? 'hot' : pct >= 70 ? 'warm' : ''
  return (
    <span className={`sb-meter ${tone}`} title={w.resetsAt ? `${label}: ${pct.toFixed(1)}% used, resets ${new Date(w.resetsAt * 1000).toLocaleString()}` : label}>
      <span className="sb-meter-label">{label}</span>
      <span className="sb-meter-bar">
        <span style={{ width: `${pct}%` }} />
      </span>
      <span className="sb-meter-pct">{Math.round(pct)}%</span>
      {w.resetsAt != null && !reset && <span className="sb-meter-reset">{resetLabel(w.resetsAt)}</span>}
    </span>
  )
}

/** Claude plan usage, as last reported to a Kuna agent's status line. */
function Usage({ usage }: { usage: PlanUsage | null }): React.JSX.Element {
  // re-render each minute: reset times pass and the report ages
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])
  if (!usage) {
    return (
      <span className="sb-usage dim" title="Claude Pro/Max usage appears once an agent started from Kuna gets its first reply.">
        usage —
      </span>
    )
  }
  const from = usage.host === 'local' ? localName : usage.host
  const at = new Date(usage.updatedAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const stale = Date.now() / 1000 - usage.updatedAt > STALE_S
  return (
    <span
      className={`sb-usage ${stale ? 'stale' : ''}`}
      title={
        stale
          ? `Claude plan usage as an agent on ${from} reported it at ${at}. It refreshes when an agent started from Kuna replies, so use since then (background sessions, other terminals) isn't counted yet.`
          : `Claude plan usage, reported by an agent on ${from} at ${at}`
      }
    >
      <Meter label="session" w={usage.fiveHour} />
      <Meter label="week" w={usage.sevenDay} />
      {stale && <span className="sb-usage-age">as of {at}</span>}
    </span>
  )
}

export function StatusBar(): React.JSX.Element {
  const zone = useKuna((s) => s.zone)
  const mode = useKuna((s) => s.mode)
  const hosts = useKuna((s) => s.hosts)
  const agents = useKuna((s) => s.agents)
  const escHint = useKuna((s) => s.escHint)
  const usage = useKuna((s) => s.usage)
  const windows = useKuna((s) => s.windows)

  const list = Object.values(agents)
  const working = list.filter((a) => a.status === 'working').length
  const waiting = list.filter((a) => a.status === 'waiting').length

  let hint: string
  if (zone === 'prompt') hint = escHint ? 'Esc again to discard' : 'Enter start the agent · ← → move in the text · ↑ ↓ pick the folder · ⇧Enter new line · Esc Esc discard'
  else if (mode === 'insert') hint = escHint ? 'Esc again to stop typing' : 'Enter send · ⇧Enter new line · Esc Esc stop typing · ⌘. interrupt'
  else if (zone === 'pane') hint = 'arrows move · type to write · Space plots · ⇧Tab mode · ⌘W close · Ctrl+X kill · ⌘S/⌘B panels'
  else hint = 'arrows move · Enter roll out / open · type + Enter start an agent · ⌘R rename · ⌘O add folder · ⌘/ help'

  const modeName = zone === 'prompt' ? 'launch' : mode === 'insert' ? 'typing' : 'navigate'

  return (
    <footer className="statusbar">
      <span className={`sb-mode sb-${modeName}`}>{modeName}</span>
      {windows.count > 1 && (
        <span className="sb-window" title={keyLabel(`Window ${windows.index + 1} of ${windows.count}: ⌘← ⌘→ go to the others`)}>
          {windows.index + 1}/{windows.count}
        </span>
      )}
      <span className="sb-hint">{keyLabel(hint)}</span>
      <span className="sb-spacer" />
      {waiting > 0 && <span className="sb-count st-waiting">{waiting} need you</span>}
      {working > 0 && <span className="sb-count st-working">{working} working</span>}
      <Usage usage={usage} />
      {Object.values(hosts).map((h) => (
        <span key={h.host} className={`sb-host host-${h.status}`} title={h.error ?? h.hostname ?? h.host}>
          <i />
          {h.host === 'local' ? 'local' : h.host}
        </span>
      ))}
    </footer>
  )
}

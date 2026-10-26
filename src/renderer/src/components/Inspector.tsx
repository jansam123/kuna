import { useMemo } from 'react'
import { compactBlocker } from '@shared/input'
import { activeAgentKey, compactAgent } from '../actions'
import { agentTitle, ago, contextOf, doingText, modeLabel, needsOptions, needsText, shortModel, shortPath, STATUS_LABEL, tokens } from '../format'
import { useKuna } from '../store'
import { folderOfAgent } from '../tree'
import { StatusDot } from './StatusDot'
import { TexText } from './TexText'
import { localName } from '../platform'

const TODO_GLYPH: Record<string, string> = { completed: '✓', in_progress: '◐', pending: '○' }

export function Inspector(): React.JSX.Element {
  // re-render on focus/selection changes
  useKuna((s) => s.zone)
  useKuna((s) => s.paneIndex)
  useKuna((s) => s.sel)
  useKuna((s) => s.tabs)
  const key = activeAgentKey()
  const a = useKuna((s) => (key ? s.agents[key] : undefined))
  const d = useKuna((s) => (key ? s.details[key] : undefined))
  const compacting = useKuna((s) => (key ? !!s.compacting[key] : false))
  const hosts = useKuna((s) => s.hosts)
  useKuna((s) => (key ? s.names[key] : undefined))
  const projects = useKuna((s) => s.projects)
  const agents = useKuna((s) => s.agents)
  const where = useMemo(
    () => (key ? folderOfAgent(projects, Object.values(agents), hosts).get(key) : undefined),
    [projects, agents, hosts, key]
  )

  if (!a) {
    return (
      <aside className="inspector">
        <div className="insp-empty">Select an agent to see its tasks, context and tools.</div>
      </aside>
    )
  }

  const ctx = contextOf(a, d)
  const isClaude = a.kind === 'claude' || !!a.transcriptPath || /\bclaude\b/.test(a.command ?? '')
  const blocked = compactBlocker(a)
  const running = d?.subagents.filter((s) => !s.done) ?? []
  const finished = d?.subagents.filter((s) => s.done) ?? []
  const tools = [...(d?.recentTools ?? [])].reverse().slice(0, 12)
  const inner = a.kind === 'claude' ? `claude attach ${a.id.slice(3)}` : `tmux -L kuna attach -t kuna_${a.id}`
  const attach = a.host === 'local' ? inner : `ssh -t ${a.host} ${inner}`
  const need = needsText(a, d)
  const options = needsOptions(a, d)

  return (
    <aside className="inspector">
      <header className="insp-head" style={{ '--repo': where?.folder.color ?? 'var(--faint)' } as React.CSSProperties}>
        <div className="insp-where">
          <span className="swatch" />
          {where ? <TexText text={where.folder.name} /> : a.cwd} <span className="dim">on {a.host === 'local' ? localName.toLowerCase() : a.host}</span>
        </div>
        <h2>{agentTitle(a, d)}</h2>
        <div className={`insp-status st-${a.status}`}>
          <StatusDot status={a.status} />
          {a.activity ? `${STATUS_LABEL[a.status]} · ${doingText(a)}` : doingText(a)}
          {a.status === 'exited' && a.exitCode != null && <span className="dim"> (code {a.exitCode})</span>}
        </div>
      </header>

      {need && (
        <section className="insp-sec insp-need">
          <h3>Needs you</h3>
          <p>{need}</p>
          {options.length > 0 && (
            <ol>
              {options.map((o, i) => (
                <li key={i}>{o}</li>
              ))}
            </ol>
          )}
          <p className="dim">Open the agent and press the number of your answer.</p>
        </section>
      )}

      {a.detail && (a.status === 'working' || a.status === 'background' || a.status === 'failed') && (
        <section className="insp-sec">
          <h3>{a.status === 'failed' ? 'Last words' : a.status === 'background' ? 'Waiting on' : 'Doing now'}</h3>
          <p className="insp-detail">{a.detail}</p>
          {a.activity?.kind === 'scheduled' && a.activity.reason && <p className="dim">Next check: {a.activity.reason}</p>}
        </section>
      )}

      <section className={`insp-sec ctx-${ctx.level}`}>
        <h3>Context</h3>
        <div className="ctx-meter">
          <span style={{ width: `${ctx.pct}%` }} />
        </div>
        <div className="kv">
          <span>
            {tokens(ctx.tokens)} of {tokens(ctx.window)}
          </span>
          <span>{ctx.pct.toFixed(0)}%</span>
        </div>
        {ctx.level === 'long' && <p className="ctx-note">Getting long: replies slow down and early details fade. Compacting keeps a summary.</p>}
        {ctx.level === 'full' && <p className="ctx-note">Almost full: Claude Code will compact on its own soon.</p>}
        {isClaude && (
          <div className="compact-row">
            {/* no focus on click: Space and Enter belong to Kuna's keyboard model */}
            <button className="compact-btn" disabled={!!blocked || compacting} onMouseDown={(e) => e.preventDefault()} onClick={() => void compactAgent(a.key)}>
              {compacting ? 'Compacting…' : 'Compact'}
            </button>
            <span className={blocked || compacting ? 'dim' : 'dim mono'}>{compacting ? 'Typing /compact into it.' : (blocked ?? '/compact')}</span>
          </div>
        )}
        <dl className="facts">
          <dt>Model</dt>
          <dd>{shortModel(d?.model ?? a.model) ?? '—'}</dd>
          <dt>Mode</dt>
          <dd>{modeLabel(d?.permissionMode ?? a.permissionMode) ?? '—'}</dd>
          <dt>Output</dt>
          <dd>{tokens(d?.outputTokens ?? 0)} tokens</dd>
          <dt>Input</dt>
          <dd>
            {tokens(d?.inputTokens ?? 0)} new · {tokens(d?.cacheReadTokens ?? 0)} cached
          </dd>
          <dt>Turns</dt>
          <dd>{d?.turns ?? 0}</dd>
          {a.kind === 'claude' && (
            <>
              <dt>Runs as</dt>
              <dd>Claude background session</dd>
            </>
          )}
          {d?.gitBranch && (
            <>
              <dt>Branch</dt>
              <dd>{d.gitBranch}</dd>
            </>
          )}
          <dt>Started</dt>
          <dd>{ago(a.createdAt)} ago</dd>
        </dl>
      </section>

      {(d?.todos.length ?? 0) > 0 && (
        <section className="insp-sec">
          <h3>Tasks</h3>
          <ul className="todos">
            {d!.todos.map((t) => (
              <li key={t.id} className={`todo todo-${t.status}`}>
                <span className="todo-glyph">{TODO_GLYPH[t.status] ?? '○'}</span>
                <span>{t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(running.length > 0 || finished.length > 0) && (
        <section className="insp-sec">
          <h3>Subagents</h3>
          <ul className="subs">
            {[...running, ...finished.slice(-4)].map((s) => (
              <li key={s.id} className={s.done ? 'done' : 'running'}>
                <span className={`dot ${s.done ? 'dot-idle' : 'dot-working'}`} />
                <span>{s.description || 'subagent'}</span>
                {s.type && <span className="dim">{s.type}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {tools.length > 0 && (
        <section className="insp-sec">
          <h3>Recent tools</h3>
          <ul className="tools">
            {tools.map((t) => (
              <li key={t.id} className={t.error ? 'err' : t.done ? '' : 'live'}>
                <span className="tool-name">{t.name}</span>
                <span className="tool-sum">{t.summary}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(d?.filesTouched.length ?? 0) > 0 && (
        <section className="insp-sec">
          <h3>Files changed</h3>
          <ul className="files">
            {[...d!.filesTouched].reverse().slice(0, 12).map((f) => (
              <li key={f} title={f}>
                {f.startsWith(a.cwd + '/') ? f.slice(a.cwd.length + 1) : shortPath(f, 3)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {(a.lastReply || d?.lastText) && a.status !== 'working' && (
        <section className="insp-sec">
          <h3>Last reply</h3>
          <p className="insp-reply">{(a.lastReply || d?.lastText || '').slice(0, 600)}</p>
        </section>
      )}

      <section className="insp-sec">
        <h3>Session</h3>
        <dl className="facts">
          <dt>Folder</dt>
          <dd className="sel-text">{a.cwd}</dd>
          {a.worktree && (
            <>
              <dt>Worktree</dt>
              <dd className="sel-text">{shortPath(a.worktree, 3)}</dd>
            </>
          )}
          {(d?.sessionId ?? a.sessionId) && (
            <>
              <dt>Session</dt>
              <dd className="sel-text">{d?.sessionId ?? a.sessionId}</dd>
            </>
          )}
          <dt>Attach</dt>
          <dd className="sel-text mono">{attach}</dd>
        </dl>
      </section>
    </aside>
  )
}

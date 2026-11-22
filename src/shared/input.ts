import type { AgentRuntime } from './types'

/**
 * Typing into Claude Code on the user's behalf (the Compact button).
 */

/**
 * Empties Claude Code's input box: End, then Ctrl+U and Backspace for each of
 * up to six lines. Ctrl+Y in Claude Code brings the draft back. `kuna send`
 * presses the same keys through tmux.
 */
export const CLEAR_INPUT = '\x05' + '\x15\x7f'.repeat(6)

/** Why the agent can't take a slash command right now, if it can't. */
export function compactBlocker(a: AgentRuntime): string | undefined {
  // a background session that is not running comes back when its tab opens
  if (!a.alive && a.kind !== 'claude') return 'The agent has exited.'
  if (a.status === 'working') return 'It is in the middle of a turn. Compact it once it is idle.'
  if (a.status === 'waiting') return 'It is waiting for you. Answer it first.'
  if (a.status === 'starting') return 'It is still starting.'
  return undefined
}

export type ScreenState = 'input' | 'busy' | 'question' | 'menu' | 'unknown'

/**
 * The key hints of a panel open in Claude Code (/config, /usage, /model, the
 * resume list), at the start of a line or after a `·`: "Esc to close", "Press
 * Esc to go back", "esc back". Not the spinner's "esc to interrupt", which
 * would stop the turn.
 */
const MENU_HINT = /(?:^|·|│)\s*(?:press\s+)?esc(?: to (?!interrupt)\w| back\b)/i

/** The prompt line between two rules: `❯ ` in Claude Code 2.1, `│ > ` before. */
export function hasInputBox(lines: string[]): boolean {
  const tail = lines.filter((l) => l.trim()).slice(-12)
  return tail.some((l) => /^\s*(?:│\s*)?[❯>]\s/.test(l)) && tail.some((l) => /─{20,}/.test(l))
}

/**
 * What the bottom of a Claude Code screen shows: a question, a panel that Esc
 * closes (even one opened mid-turn), the spinner of a running turn, or the
 * empty input box ready for typing (the prompt line between two rules: `❯ `
 * in Claude Code 2.1, `│ > ` before). The question phrases are the ones
 * `kuna snapshot` looks for on the host.
 */
export function screenState(lines: string[]): ScreenState {
  const tail = lines.filter((l) => l.trim()).slice(-12)
  const text = tail.join('\n')
  if (/Enter to confirm|Esc to cancel|Do you want to/.test(text)) return 'question'
  if (tail.slice(-6).some((l) => MENU_HINT.test(l.trim()))) return 'menu'
  if (/… *\([0-9]|to interrupt/.test(text)) return 'busy'
  return hasInputBox(lines) ? 'input' : 'unknown'
}

/**
 * A slash command is in Claude Code's input box (`/model`, `/config`, `/mod`
 * with the list of commands under it): Enter on it may open a panel instead
 * of sending anything. The input box is the prompt line right under a rule;
 * one further up, in the conversation, is a command that already ran.
 */
export function slashTyped(lines: string[]): boolean {
  const shown = lines.filter((l) => l.trim())
  return shown.some((l, i) => i > 0 && /─{20,}/.test(shown[i - 1]) && /^\s*(?:│\s*)?[❯>]\s+\/\S/.test(l))
}

/** A panel is drawn with the screen's answer to the Enter or right after it; one that isn't there by then isn't coming. */
const PANEL_GRACE_MS = 300
/** A screen that hasn't answered the Enter by now (a far host) is taken as it is. */
const ANSWER_MS = 3000

/**
 * Was an Enter the whole story? After one that may have opened a panel (on a
 * slash command) or brought the next question (in a panel, on a question),
 * call the returned function now and then with the time, whether a panel or
 * question is on the agent's screen, and when the screen last drew. It says
 * true once the screen has answered the Enter and shown neither for a moment:
 * the keyboard is no longer the agent's. While one is on screen it never is.
 */
export function enterWatch(pressed: number): (now: number, panel: boolean, lastOutput: number) => boolean {
  let clear = 0 // since when the screen, having answered, shows no panel
  return (now, panel, lastOutput) => {
    if (panel) clear = 0
    else if (!clear && (lastOutput > pressed || now - pressed >= ANSWER_MS)) clear = now
    return clear > 0 && now - clear >= PANEL_GRACE_MS
  }
}

/** One thing to pick on a question or panel: what it says, and the keys that pick it. */
export interface PanelOption {
  label: string
  /** the lines under it, in one */
  detail: string
  keys: string
  /** the one the screen's `❯` is on */
  current: boolean
}

/** A question or a panel on a Claude Code screen, as something to read and tap. */
export interface Panel {
  state: 'question' | 'menu'
  /** what it says above its list */
  text: string[]
  options: PanelOption[]
  /** what it says under it: which keys do what */
  hint: string[]
}

const firstCol = (l: string): number => l.search(/\S/)

/**
 * The question or panel at the bottom of a Claude Code screen (a permission, a
 * question of the agent's, /model, /config): its text and the rows of its list,
 * each with the keys that pick it. A numbered row is picked by its number; in
 * a list without numbers the `❯` is walked to the row and Enter pressed. Null
 * when the screen shows neither.
 */
export function screenPanel(lines: string[]): Panel | null {
  const state = screenState(lines)
  if (state !== 'question' && state !== 'menu') return null
  // a box's sides are not text
  const rows = lines.map((l) => l.replace(/^(\s*)│/, '$1 ').replace(/│\s*$/, '').trimEnd())
  let end = rows.length
  while (end > 0 && !rows[end - 1].trim()) end--
  let at = -1
  for (let i = end - 1; i >= Math.max(0, end - 40); i--) {
    if (/^\s*❯\s+\S/.test(rows[i])) {
      at = i
      break
    }
  }
  const edge = (i: number): boolean => /─{10,}|[╭╰]/.test(rows[i])
  const top = (from: number): number => {
    for (let i = from; i >= Math.max(0, from - 25); i--) if (edge(i)) return i + 1
    return Math.max(0, from - 8)
  }
  /** the lines that say something, without the list's own rows (`skip`) */
  const said = (from: number, to: number, skip?: Set<number>): string[] => {
    const out: string[] = []
    for (let i = from; i < to; i++) if (!skip?.has(i) && rows[i].trim() && !/^[\s─╭╮╰╯]+$/.test(rows[i])) out.push(rows[i].trim())
    return out
  }
  if (at < 0) return { state, text: said(top(end - 1), end), options: [], hint: [] }

  const col = rows[at].indexOf('❯') + 2
  const label = (i: number): string => rows[i].slice(col).trim()
  const numbered = /^\d+\.\s/.test(label(at))
  const isOption = (i: number): boolean =>
    i === at || (firstCol(rows[i]) === col && !/^[↑↓]\s*\d+ more/.test(label(i)) && (!numbered || /^\d+\.\s/.test(label(i))))
  const start = top(at)
  let picks: number[] = []
  if (numbered) {
    // a numbered list may have a gap in it (its last choices under a rule)
    for (let i = start; i < end; i++) if (isOption(i)) picks.push(i)
  } else {
    let first = at
    while (first > start && rows[first - 1].trim() && firstCol(rows[first - 1]) >= col) first--
    let last = at
    while (last + 1 < end && rows[last + 1].trim() && firstCol(rows[last + 1]) >= col) last++
    for (let i = first; i <= last; i++) if (isOption(i)) picks.push(i)
  }
  picks = picks.sort((a, b) => a - b)
  const cursor = picks.indexOf(at)
  const taken = new Set<number>(picks)
  const options = picks.map((i, n): PanelOption => {
    const detail: string[] = []
    for (let j = i + 1; j < end && rows[j].trim() && firstCol(rows[j]) > col && !taken.has(j); j++) {
      detail.push(rows[j].trim())
      taken.add(j)
    }
    const number = numbered ? Number(/^\d+/.exec(label(i))![0]) : 0
    const walk = n - cursor
    return {
      label: label(i).replace(/^\d+\.\s+/, ''),
      detail: detail.join(' '),
      keys: number >= 1 && number <= 9 ? String(number) : (walk > 0 ? '\x1b[B'.repeat(walk) : '\x1b[A'.repeat(-walk)) + '\r',
      current: i === at
    }
  })
  return { state, text: said(start, picks[0]), options, hint: said(picks[0], end, taken) }
}

/**
 * Kuna's shortcuts are ⌘ keys, written that way throughout. On a Mac ⌘ is the
 * Command key; elsewhere it is Ctrl+Shift (and ⇧⌘ is Ctrl+Shift+Alt), as in
 * Windows Terminal, so that plain Ctrl keys always reach the agent's terminal
 * (Ctrl+C, Ctrl+R, Ctrl+O…). Ctrl+X Ctrl+X stays Ctrl+X everywhere.
 */

/** The parts of a KeyboardEvent the shortcuts look at. */
export interface KeyPress {
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/** The physical key with Shift held (Ctrl+Shift+1 is '1', not '!'). */
const CODE_KEYS: Record<string, string> = { Period: '.', Comma: ',', Slash: '/', Equal: '=', Minus: '-', Backquote: '`' }
function unshifted(ev: KeyPress): string {
  const m = /^(?:Key|Digit)(.)$/.exec(ev.code)
  if (m) return m[1].toLowerCase()
  return CODE_KEYS[ev.code] ?? ev.key
}

export interface CmdKey {
  /** the key, lowercased for letters ('r', '1', '/', 'ArrowLeft', 'Backspace') */
  key: string
  /** ⇧ held with ⌘ (Alt outside macOS, where Shift is part of ⌘) */
  shift: boolean
}

/** The ⌘ shortcut this key press is, if it is one. */
export function cmdKeyOf(ev: KeyPress, mac: boolean): CmdKey | undefined {
  if (mac) {
    if (!ev.metaKey || ev.ctrlKey) return undefined
    return { key: ev.key.length === 1 ? ev.key.toLowerCase() : ev.key, shift: ev.shiftKey }
  }
  if (!ev.ctrlKey || !ev.shiftKey || ev.metaKey) return undefined
  return { key: unshifted(ev), shift: ev.altKey }
}

/** Modifiers that still type a character: none, or AltGr (Ctrl+Alt) outside macOS. */
export function typesCharacter(ev: KeyPress, mac: boolean): boolean {
  if (ev.metaKey) return false
  if (!mac && ev.ctrlKey && ev.altKey) return true
  return !ev.ctrlKey && !ev.altKey
}

/** Shortcut text as written for a Mac ("⇧⌘R"), for the other keyboards. */
export function keyLabelFor(text: string, mac: boolean): string {
  if (mac) return text
  return text
    .replace(/⌥ ?drag/g, 'Shift+drag')
    .replace(/Option\+drag/g, 'Shift+drag')
    .replace(/⇧⌘/g, 'Ctrl+Shift+Alt+')
    .replace(/⌥⌘/g, 'Ctrl+Alt+')
    .replace(/⌘(?=\S)/g, 'Ctrl+Shift+')
    .replace(/⌘/g, 'Ctrl+Shift')
    .replace(/⌥(?=\S)/g, 'Alt+')
    .replace(/⌥/g, 'Alt')
    .replace(/⇧(?=\S)/g, 'Shift+')
    .replace(/⇧/g, 'Shift')
    .replace(/⌫/g, 'Backspace')
}

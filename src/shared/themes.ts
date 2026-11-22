/** A terminal's colours, in the names xterm.js gives them. */
export interface TerminalColors {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  black: string
  brightBlack: string
  red: string
  brightRed: string
  green: string
  brightGreen: string
  yellow: string
  brightYellow: string
  blue: string
  brightBlue: string
  magenta: string
  brightMagenta: string
  cyan: string
  brightCyan: string
  white: string
  brightWhite: string
}

/**
 * Colour schemes. Terminals are always pure black; the chrome around them is
 * a near-black ground with one family of accents. Named after things you see
 * in a detector, since that is where most of these agents end up working.
 */
export interface Theme {
  id: string
  name: string
  blurb: string
  /** window chrome */
  ground: string
  panel: string
  raised: string
  line: string
  text: string
  dim: string
  faint: string
  /** focus ring, selection, working pulse */
  accent: string
  /** typing mode */
  insert: string
  /** status */
  working: string
  waiting: string
  idle: string
  exited: string
  unread: string
  danger: string
  terminal: TerminalColors
}

const ansi = {
  black: '#000000',
  brightBlack: '#5a5f6b',
  red: '#ff5f6d',
  brightRed: '#ff8a94',
  green: '#4ade80',
  brightGreen: '#86efac',
  yellow: '#facc15',
  brightYellow: '#fde68a',
  blue: '#60a5fa',
  brightBlue: '#93c5fd',
  magenta: '#c084fc',
  brightMagenta: '#d8b4fe',
  cyan: '#22d3ee',
  brightCyan: '#67e8f9',
  white: '#d4d7de',
  brightWhite: '#ffffff'
}

/**
 * Status and notification colours, the same in every scheme so they always
 * mean the same thing: blue working, amber needs you, grey idle, red failed,
 * cyan unread. Schemes differ only in the chrome around them.
 */
const STATUS_COLORS = {
  working: '#4d8dff',
  waiting: '#ffb547',
  idle: '#6b7488',
  exited: '#3a4152',
  unread: '#6fe3ff',
  danger: '#ff5a6e'
}

function term(fg: string, cursor: string, selection: string): TerminalColors {
  return { ...ansi, background: '#000000', foreground: fg, cursor, cursorAccent: '#000000', selectionBackground: selection }
}

export const THEMES: Theme[] = [
  {
    id: 'cherenkov',
    name: 'Cherenkov',
    blurb: 'Blue glow on black. Calm, cool, high legibility.',
    ground: '#05070c',
    panel: '#090c14',
    raised: '#0f1420',
    line: '#1a2133',
    text: '#dfe6f5',
    dim: '#8590a8',
    faint: '#4a5368',
    accent: '#4d8dff',
    insert: '#a78bff',
    ...STATUS_COLORS,
    terminal: term('#dfe6f5', '#4d8dff', '#4d8dff55')
  },
  {
    id: 'calorimeter',
    name: 'Calorimeter',
    blurb: 'Amber energy deposits. Warm, high-contrast attention cues.',
    ground: '#090604',
    panel: '#0f0a06',
    raised: '#18110a',
    line: '#2a1d10',
    text: '#f3e6d6',
    dim: '#a48f78',
    faint: '#5c4c3b',
    accent: '#ff9f1c',
    insert: '#ff5d3a',
    ...STATUS_COLORS,
    terminal: term('#f3e6d6', '#ff9f1c', '#ff9f1c44')
  },
  {
    id: 'tracker',
    name: 'Tracker',
    blurb: 'Teal tracks through silicon. Crisp and technical.',
    ground: '#030807',
    panel: '#060e0c',
    raised: '#0b1714',
    line: '#13261f',
    text: '#d9f3ec',
    dim: '#7fa79c',
    faint: '#3f5a52',
    accent: '#2ee6c5',
    insert: '#9bf26a',
    ...STATUS_COLORS,
    terminal: term('#d9f3ec', '#2ee6c5', '#2ee6c544')
  },
  {
    id: 'muon',
    name: 'Muon',
    blurb: 'Violet and magenta. Moody, but status still pops.',
    ground: '#07040b',
    panel: '#0c0713',
    raised: '#140c1f',
    line: '#24173a',
    text: '#ece0fa',
    dim: '#9c88b8',
    faint: '#55456e',
    accent: '#c26bff',
    insert: '#ff6bc1',
    ...STATUS_COLORS,
    terminal: term('#ece0fa', '#c26bff', '#c26bff44')
  },
  {
    id: 'phosphor',
    name: 'Phosphor',
    blurb: 'Grey chrome with one P1-green signal. Minimal colour noise.',
    ground: '#050505',
    panel: '#0a0a0a',
    raised: '#121212',
    line: '#202020',
    text: '#e6e6e6',
    dim: '#8c8c8c',
    faint: '#4d4d4d',
    accent: '#39ff88',
    insert: '#e6e6e6',
    ...STATUS_COLORS,
    terminal: term('#e6e6e6', '#39ff88', '#39ff8840')
  },
  {
    id: 'black',
    name: 'Black',
    blurb: 'Black with plain greys, no tint. Colour is left to status and your projects.',
    ground: '#000000',
    panel: '#000000',
    raised: '#141414',
    line: '#262626',
    text: '#d4d4d4',
    dim: '#9a9a9a',
    faint: '#5c5c5c',
    accent: '#a8a8a8',
    insert: '#d4d4d4',
    ...STATUS_COLORS,
    terminal: term('#d4d4d4', '#a8a8a8', '#a8a8a840')
  }
]

/** Colours for projects and folders: distinct hues that read well on black in every scheme. */
export const REPO_COLORS = [
  '#4d8dff',
  '#ff9f1c',
  '#2ee6c5',
  '#c26bff',
  '#ff5d73',
  '#a3e635',
  '#ffd166',
  '#6fe3ff',
  '#f472b6',
  '#a1a1aa',
  '#22c55e',
  '#f97316',
  '#818cf8',
  '#e879f9',
  '#14b8a6',
  '#fde047',
  '#fb7185',
  '#38bdf8',
  '#bef264',
  '#c4b5fd',
  '#f59e0b',
  '#5eead4',
  '#fda4af',
  '#93c5fd'
]

export function themeById(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]
}

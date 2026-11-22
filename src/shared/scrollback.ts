/**
 * What an agent's pane has scrolled past, as text the phone can scroll and
 * select like any other: `kuna scrollback` prints the newest lines of tmux's
 * history and the screen under them with their colours (`capture-pane -e`),
 * and this keeps the lines and says what changed since the last time.
 */

/** How a run of text looks. Colours are resolved against the theme: `#rrggbb`, or none for the theme's own. */
export interface BackStyle {
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
}

/** Lines joined by newlines, and their styles as `[length, style, length, style…]` over the text (lengths in UTF-16 units, as both JavaScript and iOS count). */
export interface BackBlock {
  text: string
  runs: number[]
}

export interface BackUpdate {
  /** nothing was taken: what came does not connect to what is held; ask again from line 0 */
  refetch: boolean
  /** how much of the text held so far stays (UTF-16 units); `add` goes after it, on a new line when something stays */
  keep: number
  add: BackBlock
  /** what the screen shows now */
  screen: BackBlock
  styles: BackStyle[]
  /** the history's size on the host, to ask from next time */
  size: number
  /** the pane's width in columns */
  cols: number
}

/** the terminal's colours by name, as a theme has them (`background`, `foreground`, `black` … `brightWhite`) */
export type BackPalette = Record<string, string>

const NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite']
const BOLD = 1
const DIM = 2
const ITALIC = 4
const UNDERLINE = 8
const INVERSE = 16
const STRIKE = 32
/** a colour: -1 the theme's own, 0–255 the palette's, above that 24 bits of red, green and blue */
const RGB = 0x1000000

interface Pen {
  fg: number
  bg: number
  flags: number
}

/** a line as it is kept: its text, and its runs as `[length, pen]` pairs with the pen written out */
interface Line {
  t: string
  r: [number, string][]
}

/** One `ESC [ … m`: what it changes of the pen. */
function sgr(pen: Pen, params: string): void {
  const p = params === '' ? [0] : params.split(/[;:]/).map((x) => (x === '' ? -1 : Number(x)))
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === 0) Object.assign(pen, { fg: -1, bg: -1, flags: 0 })
    else if (c === 1) pen.flags |= BOLD
    else if (c === 2) pen.flags |= DIM
    else if (c === 3) pen.flags |= ITALIC
    else if (c === 4) pen.flags |= UNDERLINE
    else if (c === 7) pen.flags |= INVERSE
    else if (c === 9) pen.flags |= STRIKE
    else if (c === 22) pen.flags &= ~(BOLD | DIM)
    else if (c === 23) pen.flags &= ~ITALIC
    else if (c === 24) pen.flags &= ~UNDERLINE
    else if (c === 27) pen.flags &= ~INVERSE
    else if (c === 29) pen.flags &= ~STRIKE
    else if (c >= 30 && c <= 37) pen.fg = c - 30
    else if (c >= 90 && c <= 97) pen.fg = c - 82
    else if (c === 39) pen.fg = -1
    else if (c >= 40 && c <= 47) pen.bg = c - 40
    else if (c >= 100 && c <= 107) pen.bg = c - 92
    else if (c === 49) pen.bg = -1
    else if (c === 38 || c === 48) {
      let color = -1
      if (p[i + 1] === 5) {
        color = p[i + 2] ?? -1
        i += 2
      } else if (p[i + 1] === 2) {
        // `38:2::r:g:b` has an empty colour space before the three
        const at = p[i + 2] === -1 && p.length - i > 5 ? i + 3 : i + 2
        color = RGB + (((p[at] & 255) << 16) | ((p[at + 1] & 255) << 8) | (p[at + 2] & 255))
        i = at + 2
      }
      if (c === 38) pen.fg = color
      else pen.bg = color
    }
  }
}

/** `capture-pane -e` output → its lines. The pen carries from one line to the next, as tmux writes it. */
function parse(lines: string[]): Line[] {
  const pen: Pen = { fg: -1, bg: -1, flags: 0 }
  // a colour change, a link (OSC 8), or any other sequence, which is dropped
  const esc = /\x1b\[([0-9;:]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;:?<=>]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b./g
  return lines.map((raw) => {
    const line: Line = { t: '', r: [] }
    const put = (text: string): void => {
      if (!text) return
      const key = `${pen.fg},${pen.bg},${pen.flags}`
      const last = line.r[line.r.length - 1]
      if (last && last[1] === key) last[0] += text.length
      else line.r.push([text.length, key])
      line.t += text
    }
    let from = 0
    for (const m of raw.matchAll(esc)) {
      put(raw.slice(from, m.index))
      from = m.index + m[0].length
      if (m[1] !== undefined) sgr(pen, m[1])
    }
    put(raw.slice(from))
    return line
  })
}

const same = (a: Line, b: Line): boolean => a.t === b.t && a.r.length === b.r.length && a.r.every((run, i) => run[0] === b.r[i][0] && run[1] === b.r[i][1])

function hex(color: number, palette: BackPalette): string | undefined {
  if (color < 0) return undefined
  if (color >= RGB) return '#' + (color - RGB).toString(16).padStart(6, '0')
  if (color < 16) return palette[NAMES[color]]
  const two = (n: number): string => n.toString(16).padStart(2, '0')
  if (color >= 232) return '#' + two(8 + (color - 232) * 10).repeat(3)
  // the 6×6×6 cube
  const level = (n: number): number => (n ? 55 + n * 40 : 0)
  const c = color - 16
  return '#' + two(level(Math.floor(c / 36))) + two(level(Math.floor(c / 6) % 6)) + two(level(c % 6))
}

/** the most lines kept, and what is left when there are more */
const MOST = 4000
const LEFT = 3000
/** `kuna scrollback` sends at most this many lines of history */
const SENT = 2000
/** how many of the lines that came must be found in what is held, to go on from there */
const OVERLAP = 8

export class Scrollback {
  private lines: Line[] = []
  private cols = 0
  /** the length of the lines held as one text, newlines between them */
  private length = 0

  /**
   * Take what `kuna scrollback` printed: `history-size pane-height pane-width
   * history-limit`, then the newest history lines and the screen. The history
   * lines that came go on from where they are found in what is held (a pane
   * that got taller took its last lines back: they are dropped); when they are
   * not found and are not all there is, nothing is taken and `refetch` is set.
   */
  feed(reply: string, palette: BackPalette): BackUpdate {
    const nl = reply.indexOf('\n')
    const [size, rows, cols] = (nl < 0 ? reply : reply.slice(0, nl)).trim().split(/\s+/).map(Number)
    const body = nl < 0 ? [] : reply.slice(nl + 1).replace(/\n$/, '').split('\n')
    const parsed = parse(body)
    const visible = Math.min(rows || 0, parsed.length)
    const came = parsed.slice(0, parsed.length - visible)
    const screen = parsed.slice(parsed.length - visible)
    const styles = new Styles(palette)
    const out = (keep: number, add: Line[], refetch = false): BackUpdate => ({ refetch, keep, add: styles.block(add), screen: styles.block(screen), styles: styles.list, size: size || 0, cols: cols || 0 })

    const whole = came.length >= (size || 0) || came.length >= SENT
    let at = -1
    if (cols === this.cols && this.lines.length && came.length) {
      const head = came.slice(0, OVERLAP)
      for (let p = this.lines.length - head.length; p >= 0 && at < 0; p--) if (head.every((l, i) => same(l, this.lines[p + i]))) at = p
    }
    if (at < 0 && !whole && (came.length || this.lines.length)) return out(this.length, [], true)
    if (at < 0) at = 0
    // what came and is held already stays as it is
    let k = 0
    while (cols === this.cols && k < came.length && at + k < this.lines.length && same(came[k], this.lines[at + k])) k++
    const stay = cols === this.cols ? at + k : 0
    if (stay === this.lines.length && k === came.length) return out(this.length, [])
    const total = (lines: Line[]): number => Math.max(0, lines.reduce((n, l) => n + l.t.length + 1, 0) - 1)
    let keep = total(this.lines.slice(0, stay))
    let add = came.slice(stay - at)
    this.cols = cols || 0
    this.lines = this.lines.slice(0, stay).concat(add)
    if (this.lines.length > MOST) {
      this.lines = this.lines.slice(-LEFT)
      keep = 0
      add = this.lines
    }
    this.length = total(this.lines)
    return out(keep, add)
  }
}

/** The styles a block uses, each once. */
class Styles {
  list: BackStyle[] = []
  private index = new Map<string, number>()
  constructor(private palette: BackPalette) {}

  private of(key: string): number {
    const known = this.index.get(key)
    if (known !== undefined) return known
    const [fg, bg, flags] = key.split(',').map(Number)
    const style: BackStyle = {}
    let front = hex(fg, this.palette)
    let back = hex(bg, this.palette)
    if (flags & INVERSE) [front, back] = [back ?? this.palette.background, front ?? this.palette.foreground]
    if (front) style.fg = front
    if (back) style.bg = back
    if (flags & BOLD) style.bold = true
    if (flags & DIM) style.dim = true
    if (flags & ITALIC) style.italic = true
    if (flags & UNDERLINE) style.underline = true
    if (flags & STRIKE) style.strike = true
    this.index.set(key, this.list.length)
    this.list.push(style)
    return this.list.length - 1
  }

  block(lines: Line[]): BackBlock {
    const runs: number[] = []
    const plain = this.of('-1,-1,0')
    lines.forEach((line, i) => {
      for (const [length, key] of line.r) runs.push(length, this.of(key))
      // the newline after it
      if (i < lines.length - 1) runs.push(1, plain)
    })
    return { text: lines.map((l) => l.t).join('\n'), runs }
  }
}

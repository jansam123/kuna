/**
 * A line diff for the iPhone's review view (the Mac's uses Monaco's): which
 * lines stayed, went and came, with their numbers on each side.
 */
export interface DiffRow {
  kind: 'same' | 'add' | 'del'
  /** 1-based line number in the old text (same, del) */
  old?: number
  /** 1-based line number in the new text (same, add) */
  new?: number
  text: string
}

/** past this many changed lines the middle is shown as all removed, then all added */
const MAX_EDITS = 3000

/** Text as lines, without the empty one a final newline would leave. */
export function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Myers' shortest edit script between two lists of lines. */
export function diffLines(a: string[], b: string[]): DiffRow[] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let enda = a.length
  let endb = b.length
  while (enda > start && endb > start && a[enda - 1] === b[endb - 1]) {
    enda--
    endb--
  }
  const out: DiffRow[] = []
  for (let i = 0; i < start; i++) out.push({ kind: 'same', old: i + 1, new: i + 1, text: a[i] })
  out.push(...middle(a, b, start, enda, endb))
  for (let i = enda, j = endb; i < a.length; i++, j++) out.push({ kind: 'same', old: i + 1, new: j + 1, text: a[i] })
  return out
}

function middle(a: string[], b: string[], start: number, enda: number, endb: number): DiffRow[] {
  const n = enda - start
  const m = endb - start
  const dels = (): DiffRow[] => Array.from({ length: n }, (_, i) => ({ kind: 'del' as const, old: start + i + 1, text: a[start + i] }))
  const adds = (): DiffRow[] => Array.from({ length: m }, (_, j) => ({ kind: 'add' as const, new: start + j + 1, text: b[start + j] }))
  if (!n || !m) return [...dels(), ...adds()]
  const max = Math.min(n + m, MAX_EDITS)
  const size = 2 * max + 1
  const v = new Int32Array(size)
  const trace: Int32Array[] = []
  let found = -1
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[max + k - 1] < v[max + k + 1]) ? v[max + k + 1] : v[max + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[start + x] === b[start + y]) {
        x++
        y++
      }
      v[max + k] = x
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
  }
  if (found < 0) return [...dels(), ...adds()]
  // walk back from the end, one edit a step
  const rev: DiffRow[] = []
  let x = n
  let y = m
  for (let d = found; d > 0; d--) {
    const prev = trace[d]
    const k = x - y
    const down = k === -d || (k !== d && prev[max + k - 1] < prev[max + k + 1])
    const pk = down ? k + 1 : k - 1
    const px = prev[max + pk]
    const py = px - pk
    while (x > (down ? px : px + 1) && y > (down ? py + 1 : py)) {
      x--
      y--
      rev.push({ kind: 'same', old: start + x + 1, new: start + y + 1, text: a[start + x] })
    }
    if (down) {
      y--
      rev.push({ kind: 'add', new: start + y + 1, text: b[start + y] })
    } else {
      x--
      rev.push({ kind: 'del', old: start + x + 1, text: a[start + x] })
    }
  }
  while (x > 0 && y > 0) {
    x--
    y--
    rev.push({ kind: 'same', old: start + x + 1, new: start + y + 1, text: a[start + x] })
  }
  return rev.reverse()
}

/** A run of rows to show, or a run of unchanged ones folded away. */
export type DiffPart = { rows: DiffRow[] } | { folded: DiffRow[] }

/** The changes with `context` unchanged lines around each; the rest folded. */
export function foldUnchanged(rows: DiffRow[], context = 3): DiffPart[] {
  const keep = new Uint8Array(rows.length)
  rows.forEach((r, i) => {
    if (r.kind === 'same') return
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) keep[j] = 1
  })
  const parts: DiffPart[] = []
  let i = 0
  while (i < rows.length) {
    let j = i
    while (j < rows.length && keep[j] === keep[i]) j++
    const run = rows.slice(i, j)
    // a fold of a line or two would hide less than its own row takes
    if (keep[i] || run.length <= 2) {
      const last = parts[parts.length - 1]
      if (last && 'rows' in last) last.rows.push(...run)
      else parts.push({ rows: run })
    } else parts.push({ folded: run })
    i = j
  }
  return parts
}

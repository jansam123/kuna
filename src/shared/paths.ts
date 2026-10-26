/**
 * Paths typed or pasted into the folder dialog.
 */

/**
 * A Windows path ("C:\\Users\\me", "C:/Users/me") as WSL sees it
 * ("/mnt/c/Users/me"): on Windows this PC's agents run in WSL. A drive
 * letter means nothing on any other host either, so this applies everywhere.
 */
export function wslPath(p: string): string {
  const m = /^([A-Za-z]):(?:[\\/](.*))?$/.exec(p)
  return m ? `/mnt/${m[1].toLowerCase()}/${(m[2] ?? '').replace(/\\/g, '/')}` : p
}

/** Repeated slashes collapse ("a//b" → "a/b"); Windows paths become WSL's. */
export function cleanTypedPath(v: string): string {
  return wslPath(v).replace(/\/{2,}/g, '/')
}

/**
 * A pasted path, as the user means it: quotes, a trailing newline and
 * "file://" dropped. An absolute or home path replaces what is in the field
 * (the field starts as "~/", and "~/" + "/project/…" is not what anyone wants);
 * anything else is inserted where the selection is.
 */
export function pastePath(field: string, pasted: string, selStart: number, selEnd: number): { value: string; caret: number } {
  let p = pasted.trim().replace(/^file:\/\//, '')
  if (/^(['"]).*\1$/.test(p)) p = p.slice(1, -1)
  // file:///C:/… and C:\… from Windows
  p = wslPath(p.replace(/^\/(?=[A-Za-z]:)/, ''))
  if (p.startsWith('/') || p.startsWith('~')) {
    const value = cleanTypedPath(p)
    return { value, caret: value.length }
  }
  const value = cleanTypedPath(field.slice(0, selStart) + p + field.slice(selEnd))
  return { value, caret: Math.min(value.length, selStart + p.length) }
}

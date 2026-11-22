import type { Theme } from '@shared/themes'

export { REPO_COLORS, THEMES, themeById, type Theme } from '@shared/themes'

export function applyTheme(t: Theme): void {
  // lets a scheme style what colours alone can't (Black's inverted selection)
  document.documentElement.dataset.theme = t.id
  const r = document.documentElement.style
  const vars: Record<string, string> = {
    ground: t.ground,
    panel: t.panel,
    raised: t.raised,
    line: t.line,
    text: t.text,
    dim: t.dim,
    faint: t.faint,
    accent: t.accent,
    insert: t.insert,
    working: t.working,
    waiting: t.waiting,
    idle: t.idle,
    exited: t.exited,
    unread: t.unread,
    danger: t.danger
  }
  for (const [k, v] of Object.entries(vars)) r.setProperty(`--${k}`, v)
}

/**
 * How full an agent's context is. Claude Code reports the tokens each reply
 * was given (input + cache writes + cache reads). The window follows Claude
 * Code's model table: 200k for Claude 3, Opus/Sonnet 4–4.5 and Haiku 4.5
 * (unless run as `[1m]`), 1M natively for everything newer.
 */

const WINDOW_200K = /^claude-(?:3|(?:opus|sonnet|haiku)-4(?:-[015])?(?:-\d{8})?$)/
const ONE_MILLION = /\[1m\]|-1m\b/i

export type ContextLevel = 'ok' | 'long' | 'full'

export interface ContextInfo {
  tokens: number
  window: number
  /** 0–100 */
  pct: number
  level: ContextLevel
}

/**
 * The plain model id behind provider spellings: Bedrock
 * (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`) and Vertex
 * (`claude-sonnet-4-5@20250929`) become `claude-sonnet-4-5-20250929`.
 */
export function baseModelId(model: string): string {
  const m = model.toLowerCase()
  const i = m.indexOf('claude-')
  return (i >= 0 ? m.slice(i) : m)
    .replace(/\[1m\]$/, '')
    .replace(/-v\d+(?::\d+)?$/, '')
    .replace(/@(\d{8})$/, '-$1')
}

/** A model for people: `claude-sonnet-4-5-20250929` (or a provider's spelling of it) → `sonnet 4.5`, `claude-sonnet-4-20250514` → `sonnet 4`. */
export function shortModel(model?: string): string | undefined {
  if (!model) return undefined
  const name = baseModelId(model)
    .replace(/^claude-/, '')
    // the date first, or it would pass for a minor version
    .replace(/-\d{8}$/, '')
    .replace(/-(\d+)(?:-(\d{1,2}))?$/, (_, major: string, minor?: string) => ` ${major}${minor ? `.${minor}` : ''}`)
  return /\[1m\]$/i.test(model) ? `${name}[1m]` : name
}

/** The `--model` an agent was started with (`claude --model sonnet[1m]` → `sonnet[1m]`). */
export function modelFlag(command?: string): string | undefined {
  const m = /(?:^|\s)--model(?:=|\s+)(['"]?)([^\s'"]+)\1/.exec(command ?? '')
  return m?.[2]
}

/**
 * @param model the model of its replies, as the transcript has it (an API id)
 * @param peak the most it has ever had in context
 * @param flag what it was started with (`--model`), the only place `[1m]` shows up
 */
export function contextWindowSize(tokens: number, model?: string, peak = 0, flag?: string): number {
  if (Math.max(tokens, peak) > 200_000 || ONE_MILLION.test(model ?? '') || ONE_MILLION.test(flag ?? '')) return 1_000_000
  // unknown model: assume the smaller window until usage says otherwise
  if (!model || WINDOW_200K.test(baseModelId(model))) return 200_000
  return 1_000_000
}

/**
 * `long` from half the window (or 300k tokens, where even 1M sessions get slow
 * and forgetful); `full` from 80%, close to where Claude Code compacts by itself.
 */
export function contextLevel(tokens: number, window: number): ContextLevel {
  if (tokens >= window * 0.8) return 'full'
  if (tokens >= window * 0.5 || tokens >= 300_000) return 'long'
  return 'ok'
}

export function contextInfo(tokens: number, model?: string, peak = 0, flag?: string): ContextInfo {
  const window = contextWindowSize(tokens, model, peak, flag)
  return { tokens, window, pct: Math.min(100, (tokens / window) * 100), level: contextLevel(tokens, window) }
}

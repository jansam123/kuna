/**
 * What the iPhone app calls in Kuna's shared logic. Bundled by
 * `npm run ios:bundle` into one script that the app runs in JavaScriptCore:
 * no DOM, no Node, strings in and JSON out.
 */
import type { HostId } from '@shared/types'
import { frameToAgents, onLocalClock, parseFrame } from '@shared/watch'

declare const __KUNA_SCRIPT__: string
declare const __KUNA_VERSION__: string

/** the helper installed on hosts, and its version (as `src/main/hosts/script.ts`) */
export const script = __KUNA_SCRIPT__
export const version = __KUNA_VERSION__

/** One watch frame (its lines, the host's clock at its end) as agents on the phone's clock. */
export function agents(host: string, lines: string[], now: number, offset: number): string {
  return JSON.stringify(onLocalClock(frameToAgents(host as HostId, parseFrame(lines, now)), offset))
}

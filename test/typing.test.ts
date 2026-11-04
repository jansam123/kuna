import { describe, expect, it, vi } from 'vitest'
import type { AgentRuntime } from '@shared/types'

// the agent's terminal, without xterm: what is written to it is recorded
const t = vi.hoisted(() => ({ writes: [] as string[], entry: { key: 'h::a', typed: 0, paged: true } as Record<string, unknown> }))
vi.mock('../src/renderer/src/terminals', () => ({
  terminalEntry: () => t.entry,
  writeToAgent: (_key: string, data: string) => (t.writes.push(data), true),
  copyTerminalSelection: () => false,
  disposeTerminal: () => {},
  pageAgent: () => {},
  reattach: () => {},
  screenLines: () => [],
  termFont: () => ({ size: 12 }),
  zenColumns: () => 160,
  zenFontSize: () => 14
}))

import { typeToAgent } from '../src/renderer/src/keys'
import { set } from '../src/renderer/src/store'

const KEY = 'h::a'
const press = (key: string): KeyboardEvent =>
  ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, preventDefault() {}, stopPropagation() {} }) as unknown as KeyboardEvent

describe('typing into an agent in tmux scroll mode', () => {
  it('sends the keys typed while tmux leaves it in order, after it has', async () => {
    let left!: () => void
    ;(globalThis as { window?: unknown }).window = { kuna: { agents: { key: () => new Promise<void>((r) => (left = r)) } } }
    set({ agents: { [KEY]: { key: KEY, kind: 'tmux', inCopyMode: true } as AgentRuntime } })
    const enter = (): void => void t.writes.push('\r')
    for (const k of ['h', 'i', 'Enter']) expect(typeToAgent(KEY, press(k), enter)).toBe(true)
    expect(t.writes).toEqual([])
    left()
    await new Promise((r) => setTimeout(r, 0))
    expect(t.writes).toEqual(['h', 'i', '\r'])
    // out of it now (the host's report lags): straight to the terminal
    expect(typeToAgent(KEY, press('x'), enter)).toBe(false)
  })
})

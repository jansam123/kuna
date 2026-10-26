import { cmdKeyOf, keyLabelFor, typesCharacter, type CmdKey } from '@shared/shortcuts'

/** ⌘ is the Command key on a Mac and Ctrl+Shift elsewhere (see @shared/shortcuts). */
const platform = typeof window !== 'undefined' ? window.kuna?.platform : undefined
export const isMac = (platform ?? 'darwin') === 'darwin'

/** What this machine is called next to SSH hosts: on Windows its agents run in WSL. */
export const localName = isMac ? 'this Mac' : 'this PC'
export const LocalName = isMac ? 'This Mac' : 'This PC (WSL)'

/** The ⌘ shortcut this key press is, if it is one. */
export const cmdKey = (ev: KeyboardEvent): CmdKey | undefined => cmdKeyOf(ev, isMac)
/** No modifiers that would make the key a shortcut (AltGr types characters). */
export const printableMods = (ev: KeyboardEvent): boolean => typesCharacter(ev, isMac)
/** Shortcut text written for a Mac ("⇧⌘R"), for this keyboard. */
export const keyLabel = (text: string): string => keyLabelFor(text, isMac)

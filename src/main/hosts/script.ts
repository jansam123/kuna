import { createHash } from 'node:crypto'
import source from '../remote/kuna.sh?raw'

// a Windows checkout may have turned the script's line endings into CRLF, which sh can't run
const raw = source.replace(/\r\n/g, '\n')

/** Version = content hash, so any change to the helper triggers a reinstall. */
export const KUNA_VERSION = createHash('sha1').update(raw).digest('hex').slice(0, 12)

export const KUNA_SCRIPT = raw.replace('__KUNA_VERSION__', KUNA_VERSION)

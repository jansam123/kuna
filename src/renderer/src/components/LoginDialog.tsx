import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { cmdKey, keyLabel } from '../platform'
import { get } from '../store'
import { termFont } from '../terminals'
import { themeById } from '../themes'
import { closeOverlay } from './Overlays'

/**
 * A small terminal running `ssh <host>` so you can type a password, OTP or
 * accept a host key. Once ssh has a shared connection open, Kuna reuses it.
 */
export function LoginDialog({ host }: { host: string }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [done, setDone] = useState<number | null>(null)

  useEffect(() => {
    const font = termFont()
    const term = new Terminal({
      fontFamily: font.family,
      fontSize: font.size,
      lineHeight: font.lineHeight,
      theme: themeById(get().settings.theme).terminal,
      cursorBlink: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(ref.current!)
    fit.fit()
    term.focus()
    let ptyId: string | undefined
    const offData = window.kuna.pty.onData((id, data) => id === ptyId && term.write(data))
    const offExit = window.kuna.pty.onExit((id, code) => {
      if (id !== ptyId) return
      setDone(code)
      if (code === 0) {
        void window.kuna.hosts.reconnect(host)
        setTimeout(closeOverlay, 900)
      }
    })
    term.onData((d) => ptyId && window.kuna.pty.write(ptyId, d))
    void window.kuna.pty.login(host, term.cols, term.rows).then((id) => (ptyId = id))

    const onKey = (ev: KeyboardEvent): void => {
      if (cmdKey(ev)?.key === 'Escape') closeOverlay()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      offData()
      offExit()
      if (ptyId) window.kuna.pty.close(ptyId)
      term.dispose()
    }
  }, [host])

  return (
    <div className="scrim">
      <div className="dialog wide">
        <h2>Sign in to {host}</h2>
        <p className="dim">
          Kuna needs one interactive login to open a shared SSH connection. Answer the prompts below; the window closes when you are
          in. {keyLabel('⌘Esc')} cancels.
        </p>
        <div className="login-term" ref={ref} />
        {done != null && done !== 0 && (
          <div className="dialog-actions">
            <span className="dim">ssh exited with code {done}.</span>
            <span className="ph-spacer" />
            <button onClick={closeOverlay}>Close</button>
          </div>
        )}
      </div>
    </div>
  )
}

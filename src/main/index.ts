import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, clipboard, ipcMain, Menu, session, shell, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { IPC } from '@shared/ipc'
import { applyPatch, sharedOf, type SharedPatch } from '@shared/sync'
import type { SpawnRequest, WindowLayout } from '@shared/types'
import type { Rect } from '@shared/windows'
import { AgentService } from './agents'
import { ClaudeFilesService, MediaService } from './files'
import { detectFonts } from './fonts'
import { PtyService } from './pty'
import { adoptLoginShellPath } from './shellEnv'
import { listSshHosts } from './sshHosts'
import { Store } from './store'
import { Windows } from './windows'

const mac = process.platform === 'darwin'
/**
 * Development hooks (scripted runs, a separate profile, the dev server, DevTools)
 * exist only when running from source; a built Kuna.app ignores the variables.
 */
const fromSource = !app.isPackaged
const automation = fromSource ? process.env.KUNA_AUTOMATION : undefined
const store = new Store()
const agents = new AgentService(() => store.state.projects)
const media = new MediaService(agents)
const claudeFiles = new ClaudeFilesService(agents)
const ptys = new PtyService()
/** agents in view, per window (open panes, selection); the union is followed */
const interests = new Map<WebContents, string[]>()
const windows = new Windows({
  make: makeWindow,
  changed: saveState,
  closed: (wc) => {
    ptys.closeOwnedBy(wc)
    interests.delete(wc)
    agents.setInterest([...interests.values()].flat())
  },
  quiet: !!automation
})

agents.on('hosts', (s) => windows.broadcast(IPC.hostsState, s))
agents.on('agents', (a) => windows.broadcast(IPC.agentsUpdate, a))
agents.on('details', (k, d) => windows.broadcast(IPC.agentsDetailsUpdate, k, d))
agents.on('usage', (u) => windows.broadcast(IPC.usageUpdate, u))

/** The state file: what all windows share, and each window's panes and place. */
function saveState(): void {
  store.save({ ...store.state, windows: windows.saved(), layout: undefined })
}

/**
 * A window saved: its change to the shared state goes to the others, and its
 * panes are noted. The main process is the only writer of the state file.
 */
function windowSaved(wc: WebContents, patch: SharedPatch | null, layout: WindowLayout): void {
  if (patch) {
    store.state = { ...store.state, ...applyPatch(sharedOf(store.state), patch) }
    windows.sendOthers(wc, IPC.stateChanged, patch)
  }
  windows.setLayout(wc, layout)
  saveState()
}

function registerIpc(): void {
  ipcMain.handle(IPC.stateLoad, (e) => {
    // a window that just loaded learns about the others
    windows.sendInfoSoon()
    return { state: sharedOf(store.state), ...windows.boot(e.sender) }
  })
  ipcMain.handle(IPC.stateSave, (e, patch: SharedPatch | null, layout: WindowLayout) => windowSaved(e.sender, patch, layout))
  // the last save when a window closes: synchronous, so it lands before quit
  ipcMain.on(IPC.stateSaveSync, (e, patch: SharedPatch | null, layout: WindowLayout) => {
    try {
      windowSaved(e.sender, patch, layout)
    } finally {
      e.returnValue = true
    }
  })
  ipcMain.on(IPC.windowOpen, (e, sel: string | null) => windows.create({ tabs: [] }, sel, BrowserWindow.fromWebContents(e.sender) ?? undefined))
  ipcMain.on(IPC.windowClose, (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.handle(IPC.windowStep, (e, dir: -1 | 1) => windows.step(e.sender, dir))
  ipcMain.handle(IPC.windowCarry, (e, key: string, dir: -1 | 1) => windows.carry(e.sender, key, dir))
  ipcMain.handle(IPC.windowReveal, (e, key: string) => windows.reveal(e.sender, key))
  ipcMain.on(IPC.windowClosePane, (e, key: string) => windows.closePane(e.sender, key))
  ipcMain.handle(IPC.sshHosts, () => listSshHosts())
  ipcMain.handle(IPC.fonts, () => detectFonts())
  ipcMain.handle(IPC.clipboardText, () => clipboard.readText())
  ipcMain.on(IPC.copyText, (_e, text: string) => clipboard.writeText(text))
  ipcMain.on(IPC.windowButtons, (e, visible: boolean) => {
    if (mac) BrowserWindow.fromWebContents(e.sender)?.setWindowButtonVisibility(visible)
  })

  ipcMain.handle(IPC.hostsWatch, (_e, hosts: string[]) => agents.watch(hosts))
  ipcMain.handle(IPC.hostsReconnect, (_e, host: string) => agents.reconnect(host))

  ipcMain.handle(IPC.agentsSpawn, (_e, req: SpawnRequest) => agents.spawn(req))
  ipcMain.handle(IPC.agentsKill, (_e, key: string) => agents.kill(key))
  ipcMain.handle(IPC.agentsRespawn, (_e, key: string) => agents.respawn(key))
  ipcMain.on(IPC.agentsInterest, (e, keys: string[]) => {
    interests.set(e.sender, keys)
    agents.setInterest([...interests.values()].flat())
  })
  ipcMain.handle(IPC.agentsKey, (_e, key: string, keys: string[]) => agents.sendKeys(key, keys))
  ipcMain.handle(IPC.agentsSend, (_e, key: string, text: string) => agents.sendText(key, text))
  ipcMain.handle(IPC.agentsDetails, (_e, key: string) => agents.details(key))
  ipcMain.handle(IPC.agentsAllDetails, () => agents.allDetails())
  ipcMain.handle(IPC.usageGet, () => agents.usage())

  ipcMain.handle(IPC.ptyAttach, (e, key: string, cols: number, rows: number) => {
    const { host, id } = agents.locate(key)
    const cmd = host.attachCommand(id)
    return ptys.open(e.sender, cmd.file, cmd.args, cols, rows, () => host.releasePane())
  })
  ipcMain.handle(IPC.ptyLogin, (e, host: string, cols: number, rows: number) => {
    const cmd = agents.host(host).loginCommand()
    return ptys.open(e.sender, cmd.file, cmd.args, cols, rows)
  })
  ipcMain.on(IPC.ptyWrite, (_e, id: string, data: string) => ptys.write(id, data))
  ipcMain.on(IPC.ptyResize, (_e, id: string, cols: number, rows: number) => ptys.resize(id, cols, rows))
  ipcMain.on(IPC.ptyClose, (_e, id: string) => ptys.close(id))

  ipcMain.handle(IPC.mediaList, (_e, key: string, page?: { before?: number; scan?: boolean }) => media.list(key, page))
  ipcMain.handle(IPC.mediaFetch, (_e, host: string, path: string, stamp?: string) => media.fetch(host, path, stamp))
  ipcMain.handle(IPC.mediaOpen, (_e, host: string, path: string, stamp?: string) => media.openExternal(host, path, stamp))
  ipcMain.handle(IPC.mediaSave, (_e, host: string, path: string, stamp?: string) => media.save(host, path, stamp))

  ipcMain.handle(IPC.claudeList, (_e, host: string, cwds: string[]) => claudeFiles.list(host, cwds))
  ipcMain.handle(IPC.claudeRead, (_e, host: string, path: string) => claudeFiles.read(host, path))
  ipcMain.handle(IPC.fsDirs, (_e, host: string, dir: string) => claudeFiles.dirs(host, dir))
  ipcMain.handle(IPC.fsRealPaths, (_e, host: string, paths: string[]) => claudeFiles.realPaths(host, paths))
}

function buildMenu(): void {
  // Elsewhere a menu's Ctrl accelerators would take keys from the agents' terminals,
  // and text fields copy and paste without one
  if (!mac) return Menu.setApplicationMenu(null)
  // No Cmd+W "Close Window" here: in Kuna Cmd+W closes the focused tab.
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }]
    },
    {
      label: 'Edit',
      submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload', accelerator: 'Shift+CmdOrCtrl+R' },
        ...(fromSource ? [{ role: 'toggleDevTools' } as const] : []),
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      role: 'window',
      submenu: [
        // the keys are Kuna's own (keys.ts); these fire when a dialog has the keyboard
        { label: 'New Window', accelerator: 'Shift+CmdOrCtrl+N', click: () => windows.newFromMenu() },
        { label: 'Close Window', accelerator: 'Shift+CmdOrCtrl+W', click: (_item, w) => w?.close() },
        { type: 'separator' },
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

let scriptRan = false

function makeWindow(bounds: Rect | undefined, fullScreen: boolean): BrowserWindow {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    ...bounds,
    // `fullscreen: false` would take the full-screen button away
    ...(fullScreen ? { fullscreen: true } : {}),
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#000000',
    // on a Mac the traffic lights sit over the sidebar; elsewhere the window keeps its title bar
    ...(mac ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: fromSource
    }
  })
  // scripted runs don't take the focus (and the keystrokes) from whatever the user is doing
  // the close/minimize/zoom buttons only show over the sidebar (the renderer
  // says when); hidden, they would sit on the pane headers
  if (mac) win.setWindowButtonVisibility(false)
  // no menu outside macOS: F12 opens DevTools when running from source
  if (!mac && fromSource) {
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools()
    })
  }
  win.once('ready-to-show', () => (automation ? win.showInactive() : win.show()))
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  if (automation) {
    win.webContents.on('console-message', (e) => console.log(`[renderer] ${e.message}`))
    // the script runs in the first window; kunaDev.eval reaches the others
    win.webContents.once('did-finish-load', () => {
      if (scriptRan) return
      scriptRan = true
      void win.webContents.executeJavaScript(readFileSync(automation, 'utf8')).catch((e) => console.error('automation failed', e))
    })
  }

  if (fromSource && process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

app.setName('Kuna')

// When Kuna is started from inside a Claude Code session (e.g. `npm run dev` in
// a terminal agent), don't let that session's identity leak into new agents.
for (const k of Object.keys(process.env)) {
  if (/^(CLAUDECODE|CLAUDE_CODE_\w+|CLAUDE_PID|CLAUDE_JOB_DIR|CLAUDE_EFFORT|AI_AGENT)$/.test(k)) delete process.env[k]
}
// wsl.exe (this PC's agents on Windows) reports its own errors in UTF-16 unless asked not to
if (process.platform === 'win32') process.env.WSL_UTF8 = '1'
// Separate profile for demos and tests: KUNA_USER_DATA=/tmp/kuna-demo npm start
if (fromSource && process.env.KUNA_USER_DATA) app.setPath('userData', process.env.KUNA_USER_DATA)

/**
 * Scripted runs for screenshots/docs: KUNA_AUTOMATION=script.js runs the file in
 * the renderer after load; the script may call kunaDev.capture(name) (written to
 * KUNA_SHOT_DIR) and kunaDev.quit().
 */
function registerAutomation(): void {
  if (!automation) return
  const shots = process.env.KUNA_SHOT_DIR
  ipcMain.handle('dev:capture', async (e, name: string) => {
    if (!shots) return
    const img = await e.sender.capturePage()
    writeFileSync(join(shots, `${name.replace(/[^\w-]/g, '_')}.png`), img.toPNG())
  })
  ipcMain.handle('dev:quit', () => app.quit())
  // the native window id, for screenshots that include the window chrome (screencapture -l)
  ipcMain.handle('dev:window-id', (e) => BrowserWindow.fromWebContents(e.sender)?.getMediaSourceId())
  // paste text as ⌘V would, leaving the user's clipboard as it was
  ipcMain.handle('dev:paste', async (e, text: string, viaShortcut = false) => {
    const before = await clipboard.readText()
    await clipboard.writeText(text)
    if (viaShortcut) {
      e.sender.sendInputEvent({ type: 'keyDown', keyCode: 'v', modifiers: ['meta'] })
      e.sender.sendInputEvent({ type: 'keyUp', keyCode: 'v', modifiers: ['meta'] })
    } else e.sender.paste()
    await new Promise((r) => setTimeout(r, 300))
    await clipboard.writeText(before)
  })
  // real key presses (default actions included, unlike synthetic DOM events)
  ipcMain.handle('dev:key', (e, keyCode: string, modifiers: ('shift' | 'meta' | 'alt' | 'control')[] = []) => {
    const wc = e.sender
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    const ch = keyCode === 'Space' ? ' ' : keyCode === 'Return' ? '\r' : keyCode.length === 1 ? keyCode : undefined
    if (ch) wc.sendInputEvent({ type: 'char', keyCode: ch, modifiers })
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  })
  // click an app menu item by role ('copy', 'paste'…), as its shortcut would
  ipcMain.handle('dev:menu', (e, role: string) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const it of items) {
        if (it.role?.toLowerCase() === role.toLowerCase()) return it
        const sub = it.submenu && find(it.submenu.items)
        if (sub) return sub
      }
      return undefined
    }
    const item = find(Menu.getApplicationMenu()?.items ?? [])
    item?.click(undefined, BrowserWindow.fromWebContents(e.sender) ?? undefined, e.sender)
    return !!item
  })
  // a real mouse drag from one point to another (CSS pixels), with modifiers held
  ipcMain.handle('dev:drag', async (e, from: [number, number], to: [number, number], modifiers: ('shift' | 'meta' | 'alt' | 'control')[] = []) => {
    const wc = e.sender
    const pause = (): Promise<unknown> => new Promise((r) => setTimeout(r, 30))
    wc.sendInputEvent({ type: 'mouseMove', x: from[0], y: from[1], modifiers })
    wc.sendInputEvent({ type: 'mouseDown', x: from[0], y: from[1], button: 'left', clickCount: 1, modifiers })
    for (let i = 1; i <= 8; i++) {
      await pause()
      const x = Math.round(from[0] + ((to[0] - from[0]) * i) / 8)
      const y = Math.round(from[1] + ((to[1] - from[1]) * i) / 8)
      wc.sendInputEvent({ type: 'mouseMove', x, y, button: 'left', modifiers: [...modifiers, 'leftbuttondown'] })
    }
    await pause()
    wc.sendInputEvent({ type: 'mouseUp', x: to[0], y: to[1], button: 'left', clickCount: 1, modifiers })
  })
  // run code in the n-th window (in the order they were opened)
  ipcMain.handle('dev:eval', (_e, n: number, code: string) => windows.nth(n)?.executeJavaScript(code))
}

app.whenReady().then(async () => {
  if (app.isPackaged) await adoptLoginShellPath()
  store.load()
  // the page needs notifications and nothing else the browser could grant
  const allowed = (permission: string): boolean => permission === 'notifications'
  session.defaultSession.setPermissionRequestHandler((_wc, permission, done) => done(allowed(permission)))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed(permission))
  // a built Kuna.app has its icon; running from source, the Dock shows Electron's otherwise
  if (fromSource) app.dock?.setIcon(join(__dirname, '../../build/icon.png'))
  registerIpc()
  buildMenu()
  registerAutomation()
  // the windows open at the last quit (from before there were several: the one window's panes)
  const s = store.state
  windows.restore(s.windows ?? (s.layout ? [s.layout] : []))
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) windows.create()
  })
})

// Quitting only disconnects; agents keep running in tmux on their hosts.
app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  // every window closing from here on comes back at the next launch
  windows.quit()
  saveState()
  ptys.dispose()
  agents.dispose()
})

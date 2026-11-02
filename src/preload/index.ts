import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type KunaApi } from '@shared/ipc'

function on<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: KunaApi = {
  platform: process.platform,
  state: {
    load: () => ipcRenderer.invoke(IPC.stateLoad),
    save: (patch, layout) => ipcRenderer.invoke(IPC.stateSave, patch, layout),
    saveNow: (patch, layout) => void ipcRenderer.sendSync(IPC.stateSaveSync, patch, layout),
    onChange: (cb) => on(IPC.stateChanged, cb)
  },
  windows: {
    open: (sel) => ipcRenderer.send(IPC.windowOpen, sel),
    close: () => ipcRenderer.send(IPC.windowClose),
    step: (dir) => ipcRenderer.invoke(IPC.windowStep, dir),
    carry: (key, dir) => ipcRenderer.invoke(IPC.windowCarry, key, dir),
    reveal: (key) => ipcRenderer.invoke(IPC.windowReveal, key),
    closePane: (key) => ipcRenderer.send(IPC.windowClosePane, key),
    onInfo: (cb) => on(IPC.windowInfo, cb),
    onCommand: (cb) => on(IPC.windowCommand, cb)
  },
  fonts: () => ipcRenderer.invoke(IPC.fonts),
  clipboardText: () => ipcRenderer.invoke(IPC.clipboardText),
  copyText: (text) => ipcRenderer.send(IPC.copyText, text),
  windowButtons: (visible) => ipcRenderer.send(IPC.windowButtons, visible),
  ssh: {
    hosts: () => ipcRenderer.invoke(IPC.sshHosts)
  },
  hosts: {
    watch: (hosts) => ipcRenderer.invoke(IPC.hostsWatch, hosts),
    reconnect: (host) => ipcRenderer.invoke(IPC.hostsReconnect, host),
    onState: (cb) => on(IPC.hostsState, cb)
  },
  agents: {
    spawn: (req) => ipcRenderer.invoke(IPC.agentsSpawn, req),
    kill: (key) => ipcRenderer.invoke(IPC.agentsKill, key),
    respawn: (key) => ipcRenderer.invoke(IPC.agentsRespawn, key),
    interest: (keys) => ipcRenderer.send(IPC.agentsInterest, keys),
    key: (key, keys) => ipcRenderer.invoke(IPC.agentsKey, key, keys),
    send: (key, text) => ipcRenderer.invoke(IPC.agentsSend, key, text),
    onUpdate: (cb) => on(IPC.agentsUpdate, cb),
    details: (key) => ipcRenderer.invoke(IPC.agentsDetails, key),
    allDetails: () => ipcRenderer.invoke(IPC.agentsAllDetails),
    onDetails: (cb) => on(IPC.agentsDetailsUpdate, cb)
  },
  usage: {
    get: () => ipcRenderer.invoke(IPC.usageGet),
    onUpdate: (cb) => on(IPC.usageUpdate, cb)
  },
  pty: {
    attach: (key, cols, rows) => ipcRenderer.invoke(IPC.ptyAttach, key, cols, rows),
    login: (host, cols, rows) => ipcRenderer.invoke(IPC.ptyLogin, host, cols, rows),
    write: (id, data) => ipcRenderer.send(IPC.ptyWrite, id, data),
    resize: (id, cols, rows) => ipcRenderer.send(IPC.ptyResize, id, cols, rows),
    close: (id) => ipcRenderer.send(IPC.ptyClose, id),
    onData: (cb) => on(IPC.ptyData, cb),
    onExit: (cb) => on(IPC.ptyExit, cb)
  },
  media: {
    list: (key, page) => ipcRenderer.invoke(IPC.mediaList, key, page),
    fetch: (host, path, stamp) => ipcRenderer.invoke(IPC.mediaFetch, host, path, stamp),
    openExternal: (host, path, stamp) => ipcRenderer.invoke(IPC.mediaOpen, host, path, stamp),
    save: (host, path, stamp) => ipcRenderer.invoke(IPC.mediaSave, host, path, stamp)
  },
  claude: {
    list: (host, cwds) => ipcRenderer.invoke(IPC.claudeList, host, cwds),
    read: (host, path) => ipcRenderer.invoke(IPC.claudeRead, host, path)
  },
  git: {
    repos: (host, dir) => ipcRenderer.invoke(IPC.gitRepos, host, dir),
    overview: (host, dir) => ipcRenderer.invoke(IPC.gitOverview, host, dir),
    compare: (host, dir, base, head) => ipcRenderer.invoke(IPC.gitCompare, host, dir, base, head),
    files: (host, dir, rev) => ipcRenderer.invoke(IPC.gitFiles, host, dir, rev),
    read: (host, dir, sides) => ipcRenderer.invoke(IPC.gitRead, host, dir, sides),
    listDir: (host, path) => ipcRenderer.invoke(IPC.gitListDir, host, path),
    readFile: (host, path) => ipcRenderer.invoke(IPC.gitReadFile, host, path)
  },
  vscode: {
    look: (refresh) => ipcRenderer.invoke(IPC.vscodeLook, refresh),
    icon: (id) => ipcRenderer.invoke(IPC.vscodeIcon, id)
  },
  fs: {
    dirs: (host, dir) => ipcRenderer.invoke(IPC.fsDirs, host, dir),
    realPaths: (host, paths) => ipcRenderer.invoke(IPC.fsRealPaths, host, paths)
  }
}

contextBridge.exposeInMainWorld('kuna', api)

// Scripted runs only: the main process answers these only when Kuna runs from
// source with KUNA_AUTOMATION set (never in a built Kuna.app).
contextBridge.exposeInMainWorld('kunaDev', {
  capture: (name: string) => ipcRenderer.invoke('dev:capture', name),
  quit: () => ipcRenderer.invoke('dev:quit'),
  windowId: () => ipcRenderer.invoke('dev:window-id'),
  key: (keyCode: string, modifiers?: string[]) => ipcRenderer.invoke('dev:key', keyCode, modifiers),
  paste: (text: string, viaShortcut?: boolean) => ipcRenderer.invoke('dev:paste', text, viaShortcut),
  drag: (from: [number, number], to: [number, number], modifiers?: string[]) => ipcRenderer.invoke('dev:drag', from, to, modifiers),
  menu: (role: string) => ipcRenderer.invoke('dev:menu', role),
  // run code in the n-th window (in the order they were opened) and return its result
  eval: (n: number, code: string) => ipcRenderer.invoke('dev:eval', n, code)
})

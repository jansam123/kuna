# Development

```sh
npm install          # installs deps and rebuilds node-pty for Electron
npm run dev          # electron-vite dev server with hot reload
npm run typecheck    # main/preload and renderer
npm test             # unit tests + host integration test
npm run build        # production bundles in out/
npm run dist         # unsigned Kuna.app in release/
sh scripts/smoke.sh  # open the app once with a throwaway profile; prints window/host checks and a screenshot path
```

The icon is drawn in `build/icon.svg`; `npm run icon` renders it to `build/icon.png` and `build/icon.icns`. `npm install` also turns `node_modules`' Electron.app into Kuna.app, with Kuna's name and icon, and points Electron's `path.txt` at it (`scripts/dev-app.sh`), since during `npm run dev` macOS takes the menu bar name from that bundle's Info.plist and the Dock and ⌘Tab name from its folder name. Run the script again after anything reinstalls Electron.

Node 22+ is required (electron-vite and vitest). The integration test needs `tmux` on your PATH and is skipped otherwise.

## Layout

```
src/
  shared/             pure logic, unit-tested, used by main and renderer
    types.ts          data model (projects, agents, details, hosts)
    ipc.ts            the window.kuna API and channel names
    watch.ts          parse `kuna watch` frames, derive agent status
    transcript.ts     incremental Claude Code transcript summariser
    layout.ts         pane grid shape and arrow-key neighbours
    windows.ts        window order for ⌘← ⌘→, placing new and restored windows
    sync.ts           patches of the state the windows share
    media.ts          find image/PDF paths in text, path normalisation
    sshConfig.ts      list hosts from ~/.ssh/config (with Include)
  main/
    remote/kuna.sh    the helper installed on every host
    hosts/            Host (install, watch stream, ssh options), exec helpers
    agents.ts         spawn/kill, merged agent list, transcript reads
    pty.ts            node-pty terminals for open panes and sign-in
    files.ts          media listing/fetching, .claude browser, folder completion
    store.ts          persisted state (userData/kuna-state.json)
    windows.ts        the windows: order, panes per window, what comes back at launch
    index.ts          windows, menu, IPC wiring, automation hooks
  preload/index.ts    contextBridge → window.kuna
  renderer/src/
    store.ts          zustand store and persisted-state actions
    keys.ts           keyboard state machine (navigate / typing / launch)
    actions.ts        focus, tabs, spawn, kill, resume, typing helpers
    terminals.ts      xterm registry kept outside React
    themes.ts         applies a colour scheme (the schemes themselves: src/shared/themes.ts)
    components/       Sidebar, PromptBar, PaneGrid, Inspector, overlays
test/
  shared.test.ts             unit tests for src/shared
  host.integration.test.ts   install/watch/spawn/read/kill through a fake ssh
  fake-ssh/ssh               runs "remote" commands locally in a temp HOME
```

## Working on the helper script

`kuna.sh` must stay POSIX `sh`: it runs on old login nodes where bash features or GNU-only flags may be missing. Rules of thumb:

- pass free text base64-encoded; decode with `b64d`
- loops reading lines from a decoded list must append a newline (`{ b64d "$1"; echo; } | while read …`) or the last line is lost
- keep `hook` silent on stdout — Claude Code treats hook output as context or decisions
- try it without the app: `sh src/main/remote/kuna.sh snapshot` after installing once, or run the integration test

The integration test sets `KUNA_TMUX_SOCKET` so it uses its own tmux server and a temporary `HOME`; it never touches your real agents.

## Scripted runs and screenshots

The README screenshots are produced by driving the real app:

```sh
KUNA_USER_DATA=/tmp/kuna-demo-profile \   # separate state file
KUNA_SHOT_DIR=/tmp/kuna-shots \           # where kunaDev.capture() writes PNGs
KUNA_AUTOMATION=script.js \               # run in the renderer after load
npx electron .
```

The script can use `window.kunaInternals` (`store`, `actions`, `terminals`), dispatch `KeyboardEvent`s on `window` to exercise the real key handling, call `kunaDev.capture(name)` and finally `kunaDev.quit()`. Renderer `console.log` output is forwarded to stdout in this mode. The script runs in the first window; `kunaDev.eval(n, code)` runs code in the n-th window (in the order they were opened), whose `kunaDev.key` and `kunaDev.capture` then act on that window.

## Conventions

- Commit messages: imperative subject, a short body with the why.
- Shared logic goes in `src/shared` with a test; Electron-specific code stays in `main`/`renderer`.
- No network access at runtime besides your ssh connections: fonts are bundled, no telemetry.

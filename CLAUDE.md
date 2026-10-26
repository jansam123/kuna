# Kuna — notes for agents

Kuna is a macOS app (Electron + React + TypeScript) that runs coding agents in tmux on this Mac and on SSH hosts, and shows Claude Code background sessions. This file has two parts: **setting Kuna up for a user on their Mac**, and **working on the code**. `README.md` is the user-facing overview; `docs/` has the details.

## Setting Kuna up on a Mac

The goal: the user ends up with Kuna running and knows how to start their first agent. Work through the steps, report what you find, and ask before installing anything system-wide.

1. **Check the prerequisites.**

   | Need | Check | If missing |
   | --- | --- | --- |
   | macOS 13+ | `sw_vers -productVersion` | — |
   | Xcode command line tools (builds the terminal library) | `xcode-select -p` | `xcode-select --install` opens a dialog the user has to accept |
   | Node.js 22.12+ | `node -v` | `brew install node`, or the user's version manager |
   | tmux, for agents on this Mac | `tmux -V` | `brew install tmux` |
   | Claude Code, signed in | `claude --version` | install it the way Claude Code's docs describe; the user signs in by running `claude` once. Never sign in for them. |

2. **Install**, from the repository root: `npm install`. Its postinstall rebuilds `node-pty` for Electron. If `npm run dev` later reports that Electron failed to install, run `node node_modules/electron/install.js && sh scripts/dev-app.sh` (the second part names the development app Kuna in the Dock and ⌘Tab).

3. **Verify.**
   - `npm run typecheck` and `npm test` must pass. The integration test uses its own tmux server (`KUNA_TMUX_SOCKET`) and a temporary `HOME`, so it never touches the user's agents.
   - `sh scripts/smoke.sh` builds, opens Kuna once with a throwaway profile, and closes it. It should print `window: ok`, `this Mac: ok` and `windows: ok`, plus the path of a screenshot you can look at. It starts no agents and leaves the user's own Kuna state alone.

4. **Run it.** Either `npm run dev` (development build with hot reload; Ctrl+C quits), or build the app with `npm run dist` → `release/mac-arm64/Kuna.app` (`release/mac/Kuna.app` on Intel). The app is unsigned; built on this Mac it opens normally. Ask before copying it to `/Applications`. If the user has a `Kuna.app` from somewhere else, build it from source instead of removing macOS's quarantine from that copy.

5. **First use** happens in the window, by keyboard: **⌘N** creates a project (*This Mac* or a host from `~/.ssh/config`), **⌘O** adds a folder, then typing a task and **Enter** starts an agent. Point the user to "First five minutes" in `README.md` and to **⌘/** for every shortcut.

**On Windows** the steps are in `docs/WINDOWS.md`: the prerequisites are Node.js, Git and Visual Studio Build Tools (C++) for `node-pty`; tmux and Claude Code go inside WSL, which is where agents on "This PC" run. `scripts/smoke.sh` is macOS-only.

**Remote hosts.** Any `Host` alias in `~/.ssh/config` works; Kuna uses the user's own `ssh`. A host needs `tmux`, `claude` and a POSIX `sh`. Kuna runs ssh with `BatchMode=yes`; hosts that need a password or OTP get a **Sign in** button. See `docs/REMOTE-HOSTS.md` for clusters, Kerberos and troubleshooting.

**What Kuna writes.**
- On this Mac: `~/Library/Application Support/Kuna/kuna-state.json` (projects, settings, each window's panes and place; a `.bak` next to it).
- On every host it uses, this Mac included: `~/.kuna/` (helper script, tmux config, hook settings, one directory per agent, ssh control sockets on the Mac).
- A private tmux server, `tmux -L kuna`, separate from the user's own tmux.
- It never edits `~/.claude/settings.json`; its hooks are passed with `claude --settings`.

To uninstall: quit Kuna, remove the app and its Application Support folder, and `~/.kuna` on each host. `tmux -L kuna kill-server` stops the agents Kuna started; they are the user's running work, so only with their say-so.

**Ground rules when helping a user**
- Ask before installing system software, connecting to a remote host, or stopping or removing agents. Don't run `claude stop` or `claude rm` on their sessions, or kill `tmux -L kuna`, unless they ask.
- Login nodes on clusters are shared: don't open bursts of ssh connections to test things. One `ssh <host> true` is enough to check access.
- Don't read or copy credentials: the keychain, `~/.ssh` keys, Claude Code's login.
- `SECURITY.md` says what Kuna can do on the user's machines and what it stores; point them to it if they ask whether it's safe.

## Working on the code

Read `docs/ARCHITECTURE.md` before changing how hosts, status or transcripts work.

### Commands

- `npm run dev` — run with hot reload
- `npm run typecheck` — must pass (two tsconfigs: node + web)
- `npm test` — vitest; includes an integration test that needs `tmux`
- `npm run build` / `npm run dist` — bundles / unsigned `.app` in `release/`
- `sh scripts/smoke.sh` — open the built app once with a throwaway profile and report

### Rules

- `src/main/remote/kuna.sh` is installed on remote machines: POSIX `sh` only, no bashisms or GNU-only flags, base64 for free-text arguments, `hook` must print nothing.
- Pure logic belongs in `src/shared/` with a test in `test/shared.test.ts`.
- The watch-frame format (`P`/`A`/`M` lines) is shared by `kuna.sh` and `src/shared/watch.ts`; change both and the tests together.
- Keyboard behaviour lives in `src/renderer/src/keys.ts`; update `docs/KEYBOARD.md` and `HelpDialog.tsx` with any shortcut change.
- Never start a test agent on the user's real tmux server without killing it afterwards; prefer `KUNA_TMUX_SOCKET` and a temp `HOME` as in `test/host.integration.test.ts`.
- To see the app without a screen, drive it with `KUNA_AUTOMATION` (see `docs/DEVELOPMENT.md` and `scripts/smoke.js`): real key presses through `kunaDev.key`, screenshots through `kunaDev.capture`.

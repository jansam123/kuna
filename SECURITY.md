# Security

## Reporting a problem

Please report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on this repository. Don't open a public issue for them.

Only the latest `main` is supported.

## What Kuna can do, and why that matters

Kuna runs commands **as you** on this Mac and on every SSH host you add a project for: it starts agents through your login shell, types into them, reads their transcripts and the images, PDFs and Markdown files they make, and lists your `.claude` files. Treat Kuna's window as having shell access to all of those machines. Everything below is about keeping it that way only for you.

**The window.** The interface runs in a sandboxed Electron renderer with context isolation and no Node.js. It reaches the system only through a small bridge (`window.kuna`, see `src/shared/ipc.ts`). A strict content security policy allows no inline or `eval` scripts and no remote content. Text from agents, transcripts, file names and paths is shown as plain text. Only two things become HTML: Markdown from `.claude` files, sanitised with DOMPurify (no scripts, styles, forms or embeds), and LaTeX in project names, rendered by KaTeX in its safe mode. PDFs are drawn to a canvas without scripting, and SVGs are shown as images, which don't run scripts.

**The main process checks what the window asks for.** Host names must be `local` or an SSH alias that can't be read as an ssh option, and every ssh command puts `--` before the host. Agent ids are letters, digits, `-` and `_` only, checked again by the helper on the host before they reach `rm`, `tmux` or `claude`. Only plain key names go to `tmux send-keys`. The plot viewer reads, opens and saves images, PDFs and Markdown files only; Markdown is shown without scripts, styles, forms or embeds, its pictures come only from the host (never the network), and only its http(s) links open, in your browser; its LaTeX goes through KaTeX with `trust` off, and its diagrams through Mermaid's strict mode, each shown as a picture; and the `.claude` browser reads only files its listing showed. The review view (⌘G) runs only read-only git commands that never write the index; branch and commit names can't start with `-`, contain `..`, `:`, whitespace or control characters, and file paths must be relative without `..` steps, checked in the main process and again by the helper; a symlink in the working tree is shown as its link text, never followed. Its file icons and colour theme are read from your VS Code installation on this Mac; icons are shown as pictures. Commands on hosts are built from argument lists, never shell strings, and free text travels base64-encoded.

**Terminal output.** A program in an agent pane can ask the terminal to set your clipboard (OSC 52). Kuna allows that only right after you acted in that pane, by selecting with the mouse or typing a command like Claude Code's `/copy`; anything else is ignored with a notice. Links in terminal output don't open anything.

**Development hooks** (`KUNA_AUTOMATION`, `KUNA_USER_DATA`, the dev server URL, DevTools) work only when Kuna runs from source. A built `Kuna.app` ignores them, and has Electron's `runAsNode`, `NODE_OPTIONS` and `--inspect` switches turned off.

## What Kuna trusts

- **Your `~/.ssh/config`** and the files it includes. Kuna runs your own `ssh`, so anything those files can do (`ProxyCommand`, `LocalCommand`) happens as it would in a terminal.
- **The agent command** of each project (`claude` by default). It runs through your login shell on the host, exactly as typed.
- **The hosts you add.** Kuna installs a small POSIX shell script in `~/.kuna` there and runs it over ssh; whoever controls that account controls what Kuna sees from it.

## What Kuna stores and sends

- No telemetry and no cloud service: the only network traffic is your own ssh connections.
- On this Mac: `~/Library/Application Support/Kuna/kuna-state.json` (projects, folders, settings, each window's panes and place; no credentials).
- On each host: `~/.kuna/`, made private (mode 700) — the helper, its tmux configuration, Kuna's hook settings, and per agent its command, first prompt and latest status. Kuna's hooks only record what happens; they print nothing, so they can never approve a tool call. The status-line command records your plan usage there.
- ssh connections Kuna opens stay shared for 10 minutes after it quits (`ControlPersist`); their sockets live in `~/.kuna/ssh`, readable only by you.

## Known limits

- **Prompts are visible in the process list.** An agent's first prompt is passed to `claude` as an argument, so other users on a shared node can see it with `ps` (unless the node hides other users' processes). Don't put secrets in launch prompts; type them into the agent instead.
- **The app is not signed or notarised.** Build it from source (`npm run dist`) rather than running a copy someone sends you.
- **Anything in the agent command is stored** in `~/.kuna` on the host (private to you) and in Kuna's state file on your Mac. Prefer your shell's environment over putting API keys there.

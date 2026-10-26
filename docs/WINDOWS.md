# Windows

Kuna runs on Windows 10/11. The window, the sidebar and SSH hosts work as on a Mac; two things differ because Windows has neither tmux nor connection sharing in its `ssh`.

## This PC is WSL

tmux, which keeps agents alive when Kuna quits, does not exist on Windows. So on Windows the local host, **This PC (WSL)**, is your default [WSL](https://learn.microsoft.com/windows/wsl/) distribution: Kuna talks to it through `wsl.exe` exactly as it talks to an SSH host through `ssh`. The helper goes into `~/.kuna` inside WSL, agents run in WSL's tmux, and folders are WSL paths (`~/src/repo`, or `/mnt/c/Users/you/repo` for a folder on the Windows side, which is slower). A Windows path typed or pasted into the folder dialog (`C:\Users\you\repo`) is turned into its `/mnt/c/…` form.

### Setting up WSL

From an administrator PowerShell, `wsl --install -d Ubuntu`, then pick a Linux user name and password when Ubuntu starts. If WSL answers `Wsl/CallMsi/Install/REGDB_E_CLASSNOTREG`, its install is incomplete: `winget install --id Microsoft.WSL --source winget`, reboot, and try again.

Inside WSL you need what any host needs: `tmux`, Claude Code (signed in) and a POSIX `sh`. In Ubuntu:

```sh
sudo apt install -y tmux
curl -fsSL https://claude.ai/install.sh | bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc   # Kuna finds claude through your login shell
exec bash -l
claude    # sign in once, then /exit
```

This is a separate Claude Code from the Windows one, with its own sign-in and settings; Kuna's agents use the one in WSL.

### Trusting a folder

Claude Code asks once per folder whether you trust it. A background session (Kuna's default launch) can't ask, and fails with *Workspace not trusted*. Trust the folder from Ubuntu first:

```sh
cd "/mnt/c/Users/you/Documents/GitHub" && claude    # answer Yes, then /exit
```

Type the path with the same capitals as the folder in Kuna: Windows doesn't care, but Claude Code remembers `…/github` and `…/GitHub` as two different folders. Projects that launch agents in tmux instead show the trust question in Kuna's own pane.

WSL shuts a distribution down a little while after its last Windows-side program exits. While Kuna is open its watch stream keeps WSL up; after you quit Kuna, agents keep running only as long as WSL does. To keep them running, set an idle timeout in `%UserProfile%\.wslconfig` (see Microsoft's `.wslconfig` documentation, `instanceIdleTimeout` / `vmIdleTimeout`), or keep a WSL terminal open.

## SSH hosts

Kuna uses Windows' own OpenSSH (`ssh.exe`, an optional Windows feature that is on by default in Windows 10 1809+ and 11) and your `%UserProfile%\.ssh\config`. Windows' OpenSSH cannot share a connection between commands (`ControlMaster` needs Unix sockets), so:

- every command and every open pane is a new ssh login, which is slower than on a Mac and noisier for busy login nodes;
- hosts must let you in without a prompt: keys through `ssh-agent` (the *OpenSSH Authentication Agent* service) work; hosts that ask for a password or an OTP each time can't be used, since the **Sign in** button cannot open a shared connection for the commands that follow.

## Keyboard

Shortcuts written ⌘ in the docs are **Ctrl+Shift** on Windows, as in Windows Terminal, so that plain Ctrl keys always reach Claude Code (Ctrl+C, Ctrl+R, Ctrl+O…). ⇧⌘ becomes **Ctrl+Shift+Alt** (⇧⌘R, ⇧⌘N and ⇧⌘W for a new window and closing it, ⇧⌘← ⇧⌘→). ⌥ is Alt. Between windows, ⌘← ⌘→ are **Ctrl+Shift+← →** and ⌥⌘← ⌥⌘→ (carry the pane) are **Ctrl+Alt+← →**. **Ctrl+X Ctrl+X** is the same. In an agent, **Shift+drag** selects text (⌥ drag on a Mac), and Home and End do what ⌘← ⌘→ do. The help (**Ctrl+Shift+/**) and the status bar show the Windows keys.

## Building from source

You need Node.js 22.12+, Git, Python 3, and the C++ build tools that `node-pty` compiles with: Visual Studio Build Tools with the *Desktop development with C++* workload **and** the *MSVC v143 – VS 2022 C++ x64/x86 Spectre-mitigated libs* component (without it the build stops with `MSB8040: Spectre-mitigated libraries are required`). From an admin PowerShell:

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre --includeRecommended"
```

If `npm run dev` then fails with `Electron uninstall`, Electron's download was skipped: run `node node_modules/electron/install.js` once.

If `npm install` says `'GetCommitHash.bat' is not recognized`, your shell sets `NoDefaultCurrentDirectoryInExePath`; run it from a terminal without that variable.

```powershell
git clone https://github.com/jansam123/kuna.git; cd kuna
npm install      # also builds node-pty for Electron
npm run dev      # run it (F12 opens DevTools)
npm run dist     # or build release\win-unpacked\Kuna.exe
```

`npm run typecheck` and the unit tests run on Windows; the tests that run `kuna.sh` itself (and the tmux integration test) are skipped there, since they need `sh`. `scripts/smoke.sh` is for macOS.

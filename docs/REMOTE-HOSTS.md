# Remote hosts

A project belongs to one host: this Mac, or any `Host` alias from `~/.ssh/config` (including `Include`d files). Kuna runs your own `ssh` binary, so everything in your config applies: `User`, `ProxyJump`, keys, Kerberos/GSSAPI, `ControlMaster`.

## What happens on a host

The first time Kuna connects it copies one small POSIX shell script to `~/.kuna/bin/kuna` and runs `kuna setup`, which:

- finds `tmux` and `claude` through your **login shell** (so `module load`, conda and `~/.local/bin` are respected) and remembers their paths,
- writes `~/.kuna/tmux.conf` for Kuna's own tmux server (`tmux -L kuna`), separate from any tmux you use yourself,
- writes `~/.kuna/claude-hooks.json`, which Kuna passes to each agent with `claude --settings …`. It holds Kuna's hooks and a status line command that records your plan usage. Your own `~/.claude/settings.json` is never modified; inside Kuna agents Kuna's status line replaces yours (Kuna shows that information in its own bar).

Each agent then lives in `~/.kuna/agents/<id>/` (command, first prompt, latest hook event, transcript path) and in a tmux session `kuna_<id>`. The script is reinstalled automatically when Kuna updates it. Deleting `~/.kuna` removes everything except running agents; `tmux -L kuna kill-server` stops those.

While Kuna is open it keeps one `ssh <host> kuna watch` stream per host. It prints a compact state frame whenever something changes (and a heartbeat every 30 s), so status updates arrive within about a second without polling.

## Claude background sessions

If a host runs Claude Code's background agents (`claude --bg`, `claude agents`), Kuna lists them next to its own agents. It reads `~/.claude/jobs/*/state.json` (state, what the session is doing, the question it waits on, its transcript) and the daemon's roster for which ones are alive — no extra processes on the host. Sessions are placed under the deepest folder of a project that contains their working directory (worktrees under `.claude/worktrees` count as their repository); the rest go under **Other agents**, where ⌘O on one of them offers its directory as a new folder.

![A background session asking a question; the inspector lists its answers](images/doc-question.png)

- **Enter** opens a session with `claude attach <id>`; closing the pane only detaches.
- A session waiting on you shows its question or permission request in amber under its row, in a strip on its pane and in the inspector. Press the number of your answer on the pane.
- **Ctrl+X Ctrl+X** runs `claude stop` and takes the session off the list, without asking. The conversation is kept: **⌘Z** brings it back, and reviving it from `claude agents` shows it again by itself. Kuna never runs `claude rm`. **⇧⌘R** runs `claude respawn`.
- New agents launched from Kuna are background sessions by default (project setting), so they show up in `claude agents` and Claude's mobile view as well.

## Being gentle with shared nodes

Login nodes are shared, and some throttle bursts of new ssh connections (a busy node can take minutes to accept one). Kuna is built to stay out of the way:

- **Few connections.** One Kuna connection per host carries the watch stream, commands and up to six open panes; a second one is opened only beyond that. Jump hosts are reached through your own config, so Kuna never logs in to them again.
- **Cheap polling.** The watch loop runs every 2 s while something changes and every 5 s once quiet; Claude's session files are re-read only when they changed (checked with one `ls`), and a heartbeat goes out every 30 s. Context sizes come from the last 256 KB of a transcript, only when it has grown and at most every 10 s.
- **Transcripts on demand.** Transcripts of background sessions are read only for the sessions you have open or selected, incrementally (new bytes only).
- **No stampedes.** At most two commands run on a host at once; reconnects back off from 10 s to 3 minutes with jitter; directory listings for completion are cached.

## Attaching without Kuna

Every agent is an ordinary tmux session. From any terminal:

```sh
ssh -t myhost tmux -L kuna attach -t kuna_1e3b4c75
```

The inspector shows this command for the selected agent. Detach with your usual tmux habit — or just close the terminal; the agent keeps going.

## Signing in

Kuna runs its background commands with `BatchMode=yes`, so it never hangs on an invisible password prompt. If a host needs a password, an OTP or a host-key confirmation, its project row shows **Sign in**. That opens a small terminal running `ssh <host>`; answer the prompts there. Once ssh has a shared connection open, Kuna's commands reuse it.

Connection sharing: Kuna always opens its **own** shared connections (`ControlPath=~/.kuna/ssh/…`, `ControlPersist=600`) — one for the watch stream, commands and up to six open panes, and a second only beyond that. It deliberately does not ride on a `ControlMaster` from your config: sshd allows only 10 sessions per connection (`MaxSessions`), and a connection shared with your terminals, tunnels and other tools fills up quickly, after which new sessions are refused and ssh falls back to a slow fresh login. Kuna also sets `ClearAllForwardings=yes`, so `LocalForward`/`DynamicForward` lines in your config don't collide with the ones your own terminals already hold. Jump hosts (`ProxyJump`) still use your config, including its connection sharing.

On Windows, `ssh.exe` can't share connections, so every command logs in anew and hosts must accept keys without a prompt: see [Windows](WINDOWS.md#ssh-hosts).

Kerberos hosts (e.g. CERN): run `kinit` on your Mac first, as you would for plain ssh.

## Load-balanced aliases (`lxplus`, `login.cluster`)

tmux sessions live on one machine. If an alias like `lxplus` sends you to a different node each time, agents started yesterday are on a node you are no longer reaching. Kuna warns when an alias lands on a different machine than last time. Point projects at a specific node instead:

```sshconfig
Host lxplus-mine
  HostName lxplus987.cern.ch
  User you
```

## Clusters and login nodes

- Run agents on interactive or login nodes where long-lived processes are allowed. Some sites kill user processes on logout or after an idle period; check your site's policy.
- Batch worker nodes usually are not reachable by ssh and are the wrong place for an interactive agent; let the agent submit jobs instead.
- If the node reboots, the tmux session is gone. The agent shows as **exited**; **⇧⌘R** resumes its Claude conversation in a new agent.

## Login shells

Agents start through your login shell (`$SHELL -lic '<command>'`), so they see the same environment as an interactive terminal. Kuna sets `DISABLE_AUTO_UPDATE=true` so oh-my-zsh doesn't stop at its update question. For `csh`/`tcsh` users the command runs with `$SHELL -c`; a launch prompt is passed through a file so quoting never matters.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| Project row says **Sign in** | Click it, answer the prompts. If it keeps coming back, check that `ssh <host> true` works in a terminal without questions after the first login. |
| “tmux was not found on host” | Install tmux there (package manager, `conda install tmux`, or a static build in `~/bin`), then **Retry**. Kuna looks for it via your login shell. |
| Agent exits immediately | Open its pane: the last lines show the error (often `claude: command not found`). Set the full path in the project's agent command, e.g. `~/.local/bin/claude`. |
| Status stuck on idle while it works | Kuna reads Claude's spinner line and its hook events. For other agent CLIs only screen activity is available. |
| Wrong colours / missing glyphs | Make sure the host has a UTF-8 locale (`locale` should mention UTF-8). |

To see exactly what Kuna sees, run the helper yourself:

```sh
ssh myhost sh .kuna/bin/kuna doctor
ssh myhost sh .kuna/bin/kuna snapshot
```

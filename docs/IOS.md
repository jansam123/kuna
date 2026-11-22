# Kuna on the iPhone

An iPhone app that signs in to your hosts over ssh, as the Mac app does, and works with the agents running there: their conversations, their terminals, their plots and their changes. It runs no agents itself, and it does not reach this Mac's own agents. Nothing goes through a server of anyone's: the phone talks to your hosts directly.

## What it does

- **Projects, folders and agents** as in the Mac's sidebar, with live status: each project in its colour with its icon (the Mac's drawings, or a letter) and how many of its agents wait, work or failed; agents set in under their folder. Math in a name (`$HH \to b\bar{b}$`) shows as text. While the layout is being chosen, **Settings ▸ Home screen** switches between four.
- **An agent's conversation**: what you wrote, what it answered, each tool call as one line, its thinking folded. Replies are drawn as Markdown, read by the same library as on the Mac: headings, lists in lists, task lists, quotes, tables, code blocks, links, and math as text. Colours say what a row is, with the scheme's terminal palette: your messages on the accent; a tool's name green when it changes files, magenta when it runs a command, cyan when it hands work on, blue when it looks something up; a green tick when it finished, red when it failed; a usage limit in an amber box and a failed request in a red one. A line under it says what it is doing right now. Write to it from the box at the bottom.
- **Its terminal**, one tap away, with the keys a phone keyboard lacks (Esc, Tab, the arrows, Ctrl+C). Questions and permission prompts are answered there.
- **Starting, stopping and removing agents**, and naming them. A folder's **+** also starts a **terminal** (your shell there), as ⌘T on the Mac.
- **Plots and files**: the PDFs, pictures, Markdown files and HTML pages an agent mentioned or wrote, grouped as on the Mac (Slides, Diagrams, Plots, Markdown, Pages; each file marked `folder`, `.claude`, `tmp` or `outside`), full screen, with a swipe to the next, a download button (to Files) and the share sheet. HTML pages are live, fenced in as on the Mac. A PDF over 4 MB stays under PDFs until it is opened.
- **A folder's files**, git or not: the button beside a folder's name on the home screen (or **Files of its folder** in an agent's menu, or the folder button in the review) lists the folder, one level at a time. Pictures, PDFs, Markdown and pages open as above, anything else as text up to 2 MB; swipe a file's row, or use the arrow in the viewer, to download it to the phone.
- **Review**, laid out as the Mac's: **Changes** is what a branch changed since it left another (`base ← head`, as a pull request shows it). The base starts as origin's default branch (`origin/main`), else `main` or `master`; head as the agent's checked-out branch. Tap either to pick any branch, remote branch or tag, or type a commit; **Working tree** as head includes what is not committed. The base is remembered per repository. **Uncommitted** lists merge conflicts, staged changes, changes and untracked files; **Files** every file at head; **Commits** the commits in the comparison, each on its own with a tap. Tap a line of a diff to comment; the comments go to the agent together.
- **Colour schemes** as on the Mac.

Not in it yet: notifications and a home screen widget (both need Apple's push service, which needs a paid developer account), the `.claude` browser, how full the plan's usage is, sending a photo to an agent.

## Getting your projects onto the phone

1. On the Mac: **Settings ▸ iPhone ▸ Export…** (the gear in the sidebar), or the menu **Kuna ▸ Export for iPhone…**, and save the file (`Kuna projects.kuna`).
2. Send it to the phone: AirDrop it, or save it to iCloud Drive / Files.
3. On the phone, open it with Kuna (AirDrop offers it; in Files, tap the file), or in the app: **+ ▸ Import from the Mac**.

The file holds the projects on ssh hosts with their folders, the names you gave agents, the sessions you took off the list, the colour scheme, how ssh reaches each host (its address, user, port and the host it jumps through, as `ssh -G` resolves your `~/.ssh/config`), and the host keys your Mac trusts for them. It holds **no passwords and no keys of yours**. Projects on the Mac itself are left out.

Importing again updates what came from the Mac and removes what the Mac no longer has; projects and hosts made on the phone stay. Nothing travels back to the Mac.

You can also set everything up by hand on the phone: **+ ▸ New project**, and a host under **Settings ▸ Hosts**.

## Signing in to the hosts

The phone has its own ssh key, made on first launch and held in the Secure Enclave: it can sign with it, but the key itself cannot be read out, not even by the app. **Settings ▸ This phone's key** shows its public half. Add that line to `~/.ssh/authorized_keys` on each host, and on the hosts they are reached through (one line does it where they share a home folder).

A host that takes a password instead: type it under **Settings ▸ Hosts ▸** the host. It is kept in the iPhone's keychain, on this device only, and Kuna asks for Face ID when it opens.

A host whose key the Mac's export brought is trusted without a question. For any other host the app shows the key's fingerprint the first time and asks; `ssh-keygen -lF <address>` on the Mac shows the one your Mac trusts. A host that later shows another key is refused.

The app connects to every host that has a project when it opens. A sign-in the host refuses is not tried again until you tap **Try again**: login nodes lock accounts out for that. A connection that worked and dropped is tried again by itself, each time a little later. iOS cuts connections some seconds after you leave the app; it signs in again when you come back.

## Building it onto your iPhone

Once:

1. Install **Xcode** from the App Store (27.2 or later for iOS 27.2). Open it, accept the licence, and let it install the iOS platform. The other platforms are not needed.
2. In Terminal: `sudo xcode-select -s /Applications/Xcode.app`.
3. Xcode ▸ Settings ▸ Accounts ▸ **+** ▸ Apple Account: sign in with your Apple ID. This makes a free "Personal Team".
4. Connect the iPhone by cable and tap **Trust** on it.
5. On the iPhone: Settings ▸ Privacy & Security ▸ **Developer Mode** ▸ on. The phone restarts and asks once more. The switch shows up only after step 4.
6. Tell the project who signs: put your team's ten characters in `ios/App/Local.xcconfig` (a file that stays out of git):

   ```
   DEVELOPMENT_TEAM = ABCDE12345
   ```

   Xcode shows them under **Kuna** (top of the left column) ▸ target **Kuna** ▸ **Signing & Capabilities** ▸ Team. Picking the team there works too; it then writes it into the project file, which git will show as changed.

Every time:

1. `npm run ios:bundle`
2. `open ios/App/Kuna.xcodeproj`
3. Wait until Xcode has fetched the packages (the bar at the top says so) the first time.
4. Pick your iPhone in the bar at the top of the window and press **⌘R**.
5. The first time, the phone refuses to open the app: Settings ▸ General ▸ VPN & Device Management ▸ your Apple ID ▸ **Trust**. Then press ⌘R again.

With a free Apple account the app stops opening after 7 days; press ⌘R again to renew it. Its projects, hosts, passwords and key stay.

Build the Mac app from the same commit (`npm run dist`, or `npm run dev`). The helper script on the hosts is versioned by its content; a phone and a Mac built from different versions each reinstall it when they connect.

## For working on it

| Path | What |
| --- | --- |
| `ios/Package.swift` | a Swift package with the app's code |
| `ios/Sources/KunaCore` | everything that is not a screen: ssh (`swift-nio-ssh`), the keychain, the host's helper and watch stream, the app's model (`AppModel`: hosts, connections, projects, agents) and an open agent (`AgentSession`: its conversation and terminal). Builds on macOS too, so `swift test` checks it without a phone. |
| `ios/Sources/KunaUI` | the screens (SwiftUI), the terminal (`SwiftTerm`) and the web views |
| `ios/bridge.ts` | what the app calls in Kuna's shared TypeScript (`src/shared`), run in JavaScriptCore |
| `ios/web/page.ts` | what its web views run: Markdown, a file's text, a diff |
| `ios/App` | the Xcode project: the app's entry point, icon, the `.kuna` file type, signing; and the walkthrough test |
| `src/shared/phone.ts` | the export's format, reading it, and merging it into what the phone has |
| `src/main/phoneExport.ts` | the Mac's **Export for iPhone…** |

The phone has no logic of its own for what the Mac already works out: the watch stream, statuses, titles, where an agent goes in the tree, the conversation's rows and a reply's Markdown as blocks, the plots a reply mentions, git's output and the branch lists, the review comments' message and the colour schemes all come from `src/shared` through `ios/bridge.ts`. `npm run ios:bundle` bundles the bridge (with the helper script `kuna.sh`) into `ios/Sources/KunaCore/Resources/kuna-shared.js` and the web script into `ios/Sources/KunaUI/Resources/kuna-web.js`. Neither is in git: **run `npm run ios:bundle` before building, and again after changing `src/shared`, `ios/bridge.ts`, `ios/web` or `kuna.sh`.**

- `npm run ios:bundle` — make the two bundles
- `npm run ios:test` — bundle, then `swift test` in `ios/`. The tests start a throwaway `sshd` on this Mac (its own host key, a temporary `HOME`, a private tmux socket) and drive the ssh code and the app's model against it: sign-in, a jump host, host keys, the helper, starting and stopping an agent, typing into it, its conversation, its terminal, an import. They touch none of your hosts and not your keychain.
- `sh scripts/ios-sim.sh` — build the app, open it in the simulator on the same kind of throwaway `sshd` with fake agents, plots and a git repository, walk through every screen (`ios/App/KunaUITests/Walkthrough.swift`) and save a picture of each. The way to look at a change without a phone. `KUNA_KEEP=1` leaves the server and the app running afterwards.

The simulator has no Secure Enclave and no Face ID: there the key is an ordinary one in the simulator's keychain and the lock is skipped.

## Limits

- The ssh library answers a key or a plain password. A host that asks for its password as a typed prompt (keyboard-interactive, as hosts with one-time codes do) is refused; the message then says what the host takes. Kerberos is not supported.
- The phone's key is ECDSA P-256. A host that refuses that type, or whose only host key is RSA, cannot be used yet.
- A conversation shows its newest 200 rows, read from the last 1.5 MB of the transcript. Replies arrive whole, not word by word; the terminal shows them as they are written.
- A Claude Code background session takes input only on its own screen, so sending it a message opens its terminal behind the conversation (which also starts a stopped session again). If a question or a panel is open there, the message is not typed and the app says so.
- Opening an agent's terminal sizes it to the phone, also for a Mac that has it open.
- A diff side is read up to 2 MB, a file to view up to 200 MB.

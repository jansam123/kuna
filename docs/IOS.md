# Kuna on the iPhone

An iPhone app that signs in to your hosts over ssh, as the Mac app does, and shows the agents running there. It runs no agents itself. It is being built in steps; this page says what exists.

**Now (step 1, the connection proof):** one host, optionally through one jump host; sign-in with the phone's own key or a saved password; Kuna's helper is installed when missing; the host's agents with live status.

**Not yet:** projects and the import from the Mac, the chat and the terminal, plots and PDFs, review, Face ID, colour schemes.

## Layout

| Path | What |
| --- | --- |
| `ios/Package.swift` | a Swift package with the app's code; it also builds on macOS, so it is checked without a phone |
| `ios/Sources/KunaCore` | everything that is not a screen: ssh (`swift-nio-ssh`), the keychain, the host's helper and watch stream |
| `ios/Sources/KunaUI` | the screens (SwiftUI) |
| `ios/bridge.ts` | what the app calls in Kuna's shared TypeScript (`src/shared`) |
| `ios/App/Kuna.xcodeproj` | the Xcode project: the app's entry point around `KunaUI`, signing, the app's name |

The app does not have its own parser for the watch stream. `npm run ios:bundle` bundles `ios/bridge.ts`, with `src/shared` and the helper script `kuna.sh`, into `ios/Sources/KunaCore/Resources/kuna-shared.js`, and the app runs that in JavaScriptCore. The bundle is not in git: **run `npm run ios:bundle` before building, and again after changing `src/shared`, `ios/bridge.ts` or `kuna.sh`.**

The helper's version is the hash of `kuna.sh`, for both apps. A phone and a Mac built from different versions of `kuna.sh` each reinstall the helper when they connect; build both from the same commit.

## Commands

- `npm run ios:bundle` — make the shared-logic bundle
- `npm run ios:test` — bundle, then `swift test` in `ios/`. The tests start a throwaway `sshd` on this Mac (its own host key, a temporary `HOME`, a private tmux socket) and sign in to it, directly and as its own jump host. They touch none of your hosts. Needs Xcode selected (`xcode-select -p` shows Xcode, not the command line tools).
- `sh scripts/ios-sim.sh` — build the app, open it in the simulator signed in to the same kind of throwaway `sshd` with two fake agents, and print the path of a screenshot. The way to look at a change without a phone.

## Building it onto your iPhone

Once:

1. Install **Xcode** from the App Store (27.2 or later for iOS 27.2). Open it, accept the licence, and let it install the iOS platform.
2. In Terminal: `sudo xcode-select -s /Applications/Xcode.app`.
3. Xcode ▸ Settings ▸ Accounts ▸ **+** ▸ Apple Account: sign in with your Apple ID. This makes a free "Personal Team".
4. Connect the iPhone by cable and tap **Trust** on it.
5. On the iPhone: Settings ▸ Privacy & Security ▸ **Developer Mode** ▸ on. The phone restarts and asks once more. The switch shows up only after step 4.

Every time:

1. `npm run ios:bundle`
2. `open ios/App/Kuna.xcodeproj`
3. The first time: click **Kuna** at the top of the left column ▸ target **Kuna** ▸ **Signing & Capabilities** ▸ Team: your Personal Team.
4. Pick your iPhone in the bar at the top of the window and press **⌘R**.
5. The first time, the phone refuses to open the app: Settings ▸ General ▸ VPN & Device Management ▸ your Apple ID ▸ **Trust**. Then press ⌘R again.

With a free Apple account the app stops opening after 7 days; press ⌘R again to renew it. Its saved hosts, passwords and key stay.

## First connection

1. Tap **Host**. Fill in the address and user, as `HostName` and `User` in your `~/.ssh/config`; switch on **Through a jump host** for a host with `ProxyJump`.
2. For hosts that take keys: send **This phone's key** to your Mac and add the line to `~/.ssh/authorized_keys` on the host (and on the jump host). For hosts that take a password: type it; it is kept in the iPhone keychain.
3. **Connect.** The first time, the app shows the host's key fingerprint and asks whether to trust it; `ssh-keygen -lF <address>` on the Mac shows the one your Mac trusts. Later a host showing another key is refused.

A sign-in the host refuses is not tried again until you tap **Try again**. A connection that worked and dropped is tried once more by itself; iOS cuts connections when the app is left, and the app signs in again when it comes back.

## Limits

- The ssh library answers a key or a plain password. A host that asks for its password as a typed prompt (keyboard-interactive, as OTP hosts do) is refused; the message then says what the host takes.
- The phone's key is ECDSA P-256, held in the Secure Enclave. A host that refuses that type is not supported yet.

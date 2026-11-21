#!/bin/sh
# Opens the iPhone app in the simulator, signed in to a throwaway sshd on this Mac with two fake
# agents, saves a screenshot and stops the server. The server has its own host key, a temporary
# HOME and a private tmux socket: your hosts, keys and agents are not touched.
# Usage: sh scripts/ios-sim.sh   (needs Xcode with an iOS simulator, and tmux)
#        KUNA_SIM="iPhone 17" sh scripts/ios-sim.sh   picks a simulator; otherwise the first iPhone Pro in the list
set -eu
cd "$(dirname "$0")/.."
app=io.github.jansam123.Kuna
sim=${KUNA_SIM:-$(xcrun simctl list devices available | sed -n 's/^ *\(iPhone [0-9]* Pro\) (.*/\1/p' | head -1)}
base=${TMPDIR:-/tmp}
tmp=$(mktemp -d "${base%/}/kuna-ios-sim.XXXXXX")
sock=kuna-ios-sim-$$
port=$((20000 + $$ % 20000))
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
waitfor() { # waitfor <seconds> <command…>
  n=$1; shift
  until "$@" > /dev/null 2>&1; do
    n=$((n - 1))
    [ "$n" -gt 0 ] || return 1
    sleep 1
  done
}
cleanup() {
  [ -z "${sshd:-}" ] || kill "$sshd" 2> /dev/null || true
  tmux -L "$sock" kill-server 2> /dev/null || true
  rm -rf "$tmp/home" "$tmp/hostkey" "${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$sock"
}
trap cleanup EXIT

echo "building…"
node scripts/ios-bundle.mjs > "$tmp/build.log" 2>&1
xcodebuild -quiet -project ios/App/Kuna.xcodeproj -scheme Kuna -configuration Debug \
  -destination "platform=iOS Simulator,name=$sim" -derivedDataPath ios/.build/xcode build >> "$tmp/build.log" 2>&1 ||
  { echo "build FAILED, see $tmp/build.log"; exit 1; }

mkdir -p "$tmp/home/work"
ssh-keygen -q -t ed25519 -N '' -f "$tmp/hostkey"
: > "$tmp/authorized_keys"
cat > "$tmp/sshd_config" <<EOF
Port $port
ListenAddress 127.0.0.1
HostKey $tmp/hostkey
PidFile none
AuthorizedKeysFile $tmp/authorized_keys
StrictModes no
UsePAM no
PasswordAuthentication no
KbdInteractiveAuthentication no
PerSourcePenalties no
LogLevel DEBUG2
SetEnv HOME=$tmp/home SHELL=/bin/sh KUNA_TMUX_SOCKET=$sock "PATH=$PATH"
ForceCommand cd "\$HOME" && exec sh -c "\$SSH_ORIGINAL_COMMAND"
EOF
/usr/sbin/sshd -D -e -f "$tmp/sshd_config" 2> "$tmp/sshd.log" &
sshd=$!
waitfor 10 grep -q listening "$tmp/sshd.log" || { echo "sshd did not start, see $tmp/sshd.log"; exit 1; }

echo "starting the simulator…"
xcrun simctl boot "$sim" 2> /dev/null || true
xcrun simctl bootstatus "$sim" > /dev/null
xcrun simctl terminate "$sim" $app 2> /dev/null || true
xcrun simctl install "$sim" ios/.build/xcode/Build/Products/Debug-iphonesimulator/Kuna.app
host="{\"name\":\"test server\",\"hop\":{\"address\":\"127.0.0.1\",\"port\":$port,\"user\":\"$(id -un)\"},\"usesJump\":false,\"jump\":{\"address\":\"\",\"port\":22,\"user\":\"\"}}"
xcrun simctl spawn "$sim" defaults write $app host -data "$(printf '%s' "$host" | xxd -p | tr -d '\n')"
xcrun simctl spawn "$sim" defaults write $app hostKeys -dict "'[127.0.0.1]:$port'" "(\"$(cut -d' ' -f1,2 "$tmp/hostkey.pub")\")"

# The simulator's key is its own, made on first launch: the first sign-in is refused, sshd's
# log says which key was offered, and the second launch gets in with it.
xcrun simctl launch "$sim" $app > /dev/null
waitfor 20 grep -q 'public key ecdsa-sha2-nistp256 ' "$tmp/sshd.log" || { echo "the app did not try to sign in, see $tmp/sshd.log"; exit 1; }
sed -n 's/.*public key \(ecdsa-sha2-nistp256 [A-Za-z0-9+\/=]*\).*/\1/p' "$tmp/sshd.log" | head -1 > "$tmp/authorized_keys"
xcrun simctl terminate "$sim" $app
xcrun simctl launch "$sim" $app > /dev/null
waitfor 30 test -f "$tmp/home/.kuna/bin/kuna" || { echo "the app did not install the helper, see $tmp/sshd.log"; exit 1; }
echo "signed in, helper installed"

spawn() { # spawn <id> <command> <prompt>
  meta="{\"id\":\"$1\",\"cwd\":\"~/work\",\"createdAt\":$(date +%s),\"prompt\":\"$3\"}"
  HOME="$tmp/home" KUNA_TMUX_SOCKET=$sock sh "$tmp/home/.kuna/bin/kuna" spawn "$1" "$(b64 '~/work')" "$(b64 "$2")" 100 30 "$(b64 "$meta")" "$(b64 '')" > /dev/null
}
spawn aaaa1111 'echo fitting; sleep 600' 'Fit the signal region'
spawn bbbb2222 'exit 3' 'Rerun the failed jobs'
sleep 6
xcrun simctl io "$sim" screenshot "$tmp/screen.png" > /dev/null 2>&1 || { echo "no screenshot from $sim"; exit 1; }
xcrun simctl terminate "$sim" $app
echo "screenshot: $tmp/screen.png"

#!/bin/sh
# Walks through the iPhone app in the simulator and saves a picture of every screen: the way to
# look at a change without a phone. The app signs in to a throwaway sshd on this Mac (its own
# host key, a temporary HOME, a private tmux socket) holding a project with fake agents, plots
# and a git repository. Your hosts, keys and agents are not touched.
# Usage: sh scripts/ios-sim.sh   (needs Xcode with an iOS simulator, tmux and git)
#        KUNA_SIM="iPhone 17" sh scripts/ios-sim.sh   picks a simulator; otherwise the first iPhone Pro in the list
#        KUNA_KEEP=1 sh scripts/ios-sim.sh   leaves the server and the app running afterwards, to try things by hand
#        KUNA_ONLY=testQuestions sh scripts/ios-sim.sh   runs one test of ios/App/KunaUITests (Walkthrough) instead of all
set -eu
cd "$(dirname "$0")/.."
app=io.github.jansam123.Kuna
sim=${KUNA_SIM:-$(xcrun simctl list devices available | sed -n 's/^ *\(iPhone [0-9]* Pro\) (.*/\1/p' | head -1)}
base=${TMPDIR:-/tmp}
tmp=$(mktemp -d "${base%/}/kuna-ios-sim.XXXXXX")
sock=kuna-ios-sim-$$
port=$((20000 + $$ % 20000))
home=$tmp/home
work=$home/work
shots=$tmp/shots
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
  rm -rf "$home" "$tmp/hostkey" "${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$sock"
}

echo "building…"
node scripts/ios-bundle.mjs > "$tmp/build.log" 2>&1
xcodebuild -quiet -project ios/App/Kuna.xcodeproj -scheme Kuna -configuration Debug \
  -destination "platform=iOS Simulator,name=$sim" -derivedDataPath ios/.build/xcode build-for-testing >> "$tmp/build.log" 2>&1 ||
  { echo "build FAILED, see $tmp/build.log"; exit 1; }

# ---- what the agents work on: a folder with a fit, its plots, notes, a page, and git history
mkdir -p "$work/plots" "$work/report" "$work/diagrams" "$work/.claude" "$home/tagger" "$home/notes" "$home/thesis" "$shots"
cp ios/Tests/fixture/fake-agent.sh "$home/fake-agent.sh"
# a Claude Code background session, and the `claude` that attaches to it
mkdir -p "$home/bin" "$home/.claude/jobs/ffff6666" "$home/.claude/daemon"
cp ios/Tests/fixture/fake-claude.sh "$home/bin/claude"
chmod +x "$home/bin/claude"
printf '{"state":"idle","tempo":"idle","updatedAt":"%s","createdAt":"%s","cwd":"%s","name":"Scan the nuisance parameters"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$work" > "$home/.claude/jobs/ffff6666/state.json"
cp build/icon.png "$work/plots/mass.png"
cp build/icon.png "$work/diagrams/flow.png"
printf '# Plan\n\n1. Rebin\n2. Refit\n' > "$work/.claude/plan.md"
printf '%%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R 6 0 R]/Count 2>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 480 270]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 52>>stream\nBT /F1 30 Tf 60 130 Td (HH to bbtautau: status) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n6 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 480 270]/Contents 7 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n7 0 obj<</Length 44>>stream\nBT /F1 30 Tf 60 130 Td (Second slide) Tj ET\nendstream endobj\ntrailer<</Root 1 0 R>>\n' > "$work/talk.pdf"
printf '%%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 300]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 58>>stream\nBT /F1 28 Tf 60 150 Td (Pulls: all within 2 sigma) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n' > "$work/plots/pulls.pdf"
printf '# Fit notes\n\nThe signal region fit **converged**.\n\n- mu = 1.04 ± 0.21\n- 41 bins\n\n```python\nresult = fit(region="SR")\n```\n\n| region | events |\n|---|---|\n| SR | 412 |\n' > "$work/notes.md"
printf '<!doctype html><meta name=viewport content="width=device-width"><title>Report</title><style>body{font:16px system-ui;background:#0b1020;color:#dfe6f5;padding:24px}</style><h1>Fit report</h1><p id=o>loading…</p><script src="data.js"></script>' > "$work/report/index.html"
printf 'document.getElementById("o").textContent = "mu = 1.04 ± 0.21, from a script in the page folder"' > "$work/report/data.js"
printf 'import numpy as np\n\n\ndef fit(region, bins=40):\n    """Fit the given region."""\n    data = load(region)\n    return minimise(data, bins)\n' > "$work/fit.py"
printf 'region: SR\nbins: 40\n' > "$work/config.yaml"
(
  cd "$work"
  export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_AUTHOR_NAME=Kuna GIT_AUTHOR_EMAIL=kuna@example.org GIT_COMMITTER_NAME=Kuna GIT_COMMITTER_EMAIL=kuna@example.org
  git init -q -b main .
  printf '.transcript-*\n.claude\n' > .gitignore
  git add .gitignore fit.py config.yaml && git commit -q -m "The fit as it was"
  git checkout -q -b new-binning
  sed -i '' 's/bins=40/bins=41/' fit.py && git commit -q -am "One more bin"
  # uncommitted: a changed file, a staged change, new files
  printf '    result = minimise(data, bins)\n    result.check()\n    return result\n' > tail.txt
  sed -i '' '$d' fit.py && cat tail.txt >> fit.py && rm tail.txt
  sed -i '' 's/bins: 40/bins: 41/' config.yaml && git add config.yaml
)

# ---- the host: sshd for this run only
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
SetEnv HOME=$home SHELL=/bin/sh KUNA_TMUX_SOCKET=$sock "PATH=$home/bin:$PATH" GIT_CONFIG_GLOBAL=/dev/null
ForceCommand cd "\$HOME" && exec sh -c "\$SSH_ORIGINAL_COMMAND"
EOF
/usr/sbin/sshd -D -e -f "$tmp/sshd_config" 2> "$tmp/sshd.log" &
sshd=$!
[ -n "${KUNA_KEEP:-}" ] || trap cleanup EXIT
waitfor 10 grep -q listening "$tmp/sshd.log" || { echo "sshd did not start, see $tmp/sshd.log"; exit 1; }
# the background session counts as running while its worker's pid is alive: sshd's will do
printf '{"workers":{"ffff6666":{"pid":%s}}}\n' "$sshd" > "$home/.claude/daemon/roster.json"

# ---- what the Mac would export: the project, and the host behind a jump host (the same sshd)
me=$(id -un)
fake="sh $home/fake-agent.sh"
cat > "$tmp/export.kuna" <<EOF
{"kuna":"iphone","version":1,"exportedAt":$(date +%s),"theme":"cherenkov",
 "projects":[{"id":"p-sim","name":"\$HH \\\\to b\\\\bar{b}\\\\tau\\\\tau\$","host":"cluster","color":"#4d8dff","icon":"higgs","agentCommand":"$fake","folders":[
   {"id":"f-sim","path":"~/work","name":"work","color":"#ff9f1c"},{"id":"f-empty","path":"~/work/report","name":"report","color":"#2ee6c5"}]},
  {"id":"p-tag","name":"Tagger training","host":"cluster","color":"#2ee6c5","icon":"network","agentCommand":"$fake","folders":[{"id":"f-tag","path":"~/tagger","name":"tagger","color":"#2ee6c5"}]},
  {"id":"p-notes","name":"Detector notes","host":"cluster","color":"#ff9f1c","icon":"μ","agentCommand":"$fake","folders":[{"id":"f-notes","path":"~/notes","name":"notes","color":"#a78bff"}]},
  {"id":"p-thesis","name":"Thesis","host":"cluster","color":"#a78bff","agentCommand":"$fake","folders":[{"id":"f-thesis","path":"~/thesis","name":"thesis","color":"#4d8dff"}]}],
 "names":{"cluster::bbbb2222":"Rerun the failed jobs"},"hidden":{},
 "hosts":[{"alias":"cluster","hostName":"127.0.0.1","user":"$me","port":$port,"jump":"gate"},{"alias":"gate","hostName":"127.0.0.1","user":"$me","port":$port}],
 "hostKeys":{"[127.0.0.1]:$port":["$(cut -d' ' -f1,2 "$tmp/hostkey.pub")"]}}
EOF

echo "starting the simulator…"
xcrun simctl boot "$sim" 2> /dev/null || true
xcrun simctl bootstatus "$sim" > /dev/null
xcrun simctl terminate "$sim" $app 2> /dev/null || true
xcrun simctl install "$sim" ios/.build/xcode/Build/Products/Debug-iphonesimulator/Kuna.app

# The simulator's key is its own, made on first launch: the first sign-in is refused, sshd's
# log says which key was offered, and from then on that key gets in.
xcrun simctl launch "$sim" $app -kunaReset YES -lock NO -kunaImport "$tmp/export.kuna" > /dev/null
waitfor 30 grep -q 'public key ecdsa-sha2-nistp256 ' "$tmp/sshd.log" || { echo "the app did not try to sign in, see $tmp/sshd.log"; exit 1; }
sed -n 's/.*public key \(ecdsa-sha2-nistp256 [A-Za-z0-9+\/=]*\).*/\1/p' "$tmp/sshd.log" | head -1 > "$tmp/authorized_keys"
xcrun simctl terminate "$sim" $app
xcrun simctl launch "$sim" $app -lock NO > /dev/null
waitfor 40 test -f "$home/.kuna/bin/kuna" || { echo "the app did not install the helper, see $tmp/sshd.log"; exit 1; }
echo "signed in, helper installed"

spawn() { # spawn <id> <command> <prompt> [folder below ~] [project id] [folder id]
  meta="{\"id\":\"$1\",\"cwd\":\"~/${4:-work}\",\"projectId\":\"${5:-p-sim}\",\"folderId\":\"${6:-f-sim}\",\"createdAt\":$(date +%s),\"prompt\":\"$3\",\"sessionId\":\"00000000-0000-4000-8000-0000$1\",\"command\":\"claude\"}"
  HOME="$home" KUNA_TMUX_SOCKET=$sock sh "$home/.kuna/bin/kuna" spawn "$1" "$(b64 "~/${4:-work}")" "$(b64 "$2")" 100 30 "$(b64 "$meta")" "$(b64 '')" > /dev/null
}
spawn aaaa1111 "$fake" 'Fit the signal region and show me the mass plot.'
spawn bbbb2222 'exit 3' 'Rerun the failed jobs'
spawn cccc3333 "$fake 'Train the tagger on the new samples' working" 'Train the tagger on the new samples' tagger p-tag f-tag
spawn dddd4444 "$fake 'Compare the ROC curves' waiting" 'Compare the ROC curves' tagger p-tag f-tag
spawn eeee5555 "$fake 'Summarise the alignment note' limit" 'Summarise the alignment note' notes p-notes f-notes
sleep 3
xcrun simctl terminate "$sim" $app

echo "walking through the app…"
TEST_RUNNER_KUNA_SHOTS="$shots" TEST_RUNNER_KUNA_IMPORT="$tmp/export.kuna" xcodebuild -quiet -project ios/App/Kuna.xcodeproj -scheme Kuna \
  -destination "platform=iOS Simulator,name=$sim" -derivedDataPath ios/.build/xcode ${KUNA_ONLY:+-only-testing:KunaUITests/Walkthrough/$KUNA_ONLY} test-without-building > "$tmp/test.log" 2>&1 && echo "walkthrough: ok" ||
  { echo "walkthrough: FAILED (the pictures up to there are kept)"; grep -E "error:|did not show up" "$tmp/test.log" | sed 's/.*Walkthrough.swift/Walkthrough.swift/' | sort -u | head -20; }
# the drag on the background session's screen reached it as wheel notches up: it starts at line 200
if [ -z "${KUNA_ONLY:-}" ]; then
  [ "$(cat "$home/.wheel" 2> /dev/null || echo 200)" -lt 200 ] && echo "wheel: ok" || echo "wheel: FAILED (a drag did not scroll the background session)"
fi
echo "pictures: $shots"
ls "$shots" | sed 's/^/  /'
[ -z "${KUNA_KEEP:-}" ] || echo "left running: sshd $sshd on port $port, tmux -L $sock, files in $tmp (stop with: kill $sshd; tmux -L $sock kill-server)"

#!/bin/sh
# A stand-in for Claude Code in the simulator fixture (scripts/ios-sim.sh): it keeps a transcript
# as Claude Code does, tells Kuna's helper where it is, and answers every line typed into it.
# Usage: fake-agent.sh [task] [working|waiting] ; run inside one of Kuna's tmux agents (KUNA_AGENT_ID is set).
# The second word leaves it at work, or waiting for a permission, after its first reply.
t=$PWD/.transcript-$KUNA_AGENT_ID.jsonl
task=${1:-Fit the signal region and show me the mass plot.}
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
n=0
line() { n=$((n + 1)); printf '%s\n' "$1" >> "$t"; }
hook() { printf '{"hook_event_name":"%s","transcript_path":"%s"}' "$1" "$t" | sh "$HOME/.kuna/bin/kuna" hook; }
say() { # say <text as a JSON string body>
  line "{\"type\":\"assistant\",\"uuid\":\"a$n\",\"timestamp\":\"$(now)\",\"message\":{\"model\":\"claude-opus-4-5\",\"usage\":{\"input_tokens\":41000,\"output_tokens\":900},\"content\":[{\"type\":\"text\",\"text\":\"$1\"}]}}"
}
: > "$t"
line "{\"type\":\"ai-title\",\"aiTitle\":\"Fit the signal region\"}"
line "{\"type\":\"user\",\"uuid\":\"u$n\",\"timestamp\":\"$(now)\",\"message\":{\"content\":\"$(printf '%s' "$task" | sed 's/\\/\\\\/g; s/"/\\"/g')\"}}"
line "{\"type\":\"assistant\",\"uuid\":\"a$n\",\"timestamp\":\"$(now)\",\"message\":{\"model\":\"claude-opus-4-5\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"The user wants the fit redone with the new binning. I should check the config first, then run it and look at the pulls.\"}]}}"
line "{\"type\":\"assistant\",\"uuid\":\"a$n\",\"timestamp\":\"$(now)\",\"message\":{\"model\":\"claude-opus-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"Read\",\"input\":{\"file_path\":\"$PWD/fit.py\"}}]}}"
line "{\"type\":\"user\",\"uuid\":\"u$n\",\"timestamp\":\"$(now)\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"content\":\"ok\"}]}}"
line "{\"type\":\"assistant\",\"uuid\":\"a$n\",\"timestamp\":\"$(now)\",\"message\":{\"model\":\"claude-opus-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t2\",\"name\":\"Bash\",\"input\":{\"command\":\"python fit.py --region SR\",\"description\":\"Run the fit in the signal region\"}}]}}"
line "{\"type\":\"user\",\"uuid\":\"u$n\",\"timestamp\":\"$(now)\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t2\",\"content\":\"Saved figure to plots/mass.png and plots/pulls.pdf\"}]}}"
say "The fit converged.\\n\\n## Result\\n\\n- **mu** = 1.04 ± 0.21\\n- chi2/ndf = 38.2 / 41\\n\\n| region | events | expected |\\n|---|---|---|\\n| SR | 412 | 398.6 |\\n\\nThe plot is in \`plots/mass.png\`, the pulls in \`plots/pulls.pdf\`, my notes in \`notes.md\` and an interactive page in \`report/index.html\`. The slides are \`talk.pdf\`, the workflow is \`diagrams/flow.png\` and the plan is \`.claude/plan.md\`.\\n\\n\`\`\`python\\nresult = fit(region='SR', bins=41)\\n\`\`\`"
hook Stop
case ${2:-} in
  working) hook UserPromptSubmit ;;
  waiting) hook PermissionRequest ;;
esac
printf 'fake agent ready\n'
printf '──────────────────────────────\n❯ \n──────────────────────────────\n'
while IFS= read -r typed; do
  [ -n "$typed" ] || continue
  hook UserPromptSubmit
  esc=$(printf '%s' "$typed" | sed 's/\\/\\\\/g; s/"/\\"/g')
  line "{\"type\":\"user\",\"uuid\":\"u$n\",\"timestamp\":\"$(now)\",\"message\":{\"content\":\"$esc\"}}"
  sleep 1
  say "You said: $esc"
  hook Stop
  printf '──────────────────────────────\n❯ \n──────────────────────────────\n'
done

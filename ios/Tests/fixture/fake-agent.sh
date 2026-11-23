#!/bin/sh
# A stand-in for Claude Code in the simulator fixture (scripts/ios-sim.sh): it keeps a transcript
# as Claude Code does, tells Kuna's helper where it is, and answers every line typed into it.
# Usage: fake-agent.sh [task] [working|waiting|limit] ; run inside one of Kuna's tmux agents (KUNA_AGENT_ID is set).
# The second word leaves it at work, waiting with two questions on its screen, or stopped by a usage limit, after its first reply.
# `/model` typed into it opens its list of models, drawn and steered as Claude Code 2.1's is.
# It starts with eighty lines of output, so its pane has something scrolled past.
t=$PWD/.transcript-$KUNA_AGENT_ID.jsonl
task=${1:-Fit the signal region and show me the mass plot.}
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
n=0
line() { n=$((n + 1)); printf '%s\n' "$1" >> "$t"; }
hook() { printf '{"hook_event_name":"%s","transcript_path":"%s"}' "$1" "$t" | sh "$HOME/.kuna/bin/kuna" hook; }
say() { # say <text as a JSON string body>
  line "{\"type\":\"assistant\",\"effort\":\"high\",\"uuid\":\"a$n\",\"timestamp\":\"$(now)\",\"message\":{\"model\":\"claude-opus-4-5\",\"usage\":{\"input_tokens\":6,\"cache_creation_input_tokens\":1400,\"cache_read_input_tokens\":64600,\"output_tokens\":900},\"content\":[{\"type\":\"text\",\"text\":\"$1\"}]}}"
}
key() { # one key, as it is pressed
  old=$(stty -g)
  stty -icanon -echo min 1 time 0
  picked=$(dd bs=1 count=1 2> /dev/null)
  stty "$old"
}
soon() { # the next key if it is there already (the rest of an arrow key), or nothing
  old=$(stty -g)
  stty -icanon -echo min 0 time 2
  picked=$(dd bs=1 count=1 2> /dev/null)
  stty "$old"
}
models() { # the list of models with its ❯ on row $1, at a phone's width: the hint is wrapped
  printf '\033[2J\033[H────────────────────────────────────────────────────────\n  Select model\n  Your pick is the default for new sessions. For other\n  models, use --model.\n\n'
  i=0
  for row in 'Default (recommended) ✔  Opus 4.5 · Best for|everyday, complex tasks' 'Sonnet 4.5               Most efficient for simpler|tasks' 'Haiku 4.5                Fastest for quick answers|'; do
    i=$((i + 1))
    if [ "$i" = "$1" ]; then mark='❯'; else mark=' '; fi
    printf '  %s %s.  %s\n' "$mark" "$i" "${row%%|*}"
    [ -z "${row#*|}" ] || printf '                                 %s\n' "${row#*|}"
  done
  printf '\n  ● %s effort ←/→ to adjust\n\n  s to use this session only · Enter to save · Esc to\n  cancel\n' "$2"
}
ask() { # ask <header> <question> <option> <about> <option> <about>: draws it, waits for a key, leaves it in $picked
  printf '\033[2J\033[H──────────────────────────────────────────\n ☐ %s\n\n %s\n\n ❯ 1. %s\n      %s\n   2. %s\n      %s\n   3. Type something.\n\n Enter to select · ↑/↓ to navigate · Esc to cancel\n' "$1" "$2" "$3" "$4" "$5" "$6"
  key
  printf '\033[2J\033[H'
}
: > "$t"
line "{\"type\":\"ai-title\",\"aiTitle\":\"Fit the signal region\"}"
line "{\"type\":\"user\",\"uuid\":\"u$n\",\"timestamp\":\"$(now)\",\"message\":{\"content\":\"$(printf '%s' "$task" | sed 's/\\/\\\\/g; s/"/\\"/g')\"}}"
line "{\"type\":\"assistant\",\"uuid\":\"a$n\",\"timestamp\":\"$(now)\",\"message\":{\"model\":\"claude-opus-4-5\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"The user wants the fit redone with the new binning. I should check the config first, then run it and look at the pulls.\"}]}}"
line "{\"type\":\"assistant\",\"uuid\":\"a$n\",\"timestamp\":\"$(now)\",\"message\":{\"model\":\"claude-opus-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"Read\",\"input\":{\"file_path\":\"$PWD/fit.py\"}}]}}"
line "{\"type\":\"user\",\"uuid\":\"u$n\",\"timestamp\":\"$(now)\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"content\":\"ok\"}]}}"
line "{\"type\":\"assistant\",\"uuid\":\"a$n\",\"timestamp\":\"$(now)\",\"message\":{\"model\":\"claude-opus-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t3\",\"name\":\"Edit\",\"input\":{\"file_path\":\"$PWD/fit.py\"}}]}}"
line "{\"type\":\"user\",\"uuid\":\"u$n\",\"timestamp\":\"$(now)\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t3\",\"content\":\"ok\"}]}}"
line "{\"type\":\"assistant\",\"uuid\":\"a$n\",\"timestamp\":\"$(now)\",\"message\":{\"model\":\"claude-opus-4-5\",\"content\":[{\"type\":\"text\",\"text\":\"Binning set to 41. Now the fit, the plot and the tests.\"}]}}"
# three shell commands in a row, the last one failed: one folded row on the phone
line "{\"type\":\"assistant\",\"uuid\":\"a$n\",\"timestamp\":\"$(now)\",\"message\":{\"model\":\"claude-opus-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t2\",\"name\":\"Bash\",\"input\":{\"command\":\"python fit.py --region SR\",\"description\":\"Run the fit in the signal region\"}}]}}"
line "{\"type\":\"user\",\"uuid\":\"u$n\",\"timestamp\":\"$(now)\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t2\",\"content\":\"Saved figure to plots/mass.png and plots/pulls.pdf\"}]}}"
line "{\"type\":\"assistant\",\"uuid\":\"a$n\",\"timestamp\":\"$(now)\",\"message\":{\"model\":\"claude-opus-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t5\",\"name\":\"Bash\",\"input\":{\"command\":\"python plot.py --log\",\"description\":\"Draw the mass plot\"}}]}}"
line "{\"type\":\"user\",\"uuid\":\"u$n\",\"timestamp\":\"$(now)\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t5\",\"content\":\"ok\"}]}}"
line "{\"type\":\"assistant\",\"uuid\":\"a$n\",\"timestamp\":\"$(now)\",\"message\":{\"model\":\"claude-opus-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t4\",\"name\":\"Bash\",\"input\":{\"command\":\"pytest\",\"description\":\"Run the tests\"}}]}}"
line "{\"type\":\"user\",\"uuid\":\"u$n\",\"timestamp\":\"$(now)\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t4\",\"content\":\"1 failed\",\"is_error\":true}]}}"
say "The fit converged.\\n\\n## Result\\n\\n- **mu** = 1.04 ± 0.21, for \$m_{\\\\gamma\\\\gamma}\$ in [105, 160] GeV\\n- chi2/ndf = 38.2 / 41\\n  1. the pulls are flat\\n  2. see [the note](https://example.org/note)\\n- [x] signal region\\n- [ ] control region\\n\\n> One test fails: it still expects 40 bins.\\n\\n| region | events | expected |\\n|:---|---:|---:|\\n| SR | 412 | 398.6 |\\n| CR | 9120 | 9087.2 |\\n\\nThe plot is in \`plots/mass.png\`, the pulls in \`plots/pulls.pdf\`, my notes in \`notes.md\` and an interactive page in \`report/index.html\`. The slides are \`talk.pdf\`, the workflow is \`diagrams/flow.png\` and the plan is \`.claude/plan.md\`.\\n\\n\`\`\`python\\nresult = fit(region='SR', bins=41)\\n\`\`\`"
hook Stop
case ${2:-} in
  working) hook UserPromptSubmit ;;
  waiting)
    # two questions of its own, each a panel on its screen as Claude Code draws one
    line "{\"type\":\"assistant\",\"uuid\":\"a$n\",\"timestamp\":\"$(now)\",\"message\":{\"model\":\"claude-opus-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"q1\",\"name\":\"AskUserQuestion\",\"input\":{\"questions\":[{\"question\":\"Which curves should be compared?\",\"header\":\"Curves\",\"options\":[{\"label\":\"All taggers\"},{\"label\":\"Only the new one\"}]},{\"question\":\"Log scale on the background axis?\",\"header\":\"Scale\",\"options\":[{\"label\":\"Yes\"},{\"label\":\"No\"}]}]}}]}}"
    hook PermissionRequest
    ask 'Curves' 'Which curves should be compared?' 'All taggers' 'Every tagger trained so far, on one canvas' 'Only the new one' 'Against the baseline'
    first=$picked
    ask 'Scale' 'Log scale on the background axis?' 'Yes' 'Rejection over four decades' 'No' 'Linear, as in the note'
    line "{\"type\":\"user\",\"uuid\":\"u$n\",\"timestamp\":\"$(now)\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"q1\",\"content\":\"answered\"}]}}"
    hook UserPromptSubmit
    say "Comparing with choice $first, log scale choice $picked."
    hook Stop
    ;;
  limit)
    # as Claude Code writes a usage limit and a request that failed
    line "{\"type\":\"assistant\",\"uuid\":\"a$n\",\"timestamp\":\"$(now)\",\"isApiErrorMessage\":true,\"error\":\"server_error\",\"message\":{\"model\":\"<synthetic>\",\"content\":[{\"type\":\"text\",\"text\":\"API Error: the connection dropped mid-response.\"}]}}"
    line "{\"type\":\"assistant\",\"uuid\":\"a$n\",\"timestamp\":\"$(now)\",\"isApiErrorMessage\":true,\"error\":\"rate_limit\",\"message\":{\"model\":\"<synthetic>\",\"content\":[{\"type\":\"text\",\"text\":\"You've hit your 5-hour limit · resets 5:40pm (Europe/Amsterdam)\"}]}}"
    ;;
esac
i=0
while [ "$i" -lt 80 ]; do
  i=$((i + 1))
  printf '\033[32mepoch %3d\033[0m  loss \033[1m0.%03d\033[0m  \033[2mlr 3e-4\033[0m\n' "$i" "$((900 - i * 9))"
done
printf 'fake agent ready\n'
printf '──────────────────────────────\n❯ \n──────────────────────────────\n'
while IFS= read -r typed; do
  [ -n "$typed" ] || continue
  if [ "$typed" = /model ]; then
    # a panel of Claude Code's own: nothing goes into the conversation
    at=1
    effort=High
    said='Kept the model'
    while :; do
      models "$at" "$effort"
      key
      case $picked in
        s) said="Set model to choice $at for this session only with $effort effort"; break ;;
        "$(printf '\033')")
          # an arrow is Esc and two more; Esc alone closes the list
          soon
          [ -n "$picked" ] || break
          soon
          case $picked in
            A) [ "$at" -le 1 ] || at=$((at - 1)) ;;
            B) [ "$at" -ge 3 ] || at=$((at + 1)) ;;
            C) effort=Max ;;
            D) effort=High ;;
          esac
          ;;
        *) break ;;
      esac
    done
    printf '\033[2J\033[H  ⎿  %s\n──────────────────────────────\n❯ \n──────────────────────────────\n' "$said"
    continue
  fi
  hook UserPromptSubmit
  esc=$(printf '%s' "$typed" | sed 's/\\/\\\\/g; s/"/\\"/g')
  line "{\"type\":\"user\",\"uuid\":\"u$n\",\"timestamp\":\"$(now)\",\"message\":{\"content\":\"$esc\"}}"
  sleep 1
  say "You said: $esc"
  hook Stop
  printf '──────────────────────────────\n❯ \n──────────────────────────────\n'
done

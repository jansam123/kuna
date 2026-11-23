#!/bin/sh
# A stand-in for Claude Code in the simulator fixture (scripts/ios-sim.sh): it keeps a transcript
# as Claude Code does, tells Kuna's helper where it is, and answers every line typed into it.
# Usage: fake-agent.sh [task] [working|waiting|limit] ; run inside one of Kuna's tmux agents (KUNA_AGENT_ID is set).
# The second word leaves it at work, waiting with two questions on its screen, or stopped by a usage limit, after its first reply.
# `/model` typed into it opens its list of models, drawn and steered as Claude Code 2.1's is.
# `ask one`, `ask many` (checkboxes), `ask set` (two questions) and `run it` (a permission) make it
# ask, and `/compact` compacts, each drawn and answered as Claude Code 2.1.330 does it
# (test/fixtures/screens has the real screens).
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
# ---- questions (AskUserQuestion) as Claude Code 2.1.330 draws them at 46 columns and takes keys
# (captured from the real one: test/fixtures/screens). A question is set up with `question`, then
# `ask` runs them all as one set and leaves the answers in $answers, or nothing when cancelled.
rule='──────────────────────────────────────────────'
nq=0
question() { # question <header> <text> <1 when it takes several answers> <option> <about> [<option> <about>…]
  nq=$((nq + 1))
  eval "qh$nq=\$1 qt$nq=\$2 qm$nq=\$3 qa$nq= qy$nq="
  shift 3
  k=0
  while [ $# -ge 2 ]; do
    k=$((k + 1))
    eval "qo${nq}_$k=\$1 qd${nq}_$k=\$2 qc${nq}_$k=0"
    shift 2
  done
  eval "qn$nq=$k qc${nq}_$((k + 1))=0"
}
pick() { # the list of models, drawn at once as Claude Code draws it (within 50 ms of the Enter), steered by keys; what it ended with in $said
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
  # what the list ended with, for the fixture to show
  printf '%s\n' "$said" >> "$HOME/.models"
}
# `fake-agent.sh models`: only the list of models (the fixture's background session opens it so)
[ "${1:-}" != models ] || { pick; exit 0; }
v() { eval "printf '%s' \"\$$1\""; } # the value of the variable named $1
answered() { # is question $1 answered (a pick, or a box ticked)
  [ -n "$(v "qa$1")" ] && return 0
  [ "$(v "qm$1")" = 1 ] || return 1
  ai=1
  while [ "$ai" -le $(($(v "qn$1") + 1)) ]; do
    [ "$(v "qc$1_$ai")" = 1 ] && return 0
    ai=$((ai + 1))
  done
  return 1
}
tabs() {
  if [ "$nq" -gt 1 ] || [ "$qm1" = 1 ]; then
    printf '←  '
    ti=1
    while [ "$ti" -le "$nq" ]; do
      if answered "$ti"; then printf '☒ %s  ' "$(v "qh$ti")"; else printf '☐ %s  ' "$(v "qh$ti")"; fi
      ti=$((ti + 1))
    done
    printf '✔ Submit  →\n'
  else
    printf ' ☐ %s\n' "$qh1"
  fi
}
draw() { # the question $j with the ❯ on row $c
  cnt=$(v "qn$j")
  m=$(v "qm$j")
  printf '\033[2J\033[H%s\n' "$rule"
  tabs
  printf '\n%s\n\n' "$(v "qt$j")"
  k=1
  while [ "$k" -le $((cnt + 1)) ]; do
    if [ "$k" = "$c" ]; then mark='❯'; else mark=' '; fi
    if [ "$k" -le "$cnt" ]; then label=$(v "qo${j}_$k"); else label=$(v "qy$j"); fi
    [ -n "$label" ] || { label='Type something'; [ "$m" = 1 ] || label='Type something.'; }
    if [ "$m" = 1 ]; then
      if [ "$(v "qc${j}_$k")" = 1 ]; then tick='[✔]'; else tick='[ ]'; fi
      printf '%s %s. %s %s\n' "$mark" "$k" "$tick" "$label"
      [ "$k" -gt "$cnt" ] || printf '         %s\n' "$(v "qd${j}_$k")"
    else
      printf '%s %s. %s\n' "$mark" "$k" "$label"
      [ "$k" -gt "$cnt" ] || printf '     %s\n' "$(v "qd${j}_$k")"
    fi
    k=$((k + 1))
  done
  if [ "$m" = 1 ]; then
    if [ "$c" = $((cnt + 2)) ]; then printf '❯    Submit\n'; else printf '     Submit\n'; fi
  fi
  printf '%s\n  %s. Chat about this\n\n' "$rule" $((cnt + 2))
  if [ "$nq" -gt 1 ]; then printf 'Enter to select · Tab/Arrow keys to navigate ·\nEsc to cancel\n'; else printf 'Enter to select · ↑/↓ to navigate · Esc to\ncancel\n'; fi
}
review() { # the set's answers, with the ❯ on row $c
  printf '\033[2J\033[H%s\n' "$rule"
  tabs
  printf '\nReview your answers\n\n'
  all=1
  ri=1
  while [ "$ri" -le "$nq" ]; do answered "$ri" || all=0; ri=$((ri + 1)); done
  [ "$all" = 1 ] || printf '⚠ Some questions are unanswered\n\n'
  ri=1
  while [ "$ri" -le "$nq" ]; do
    [ -z "$(v "qa$ri")" ] || printf ' ● %s\n   → %s\n' "$(v "qt$ri")" "$(v "qa$ri")"
    ri=$((ri + 1))
  done
  if [ "$c" = 1 ]; then printf '\n❯ 1. Submit answers\n  2. Cancel\n'; else printf '\n  1. Submit answers\n❯ 2. Cancel\n'; fi
}
rawkey() { # one key in raw mode: an arrow comes back as up, down, left or right, Esc alone as esc
  picked=$(dd bs=1 count=1 2> /dev/null)
  [ "$picked" = "$(printf '\033')" ] || return 0
  stty min 0 time 2
  a=$(dd bs=1 count=1 2> /dev/null)
  b=$(dd bs=1 count=1 2> /dev/null)
  stty min 1 time 0
  case "$a$b" in '[A') picked=up ;; '[B') picked=down ;; '[C') picked=right ;; '[D') picked=left ;; *) picked=esc ;; esac
}
ticked() { # the answer of the boxes of question $1, as Claude Code writes it
  out=
  xi=1
  while [ "$xi" -le $(($(v "qn$1") + 1)) ]; do
    if [ "$(v "qc$1_$xi")" = 1 ]; then
      if [ "$xi" -le "$(v "qn$1")" ]; then w=$(v "qo$1_$xi"); else w=$(v "qy$1"); fi
      out="${out:+$out, }$w"
    fi
    xi=$((xi + 1))
  done
  printf '%s' "$out"
}
ask() {
  old=$(stty -g)
  stty -icanon -echo -icrnl min 1 time 0
  j=1
  c=1
  answers=
  plain=
  enter=$(printf '\r')
  while :; do
    if [ "$j" -gt "$nq" ]; then review; else draw; fi
    rawkey
    if [ "$j" -gt "$nq" ]; then
      case $picked in
        1) break ;;
        2 | esc) answers=; nq=0; stty "$old"; return ;;
        "$enter") [ "$c" = 1 ] && break; answers=; nq=0; stty "$old"; return ;;
        up) c=1 ;;
        down) c=2 ;;
        left) j=$nq; c=1 ;;
      esac
      continue
    fi
    cnt=$(v "qn$j")
    m=$(v "qm$j")
    free=$((cnt + 1))
    next=
    if [ "$c" = "$free" ] && [ ${#picked} = 1 ] && [ "$picked" != "$enter" ] && [ "$picked" != "$(printf '\025')" ] && [ "$picked" != "$(printf '\177')" ]; then
      # on the row to type into, every key is text, digits too; typing ticks its box
      eval "qy$j=\$qy$j\$picked"
      [ "$m" != 1 ] || eval "qc${j}_$free=1"
      continue
    fi
    case $picked in
      esc) answers=; nq=0; stty "$old"; return ;;
      up) [ "$c" -le 1 ] || c=$((c - 1)) ;;
      down) [ "$c" -ge $((cnt + 1 + m)) ] || c=$((c + 1)) ;;
      left) [ "$j" -le 1 ] || { j=$((j - 1)); c=1; } ;;
      right | "$(printf '\t')") [ "$nq" -le 1 ] && [ "$m" != 1 ] || { j=$((j + 1)); c=1; } ;;
      "$(printf '\025')") [ "$c" != "$free" ] || eval "qy$j=" ;;
      "$(printf '\177')") [ "$c" != "$free" ] || eval "qy$j=\${qy$j%?}" ;;
      [1-9])
        if [ "$m" = 1 ]; then
          # a number ticks its box and leaves the ❯ where it is
          [ "$picked" -gt "$free" ] || eval "qc${j}_$picked=\$((1 - qc${j}_$picked))"
        elif [ "$picked" -le "$cnt" ]; then
          eval "qa$j=\$qo${j}_$picked"
          next=1
        elif [ "$picked" = "$free" ]; then
          c=$free
        fi
        ;;
      "$enter")
        if [ "$m" = 1 ]; then
          if [ "$c" -le "$free" ]; then eval "qc${j}_$c=\$((1 - qc${j}_$c))"; else eval "qa$j=\$(ticked $j)"; next=1; fi
        elif [ "$c" -le "$cnt" ]; then
          eval "qa$j=\$qo${j}_$c"
          next=1
        elif [ -n "$(v "qy$j")" ]; then
          eval "qa$j=\$qy$j"
          next=1
        fi
        ;;
    esac
    if [ -n "$next" ]; then
      # one question that takes one answer is sent at once; a set goes on to the next, then the review
      [ "$nq" -gt 1 ] || [ "$m" = 1 ] || break
      j=$((j + 1))
      c=1
    fi
  done
  stty "$old"
  i=1
  while [ "$i" -le "$nq" ]; do
    answers="${answers:+$answers, }\\\"$(v "qt$i")\\\"=\\\"$(v "qa$i")\\\""
    plain="${plain:+$plain; }$(v "qa$i")"
    i=$((i + 1))
  done
  nq=0
}
asked() { # asked <id> <questions as JSON>: the tool call in the transcript, the question on the screen, then its answer and a reply
  line "{\"type\":\"assistant\",\"uuid\":\"a$n\",\"timestamp\":\"$(now)\",\"message\":{\"model\":\"claude-opus-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"$1\",\"name\":\"AskUserQuestion\",\"input\":{\"questions\":$2}}]}}"
  hook PermissionRequest
  ask
  printf '\033[2J\033[H'
  if [ -z "$answers" ]; then
    line "{\"type\":\"user\",\"uuid\":\"u$n\",\"timestamp\":\"$(now)\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"$1\",\"is_error\":true,\"content\":\"The user doesn't want to proceed with this tool use.\"}]}}"
    lastsaid='No answer, so I stopped.'
  else
    line "{\"type\":\"user\",\"uuid\":\"u$n\",\"timestamp\":\"$(now)\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"$1\",\"content\":\"Your questions have been answered: $answers. You can now continue with these answers in mind.\"}]}}"
    hook UserPromptSubmit
    lastsaid="Answers: $plain."
  fi
  say "$lastsaid"
  hook Stop
  printf '⏺ %s\n\n' "$lastsaid"
}
box() { printf '%s\n❯ \n%s\n  ⏸ manual mode on\n' "$rule" "$rule"; }
dashes='╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌'
permission() { # a command that needs a yes, asked as Claude Code 2.1.330 asks it
  id="b$n"
  line "{\"type\":\"assistant\",\"uuid\":\"a$n\",\"timestamp\":\"$(now)\",\"message\":{\"model\":\"claude-opus-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"$id\",\"name\":\"Bash\",\"input\":{\"command\":\"make plots\",\"description\":\"Make the plots\"}}]}}"
  hook PermissionRequest
  old=$(stty -g)
  stty -icanon -echo -icrnl min 1 time 0
  c=1
  yes=
  while :; do
    printf '\033[2J\033[H⏺ Bash(make plots)\n  ⎿  Waiting…\n\n%s\n Bash command\n Make the plots\n%s\n make plots\n%s\n Do you want to proceed?\n' "$rule" "$dashes" "$dashes"
    k=1
    for o in 'Yes' 'Yes, and always allow access to|~/work/ from this project' 'No'; do
      if [ "$k" = "$c" ]; then mark='❯'; else mark=' '; fi
      printf ' %s %s. %s\n' "$mark" "$k" "${o%%|*}"
      [ "${o#*|}" = "$o" ] || printf '      %s\n' "${o#*|}"
      k=$((k + 1))
    done
    printf '\n Esc to cancel · Tab to amend\n'
    rawkey
    case $picked in
      1 | 2) yes=1; break ;;
      3 | esc) break ;;
      up) [ "$c" -le 1 ] || c=$((c - 1)) ;;
      down) [ "$c" -ge 3 ] || c=$((c + 1)) ;;
      "$(printf '\r')") [ "$c" = 3 ] || yes=1; break ;;
    esac
  done
  stty "$old"
  printf '\033[2J\033[H'
  if [ -n "$yes" ]; then
    line "{\"type\":\"user\",\"uuid\":\"u$n\",\"timestamp\":\"$(now)\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"$id\",\"content\":\"3 plots written to plots/\"}]}}"
    hook UserPromptSubmit
    lastsaid='Ran make plots: three plots are in plots/.'
  else
    line "{\"type\":\"user\",\"uuid\":\"u$n\",\"timestamp\":\"$(now)\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"$id\",\"is_error\":true,\"content\":\"The user doesn't want to proceed with this tool use.\"}]}}"
    lastsaid='I did not run it.'
  fi
  say "$lastsaid"
  hook Stop
  printf '⏺ %s\n\n' "$lastsaid"
}
compact() { # /compact as Claude Code 2.1.330 shows it: a spinner, then the last reply drawn again above the box
  for s in 1 2 3; do
    printf '\033[2J\033[H⏺ %s\n\n❯ /compact\n✶ Compacting conversation… (%ss)\n  ⎿  Tip: Use ctrl+v to paste images from your clipboard\n\n' "$lastsaid" "$s"
    printf '%s\n❯ \n%s\n  ⏸ manual mode on · esc to interrupt\n' "$rule" "$rule"
    sleep 1
  done
  line "{\"type\":\"user\",\"uuid\":\"u$n\",\"timestamp\":\"$(now)\",\"message\":{\"content\":\"<command-name>/compact</command-name><command-args></command-args>\"}}"
  line "{\"type\":\"system\",\"uuid\":\"s$n\",\"timestamp\":\"$(now)\",\"subtype\":\"compact_boundary\",\"compactMetadata\":{\"preTokens\":41000,\"postTokens\":3000}}"
  printf '\033[2J\033[H✻ Conversation compacted (ctrl+o for the summary)\n\n⏺ %s\n\n❯ /compact\n  ⎿  Compacted (ctrl+o to see full summary)\n\n' "$lastsaid"
  box
}
lastsaid='The fit converged.'
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
  working)
    hook UserPromptSubmit
    # at work, a tool every few seconds as Claude Code's hooks tell them, until the walkthrough
    # says the turn is over: the file ~/.turn-over-<agent id>
    (
      n=1000
      k=0
      until [ -e "$HOME/.turn-over-$KUNA_AGENT_ID" ]; do
        k=$((k + 1))
        case $((k % 3)) in
          0) tool=Bash what='{"command":"python train.py --epochs 40 --samples new","description":"Train on the new samples"}' ;;
          1) tool=Read what="{\"file_path\":\"$PWD/config.yaml\"}" ;;
          2) tool=Edit what="{\"file_path\":\"$PWD/train.py\"}" ;;
        esac
        line "{\"type\":\"assistant\",\"uuid\":\"w$k\",\"timestamp\":\"$(now)\",\"message\":{\"model\":\"claude-opus-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"w$k\",\"name\":\"$tool\",\"input\":$what}]}}"
        printf '{"hook_event_name":"PreToolUse","tool_name":"%s","transcript_path":"%s"}' "$tool" "$t" | sh "$HOME/.kuna/bin/kuna" hook
        sleep 3
        line "{\"type\":\"user\",\"uuid\":\"r$k\",\"timestamp\":\"$(now)\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"w$k\",\"content\":\"ok\"}]}}"
      done
      rm -f "$HOME/.turn-over-$KUNA_AGENT_ID"
      say "The tagger is trained: AUC 0.94 on the new samples."
      hook Stop
    ) &
    ;;
  waiting)
    # two questions of its own at once, as Claude Code draws a set: one tab each, then the review
    question Curves 'Which curves should be compared?' 0 'All taggers' 'Every tagger trained so far, on one canvas' 'Only the new one' 'Against the baseline'
    question Scale 'Log scale on the background axis?' 0 Yes 'Rejection over four decades' No 'Linear, as in the note'
    asked q1 '[{"question":"Which curves should be compared?","header":"Curves","options":[{"label":"All taggers"},{"label":"Only the new one"}],"multiSelect":false},{"question":"Log scale on the background axis?","header":"Scale","options":[{"label":"Yes"},{"label":"No"}],"multiSelect":false}]'
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
    pick
    printf '\033[2J\033[H  ⎿  %s\n──────────────────────────────\n❯ \n──────────────────────────────\n' "$said"
    continue
  fi
  # what makes it ask (the phone's walkthrough types these), and /compact
  case $typed in
    'ask one' | 'ask many' | 'ask set' | 'run it')
      hook UserPromptSubmit
      line "{\"type\":\"user\",\"uuid\":\"u$n\",\"timestamp\":\"$(now)\",\"message\":{\"content\":\"$typed\"}}"
      case $typed in
        'ask one')
          question Colour 'Which colour do you prefer?' 0 Red Warm Green Calm Blue Cool
          asked "q$n" '[{"question":"Which colour do you prefer?","header":"Colour","options":[{"label":"Red","description":"Warm"},{"label":"Green","description":"Calm"},{"label":"Blue","description":"Cool"}],"multiSelect":false}]'
          ;;
        'ask many')
          question Fruits 'Which fruits do you want?' 1 Apple Crisp Banana Soft Cherry Small
          asked "q$n" '[{"question":"Which fruits do you want?","header":"Fruits","options":[{"label":"Apple","description":"Crisp"},{"label":"Banana","description":"Soft"},{"label":"Cherry","description":"Small"}],"multiSelect":true}]'
          ;;
        'ask set')
          question Size 'Which size?' 0 Small 'For one' Large 'To share'
          question Toppings 'Which toppings?' 1 Cheese Melted Olives Black
          asked "q$n" '[{"question":"Which size?","header":"Size","options":[{"label":"Small","description":"For one"},{"label":"Large","description":"To share"}],"multiSelect":false},{"question":"Which toppings?","header":"Toppings","options":[{"label":"Cheese","description":"Melted"},{"label":"Olives","description":"Black"}],"multiSelect":true}]'
          ;;
        'run it') permission ;;
      esac
      box
      continue
      ;;
    /compact) compact; continue ;;
  esac
  hook UserPromptSubmit
  esc=$(printf '%s' "$typed" | sed 's/\\/\\\\/g; s/"/\\"/g')
  line "{\"type\":\"user\",\"uuid\":\"u$n\",\"timestamp\":\"$(now)\",\"message\":{\"content\":\"$esc\"}}"
  sleep 1
  say "You said: $esc"
  lastsaid="You said: $typed"
  hook Stop
  printf '⏺ %s\n\n──────────────────────────────\n❯ \n──────────────────────────────\n' "$lastsaid"
done

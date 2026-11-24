#!/bin/sh
# A stand-in for `claude` in the simulator fixture (scripts/ios-sim.sh), for its one Claude Code
# background session. `claude attach <id>` draws as the real one does: on the alternate screen,
# with the mouse, its lines scrolled by the wheel and by nothing else, and its input box under
# them, where `/model` opens the fake agent's list of models. The first line shown is kept in
# ~/.wheel, for the fixture to check that a drag on the phone arrived as the wheel.
# `claude stop` and `claude rm` are noted in ~/.claude-calls; rm takes the session off the list
case "${1:-}" in
  stop | rm)
    printf '%s %s\n' "$1" "$2" >> "$HOME/.claude-calls"
    [ "$1" = stop ] || rm -rf "$HOME/.claude/jobs/$2"
    exit 0
    ;;
esac
[ "${1:-}" = attach ] || exit 0
# it starts as slowly as `claude attach` on a busy login node: the app shows what it knows meanwhile
sleep 3
top=200
typed=
old=$(stty -g)
trap 'stty "$old"; printf "\033[?1000l\033[?1006l\033[?1049l"' EXIT
stty raw -echo min 1 time 0
printf '\033[?1049h\033[?1000h\033[?1006h'
while :; do
  printf '\033[H\033[2J\033[1mA background session\033[0m: drag to scroll\r\n\r\n'
  i=0
  while [ "$i" -lt 20 ]; do
    printf '  line %d of its conversation\r\n' $((top + i))
    i=$((i + 1))
  done
  printf '──────────────────────────────\r\n❯ %s\r\n──────────────────────────────\r\n' "$typed"
  printf '%s' "$top" > "$HOME/.wheel"
  got=$(dd bs=256 count=1 2> /dev/null)
  [ -n "$got" ] || exit 0
  case $got in
    *"$(printf '\033')"*)
      # every wheel notch in what came: ESC [ < 64 ; column ; row M is up, 65 down
      while :; do
        case $got in
          *'[<64;'*) top=$((top - 1)); got=${got#*'[<64;'} ;;
          *'[<65;'*) top=$((top + 1)); got=${got#*'[<65;'} ;;
          *) break ;;
        esac
      done
      ;;
    *)
      # typed: Ctrl+U empties the box, Enter runs what is in it
      case $got in *"$(printf '\025')"*) typed= ;; esac
      typed=$typed$(printf '%s' "${got##*"$(printf '\025')"}" | tr -d '\000-\037\177')
      case $got in
        *"$(printf '\r')"*)
          if [ "$typed" = /model ]; then
            stty "$old"
            sh "$HOME/fake-agent.sh" models
            stty raw -echo min 1 time 0
          fi
          typed=
          ;;
      esac
      ;;
  esac
done

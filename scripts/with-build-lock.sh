#!/bin/bash
# Run a heavy command (cargo build/test, vitest, vite build, e2e) behind a shared
# build lock: at most three of them at once on this laptop.
#
#   scripts/with-build-lock.sh <command...>
#   scripts/with-build-lock.sh --self-test
#
# macOS has no flock(1), so each slot is a directory created with mkdir (atomic):
# .scratch/slots/slot1 .. slot3, holding a `pid` file with the wrapper's pid.
# The wrapper waits for a free slot, prints which one it took, runs the command
# under `nice -n 10`, forwards INT/TERM/HUP to it and always releases the slot on
# exit. A slot whose owner pid is dead (wrapper killed with SIGKILL) is stale and
# is reclaimed by the next waiter; reclaiming is a rename, so only one waiter wins.
#
# Environment (tests and tuning): INTELY_LOCK_DIR (slots directory),
# INTELY_LOCK_SLOTS (default 3), INTELY_LOCK_POLL (seconds between polls, default 3).
# This script never runs git, never touches a network and never starts a server.

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SLOTS_DIR="${INTELY_LOCK_DIR:-$ROOT/.scratch/slots}"
SLOT_COUNT="${INTELY_LOCK_SLOTS:-3}"
POLL="${INTELY_LOCK_POLL:-3}"

log() { printf 'with-build-lock: %s\n' "$*" >&2; }

# Echo the slot number taken, return 1 when every slot is busy.
try_acquire() {
  local n slot owner reclaimed
  n=1
  while [ "$n" -le "$SLOT_COUNT" ]; do
    slot="$SLOTS_DIR/slot$n"
    if mkdir "$slot" 2>/dev/null; then
      echo "$$" > "$slot/pid"
      echo "$n"
      return 0
    fi
    owner="$(cat "$slot/pid" 2>/dev/null || true)"
    if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
      # Owner is dead: take the slot away atomically, then retry this number once.
      reclaimed="$slot.stale.$$"
      if mv "$slot" "$reclaimed" 2>/dev/null; then
        rm -rf "$reclaimed"
        log "removed stale slot $n (owner pid $owner is gone)"
        continue
      fi
    elif [ -z "$owner" ]; then
      # Between mkdir and the pid write, or a crashed creator: stale after 10 s.
      local age
      age=$(( $(date +%s) - $(stat -f %m "$slot" 2>/dev/null || echo 0) ))
      if [ "$age" -gt 10 ]; then
        reclaimed="$slot.stale.$$"
        if mv "$slot" "$reclaimed" 2>/dev/null; then
          rm -rf "$reclaimed"
          log "removed stale slot $n (no owner pid, ${age}s old)"
          continue
        fi
      fi
    fi
    n=$((n + 1))
  done
  return 1
}

HELD_SLOT=""
CHILD=""

release() {
  if [ -n "$HELD_SLOT" ]; then
    local slot="$SLOTS_DIR/slot$HELD_SLOT"
    # Only remove what is ours (the pid file still names this wrapper).
    if [ "$(cat "$slot/pid" 2>/dev/null || true)" = "$$" ]; then
      rm -rf "$slot"
    fi
    HELD_SLOT=""
  fi
}

forward() {
  if [ -n "$CHILD" ]; then
    kill -"$1" "$CHILD" 2>/dev/null || true
  fi
}

run_locked() {
  mkdir -p "$SLOTS_DIR"
  trap release EXIT
  trap 'forward TERM' TERM
  trap 'forward TERM' INT # a background child ignores SIGINT in a non-interactive shell
  trap 'forward HUP' HUP

  local got waited
  waited=0
  while true; do
    if got="$(try_acquire)"; then
      HELD_SLOT="$got"
      break
    fi
    if [ "$waited" -eq 0 ]; then
      log "all $SLOT_COUNT slots busy, waiting"
      waited=1
    fi
    sleep "$POLL"
  done
  log "took slot $HELD_SLOT of $SLOT_COUNT (pid $$)"

  nice -n 10 "$@" &
  CHILD=$!
  local rc
  wait "$CHILD"
  rc=$?
  # A forwarded signal interrupts `wait`; wait again for the real exit status.
  while kill -0 "$CHILD" 2>/dev/null; do
    wait "$CHILD"
    rc=$?
  done
  CHILD=""
  exit "$rc"
}

self_test() {
  local self tmp fails
  self="$ROOT/scripts/with-build-lock.sh"
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/lock-selftest.XXXXXX")" || exit 2
  fails=0
  ok() { printf '  ok   %s\n' "$1"; }
  bad() { printf '  FAIL %s\n' "$1"; fails=$((fails + 1)); }
  local run="env INTELY_LOCK_DIR=$tmp/slots INTELY_LOCK_POLL=1 $self"

  # 1: runs the command, prints the slot, propagates the exit code.
  local out rc
  out="$($run sh -c 'exit 7' 2>&1)"; rc=$?
  [ "$rc" -eq 7 ] && ok "exit code propagated" || bad "exit code propagated (got $rc)"
  case "$out" in *"took slot 1 of 3"*) ok "prints the slot it took";; *) bad "prints the slot it took: $out";; esac
  [ ! -e "$tmp/slots/slot1" ] && ok "slot released after the command" || bad "slot released after the command"

  # 2: niceness is raised by 10 (capped at 20).
  local base inner want
  base="$(ps -o nice= -p $$ | tr -d ' ')"
  inner="$($run sh -c 'ps -o nice= -p $$' 2>/dev/null | tr -d ' ')"
  want=$((base + 10)); [ "$want" -gt 20 ] && want=20
  [ "$inner" = "$want" ] && ok "runs under nice -n 10 ($base -> $inner)" || bad "nice (base $base, inner $inner, want $want)"

  # 3: three holders take three distinct slots and a fourth waits for a release.
  local d="$tmp/slots" p1 p2 p3 p4 n
  $run sleep 6 >/dev/null 2>&1 & p1=$!
  sleep 0.4
  $run sleep 6 >/dev/null 2>&1 & p2=$!
  sleep 0.4
  $run sleep 6 >/dev/null 2>&1 & p3=$!
  sleep 0.8
  n="$(ls "$d" | grep -c '^slot[0-9]$')"
  [ "$n" -eq 3 ] && ok "three concurrent holders use three slots" || bad "three slots expected, saw $n"
  ( $run sh -c 'date +%s' > "$tmp/fourth.out" 2>"$tmp/fourth.err" ) & p4=$!
  sleep 1.5
  [ ! -s "$tmp/fourth.out" ] && ok "fourth caller waits while all slots are busy" || bad "fourth caller did not wait"
  kill -TERM "$p1" 2>/dev/null
  wait "$p1" 2>/dev/null
  local i=0
  while [ ! -s "$tmp/fourth.out" ] && [ "$i" -lt 20 ]; do sleep 0.5; i=$((i + 1)); done
  [ -s "$tmp/fourth.out" ] && ok "fourth caller proceeds after a slot is freed (SIGTERM releases)" || bad "fourth caller never ran"
  kill -TERM "$p2" "$p3" 2>/dev/null
  wait "$p2" "$p3" "$p4" 2>/dev/null
  n="$(ls "$d" 2>/dev/null | grep -c '^slot[0-9]$')"
  [ "$n" -eq 0 ] && ok "all slots released at the end" || bad "slots left behind: $n"

  # 4: stale slot (dead owner pid) is reclaimed, a live foreign slot is not.
  mkdir -p "$d/slot1" "$d/slot2" "$d/slot3"
  sh -c 'exit 0' & local dead=$!; wait "$dead" 2>/dev/null
  echo "$dead" > "$d/slot1/pid"
  echo "$$" > "$d/slot2/pid"
  echo "$$" > "$d/slot3/pid"
  out="$($run sh -c 'echo ran' 2>&1)"
  case "$out" in *"removed stale slot 1"*"took slot 1 of 3"*) ok "stale slot (dead pid) reclaimed";; *) bad "stale slot not reclaimed: $out";; esac
  [ -d "$d/slot2" ] && [ -d "$d/slot3" ] && ok "live foreign slots left alone" || bad "live foreign slot removed"
  rm -rf "$d"

  # 5: the command is killed with the wrapper's SIGTERM and the slot is freed.
  $run sleep 30 >/dev/null 2>&1 & p1=$!
  sleep 0.8
  local child_pid
  child_pid="$(pgrep -P "$p1" 2>/dev/null | head -1)"
  kill -TERM "$p1" 2>/dev/null
  wait "$p1" 2>/dev/null
  sleep 0.3
  if [ -n "$child_pid" ] && kill -0 "$child_pid" 2>/dev/null; then
    bad "SIGTERM did not stop the command"
    kill -9 "$child_pid" 2>/dev/null
  else
    ok "SIGTERM stops the command"
  fi
  [ ! -e "$d/slot1" ] && ok "slot freed after SIGTERM" || bad "slot not freed after SIGTERM"

  rm -rf "$tmp"
  if [ "$fails" -eq 0 ]; then
    echo "self-test: all passed"
    exit 0
  fi
  echo "self-test: $fails failed"
  exit 1
}

case "${1:-}" in
  --self-test) self_test ;;
  ""|-h|--help)
    echo "usage: scripts/with-build-lock.sh <command...> | --self-test" >&2
    [ -z "${1:-}" ] && exit 2 || exit 0
    ;;
  *) run_locked "$@" ;;
esac

#!/bin/bash
# Sourced by the signing wrappers. run_scrubbed <command...> runs the command with an environment
# that holds ONLY PATH, HOME and the signing variables. The values never appear on a
# command line (so not in `ps`): everything else is unset inside a subshell and the command is
# exec'd from there, instead of `env -i VAR=value cmd`.

run_scrubbed() {
  (
    local v
    for v in $(compgen -e); do
      case "$v" in
        PATH|HOME|TAURI_SIGNING_PRIVATE_KEY|TAURI_SIGNING_PRIVATE_KEY_PASSWORD) ;;
        *) unset "$v" 2>/dev/null || true ;;
      esac
    done
    exec "$@"
  )
}

# need_var NAME: true when the variable is set and non-empty (the value is never echoed).
need_var() {
  [ -n "${!1:-}" ]
}

#!/usr/bin/env bash
# Fake scripts/with-build-lock.sh for gate.test.sh: records the wrapped command line, then runs it.
printf 'lock %s\n' "$*" >>"${FAKE_LOCK_LOG:?FAKE_LOCK_LOG is not set}"
exec "$@"

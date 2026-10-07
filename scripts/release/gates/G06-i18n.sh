#!/usr/bin/env bash
# G06 i18n ((design notes: release-ci-spec) 4.2): all 53 languages in the release profiles, en and hu otherwise.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

if [ "$GATE_STRICT" = "1" ]; then
  step "i18n:check (all languages)" pnpm i18n:check
else
  step "i18n-check en,hu" node scripts/i18n-check.mjs --lang=en,hu
fi
finish

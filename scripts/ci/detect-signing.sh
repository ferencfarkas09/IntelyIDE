#!/usr/bin/env bash
# Decide the signing mode of the release `sign` job from what is present ((design notes: release-ci-spec) 5.4 item 3).
#
# Inputs (environment, set by the workflow from expressions such as `secrets.X != ''`, so they hold the
# words true or false and never a secret value):
#   HAVE_CERT HAVE_CERT_PASSWORD HAVE_API_KEY HAVE_API_ISSUER HAVE_API_KEY_P8 HAVE_IDENTITY
#   REQUIRE_SIGNED   repository variable; the word true makes a final tag without credentials a failure
#   REF_NAME         tag or branch name (github.ref_name); REF_TYPE (github.ref_type) is optional
#
# Result: `mode=adhoc` (nothing present) or `mode=developer-id` (everything present), on $GITHUB_OUTPUT
# when set and on stdout. Some but not all present is a failure that names the missing NAMES only, so a
# typo or a rotation cannot silently downgrade a release. Exit 0 ok, 1 refused, 2 bad input.
set -euo pipefail
set +x

die() { echo "detect-signing: $*" >&2; exit "${2:-1}"; }

# pairs "FLAG_VARIABLE:name shown to the owner"
PAIRS="HAVE_CERT:APPLE_CERTIFICATE
HAVE_CERT_PASSWORD:APPLE_CERTIFICATE_PASSWORD
HAVE_API_KEY:APPLE_API_KEY
HAVE_API_ISSUER:APPLE_API_ISSUER
HAVE_API_KEY_P8:APPLE_API_KEY_P8
HAVE_IDENTITY:APPLE_SIGNING_IDENTITY (repository or environment variable)"

present=0
total=0
missing=""
while IFS= read -r pair; do
  var="${pair%%:*}"
  label="${pair#*:}"
  value="${!var:-}"
  total=$((total + 1))
  case "$value" in
    true) present=$((present + 1)) ;;
    false | "") missing="${missing:+$missing, }$label" ;;
    *) die "$var must be true, false or empty" 2 ;;
  esac
done <<EOF
$PAIRS
EOF

# A final tag is v<major>.<minor>.<patch> (no -rc suffix) on a tag ref.
is_final_tag=0
ref_name="${REF_NAME:-}"
ref_type="${REF_TYPE:-tag}"
if [ "$ref_type" = "tag" ]; then
  case "$ref_name" in
    v[0-9]*.[0-9]*.[0-9]*)
      if printf '%s' "$ref_name" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; then is_final_tag=1; fi
      ;;
  esac
fi

require_signed="${REQUIRE_SIGNED:-}"
case "$require_signed" in
  true | false | "") ;;
  *) die "REQUIRE_SIGNED must be true, false or empty" 2 ;;
esac

if [ "$present" -eq "$total" ]; then
  mode="developer-id"
elif [ "$present" -eq 0 ]; then
  if [ "$require_signed" = "true" ] && [ "$is_final_tag" -eq 1 ]; then
    die "REQUIRE_SIGNED=true but no signing credentials are present on a final tag; missing: $missing"
  fi
  mode="adhoc"
else
  die "partial signing configuration, refusing to downgrade silently; missing: $missing"
fi

echo "detect-signing: mode=$mode"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  printf 'mode=%s\n' "$mode" >> "$GITHUB_OUTPUT"
else
  printf 'mode=%s\n' "$mode"
fi
if [ "$mode" = "adhoc" ] && [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf '%s\n' "AD-HOC: no Apple signing credentials are configured, Gatekeeper will block the first launch." >> "$GITHUB_STEP_SUMMARY"
fi
exit 0

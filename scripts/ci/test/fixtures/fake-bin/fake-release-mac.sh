#!/bin/bash
# Stand-in for scripts/release-mac.sh in the run-sign tests: records its arguments and the NAMES of the
# APPLE_* variables it can see (never values) in $FAKE_LOG, and whether xtrace leaked in.
traced=no
if [ "${SHELLOPTS:-}" != "${SHELLOPTS#*xtrace}" ]; then traced=yes; fi
{
  echo "release-mac args: $*"
  echo "release-mac apple-vars: $(env | grep '^APPLE_' | cut -d= -f1 | sort | tr '\n' ' ')"
  echo "release-mac shellopts-xtrace: $traced"
} >> "${FAKE_LOG:?}"
exit "${FAKE_RELEASE_MAC_RC:-0}"

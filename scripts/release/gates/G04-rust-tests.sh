#!/usr/bin/env bash
# G04 Rust tests ((design notes: release-ci-spec) 4.2): cargo test --workspace --locked, failed tests re-run once.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

heavy "cargo test" bash "$TOOLS/scripts/ci/cargo-test.sh"
# cargo-test.sh prints `FLAKY <test>` for a test that failed once and passed on the re-run.
flaky="$(grep '^FLAKY ' "$GATE_LOG" 2>/dev/null | sed 's/^FLAKY //' | tr '\n' ' ')"
[ -n "$flaky" ] && note "FLAKY (failed once, passed on re-run): $flaky"
finish

#!/usr/bin/env bash
ORCHESTRATOR="scripts/release-mac.sh"
args=(--arch "$ARCH" --ci --stage sign --require-style --out "$OUT_DIR")
args+=(--sign --require-notarized)
bash "$ORCHESTRATOR" "${args[@]}"

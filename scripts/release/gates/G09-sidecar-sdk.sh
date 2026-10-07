#!/usr/bin/env bash
# G09 SDK absent from the sidecar bundle ((design notes: release-ci-spec) 4.2): build the sidecar, then assert that no
# input of the bundle comes from the Claude Agent SDK or the claude CLI package.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

step "sidecar build" bash -c 'cd sidecar && node build.mjs'
step "bundle inputs have no SDK" node -e '
const fs = require("fs");
const m = JSON.parse(fs.readFileSync("sidecar/dist/meta.json", "utf8"));
const inputs = Object.keys(m.inputs || {});
if (inputs.length === 0) { console.error("sidecar/dist/meta.json lists no inputs"); process.exit(1); }
const bad = inputs.filter((k) => /claude-agent-sdk|claude-code/.test(k));
if (bad.length) { console.error("bundled SDK input(s): " + bad.slice(0, 5).join(", ")); process.exit(1); }
console.log("ok: " + inputs.length + " inputs, none from the SDK");
'
heavy "vitest no-bundled-sdk" pnpm --filter @intely/sidecar exec vitest run no-bundled-sdk
finish

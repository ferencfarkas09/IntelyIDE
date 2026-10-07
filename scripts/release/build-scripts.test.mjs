// SPDX-License-Identifier: GPL-3.0-or-later
// Structural tests of scripts/build-dev.sh and scripts/dev.sh (release spec task R23). Reads the scripts only;
// nothing is built or run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const code = (p) => read(p).split("\n").filter((l) => !/^\s*#/.test(l));

for (const s of ["scripts/build-dev.sh", "scripts/dev.sh"]) {
  test(`${s} passes bash -n`, () => {
    execFileSync("bash", ["-n", join(ROOT, s)]);
  });
  test(`${s}: every cargo build/run line carries --locked`, () => {
    for (const l of code(s).filter((x) => /\bcargo\s+(build|run)\b/.test(x))) {
      assert.match(l, /--locked\b/, l);
    }
  });
}

test("build-dev.sh builds the sidecar before cargo build", () => {
  const lines = code("scripts/build-dev.sh");
  const side = lines.findIndex((l) => /pnpm --filter @intely\/sidecar build\b/.test(l));
  const cargo = lines.findIndex((l) => /\bcargo\s+build\b/.test(l));
  assert.ok(side >= 0, "no sidecar build line");
  assert.ok(cargo >= 0, "no cargo build line");
  assert.ok(side < cargo, "sidecar build must precede cargo build");
});

test("build-dev.sh verifies sidecar/dist/index.js exists with a message", () => {
  const lines = code("scripts/build-dev.sh");
  const chk = lines.findIndex((l) => /sidecar\/dist\/index\.js/.test(l) && /(-f|-s|test|\[)/.test(l));
  const cargo = lines.findIndex((l) => /\bcargo\s+build\b/.test(l));
  assert.ok(chk >= 0, "no existence check");
  assert.ok(chk < cargo, "check must precede cargo build");
  assert.match(lines.slice(chk, chk + 3).join("\n"), />&2/);
});

test("dev.sh keeps the read-only banner and --no-build", () => {
  const t = read("scripts/dev.sh");
  assert.match(t, /READ-ONLY \(INTELY_READONLY=1\)/);
  assert.match(t, /--no-build\)\s*BUILD=0/);
});

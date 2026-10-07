// node --test scripts/ci/test/gate-failures.test.mjs
// gate-failures.sh prints the output of every failed gate step for the CI log; the lines come from a gate run that can
// belong to a pull request, so a line that would start a workflow command is broken.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../gate-failures.sh");
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Runs the script in a temp directory that holds one gate log with the given text. */
const run = (log) => {
  const dir = mkdtempSync(join(tmpdir(), "gate-failures-"));
  made.push(dir);
  mkdirSync(join(dir, ".scratch/gate/run1"), { recursive: true });
  writeFileSync(join(dir, ".scratch/gate/run1/G03.log"), log);
  return spawnSync("bash", [SCRIPT], { cwd: dir, encoding: "utf8" });
};

describe("gate-failures.sh", () => {
  it("prints the block of a failed step and nothing of the steps that passed", () => {
    const r = run(
      ["### step: vitest ui", "+ pnpm vitest", "ui ok", "### step: vitest sidecar", "+ pnpm vitest", "boom: cannot find module", "step 'vitest sidecar' exited with 1", "### step: later", "+ true", "later ok"].join("\n") + "\n",
    );
    assert.equal(r.status, 0);
    assert.match(r.stdout, /::group::\.scratch\/gate\/run1\/G03\.log: step 'vitest sidecar' exited with 1/);
    assert.match(r.stdout, /boom: cannot find module/);
    assert.match(r.stdout, /::endgroup::/);
    assert.doesNotMatch(r.stdout, /ui ok|later ok/);
  });

  it("shows a step that the gate marked FAILED without running it", () => {
    const r = run("### step: remote-web tests FAILED: dependencies are not installed\n");
    assert.match(r.stdout, /::group::.*remote-web tests FAILED: dependencies are not installed/);
  });

  it("shows a long block as the excerpts around its failure markers plus its last 60 lines", () => {
    const lines = ["### step: noisy"];
    for (let i = 1; i <= 400; i++) {
      lines.push(`line ${i}`);
      if (i === 100) lines.push("---- the_broken_test stdout ----", "thread 'the_broken_test' panicked at src/x.rs:1:1:", "assertion failed: left == right");
    }
    lines.push("step 'noisy' exited with 2");
    const out = run(lines.join("\n") + "\n").stdout;
    assert.match(out, /^---- the_broken_test stdout ----$/m);
    assert.match(out, /^assertion failed: left == right$/m);
    assert.match(out, /^\.\.\. the last 60 lines of the step:$/m);
    assert.match(out, /^line 400$/m);
    assert.doesNotMatch(out, /^line 250$/m);
  });

  it("shows a short block whole", () => {
    const lines = ["### step: small"];
    for (let i = 1; i <= 150; i++) lines.push(`line ${i}`);
    lines.push("step 'small' exited with 2");
    const out = run(lines.join("\n") + "\n").stdout;
    assert.match(out, /^line 1$/m);
    assert.match(out, /^line 150$/m);
    assert.doesNotMatch(out, /the last 60 lines/);
  });

  it("breaks a line that would start a workflow command", () => {
    const out = run("### step: x\n::error::injected\n  ##[error]legacy\n::stop-commands::tok\nstep 'x' exited with 1\n").stdout;
    assert.doesNotMatch(out, /^\s*::error::/m);
    assert.doesNotMatch(out, /^\s*##\[/m);
    assert.doesNotMatch(out, /^::stop-commands::/m);
    assert.match(out, /^: :error::injected$/m);
    assert.match(out, /^ {2}# #\[error\]legacy$/m);
  });

  it("says so when nothing failed, and exits 0 without any log", () => {
    assert.match(run("### step: fine\nall good\n").stdout, /no failed step found/);
    const dir = mkdtempSync(join(tmpdir(), "gate-failures-"));
    made.push(dir);
    const r = spawnSync("bash", [SCRIPT], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /no failed step found/);
  });
});

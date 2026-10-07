import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "notes.mjs");
const FIX = join(HERE, "fixtures", "notes");
const TEAM = "ABCDE12345";
const tmp = mkdtempSync(join(tmpdir(), "notes-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { PATH: process.env.PATH } });
const common = (extra = []) => ["--version", "0.1.0", "--repo", "Example/Repo", "--changelog", join(FIX, "CHANGELOG.md"), ...extra];
const adhoc = [join(FIX, "release-aarch64.json"), join(FIX, "release-x64.json")];
const render = (jsons, extra = []) => {
  const r = run(common(["--template", join(FIX, "template.md"), "--release-json", ...jsons, ...extra]));
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

describe("notes.mjs", () => {
  it("renders every placeholder of the fixture template", () => {
    const t = render(adhoc);
    assert.doesNotMatch(t, /\{\{/);
    assert.match(t, /^Fixture template\n\nFirst public alpha of the fixture project\./);
    assert.match(t, /\| Asset \| Architecture \| SHA-256 \|/);
    assert.match(t, /- Guarded push with typed confirmation\./);
    assert.match(t, /Not in this build:/);
    assert.match(t, /Corresponding source: the tag archive of this release/);
    assert.match(t, /signed update feed; the DMG above is the manual route\.\n$/);
  });

  it("extracts only the requested version section", () => {
    const t = render(adhoc);
    assert.doesNotMatch(t, /Older entry/);
    assert.doesNotMatch(t, /compare\/v0\.1\.0/);
  });

  it("is deterministic", () => {
    assert.equal(render(adhoc), render(adhoc));
  });

  it("includes the Gatekeeper block exactly for ad-hoc assets, and the Team ID line exactly for notarized ones", () => {
    const a = render(adhoc);
    assert.match(a, /Open Anyway/);
    assert.match(a, /right-click the app and choose Open/);
    assert.doesNotMatch(a, /Team ID|TeamIdentifier|spctl --assess/);
    assert.match(a, /ad-hoc signed, not notarized/);

    const n = render([join(FIX, "release-aarch64-notarized.json")], ["--team-id", TEAM]);
    assert.match(n, new RegExp(`TeamIdentifier line .* \\*\\*${TEAM}\\*\\*`));
    assert.match(n, /spctl --assess/);
    assert.doesNotMatch(n, /Open Anyway/);
    assert.match(n, /Developer ID signed and notarized/);

    const mixed = render([join(FIX, "release-aarch64-notarized.json"), join(FIX, "release-x64.json")], ["--team-id", TEAM]);
    assert.match(mixed, /Open Anyway/);
    assert.match(mixed, new RegExp(TEAM));
  });

  it("a notarized asset without --team-id is an input error", () => {
    const r = run(common(["--template", join(FIX, "template.md"), "--release-json", join(FIX, "release-aarch64-notarized.json")]));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--team-id/);
  });

  it("always has the verify block in the specified order", () => {
    for (const t of [render(adhoc), render([join(FIX, "release-aarch64-notarized.json")], ["--team-id", TEAM])]) {
      const at = ["shasum -a 256 --ignore-missing -c SHA256SUMS", "gh attestation verify", "--signer-workflow Example/Repo/.github/workflows/release.yml", "--source-ref refs/tags/v0.1.0"].map((s) => t.indexOf(s));
      assert.ok(at.every((i) => i >= 0), String(at));
      assert.deepEqual(at, [...at].sort((x, y) => x - y));
    }
    const n = render([join(FIX, "release-aarch64-notarized.json")], ["--team-id", TEAM]);
    assert.ok(n.indexOf("gh attestation verify") < n.indexOf("codesign -dv --verbose=4"));
    assert.ok(n.indexOf("codesign -dv --verbose=4") < n.indexOf("spctl --assess"));
  });

  it("lists what is not in the build", () => {
    const t = render(adhoc);
    for (const s of ["Claude Agent SDK", "`claude` command-line tool", "Git", "MongoDB AI-find", "Remote relay"]) assert.ok(t.includes(s), s);
  });

  it("never contains sudo, xattr or the Gatekeeper-disable command", () => {
    for (const t of [render(adhoc), render([join(FIX, "release-aarch64-notarized.json")], ["--team-id", TEAM])]) {
      assert.doesNotMatch(t, /sudo/);
      assert.doesNotMatch(t, /xattr/);
      assert.doesNotMatch(t, /spctl\s+--master-disable/);
      assert.match(t, /Never disable Gatekeeper system-wide|Open the app; macOS asks once/);
    }
  });

  it("uses the real template and footer files by default", () => {
    const r = run(common(["--release-json", ...adhoc]));
    assert.equal(r.status, 0, r.stderr);
    for (const h of ["## Install", "## Verify the download", "## What's changed", "## Known limitations", "## Upgrading", "## Safety and source"]) assert.ok(r.stdout.includes(h), h);
    assert.doesNotMatch(r.stdout, /\{\{/);
  });

  it("falls back to the built-in section order when the template is missing", () => {
    const r = run(common(["--template", join(tmp, "missing.md"), "--release-json", ...adhoc]));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /built-in section order/);
    assert.match(r.stdout, /Open Anyway/);
    assert.match(r.stdout, /signed update feed/);
  });

  it("fails on an unknown placeholder and on a placeholder that renders empty", () => {
    const bad = join(tmp, "bad.md");
    writeFileSync(bad, "{{SUMMARY}}\n{{NOPE}}\n");
    let r = run(common(["--template", bad, "--release-json", ...adhoc]));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown placeholder\(s\): NOPE/);
    const log = join(tmp, "CHANGELOG-bare.md");
    writeFileSync(log, "## [0.1.0] - 2026-10-04\n\n### Added\n- Only a list entry\n");
    writeFileSync(bad, "{{SUMMARY}} {{WHATS_CHANGED}}\n");
    r = run(["--version", "0.1.0", "--repo", "Example/Repo", "--changelog", log, "--template", bad, "--release-json", ...adhoc]);
    assert.equal(r.status, 0, r.stderr);
  });

  it("fails on an empty or missing changelog section", () => {
    let r = run(common(["--changelog", join(FIX, "CHANGELOG-empty.md"), "--release-json", ...adhoc]));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no entries/);
    const none = join(tmp, "CHANGELOG-none.md");
    writeFileSync(none, "## [Unreleased]\n\n## [0.0.9] - 2026-09-01\n\n- Older entry.\n");
    r = run(common(["--changelog", none, "--release-json", ...adhoc]));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no section/);
  });

  it("fails on a planted forbidden string and never prints its value", () => {
    const secret = "gh" + "p_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    const log = join(tmp, "CHANGELOG-planted.md");
    writeFileSync(log, `## [0.1.0] - 2026-10-04\n\nSummary line.\n\n- leaked ${secret}\n`);
    const r = run(["--version", "0.1.0", "--repo", "Example/Repo", "--changelog", log, "--release-json", ...adhoc]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /publish-scan rule github-token at line/);
    assert.ok(!r.stderr.includes(secret) && !r.stdout.includes(secret));
    assert.equal(r.stdout, "");
  });

  it("rejects bad asset names and bad usage", () => {
    const p = join(tmp, "badname.json");
    writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(adhoc[1], "utf8")), file: "IntelyIDE-x64.dmg" }));
    assert.equal(run(common(["--release-json", p])).status, 2);
    assert.equal(run(["--release-json", ...adhoc]).status, 2);
    assert.equal(run(common([])).status, 2);
  });

  it("--out writes the file atomically", () => {
    const out = join(tmp, "out", "notes.md");
    const r = run(common(["--release-json", ...adhoc, "--out", out]));
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(out, "utf8"), /^First public alpha/);
  });
});

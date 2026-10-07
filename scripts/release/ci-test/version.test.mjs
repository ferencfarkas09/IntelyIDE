// node --test scripts/release/ci-test/version.test.mjs
// RC1: bump-version.mjs, check-version.mjs, check-changelog.mjs on a fixture mini-workspace under the temp dir.
// The real tree is only touched by `bump-version.mjs --dry-run`, which writes nothing (hash-checked).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { normaliseTag } from "../lib/version.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../..");
const FIXTURE = join(HERE, "fixtures/version");
const BUMP = join(HERE, "../bump-version.mjs");
const CHECK = join(HERE, "../check-version.mjs");
const CHANGELOG = join(HERE, "../check-changelog.mjs");
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", SOURCE_DATE_EPOCH: "1790000000" };
const SET = ["package.json", "ui/package.json", "sidecar/package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "Cargo.lock"];
const hasCargo = spawnSync("cargo", ["--version"]).status === 0;

const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

function fresh() {
  const d = mkdtempSync(join(tmpdir(), "rc1-"));
  made.push(d);
  cpSync(FIXTURE, d, { recursive: true });
  return d;
}
const run = (script, args, extra = {}) => spawnSync("node", [script, ...args], { encoding: "utf8", env: ENV, ...extra });
const bump = (root, ...args) => run(BUMP, [...args, "--root", root, ...(hasCargo ? [] : ["--no-cargo-check"])]);
const check = (root, ...args) => run(CHECK, [...args, "--root", root]);
const read = (root, f) => readFileSync(join(root, f), "utf8");
const sha = (root, f) => createHash("sha256").update(readFileSync(join(root, f))).digest("hex");
const mutate = (root, f, fn) => writeFileSync(join(root, f), fn(read(root, f)));

describe("bump-version on the fixture workspace", () => {
  it("changes exactly the packaging 4.5 fields and nothing else, byte for byte", () => {
    const root = fresh();
    const before = Object.fromEntries([...SET, "pnpm-lock.yaml", "crates/core/Cargo.toml", "CHANGELOG.md"].map((f) => [f, read(root, f)]));
    assert.equal(check(root).status, 0, "fixture starts consistent");
    const r = bump(root, "0.1.0", "--date", "2026-10-05");
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const expected = {
      "package.json": before["package.json"].replace('"version": "0.0.0"', '"version": "0.1.0"'),
      "ui/package.json": before["ui/package.json"].replace('"version": "0.0.0"', '"version": "0.1.0"'),
      "sidecar/package.json": before["sidecar/package.json"].replace('"version":"0.0.0"', '"version":"0.1.0"'),
      "src-tauri/tauri.conf.json": before["src-tauri/tauri.conf.json"].replace('"version": "0.0.0"', '"version": "0.1.0"'),
      "src-tauri/Cargo.toml": before["src-tauri/Cargo.toml"].replace('name = "fixture-app"\nversion = "0.0.0"', 'name = "fixture-app"\nversion = "0.1.0"'),
      "Cargo.lock": before["Cargo.lock"].replace('name = "fixture-app"\nversion = "0.0.0"', 'name = "fixture-app"\nversion = "0.1.0"'),
    };
    for (const f of SET) {
      assert.notEqual(expected[f], before[f], `${f}: expectation is not a no-op`);
      assert.equal(read(root, f), expected[f], `${f} differs from the expected splice`);
    }
    // untouched: workspace-crate lock block (inside Cargo.lock, covered above), pnpm lock, crate manifest
    assert.equal(read(root, "pnpm-lock.yaml"), before["pnpm-lock.yaml"]);
    assert.equal(read(root, "crates/core/Cargo.toml"), before["crates/core/Cargo.toml"]);
    assert.match(read(root, "Cargo.lock"), /name = "fixture-core"\nversion = "0.0.0"/);
    assert.match(read(root, "src-tauri/tauri.conf.json"), /"plugins": \{ "x": \{ "version": "9.9.9" \} \}/);
    assert.match(read(root, "sidecar/package.json"), /"devDependencies":\{"version":"1.2.3"\}/);
    assert.match(read(root, "CHANGELOG.md"), /## \[Unreleased\]\n\n## \[0\.1\.0\] - 2026-10-05\n/);
    assert.equal(check(root).status, 0, "check-version passes after the bump");
    assert.equal(run(CHANGELOG, ["--release", "--root", root]).status, 0);
  });

  it("--dry-run writes nothing and lists the set", () => {
    const root = fresh();
    const hashes = SET.map((f) => sha(root, f)).concat(sha(root, "CHANGELOG.md"));
    const r = bump(root, "0.1.0", "--dry-run");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(SET.map((f) => sha(root, f)).concat(sha(root, "CHANGELOG.md")), hashes);
    for (const f of SET) assert.ok(r.stdout.includes(f), `${f} listed`);
  });

  it("--dry-run on the real tree writes nothing and lists exactly the six files", () => {
    const files = [...SET, "pnpm-lock.yaml", "CHANGELOG.md"].filter((f) => existsSync(join(REPO, f)));
    const before = files.map((f) => sha(REPO, f));
    const r = run(BUMP, ["0.1.0", "--dry-run", "--no-changelog", "--root", REPO]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(files.map((f) => sha(REPO, f)), before);
    const listed = r.stdout.split("\n").filter((l) => /^ {2}\S+:/.test(l)).map((l) => l.trim().split(":")[0]);
    assert.deepEqual(listed.sort(), [...SET].sort());
  });

  it("refuses invalid, pre-release, lower and equal versions with exit 2; --force-same overrides", () => {
    const root = fresh();
    for (const v of ["abc", "1.2", "0.1.0-alpha.1", "0.1.0+build", "00.1.0", "0.0.0"]) {
      const r = bump(root, v);
      assert.equal(r.status, 2, `${v}: ${r.stderr}`);
      assert.ok(r.stderr.length > 10, `${v}: has a message`);
    }
    assert.equal(bump(root).status, 2, "no version argument");
    assert.equal(bump(root, "0.2.0", "--no-changelog").status, 0);
    assert.equal(bump(root, "0.1.0").status, 2, "lower");
    assert.equal(bump(root, "0.2.0").status, 2, "equal");
    assert.equal(bump(root, "0.2.0", "--force-same", "--no-changelog").status, 0);
    assert.equal(bump(root, "0.3.0", "--date", "2026-13-40").status, 2, "bad date");
  });

  it("verifies Cargo.lock with cargo metadata", { skip: !hasCargo && "cargo not installed" }, () => {
    const root = fresh();
    mutate(root, "Cargo.lock", (t) => t.replace('name = "fixture-core"\nversion = "0.0.0"', 'name = "fixture-core"\nversion = "0.0.7"'));
    const r = run(BUMP, ["0.1.0", "--no-changelog", "--root", root]);
    assert.equal(r.status, 1, "a lock that no longer matches the manifests fails the post-condition");
    assert.match(r.stderr, /Cargo\.lock/);
  });
});

describe("check-version", () => {
  const mutations = {
    "package.json": ['"version": "0.0.0"', '"version": "0.0.1"', "package.json:version"],
    "ui/package.json": ['"version": "0.0.0"', '"version": "0.0.1"', "ui/package.json:version"],
    "sidecar/package.json": ['"version":"0.0.0"', '"version":"0.0.1"', "sidecar/package.json:version"],
    "src-tauri/tauri.conf.json": ['"version": "0.0.0"', '"version": "0.0.1"', "src-tauri/tauri.conf.json:version"],
    "src-tauri/Cargo.toml": ['name = "fixture-app"\nversion = "0.0.0"', 'name = "fixture-app"\nversion = "0.0.1"', "src-tauri/Cargo.toml:package.version"],
    "Cargo.lock": ['name = "fixture-app"\nversion = "0.0.0"', 'name = "fixture-app"\nversion = "0.0.1"', "Cargo.lock:package[fixture-app].version"],
  };
  for (const [file, [from, to, label]] of Object.entries(mutations)) {
    it(`a mismatch in ${file} exits 1 naming ${label}`, () => {
      const root = fresh();
      mutate(root, file, (t) => {
        assert.ok(t.includes(from));
        return t.replace(from, to);
      });
      const r = check(root);
      assert.equal(r.status, 1);
      assert.ok(r.stderr.includes(label), r.stderr);
    });
  }

  it("a missing file is named", () => {
    const root = fresh();
    rmSync(join(root, "ui/package.json"));
    const r = check(root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ui\/package\.json:version: file is missing/);
  });

  it("a pre-release version in tauri.conf.json (and in package.json) is refused", () => {
    const root = fresh();
    mutate(root, "src-tauri/tauri.conf.json", (t) => t.replace('"version": "0.0.0"', '"version": "0.0.0-alpha.1"'));
    const r = check(root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /src-tauri\/tauri\.conf\.json:version/);
    const root2 = fresh();
    for (const f of ["package.json", "ui/package.json"]) mutate(root2, f, (t) => t.replace('"version": "0.0.0"', '"version": "0.0.0-rc.1"'));
    assert.equal(check(root2).status, 1);
  });

  it("checks manual:nodejs.version against node-pin.json", () => {
    const root = fresh();
    mutate(root, "scripts/licenses/extra-components.json", (t) => t.replace('"manual:nodejs", "version": "24.13.0"', '"manual:nodejs", "version": "24.12.0"'));
    const r = check(root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /extra-components\.json:manual:nodejs\.version/);
  });

  it("a placeholder pin passes normally and fails --release; a missing pin only fails --release", () => {
    const root = fresh();
    writeFileSync(join(root, "scripts/release/node-pin.json"), '{ "schema": 1, "version": "<24.x.y>" }\n');
    assert.equal(check(root).status, 0);
    assert.equal(check(root, "--release").status, 1);
    rmSync(join(root, "scripts/release/node-pin.json"));
    assert.equal(check(root).status, 0);
    assert.equal(check(root, "--release").status, 1);
  });

  it("is hermetic about bump results: version 0.1.0 with rc and final tags", () => {
    const root = fresh();
    assert.equal(bump(root, "0.1.0", "--no-changelog").status, 0);
    for (const t of ["v0.1.0", "v0.1.0-rc.1", "v0.1.0-rc.12"]) assert.equal(check(root, "--tag", t).status, 0, t);
    for (const t of ["v0.1.0-rc.0", "v0.1.0-rc", "v0.1.0-beta.1", "v0.1.1", "0.1.0", "v0.1.0-rc.01", "v0.1.0-rc.1-x"]) {
      const r = check(root, "--tag", t);
      assert.equal(r.status, 1, t);
      assert.match(r.stderr, /--tag/);
    }
  });

  it("usage errors exit 2", () => {
    assert.equal(run(CHECK, ["--nope"]).status, 2);
    assert.equal(run(CHECK, ["--tag"]).status, 2);
  });

  it("passes on the real tree (consistent 0.0.0 or 0.1.0)", () => {
    const r = run(CHECK, ["--root", REPO]);
    assert.equal(r.status, 0, r.stderr);
  });
});

describe("tag normaliser", () => {
  it("accepts vX.Y.Z and vX.Y.Z-rc.N", () => {
    assert.equal(normaliseTag("v0.1.0"), "v0.1.0");
    assert.equal(normaliseTag("v0.1.0-rc.1"), "v0.1.0");
    assert.equal(normaliseTag("v10.20.30-rc.9"), "v10.20.30");
  });
  it("rejects everything else", () => {
    for (const t of ["v0.1.0-rc.0", "v0.1.0-rc", "v0.1.0-beta.1", "0.1.0", "v0.1", "v0.1.0-rc.1.2", "", "V0.1.0"]) {
      assert.throws(() => normaliseTag(t), t);
    }
  });
  it("CLI --normalise-tag", () => {
    const ok = run(CHECK, ["--normalise-tag", "v0.1.0-rc.3"]);
    assert.equal(ok.status, 0);
    assert.equal(ok.stdout.trim(), "v0.1.0");
    assert.equal(run(CHECK, ["--normalise-tag", "v0.1.0-rc.0"]).status, 1);
  });
});

describe("CHANGELOG handling", () => {
  const setChangelog = (root, text) => writeFileSync(join(root, "CHANGELOG.md"), text);

  it("renames [Unreleased] and inserts a fresh one", () => {
    const root = fresh();
    assert.equal(bump(root, "0.1.0", "--date", "2026-10-05").status, 0);
    const t = read(root, "CHANGELOG.md");
    assert.match(t, /^# Changelog\n\n## \[Unreleased\]\n\n## \[0\.1\.0\] - 2026-10-05\n\n- Added the first thing\./);
    assert.match(t, /## \[0\.0\.0\] - 2026-01-01/);
  });

  it("uses SOURCE_DATE_EPOCH when --date is absent", () => {
    const root = fresh();
    assert.equal(bump(root, "0.1.0").status, 0);
    assert.match(read(root, "CHANGELOG.md"), /## \[0\.1\.0\] - 2026-09-21\n/); // 1790000000
  });

  it("a seeded section only gets its placeholder date replaced", () => {
    const root = fresh();
    const seeded = "# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - YYYY-MM-DD\n\n- First public release.\n\n## [0.0.0] - 2026-01-01\n\n- x\n";
    setChangelog(root, seeded);
    assert.equal(bump(root, "0.1.0", "--date", "2026-10-05").status, 0);
    assert.equal(read(root, "CHANGELOG.md"), seeded.replace("YYYY-MM-DD", "2026-10-05"));
  });

  it("refuses an empty section and an empty [Unreleased], writing nothing", () => {
    const root = fresh();
    const empty = "# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - YYYY-MM-DD\n\nnothing here\n";
    setChangelog(root, empty);
    const before = SET.map((f) => sha(root, f));
    const r = bump(root, "0.1.0");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no entries/);
    assert.deepEqual(SET.map((f) => sha(root, f)), before, "no file changed");
    setChangelog(root, "# Changelog\n\n## [Unreleased]\n\n");
    assert.equal(bump(root, "0.1.0").status, 2);
  });

  it("updates compare links when the Unreleased link is a real compare URL", () => {
    const root = fresh();
    setChangelog(
      root,
      "## [Unreleased]\n\n- a\n\n## [0.0.0] - 2026-01-01\n\n- b\n\n[Unreleased]: https://example.test/r/compare/v0.0.0...HEAD\n[0.0.0]: https://example.test/r/releases/tag/v0.0.0\n"
    );
    assert.equal(bump(root, "0.1.0", "--date", "2026-10-05").status, 0);
    const t = read(root, "CHANGELOG.md");
    assert.match(t, /^\[Unreleased\]: https:\/\/example\.test\/r\/compare\/v0\.1\.0\.\.\.HEAD$/m);
    assert.match(t, /^\[0\.1\.0\]: https:\/\/example\.test\/r\/compare\/v0\.0\.0\.\.\.v0\.1\.0$/m);
    assert.equal(run(CHANGELOG, ["--release", "--root", root]).status, 0);
  });

  it("check-changelog: plain mode needs [Unreleased] first; --release needs a real dated section with entries", () => {
    const root = fresh();
    const cl = (...a) => run(CHANGELOG, [...a, "--root", root]);
    setChangelog(root, "# Changelog\n\n## [Unreleased]\n\n- x\n");
    assert.equal(cl().status, 0);
    assert.equal(cl("--release").status, 1, "no section for 0.0.0");
    setChangelog(root, "# Changelog\n\n## [0.0.0] - 2026-01-01\n\n- x\n");
    assert.equal(cl().status, 1, "Unreleased missing/first");
    setChangelog(root, "# Changelog\n\n## [Unreleased]\n\n## [0.0.0] - YYYY-MM-DD\n\n- x\n");
    assert.equal(cl().status, 0);
    assert.equal(cl("--release").status, 1, "placeholder date");
    setChangelog(root, "# Changelog\n\n## [Unreleased]\n\n## [0.0.0] - 2026-02-30\n\n- x\n");
    assert.equal(cl("--release").status, 1, "impossible date");
    setChangelog(root, "# Changelog\n\n## [Unreleased]\n\n## [0.0.0] - 2026-01-01\n\ntext only\n");
    assert.equal(cl("--release").status, 1, "no entries");
    setChangelog(root, "# Changelog\n\n## [Unreleased]\n\n## [0.0.0] - 2026-01-01\n\n- x\n");
    assert.equal(cl("--release").status, 0);
    setChangelog(root, "# Changelog\n\n## [Unreleased]\n\n## [0.0.0] - 2026-01-01\n\n- x\n\n[Unreleased]: https://example.test/r/compare/v0.0.0...HEAD\n");
    assert.equal(cl("--release").status, 1, "compare links in use but no link for the version");
    setChangelog(root, "# Changelog\n\n## [Unreleased]\n\n## [0.0.0] - 2026-01-01\n\n- x\n\n[Unreleased]: https://github.com/OWNER/REPO/compare/v0.0.0...HEAD\n");
    assert.equal(cl("--release").status, 0, "placeholder repository URL: links not checked");
    rmSync(join(root, "CHANGELOG.md"));
    assert.equal(cl().status, 1, "missing file");
  });
});

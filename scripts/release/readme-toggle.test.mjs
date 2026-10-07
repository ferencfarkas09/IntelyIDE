// node --test scripts/release/readme-toggle.test.mjs
// Everything runs on throwaway copies under the system temp dir; no network, no git.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { STATES, ToggleError, applyState, currentView, main, reveal, stateFromRelease, stateFromReleaseFiles, visibleBlocks, visibleVariants } from "./readme-toggle.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "readme-toggle.mjs");

const README = [
  "# IntelyIDE",
  "",
  "Intro paragraph with a trailing space. ",
  "",
  "## Install",
  "",
  "<!--dmg:available-->",
  "### macOS installer (DMG)",
  "1. Download the file for your Mac from the Releases page.",
  "5. First launch. <!--dmg:v:adhoc,developer-id-->This build is not notarized: choose Open Anyway.<!--/dmg:v--><!--dmg:v:notarized-->It opens normally.<!--/dmg:v-->",
  "6. <!--dmg:v:adhoc-->Ad-hoc builds get a new identity with every release.<!--/dmg:v-->",
  "<!--/dmg:available-->",
  "<!--dmg:pending-->",
  "### macOS installer",
  "A macOS installer (DMG) is built from this repository when it has been verified.",
  "<!--/dmg:pending-->",
  "",
  "## Requirements",
  "Tail text.",
  "",
].join("\n");

const made = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "rtoggle-"));
  made.push(d);
  return d;
}
function sink() {
  let s = "";
  return { write: (x) => void (s += x), get text() {
    return s;
  } };
}

// the README with the pending block active is what the first commit ships
const SHIPPED = applyState(README, "none");

describe("applyState", () => {
  it("shows the pending block for none and the available block otherwise", () => {
    assert.deepEqual(visibleBlocks(applyState(README, "none")), { available: false, pending: true });
    for (const s of ["adhoc", "developer-id", "notarized"]) {
      assert.deepEqual(visibleBlocks(applyState(README, s)), { available: true, pending: false }, s);
    }
  });

  it("is idempotent for every state", () => {
    for (const s of STATES) {
      const once = applyState(README, s);
      assert.equal(applyState(once, s), once, s);
    }
  });

  it("is reversible: every path through the states reveals the same canonical text", () => {
    const canonical = reveal(README);
    for (const a of STATES) {
      for (const b of STATES) {
        assert.equal(reveal(applyState(applyState(README, a), b)), canonical, `${a} -> ${b}`);
        assert.equal(reveal(applyState(applyState(README, a), b)), reveal(applyState(README, b)));
      }
    }
  });

  it("leaves everything outside the marker pairs byte-identical", () => {
    for (const s of STATES) {
      const out = applyState(README, s);
      assert.ok(out.startsWith(README.slice(0, README.indexOf("<!--dmg:available-->"))));
      assert.ok(out.endsWith(README.slice(README.indexOf("<!--/dmg:pending-->"))));
      const mid = (t) => t.slice(t.indexOf("<!--/dmg:available-->"), t.indexOf("<!--dmg:pending-->"));
      assert.equal(mid(out), "<!--/dmg:available-->\n");
    }
  });

  it("wraps the hidden block in one comment and keeps its text recoverable", () => {
    const hidden = applyState(README, "none");
    const block = hidden.slice(hidden.indexOf("<!--dmg:available-->"), hidden.indexOf("<!--/dmg:available-->"));
    assert.match(block, /^<!--dmg:available-->\n<!--\n/);
    assert.match(block, /\n-->\n$/);
    // no unescaped comment end inside the wrapped text
    const inner = block.split("\n").slice(2, -2).join("\n");
    assert.equal(inner.includes("-->"), false);
    assert.equal(inner.includes("<!--"), false);
    assert.ok(inner.includes("Open Anyway"));
  });

  it("picks the first-launch variant that matches the state", () => {
    const adhoc = applyState(README, "adhoc");
    assert.match(adhoc, /<!--dmg:v:adhoc,developer-id-->This build is not notarized/);
    assert.match(adhoc, /<!--dmg:v:notarized--><!--It opens normally\.--><!--\/dmg:v-->/);
    assert.match(adhoc, /<!--dmg:v:adhoc-->Ad-hoc builds/);
    const dev = applyState(README, "developer-id");
    assert.match(dev, /<!--dmg:v:adhoc,developer-id-->This build is not notarized/);
    assert.match(dev, /<!--dmg:v:adhoc--><!--Ad-hoc builds get a new identity with every release\.--><!--\/dmg:v-->/);
    const nota = applyState(README, "notarized");
    assert.match(nota, /<!--dmg:v:adhoc,developer-id--><!--This build is not notarized: choose Open Anyway\.--><!--\/dmg:v-->/);
    assert.match(nota, /<!--dmg:v:notarized-->It opens normally\.<!--\/dmg:v-->/);
    assert.deepEqual(
      visibleVariants(nota).map((v) => v.visible),
      [false, true, false],
    );
  });

  it("refuses unknown states and broken markers", () => {
    assert.throws(() => applyState(README, "on"), ToggleError);
    assert.throws(() => applyState(README, "signed"), ToggleError);
    assert.throws(() => applyState("# x\n", "none"), /exactly one/);
    assert.throws(() => applyState(README.replace("<!--/dmg:pending-->", ""), "none"), /exactly one/);
    assert.throws(() => applyState(README + "\n<!--dmg:pending-->\n<!--/dmg:pending-->\n", "none"), /exactly one/);
    assert.throws(() => applyState(README.replace("<!--dmg:v:notarized-->", "<!--dmg:v:bogus-->"), "adhoc"), /unknown state/);
  });

  it("refuses to hide text that already contains the escape sequences", () => {
    const tricky = README.replace("1. Download", "1. &lt;!-- Download");
    assert.throws(() => applyState(tricky, "none"), /escape sequence/);
  });

  it("describes the view of a README", () => {
    assert.equal(currentView(SHIPPED).visible, "pending");
    assert.equal(currentView(applyState(README, "adhoc")).visible, "available");
    assert.equal(currentView(README).visible, "both");
  });
});

describe("stateFromRelease", () => {
  const rel = (over = {}) => ({
    schema: 1,
    version: "0.1.0",
    arch: "aarch64",
    file: "IntelyIDE_0.1.0_aarch64.dmg",
    signed: false,
    notarized: false,
    stapled: false,
    pk: { release: true, fixture: false },
    ...over,
  });

  it("maps signed, notarized and stapled to the four states", () => {
    assert.equal(stateFromRelease(rel()), "adhoc");
    assert.equal(stateFromRelease(rel({ signed: true })), "developer-id");
    assert.equal(stateFromRelease(rel({ signed: true, notarized: true })), "developer-id", "not stapled: no promise of a plain first launch");
    assert.equal(stateFromRelease(rel({ signed: true, notarized: true, stapled: true })), "notarized");
    assert.ok(STATES.includes("none"), "none is never derived from a release file");
  });

  it("rejects malformed files", () => {
    const bad = [
      [null, /not a JSON object/],
      [[], /not a JSON object/],
      [rel({ schema: 2 }), /schema/],
      [rel({ signed: "yes" }), /"signed" must be a boolean/],
      [rel({ notarized: 1 }), /"notarized"/],
      [rel({ stapled: undefined }), /"stapled"/],
      [rel({ version: "one" }), /version/],
      [rel({ arch: "arm64" }), /arch/],
      [rel({ file: "IntelyIDE_0.1.0_aarch64-LOCAL.dmg" }), /file/],
      [rel({ file: "evil.dmg" }), /file/],
      [rel({ file: "IntelyIDE_0.1.0_x64.dmg" }), /disagree/],
      [rel({ notarized: true }), /notarized but not signed/],
      [rel({ signed: true, stapled: true }), /stapled but not notarized/],
      [rel({ pk: { release: false } }), /not made with --release/],
      [rel({ pk: { fixture: true } }), /fixture/],
    ];
    for (const [json, re] of bad) assert.throws(() => stateFromRelease(json), re, JSON.stringify(json)?.slice(0, 60));
  });

  it("combines per-arch files: same version, the weakest state wins", () => {
    const a = rel({ signed: true, notarized: true, stapled: true });
    const x = rel({ arch: "x64", file: "IntelyIDE_0.1.0_x64.dmg" });
    assert.equal(stateFromReleaseFiles([{ label: "a", json: a }]), "notarized");
    assert.equal(stateFromReleaseFiles([{ label: "a", json: a }, { label: "x", json: x }]), "adhoc");
    assert.throws(() => stateFromReleaseFiles([{ label: "a", json: a }, { label: "a2", json: a }]), /given twice/);
    assert.throws(
      () => stateFromReleaseFiles([{ label: "a", json: a }, { label: "x", json: { ...x, version: "0.2.0", file: "IntelyIDE_0.2.0_x64.dmg" } }]),
      /differs/,
    );
    assert.throws(() => stateFromReleaseFiles([]), /no release json/);
  });
});

describe("command line", () => {
  function project() {
    const root = tmp();
    mkdirSync(join(root, "scripts/release"), { recursive: true });
    writeFileSync(join(root, "README.md"), SHIPPED);
    writeFileSync(join(root, "scripts/release/readme-state.json"), '{ "dmg": "none" }\n');
    return root;
  }
  const run = (root, ...args) => spawnSync(process.execPath, [SCRIPT, "--root", root, ...args], { encoding: "utf8", env: { PATH: process.env.PATH } });
  const release = (root, name, json) => {
    writeFileSync(join(root, name), typeof json === "string" ? json : JSON.stringify(json));
    return name;
  };

  it("--dmg writes README and state file, and a second run changes nothing", () => {
    const root = project();
    let r = run(root, "--dmg", "adhoc");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /readme=changed state-file=changed/);
    assert.equal(readFileSync(join(root, "scripts/release/readme-state.json"), "utf8"), '{ "dmg": "adhoc" }\n');
    const once = readFileSync(join(root, "README.md"), "utf8");
    assert.deepEqual(visibleBlocks(once), { available: true, pending: false });
    r = run(root, "--dmg", "adhoc");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /readme=unchanged state-file=unchanged/);
    assert.equal(readFileSync(join(root, "README.md"), "utf8"), once);
    // back to none restores the shipped bytes exactly
    r = run(root, "--dmg", "none");
    assert.equal(r.status, 0);
    assert.equal(readFileSync(join(root, "README.md"), "utf8"), SHIPPED);
  });

  it("--check reports a pending change and writes nothing", () => {
    const root = project();
    const r = run(root, "--dmg", "notarized", "--check");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /PENDING/);
    assert.equal(readFileSync(join(root, "README.md"), "utf8"), SHIPPED);
    assert.equal(run(root, "--dmg", "none", "--check").status, 0);
  });

  it("--from-release-json maps the file and rejects bad input without touching anything", () => {
    const root = project();
    const good = release(root, "release-aarch64.json", {
      schema: 1, version: "0.1.0", arch: "aarch64", file: "IntelyIDE_0.1.0_aarch64.dmg", signed: false, notarized: false, stapled: false,
    });
    let r = run(root, "--from-release-json", good);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /state=adhoc/);
    const after = readFileSync(join(root, "README.md"), "utf8");
    const malformed = release(root, "bad.json", "{ not json");
    r = run(root, "--from-release-json", malformed);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not valid JSON/);
    const wrong = release(root, "wrong.json", { schema: 1, signed: true });
    r = run(root, "--from-release-json", wrong);
    assert.equal(r.status, 1);
    r = run(root, "--from-release-json", "missing.json");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cannot read/);
    assert.equal(readFileSync(join(root, "README.md"), "utf8"), after);
    assert.equal(readFileSync(join(root, "scripts/release/readme-state.json"), "utf8"), '{ "dmg": "adhoc" }\n');
  });

  it("usage errors exit 3; unknown or missing markers exit 1", () => {
    const root = project();
    assert.equal(run(root).status, 3);
    assert.equal(run(root, "--dmg").status, 3);
    assert.equal(run(root, "--dmg", "none", "--from-release-json", "x").status, 3);
    assert.equal(run(root, "--bogus").status, 3);
    assert.equal(run(root, "--dmg", "on").status, 1);
    writeFileSync(join(root, "README.md"), "# no markers\n");
    const r = run(root, "--dmg", "adhoc");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /exactly one/);
  });

  it("main() works in process with injected streams", () => {
    const root = project();
    const out = sink();
    const err = sink();
    assert.equal(main(["--root", root, "--dmg", "developer-id"], { out, err }), 0);
    assert.match(out.text, /state=developer-id/);
    assert.equal(err.text, "");
  });
});

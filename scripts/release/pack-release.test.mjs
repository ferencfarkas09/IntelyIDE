// node --test scripts/release/pack-release.test.mjs
// The file-level half of `pnpm release`: bundle checks, path patching, checksums, release notes, site data, artifact verification.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildSums, checkApp, finalize, main, neutralPrefix, parseSums, patchApp, patchBuffer, plistVersion, renderNotes, siteRelease, verifyOut } from "./pack-release.mjs";

const REAL = join(dirname(fileURLToPath(import.meta.url)), "../..");
const VERSION = JSON.parse(readFileSync(join(REAL, "package.json"), "utf8")).version;
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "pack-release-"));
  made.push(d);
  return d;
};

const SOURCES = {
  "Contents/Resources/sidecar/index.js": "sidecar/dist/index.js",
  "Contents/Resources/sidecar/sdk-install.js": "sidecar/dist/sdk-install.js",
  "Contents/Resources/sidecar/package.json": "src-tauri/resources/sidecar-package.json",
  "Contents/Resources/sdk-pin/package.json": "sidecar/sdk-pin/package.json",
  "Contents/Resources/sdk-pin/package-lock.json": "sidecar/sdk-pin/package-lock.json",
  "Contents/Resources/sdk-pin/tree.sha256": "sidecar/sdk-pin/tree.sha256",
  "Contents/Resources/sdk-pin/hash-tree.mjs": "sidecar/sdk-pin/hash-tree.mjs",
  "Contents/Resources/legal/LICENSE": "LICENSE",
};
const plist = (v) => `<?xml version="1.0"?><plist><dict><key>CFBundleShortVersionString</key><string>${v}</string></dict></plist>`;

/** A fake source tree and a bundle built from it. */
function fixture({ version = "9.9.9", exe = "plain executable bytes" } = {}) {
  const root = tmp();
  const app = join(tmp(), "IntelyIDE.app");
  for (const [inApp, source] of Object.entries(SOURCES)) {
    mkdirSync(dirname(join(root, source)), { recursive: true });
    writeFileSync(join(root, source), `content of ${source}\n`);
    mkdirSync(dirname(join(app, inApp)), { recursive: true });
    writeFileSync(join(app, inApp), `content of ${source}\n`);
  }
  mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
  writeFileSync(join(app, "Contents/Info.plist"), plist(version));
  writeFileSync(join(app, "Contents/MacOS/intely-switch-ide"), exe);
  const lipo = () => ({ status: 0, stdout: "x86_64\n" });
  return { root, app, lipo };
}

describe("path patching", () => {
  it("keeps the length: the usual 13-byte home and other lengths all get a path-shaped stand-in", () => {
    assert.equal(neutralPrefix("/Users/alice"), ["", "Users", "build", ""].join("/"));
    assert.equal(neutralPrefix("/Users/someone"), "/build________/");
    for (const home of ["/Users/alice", "/Users/someone", "/home/runner"]) assert.equal(neutralPrefix(home).length, home.length + 1);
    assert.throws(() => neutralPrefix("/a"), /too short/);
  });

  it("replaces every occurrence and nothing else", () => {
    const buf = Buffer.from("x/Users/alice/Documents/a\0/Users/alice/b/Users/alice-x/c");
    const { out, count } = patchBuffer(buf, "/Users/alice");
    assert.equal(count, 2);
    assert.equal(out.length, buf.length);
    const B = neutralPrefix("/Users/alice");
    assert.equal(out.toString(), `x${B}Documents/a\0${B}b/Users/alice-x/c`);
    assert.equal(patchBuffer(Buffer.from("nothing here"), "/Users/alice").count, 0);
  });

  it("patches the executable of a bundle in place", () => {
    const f = fixture({ exe: "a /Users/alice/src b /Users/alice/ui" });
    assert.equal(patchApp(f.app, "/Users/alice"), 2);
    assert.equal(readFileSync(join(f.app, "Contents/MacOS/intely-switch-ide"), "utf8"), `a ${neutralPrefix("/Users/alice")}src b ${neutralPrefix("/Users/alice")}ui`);
  });
});

describe("check-app", () => {
  it("passes a clean bundle", () => {
    const f = fixture();
    assert.deepEqual(checkApp({ app: f.app, version: "9.9.9", home: "/Users/alice", root: f.root, run: f.lipo }), []);
  });

  it("names the version, a resource that differs, a missing one, a file that must not ship and the builder's path", () => {
    const f = fixture({ exe: "build at /Users/alice/Documents/x" });
    writeFileSync(join(f.app, "Contents/Resources/sidecar/index.js"), "changed\n");
    rmSync(join(f.app, "Contents/Resources/sdk-pin/tree.sha256"));
    writeFileSync(join(f.app, "Contents/Resources/sidecar/testkit.js"), "x");
    const problems = checkApp({ app: f.app, version: "1.0.0", home: "/Users/alice", root: f.root, run: f.lipo });
    const text = problems.join("\n");
    assert.match(text, /Info\.plist says version 9\.9\.9, expected 1\.0\.0/);
    assert.match(text, /sidecar\/index\.js differs from sidecar\/dist\/index\.js/);
    assert.match(text, /missing in the bundle: Contents\/Resources\/sdk-pin\/tree\.sha256/);
    assert.match(text, /must not ship: Contents\/Resources\/sidecar\/testkit\.js/);
    assert.match(text, /MacOS\/intely-switch-ide contains the builder's path/);
  });

  it("refuses an executable of another architecture", () => {
    const f = fixture();
    const p = checkApp({ app: f.app, version: "9.9.9", home: "/Users/alice", root: f.root, run: () => ({ status: 0, stdout: "arm64\n" }) });
    assert.match(p.join("\n"), /expected x86_64/);
  });

  it("reads the version from an Info.plist", () => {
    assert.equal(plistVersion(plist("1.2.3")), "1.2.3");
    assert.equal(plistVersion("<plist/>"), null);
  });
});

describe("checksums, notes and site data", () => {
  const dmg = { name: "IntelyIDE_1.0.1_x64.dmg", size: 16 * 1048576, sha256: "a".repeat(64) };
  const sbom = { name: "IntelyIDE_1.0.1_x64.sbom.cdx.json", size: 1000, sha256: "b".repeat(64) };

  it("writes and reads SHA256SUMS in the format `shasum -c` takes", () => {
    const text = buildSums([dmg, sbom]);
    assert.equal(text, `${"a".repeat(64)}  IntelyIDE_1.0.1_x64.dmg\n${"b".repeat(64)}  IntelyIDE_1.0.1_x64.sbom.cdx.json\n`);
    assert.equal(parseSums(text).get("IntelyIDE_1.0.1_x64.dmg"), "a".repeat(64));
    assert.throws(() => parseSums("not a sum line\n"), /malformed/);
  });

  it("renders release notes that say stable, carry the hashes and name no other contact point", () => {
    const notes = renderNotes({ version: "1.0.1", dmg, sbom, body: "### Fixed\n\n- A thing.\n" });
    assert.match(notes, /^# IntelyIDE 1\.0\.1/);
    assert.ok(notes.includes(dmg.sha256) && notes.includes(sbom.sha256));
    assert.match(notes, /shasum -a 256 -c SHA256SUMS/);
    assert.match(notes, /#### Fixed/);
    assert.doesNotMatch(notes, /\balpha\b|\bbeta\b|pre-release/i);
    assert.doesNotMatch(notes, /[\w.+-]+@[\w-]+\.[\w.]+/);
    for (const host of notes.match(/https?:\/\/[^/\s)`]+/g)) assert.ok(["https://github.com", "https://intelyhome.com"].includes(host), host);
  });

  it("builds the site's download record for a stable release", () => {
    const r = siteRelease({ version: "1.0.1", date: "2026-10-08", dmg, previous: { minMacOS: "13.5", appleSiliconPlanned: false } });
    assert.equal(r.status, "stable");
    assert.equal(r.assets[0].url, "https://github.com/ferencfarkas09/IntelyIDE/releases/download/v1.0.1/IntelyIDE_1.0.1_x64.dmg");
    assert.equal(r.sha256sumsUrl, "https://github.com/ferencfarkas09/IntelyIDE/releases/download/v1.0.1/SHA256SUMS");
    assert.equal(r.appleSiliconPlanned, false);
  });
});

describe("finalize and verify on a throwaway folder", () => {
  it("writes the files of the current version from the real changelog, and verify notices a changed file", () => {
    const out = tmp();
    const dmg = join(out, `IntelyIDE_${VERSION}_x64.dmg`);
    writeFileSync(dmg, "pretend disk image");
    const site = join(out, "site-release.json");
    const r = finalize({ version: VERSION, dmg, out, commit: "c".repeat(40), siteData: site });
    for (const f of ["SHA256SUMS", "RELEASE_NOTES.md", "build-record.json", `IntelyIDE_${VERSION}_x64.sbom.cdx.json`]) assert.ok(existsSync(join(out, f)), f);
    assert.equal(r.dmg.size, 18);
    assert.deepEqual(verifyOut({ version: VERSION, out, commit: "c".repeat(40), siteData: site }), []);
    assert.match(verifyOut({ version: VERSION, out, commit: "d".repeat(40) }).join("\n"), /build record is for commit/);
    writeFileSync(dmg, "pretend disk image, changed");
    assert.match(verifyOut({ version: VERSION, out, siteData: site }).join("\n"), /changed since the build record/);
  });

  it("refuses a disk image with another name and a missing one", () => {
    const out = tmp();
    writeFileSync(join(out, "x.dmg"), "x");
    assert.throws(() => finalize({ version: VERSION, dmg: join(out, "x.dmg"), out, commit: "c".repeat(40) }), /must be named/);
    assert.throws(() => finalize({ version: VERSION, dmg: join(out, `IntelyIDE_${VERSION}_x64.dmg`), out, commit: "c".repeat(40) }), /no disk image/);
  });

  it("the command line returns 0, 1 and 2", () => {
    const log = [];
    const io = { log: (l) => log.push(l), err: (l) => log.push(l) };
    assert.equal(main([], io), 2);
    assert.equal(main(["verify", "--version", VERSION, "--out", tmp()], io), 1);
    assert.equal(main(["check-app", "--version", VERSION], io), 2);
  });
});

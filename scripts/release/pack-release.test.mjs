// node --test scripts/release/pack-release.test.mjs
// The file-level half of `pnpm release`: bundle checks, path patching, checksums, release notes, site data, artifact verification.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { assetNames } from "./assets.mjs";
import { main as stageMain, stage } from "./stage-artifacts.mjs";
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
  "Contents/Resources/relay-kit/remote-relay/package.json": "remote-relay/package.json",
  "Contents/Resources/relay-kit/remote-relay/pnpm-lock.yaml": "remote-relay/pnpm-lock.yaml",
  "Contents/Resources/relay-kit/remote-relay/wrangler.jsonc": "remote-relay/wrangler.jsonc",
  "Contents/Resources/relay-kit/remote-relay/src/index.ts": "remote-relay/src/index.ts",
  "Contents/Resources/relay-kit/remote-web/package.json": "remote-web/package.json",
  "Contents/Resources/relay-kit/remote-web/dist/index.html": "remote-web/dist/index.html",
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
  const lipo = () => ({ status: 0, stdout: "x86_64 arm64\n" });
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
    rmSync(join(f.app, "Contents/Resources/relay-kit/remote-web/dist/index.html"));
    writeFileSync(join(f.app, "Contents/Resources/sidecar/testkit.js"), "x");
    const problems = checkApp({ app: f.app, version: "1.0.0", home: "/Users/alice", root: f.root, run: f.lipo });
    const text = problems.join("\n");
    assert.match(text, /Info\.plist says version 9\.9\.9, expected 1\.0\.0/);
    assert.match(text, /sidecar\/index\.js differs from sidecar\/dist\/index\.js/);
    assert.match(text, /missing in the bundle: Contents\/Resources\/sdk-pin\/tree\.sha256/);
    assert.match(text, /missing in the bundle: Contents\/Resources\/relay-kit\/remote-web\/dist\/index\.html/);
    assert.match(text, /must not ship: Contents\/Resources\/sidecar\/testkit\.js/);
    assert.match(text, /MacOS\/intely-switch-ide contains the builder's path/);
  });

  it("refuses an executable that is not universal (either architecture alone)", () => {
    const f = fixture();
    for (const archs of ["arm64\n", "x86_64\n"]) {
      const p = checkApp({ app: f.app, version: "9.9.9", home: "/Users/alice", root: f.root, run: () => ({ status: 0, stdout: archs }) });
      assert.match(p.join("\n"), /expected a universal binary/);
    }
    // lipo prints the architectures in the order of the file
    assert.deepEqual(checkApp({ app: f.app, version: "9.9.9", home: "/Users/alice", root: f.root, run: () => ({ status: 0, stdout: "arm64 x86_64\n" }) }), []);
  });

  it("reads the version from an Info.plist", () => {
    assert.equal(plistVersion(plist("1.2.3")), "1.2.3");
    assert.equal(plistVersion("<plist/>"), null);
  });
});

describe("checksums, notes and site data", () => {
  const dmg = { name: "IntelyIDE_1.0.1_universal.dmg", size: 16 * 1048576, sha256: "a".repeat(64) };
  const sbom = { name: "IntelyIDE_1.0.1.sbom.cdx.json", size: 1000, sha256: "b".repeat(64) };

  it("writes and reads SHA256SUMS in the format `shasum -c` takes", () => {
    const text = buildSums([dmg, sbom]);
    assert.equal(text, `${"a".repeat(64)}  IntelyIDE_1.0.1_universal.dmg\n${"b".repeat(64)}  IntelyIDE_1.0.1.sbom.cdx.json\n`);
    assert.equal(parseSums(text).get("IntelyIDE_1.0.1_universal.dmg"), "a".repeat(64));
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

  const ci = {
    nsis: { name: "IntelyIDE_1.0.1_x64-setup.exe", size: 3 * 1048576, sha256: "c".repeat(64) },
    msi: { name: "IntelyIDE_1.0.1_x64.msi", size: 4 * 1048576, sha256: "d".repeat(64) },
    appimage: { name: "IntelyIDE_1.0.1_x86_64.AppImage", size: 9 * 1048576, sha256: "e".repeat(64) },
    deb: { name: "intelyide_1.0.1_amd64.deb", size: 3 * 1048576, sha256: "f".repeat(64) },
  };

  it("builds the site's download record: one asset per platform, keyed by platform", () => {
    const r = siteRelease({ version: "1.0.1", date: "2026-10-08", dmg, ci, previous: { minMacOS: "13.5" } });
    assert.equal(r.status, "stable");
    assert.equal(r.assets.mac.url, "https://github.com/ferencfarkas09/IntelyIDE/releases/download/v1.0.1/IntelyIDE_1.0.1_universal.dmg");
    assert.equal(r.assets.mac.arch, "universal");
    assert.equal(r.assets.windows.nsis.sha256, "c".repeat(64));
    assert.equal(r.assets.windows.msi.name, "IntelyIDE_1.0.1_x64.msi");
    assert.deepEqual(Object.keys(r.assets.linux), ["appimage", "deb"]);
    assert.equal(r.sha256sumsUrl, "https://github.com/ferencfarkas09/IntelyIDE/releases/download/v1.0.1/SHA256SUMS");
    assert.equal(r.signed, false);
    assert.equal(r.windowsSigned, false);
    assert.deepEqual(Object.keys(siteRelease({ version: "1.0.1", date: "2026-10-08", dmg }).assets), ["mac"]);
  });

  it("lists every platform in the notes with its hash, tells Windows users about SmartScreen and Linux users about chmod", () => {
    const notes = renderNotes({ version: "1.0.1", dmg, sbom, ci, body: "", notarized: true });
    for (const f of [dmg, sbom, ...Object.values(ci)]) assert.ok(notes.includes(f.name) && notes.includes(f.sha256), f.name);
    assert.match(notes, /More info, then Run anyway/);
    assert.match(notes, /chmod \+x IntelyIDE_1\.0\.1_x86_64\.AppImage/);
    assert.match(notes, /apt install \.\/intelyide_1\.0\.1_amd64\.deb/);
    assert.doesNotMatch(renderNotes({ version: "1.0.1", dmg, sbom, body: "" }), /SmartScreen|chmod/);
  });

  it("drops the Open Anyway steps for a notarized build and marks the site record signed", () => {
    const notes = renderNotes({ version: "1.0.1", dmg, sbom, body: "", notarized: true });
    assert.match(notes, /notarized by Apple/);
    assert.doesNotMatch(notes, /Open Anyway/);
    assert.match(renderNotes({ version: "1.0.1", dmg, sbom, body: "" }), /Open Anyway/);
    assert.equal(siteRelease({ version: "1.0.1", date: "2026-10-08", dmg, notarized: true }).signed, true);
  });
});

const names = assetNames(VERSION);
/** Fake installers of the plausible sizes, as the downloaded workflow artifacts. */
const putCi = (out) => {
  for (const k of ["nsis", "msi", "appimage", "deb"]) writeFileSync(join(out, names[k]), Buffer.alloc(2_100_000 + (k === "appimage" ? 4_000_000 : 0), k));
};

describe("finalize and verify on a throwaway folder", () => {
  it("a disk image alone verifies only as partial; the installers complete it, and verify notices a changed file", () => {
    const out = tmp();
    const dmg = join(out, names.dmg);
    writeFileSync(dmg, "pretend disk image");
    const site = join(out, "site-release.json");
    finalize({ version: VERSION, dmg, out, commit: "c".repeat(40), siteData: site });
    assert.equal(existsSync(site), false, "no site data before the installers exist");
    assert.deepEqual(verifyOut({ version: VERSION, out, partial: true }), []);
    assert.match(verifyOut({ version: VERSION, out }).join("\n"), /does not list IntelyIDE_.*_x64-setup\.exe/);

    putCi(out);
    const r = finalize({ version: VERSION, dmg, out, commit: "c".repeat(40), siteData: site, ci: true });
    for (const f of ["SHA256SUMS", "RELEASE_NOTES.md", "build-record.json", names.sbom, ...["nsis", "msi", "appimage", "deb"].map((k) => names[k])]) assert.ok(existsSync(join(out, f)), f);
    assert.equal(r.dmg.size, 18);
    assert.deepEqual(verifyOut({ version: VERSION, out, commit: "c".repeat(40), siteData: site }), []);
    assert.equal(JSON.parse(readFileSync(site, "utf8")).assets.linux.deb.name, names.deb);
    assert.match(verifyOut({ version: VERSION, out, commit: "d".repeat(40) }).join("\n"), /build record is for commit/);
    writeFileSync(join(out, names.msi), Buffer.alloc(2_200_000, "x"));
    assert.match(verifyOut({ version: VERSION, out, siteData: site }).join("\n"), /x64\.msi changed since the build record/);
    writeFileSync(dmg, "pretend disk image, changed");
    assert.match(verifyOut({ version: VERSION, out, siteData: site }).join("\n"), /changed since the build record/);
  });

  it("refuses a missing or truncated installer", () => {
    const out = tmp();
    const dmg = join(out, names.dmg);
    writeFileSync(dmg, "pretend disk image");
    putCi(out);
    writeFileSync(join(out, names.deb), "tiny");
    rmSync(join(out, names.nsis));
    assert.throws(() => finalize({ version: VERSION, dmg, out, commit: "c".repeat(40), ci: true }), (e) => /x64-setup\.exe \(not found\)/.test(e.message) && /amd64\.deb \(only 4 bytes\)/.test(e.message));
  });

  it("refuses a disk image with another name and a missing one", () => {
    const out = tmp();
    writeFileSync(join(out, "x.dmg"), "x");
    assert.throws(() => finalize({ version: VERSION, dmg: join(out, "x.dmg"), out, commit: "c".repeat(40) }), /must be named/);
    assert.throws(() => finalize({ version: VERSION, dmg: join(out, names.dmg), out, commit: "c".repeat(40) }), /no disk image/);
  });

  it("the command line returns 0, 1 and 2", () => {
    const log = [];
    const io = { log: (l) => log.push(l), err: (l) => log.push(l) };
    assert.equal(main([], io), 2);
    assert.equal(main(["verify", "--version", VERSION, "--out", tmp()], io), 1);
    assert.equal(main(["check-app", "--version", VERSION], io), 2);
  });
});

describe("the release file names and the CI staging", () => {
  it("names every file of a release", () => {
    assert.deepEqual(assetNames("1.4.0"), {
      dmg: "IntelyIDE_1.4.0_universal.dmg",
      appimage: "IntelyIDE_1.4.0_x86_64.AppImage",
      deb: "intelyide_1.4.0_amd64.deb",
      nsis: "IntelyIDE_1.4.0_x64-setup.exe",
      msi: "IntelyIDE_1.4.0_x64.msi",
      sbom: "IntelyIDE_1.4.0.sbom.cdx.json",
    });
  });

  /** A target/release/bundle tree the way Tauri writes it. */
  function bundleTree(platform, version = "1.4.0") {
    const dir = tmp();
    const put = (sub, file, size) => {
      mkdirSync(join(dir, sub), { recursive: true });
      writeFileSync(join(dir, sub, file), Buffer.alloc(size, 1));
    };
    if (platform === "linux") {
      put("appimage", `IntelyIDE_${version}_amd64.AppImage`, 6_000_000);
      put("deb", `IntelyIDE_${version}_amd64.deb`, 3_000_000);
    } else {
      put("nsis", `IntelyIDE_${version}_x64-setup.exe`, 3_000_000);
      put("msi", `IntelyIDE_${version}_x64_en-US.msi`, 3_000_000);
    }
    return dir;
  }

  it("renames the Tauri bundles to the release names", () => {
    for (const [platform, kinds] of [["linux", ["appimage", "deb"]], ["windows", ["nsis", "msi"]]]) {
      const out = tmp();
      const staged = stage({ platform, version: "1.4.0", bundleDir: bundleTree(platform), out });
      assert.deepEqual(staged.map((s) => s.kind), kinds);
      for (const k of kinds) assert.ok(existsSync(join(out, assetNames("1.4.0")[k])), k);
    }
  });

  it("fails on a missing bundle, a stale version, an ambiguous match and an implausible size", () => {
    const io = { log() {}, err() {} };
    const dir = bundleTree("linux");
    assert.throws(() => stage({ platform: "linux", version: "1.5.0", bundleDir: dir, out: tmp() }), /does not carry the version 1\.5\.0/);
    writeFileSync(join(dir, "deb/other.deb"), Buffer.alloc(3_000_000));
    assert.throws(() => stage({ platform: "linux", version: "1.4.0", bundleDir: dir, out: tmp() }), /expected one file.*found 2/);
    assert.throws(() => stage({ platform: "windows", version: "1.4.0", bundleDir: dir, out: tmp() }), /expected one file/);
    const small = bundleTree("windows");
    writeFileSync(join(small, "msi/IntelyIDE_1.4.0_x64_en-US.msi"), "tiny");
    assert.throws(() => stage({ platform: "windows", version: "1.4.0", bundleDir: small, out: tmp() }), /only 4 bytes/);
    assert.equal(stageMain(["--platform", "mac"], io), 2);
    assert.equal(stageMain(["--platform", "linux", "--version", "1.4.0", "--bundle-dir", tmp(), "--out", tmp()], io), 1);
  });
});

// node --test scripts/release/verify-no-telemetry.test.mjs
// Synthetic lockfiles, manifests, capability files and source trees under the system temp dir; no network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ALLOWED_CRATES,
  EXPECTED_PERMISSIONS,
  checkCapabilities,
  checkCsp,
  checkEndpoints,
  checkGraph,
  checkLockfiles,
  checkManifests,
  checkPrivacy,
  checkRustSources,
  checkSidecar,
  checkUiSources,
  isGitFetchWrapper,
  manifestDeps,
  pnpmNames,
  runAll,
} from "./verify-no-telemetry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "verify-no-telemetry.mjs");
const REAL_ROOT = join(HERE, "../..");

const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost; frame-src http://127.0.0.1:* http://localhost:*";

const CARGO_LOCK = `
[[package]]
name = "intely-switch-ide"
version = "0.0.0"
dependencies = [
 "intely-remote",
 "serde",
]

[[package]]
name = "intely-remote"
version = "0.0.0"
dependencies = [
 "reqwest",
]

[[package]]
name = "reqwest"
version = "0.13.5"
dependencies = [
 "hyper",
 "native-tls",
]

[[package]]
name = "hyper"
version = "1.0.0"

[[package]]
name = "native-tls"
version = "0.2.0"
dependencies = [
 "openssl",
]

[[package]]
name = "openssl"
version = "0.10.0"

[[package]]
name = "serde"
version = "1.0.0"
`;

const BASE = {
  "Cargo.lock": CARGO_LOCK,
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\npackages:\n\n  '@fontsource/sora@5.3.0':\n    resolution: {}\n\n  solid-js@1.9.0:\n    resolution: {}\n\nsnapshots:\n\n  solid-js@1.9.0: {}\n",
  "Cargo.toml": '[workspace]\nmembers = ["crates/remote", "crates/core"]\n',
  "crates/remote/Cargo.toml": '[package]\nname = "intely-remote"\n\n[dependencies]\nreqwest = { version = "0.13" }\n',
  "crates/core/Cargo.toml": '[package]\nname = "intely-core"\n\n[dependencies]\nserde = "1"\n',
  "crates/core/src/lib.rs": "pub fn add() {}\n",
  "src-tauri/Cargo.toml": '[package]\nname = "intely-switch-ide"\n\n[dependencies]\ntauri = "2"\n',
  "src-tauri/tauri.conf.json": JSON.stringify({ app: { security: { csp: CSP } } }),
  "src-tauri/capabilities/default.json": JSON.stringify({ identifier: "default", windows: ["main"], permissions: EXPECTED_PERMISSIONS }),
  "ui/src/app.tsx": "export const x = 1;\n",
  "sidecar/src/index.ts": "export const y = 2;\n",
  "docs/privacy.md": `${ALLOWED_CRATES.join(" ")} sdk-install\n`,
};

function tree(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), "vnt-"));
  made.push(dir);
  for (const [rel, body] of Object.entries({ ...BASE, ...over })) {
    if (body === null) continue;
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return dir;
}

const rules = (items) => items.filter((i) => !i.pending).map((i) => i.check);

describe("baseline", () => {
  it("a clean synthetic tree has no failures", () => {
    const res = runAll(tree());
    for (const g of res) assert.deepEqual(g.items.filter((i) => !i.pending), [], g.id);
  });
});

describe("(1) lockfile deny list", () => {
  it("passes the clean locks", () => assert.deepEqual(checkLockfiles(tree()), []));
  it("fails a denied Cargo package", () => {
    const d = tree({ "Cargo.lock": `${CARGO_LOCK}\n[[package]]\nname = "sentry-core"\nversion = "0.3.0"\n` });
    assert.deepEqual(rules(checkLockfiles(d)), ["lock-deny"]);
  });
  it("fails exact entries (tauri-plugin-http, opentelemetry-otlp)", () => {
    for (const n of ["tauri-plugin-http", "tauri-plugin-shell", "tauri-plugin-updater", "opentelemetry-otlp"]) {
      const d = tree({ "Cargo.lock": `${CARGO_LOCK}\n[[package]]\nname = "${n}"\nversion = "1.0.0"\n` });
      assert.equal(checkLockfiles(d).length, 1, n);
    }
  });
  it("does not flag look-alikes of exact entries", () => {
    const d = tree({ "Cargo.lock": `${CARGO_LOCK}\n[[package]]\nname = "opentelemetry-sdk"\nversion = "1.0.0"\n` });
    assert.deepEqual(checkLockfiles(d), []);
  });
  it("fails a denied pnpm package, scoped or not", () => {
    for (const key of ["'@sentry/browser@8.0.0'", "posthog-js@1.0.0", "'@segment/analytics-next@1.0.0(x@1)'", "react-ga4@2.1.0", "'@vercel/analytics@1.0.0'",
      "logrocket@8.0.0", "hotjar@1.0.0", "'@hotjar/browser@1.0.0'", "applicationinsights@3.0.0", "newrelic@11.0.0", "'@honeycombio/opentelemetry-web@1.0.0'",
      "'@fullstory/browser@2.0.0'", "'@google-analytics/data@4.0.0'"]) {
      const lock = `lockfileVersion: '9.0'\n\npackages:\n\n  ${key}:\n    resolution: {}\n`;
      assert.equal(checkLockfiles(tree({ "pnpm-lock.yaml": lock })).length, 1, key);
    }
  });
  it("also scans a lock one directory down", () => {
    const lock = "packages:\n\n  mixpanel@1.0.0:\n    resolution: {}\n";
    assert.equal(checkLockfiles(tree({ "remote-relay/pnpm-lock.yaml": lock })).length, 1);
  });
  it("pnpmNames reads package and snapshot keys", () => {
    assert.deepEqual([...pnpmNames(BASE["pnpm-lock.yaml"])].sort(), ["@fontsource/sora", "solid-js"]);
  });
  it("prints the file, not a secret value", () => {
    const [f] = checkLockfiles(tree({ "Cargo.lock": `${CARGO_LOCK}\n[[package]]\nname = "bugsnag"\nversion = "1.0.0"\n` }));
    assert.equal(f.file, "Cargo.lock");
  });
});

describe("(2) CSP", () => {
  const conf = (csp) => tree({ "src-tauri/tauri.conf.json": JSON.stringify({ app: { security: { csp } } }) });
  it("passes the real shape", () => assert.deepEqual(checkCsp(tree()), []));
  it("fails an https source", () => assert.equal(rules(checkCsp(conf(CSP.replace("ipc:", "ipc: https://example.com")))).length, 1));
  it("fails a wildcard and a ws scheme", () => {
    assert.ok(checkCsp(conf("default-src 'self'; connect-src *")).length);
    assert.ok(checkCsp(conf("default-src 'self'; connect-src ws://127.0.0.1:1")).length);
  });
  it("fails a remote origin that merely contains localhost", () => {
    assert.ok(checkCsp(conf("default-src 'self'; connect-src http://localhost.evil.com")).length);
  });
  it("fails a missing or malformed CSP", () => {
    assert.ok(checkCsp(tree({ "src-tauri/tauri.conf.json": "{}" })).length);
    assert.ok(checkCsp(tree({ "src-tauri/tauri.conf.json": "{" })).length);
  });
});

describe("(8) capabilities and frame-src", () => {
  const caps = (o) => tree({ "src-tauri/capabilities/default.json": JSON.stringify(o) });
  it("passes the recorded set", () => assert.deepEqual(checkCapabilities(tree()), []));
  it("the recorded set is exactly the one in this test", () => {
    assert.deepEqual(EXPECTED_PERMISSIONS, ["core:default", "core:window:allow-start-dragging", "core:window:allow-toggle-maximize"]);
  });
  it("fails a remote section", () => {
    assert.ok(checkCapabilities(caps({ permissions: EXPECTED_PERMISSIONS, remote: { urls: ["https://x.example"] } })).length);
  });
  it("fails an extra permission", () => {
    assert.ok(checkCapabilities(caps({ permissions: [...EXPECTED_PERMISSIONS, "shell:allow-execute"] })).length);
  });
  it("fails when a recorded permission vanished (the record must be updated)", () => {
    assert.ok(checkCapabilities(caps({ permissions: ["core:default"] })).length);
  });
  it("fails a non-loopback frame-src", () => {
    const c = "default-src 'self'; frame-src http://127.0.0.1:* https://example.com";
    assert.ok(checkCsp(tree({ "src-tauri/tauri.conf.json": JSON.stringify({ app: { security: { csp: c } } }) })).length);
    const s = "default-src 'self'; frame-src 'self'";
    assert.ok(checkCsp(tree({ "src-tauri/tauri.conf.json": JSON.stringify({ app: { security: { csp: s } } }) })).some((x) => /frame-src/.test(x.detail)));
  });
});

describe("(3) UI network APIs", () => {
  const ui = (body, name = "ui/src/m/a.ts") => tree({ [name]: body });
  it("passes plain code", () => assert.deepEqual(checkUiSources(tree()), []));
  for (const [label, code] of [
    ["fetch", "const r = await fetch(url);"],
    ["window.fetch", "window.fetch(u)"],
    ["XMLHttpRequest", "new XMLHttpRequest()"],
    ["sendBeacon", "navigator.sendBeacon(u, d)"],
    ["WebSocket", "new WebSocket(u)"],
    ["EventSource", "new EventSource(u)"],
  ]) {
    it(`fails ${label}`, () => assert.equal(checkUiSources(ui(code)).length, 1));
  }
  it("allows the git fetch IPC wrapper by name", () => {
    assert.deepEqual(checkUiSources(ui("interface Ipc {\n  fetch(repoId: string): Promise<void>;\n}\nawait ipc.fetch(id);\n")), []);
    assert.equal(isGitFetchWrapper("  fetch(repoId: string): Promise<RunStarted>;"), true);
    assert.equal(isGitFetchWrapper("window.fetch(u)"), false);
    assert.equal(isGitFetchWrapper("await fetch(url)"), false);
  });
  it("ignores test and mock files and comments", () => {
    assert.deepEqual(checkUiSources(ui("fetch(u)", "ui/src/m/a.test.ts")), []);
    assert.deepEqual(checkUiSources(ui("fetch(u)", "ui/src/ipc/mock.ts")), []);
    assert.deepEqual(checkUiSources(ui("// fetch(u) is not used")), []);
  });
});

describe("(4) manifests", () => {
  it("allowed crates may use the network", () => assert.deepEqual(checkManifests(tree()), []));
  it("fails reqwest in a non-allowed crate", () => {
    const d = tree({ "crates/core/Cargo.toml": '[package]\nname = "intely-core"\n\n[dependencies]\nreqwest = "0.13"\n' });
    assert.deepEqual(rules(checkManifests(d)), ["cargo-net"]);
  });
  it("fails tungstenite, hyper and mongodb in src-tauri and the table form", () => {
    for (const dep of ["tokio-tungstenite", "hyper", "mongodb"]) {
      const d = tree({ "src-tauri/Cargo.toml": `[package]\nname = "x"\n\n[dependencies.${dep}]\nversion = "1"\n` });
      assert.equal(checkManifests(d).length, 1, dep);
    }
  });
  it("fails a renamed dependency and a target-specific one", () => {
    const d = tree({ "crates/core/Cargo.toml": '[dependencies]\nhttpc = { package = "reqwest", version = "1" }\n' });
    assert.ok(checkManifests(d).length);
    const t = tree({ "crates/core/Cargo.toml": '[target.\'cfg(unix)\'.dependencies]\nhyper = "1"\n' });
    assert.ok(checkManifests(t).length);
  });
  it("a new crate with a network dependency fails until the lists are updated", () => {
    const d = tree({ "crates/newnet/Cargo.toml": '[package]\nname = "intely-newnet"\n\n[dependencies]\nureq = "2"\n' });
    assert.equal(checkManifests(d).length, 1);
  });
  it("manifestDeps ignores comments and feature tables", () => {
    assert.deepEqual([...manifestDeps('[features]\nmongo = ["dep:mongodb"]\n[dependencies]\n# reqwest = "1"\nserde = "1"\n')], ["serde"]);
  });
});

describe("(5) + (9) privacy.md", () => {
  const p = (body) => tree({ "docs/privacy.md": body });
  it("is pending, not failing, when the file does not exist yet", () => {
    const items = checkPrivacy(tree({ "docs/privacy.md": null }), null);
    assert.equal(items.length, 1);
    assert.equal(items[0].pending, true);
  });
  it("fails when an allowed crate is not named", () => {
    const body = ALLOWED_CRATES.filter((c) => c !== "mongo").join(" ");
    assert.equal(checkPrivacy(p(body), body).length, 1);
  });
  it("accepts a hyphenated crate name", () => {
    const body = ALLOWED_CRATES.map((c) => c.replace(/_/g, "-")).join(" ");
    assert.deepEqual(checkPrivacy(p(body), body), []);
  });
  it("fails an update-check sentence without the idle-socket result", () => {
    const body = `${ALLOWED_CRATES.join(" ")} the check reads one file from ferencfarkas09.github.io`;
    assert.equal(checkPrivacy(p(body), body).length, 1);
  });
  it("passes when the idle-socket result is cited", () => {
    const body = `${ALLOWED_CRATES.join(" ")} the check reads one file from ferencfarkas09.github.io (idle-socket smoke S-10 passed)`;
    assert.deepEqual(checkPrivacy(p(body), body), []);
  });
});

describe("(6) sidecar", () => {
  const sc = (body, name = "sidecar/src/a.ts", over = {}) => tree({ [name]: body, ...over });
  for (const code of [
    'import http from "node:http";',
    'import { connect } from "node:net";',
    'import tls from "node:tls";',
    'import dgram from "node:dgram";',
    'import dns from "node:dns";',
    'import https from "https";',
    "const r = await fetch(u);",
    "const w = new WebSocket(u);",
    'import { request } from "undici";',
    'import fetch2 from "node-fetch";',
    'const a = require("axios");',
    'const g = await import("got");',
  ]) {
    it(`fails ${code}`, () => assert.equal(checkSidecar(sc(code), "x").length, 1));
  }
  it("allows the named installer file when privacy.md names it", () => {
    const d = sc('import https from "node:https";', "sidecar/src/sdk-install.ts");
    assert.deepEqual(checkSidecar(d, "sdk-install"), []);
  });
  it("fails the installer file when privacy.md does not name it", () => {
    const d = sc('import https from "node:https";', "sidecar/src/sdk-install.ts");
    assert.equal(checkSidecar(d, "nothing").length, 1);
  });
  it("ignores tests", () => assert.deepEqual(checkSidecar(sc("fetch(u)", "sidecar/src/a.test.ts"), "x"), []));
});

describe("(7) Rust sources and the dependency graph", () => {
  const rs = (body, name = "crates/core/src/net.rs") => tree({ [name]: body });
  for (const code of [
    "let s = std::net::TcpStream::connect(a);",
    "let s = UdpSocket::bind(a);",
    'Command::new("curl")',
    "use ureq::get;",
  ]) {
    it(`fails ${code}`, () => assert.equal(checkRustSources(rs(code)).length, 1));
  }
  it("allows the same code in an allowed crate", () => {
    assert.deepEqual(checkRustSources(rs("TcpStream::connect(a)", "crates/remote/src/x.rs")), []);
  });
  it("ignores cfg(test) tails, test files and comments", () => {
    assert.deepEqual(checkRustSources(rs("fn a() {}\n#[cfg(test)]\nmod t { use std::net::TcpStream; }\n")), []);
    assert.deepEqual(checkRustSources(rs("TcpStream", "crates/core/tests/net.rs")), []);
    assert.deepEqual(checkRustSources(rs("// TcpStream is not used")), []);
  });
  it("graph: reachable only through an allowed crate passes", () => assert.deepEqual(checkGraph(tree()), []));
  it("graph: a direct path from the root to reqwest fails and names the nearest dependent", () => {
    const lock = CARGO_LOCK.replace(' "intely-remote",\n "serde",', ' "intely-remote",\n "reqwest",\n "serde",');
    const f = checkGraph(tree({ "Cargo.lock": lock }));
    assert.ok(f.some((x) => /reqwest reachable/.test(x.detail) && /intely-switch-ide/.test(x.detail)));
  });
  it("graph: rustls through a non-allowed crate fails", () => {
    const lock = `${CARGO_LOCK}\n[[package]]\nname = "intely-core"\nversion = "0.0.0"\ndependencies = [\n "rustls",\n]\n\n[[package]]\nname = "rustls"\nversion = "0.23.0"\n`.replace(' "intely-remote",\n "serde",', ' "intely-core",\n "intely-remote",\n "serde",');
    assert.ok(checkGraph(tree({ "Cargo.lock": lock })).some((x) => /rustls/.test(x.detail)));
  });
  it("graph: versioned dependency strings resolve", () => {
    const lock = CARGO_LOCK.replace(' "serde",', ' "serde 1.0.0",\n "hyper 1.0.0 (registry+https://github.com/rust-lang/crates.io-index)",');
    assert.ok(checkGraph(tree({ "Cargo.lock": lock })).some((x) => /hyper reachable/.test(x.detail)));
  });
  it("graph: the recorded mobile-only tauri to reqwest edge is ignored, other tauri edges are not", () => {
    const lock = `${CARGO_LOCK}\n[[package]]\nname = "tauri"\nversion = "2.0.0"\ndependencies = [\n "reqwest",\n "hyper",\n]\n`.replace(' "intely-remote",\n "serde",', ' "intely-remote",\n "serde",\n "tauri",');
    const f = checkGraph(tree({ "Cargo.lock": lock }));
    assert.deepEqual(f.map((x) => /(\w+) reachable/.exec(x.detail)[1]), ["hyper"]);
  });
});

describe("(10) updater endpoints", () => {
  const ep = (body) => tree({ "crates/updater/src/endpoints.rs": body });
  const GOOD = [
    'pub const FEED_HOST: &str = "ferencfarkas09.github.io";',
    'pub const MIRROR_HOST: &str = "raw.githubusercontent.com";',
    'pub const DOWNLOAD_HOST: &str = "github.com";',
    'pub fn feed(ch: &str) -> String { format!("https://{}/IntelyIDE/update/{}.json", FEED_HOST, ch) }',
  ].join("\n");
  it("is pending until the crate exists", () => assert.equal(checkEndpoints(tree())[0].pending, true));
  it("passes the recorded hosts and a plain builder", () => assert.deepEqual(checkEndpoints(ep(GOOD)), []));
  it("accepts a release CDN host under githubusercontent.com", () => {
    assert.deepEqual(checkEndpoints(ep(`${GOOD}\nconst CDN: &str = "objects.githubusercontent.com";`)), []);
  });
  it("accepts the loopback hook origin but not another local or look-alike host", () => {
    assert.deepEqual(checkEndpoints(ep(`${GOOD}\nlet o = format!("http://127.0.0.1:{port}");`)), []);
    assert.equal(checkEndpoints(ep(`${GOOD}\nconst X: &str = "http://localhost:80/a";`)).length, 1);
    assert.equal(checkEndpoints(ep(`${GOOD}\nconst X: &str = "http://127.0.0.1.evil.com/a";`)).length, 1);
  });
  it("fails an unknown host", () => assert.equal(checkEndpoints(ep(`${GOOD}\nconst X: &str = "https://example.com/a";`)).length, 1));
  it("fails a bare suffix match and a lookalike", () => {
    assert.equal(checkEndpoints(ep('const X: &str = "githubusercontent.com";')).length, 1);
    assert.equal(checkEndpoints(ep('const X: &str = "evilgithub.com";')).length, 1);
  });
  it("fails a query string in a URL literal or builder", () => {
    assert.ok(checkEndpoints(ep('const X: &str = "https://github.com/a?v=1";')).length);
    assert.ok(checkEndpoints(ep('fn f() -> String { format!("https://github.com/a?v={}", V) }')).length);
  });
});

describe("driver and the real tree", () => {
  const run = (...a) => spawnSync("node", [SCRIPT, ...a], { encoding: "utf8" });
  it("a failing synthetic tree exits 1 and prints FAIL lines", () => {
    const d = tree({ "ui/src/x.ts": "fetch(u)" });
    const r = run("--root", d);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL ui-net ui\/src\/x\.ts:1/);
    assert.match(r.stdout, /RESULT verify-no-telemetry FAIL/);
  });
  it("--release turns a pending check into a failure", () => {
    const d = tree({ "docs/privacy.md": null });
    assert.equal(run("--root", d).status, 0);
    assert.equal(run("--root", d, "--release").status, 1);
  });
  it("bad arguments and a missing root are environment errors", () => {
    assert.equal(run("--bogus").status, 3);
    assert.equal(run("--root", "/nonexistent-vnt-root").status, 3);
  });
  it("the real tree exits 0", () => {
    const r = run("--root", REAL_ROOT);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /RESULT verify-no-telemetry OK/);
  });
  it("the allowed crates exist in the real workspace and are all documented here", () => {
    assert.deepEqual([...ALLOWED_CRATES].sort(), ["happy", "mcp", "mongo", "preview-proxy", "relay_bundle", "relay_deploy", "remote", "sentry", "updater"]);
  });
});

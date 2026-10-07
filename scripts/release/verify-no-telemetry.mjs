#!/usr/bin/env node
// Repeatable telemetry and network gate ((design notes: public-release-spec) 8.3, task R20).
// Offline, read-only: reads files, never opens a socket, never runs git, never reads .env files.
// Lines: `FAIL <check> <file>[:<line>] [detail]`, `PENDING <check> <file> <reason>`, `OK <check>`.
// A hit prints the file and a rule name, never file content. The lockfiles are read here inside Node on
// purpose (the rule against reading lockfiles applies to agent context, not to scripts).
// Exit codes: 0 clean, 1 violations, 3 environment problem.
//
//   node scripts/release/verify-no-telemetry.mjs [--root <dir>] [--release] [--json]
//     --release   a PENDING check (privacy.md or the updater endpoints file not written yet) fails instead
//
// To allow a new network crate: add it to ALLOWED_CRATES AND name it in docs/privacy.md AND extend the test.

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolvePath(HERE, "../..");

// Crates (directory names under crates/) that may use the network. Every one is named in docs/privacy.md.
export const ALLOWED_CRATES = ["remote", "relay_bundle", "relay_deploy", "happy", "sentry", "mongo", "mcp", "preview-proxy", "updater"];
// Root package of the shipped binary in Cargo.lock.
export const ROOT_PACKAGE = "intely-switch-ide";

// (1) package deny list; a trailing * means "starts with". Scoped npm names match on scope or package.
export const DENY_PACKAGES = [
  "sentry*", "posthog*", "mixpanel*", "amplitude*", "segment*", "datadog*", "bugsnag*", "rollbar*",
  "opentelemetry-otlp", "firebase*", "appcenter*", "matomo*", "plausible*", "umami*",
  "react-ga*", "@google-analytics/*", "@vercel/analytics", "@vercel/speed-insights", "logrocket*", "hotjar*", "@hotjar/*",
  "applicationinsights", "@microsoft/applicationinsights*", "newrelic*", "@newrelic/*", "@honeycombio/*", "fullstory*", "@fullstory/*",
  "tauri-plugin-updater", "tauri-plugin-http", "tauri-plugin-shell",
];
// (4) crates whose presence in a manifest means network capability
export const NET_DEPS = [
  "reqwest", "tungstenite", "tokio-tungstenite", "hyper", "hyper-util", "hyper-tls", "hyper-rustls",
  "mongodb", "ureq", "curl", "isahc", "attohttpc", "surf", "awc",
];
// (7) packages reachable from the root only through allowed crates
export const GRAPH_WATCH = ["reqwest", "hyper", "rustls", "native-tls", "openssl", "tungstenite"];
// Edges of Cargo.lock that are not compiled for macOS. Cargo.lock lists dependencies of every target, so
// the graph over-approximates. tauri 2.12.1 depends on reqwest only under
// `cfg(any(target_os = "android", all(target_vendor = "apple", not(target_os = "macos"))))` (its Cargo.toml).
// Every entry needs that kind of reason; a new path to a watched package still fails.
export const IGNORED_EDGES = [["tauri", "reqwest"]];
// (7) loopback-only probes outside the allowed crates, by exact file (reason in the comment)
export const RUST_NET_ALLOW = [
  "src-tauri/src/modules/preview/gate.rs", // TcpStream::connect_timeout to 127.0.0.1 / ::1 only: "is a dev server listening"
];
// (6) the one sidecar file allowed to use the network (confirm-first SDK installer); must be named in privacy.md
export const SIDECAR_NET_FILE = "sidecar/src/sdk-install.ts";
// (8) the capability set recorded for the main window (test asserts the same literal)
export const EXPECTED_PERMISSIONS = ["core:default", "core:window:allow-start-dragging", "core:window:allow-toggle-maximize"];
// (10) hosts of crates/updater/src/endpoints.rs (updater-spec 4.6); a suffix entry starts with a dot
export const UPDATER_HOSTS = ["ferencfarkas09.github.io", "github.com", "raw.githubusercontent.com"];
export const UPDATER_HOST_SUFFIXES = [".githubusercontent.com"];
// the cfg-gated loopback hook (updater-spec 8.3) builds `http://127.0.0.1:<port>`; loopback never leaves the machine
export const UPDATER_LOOPBACK_HOSTS = ["127.0.0.1"];

const SKIP_DIRS = new Set(["node_modules", "target", "dist", "build", ".git", ".scratch", ".history", "coverage"]);
const IDLE_MARK = /idle-socket|\bS-10\b/i;

const posix = (p) => p.split(sep).join("/");

function read(root, rel) {
  const p = join(root, rel);
  try {
    if (!existsSync(p) || lstatSync(p).isDirectory()) return null;
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function walk(root, rel, accept, out = []) {
  const dir = join(root, rel);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.isSymbolicLink()) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(root, r, accept, out);
    } else if (e.isFile() && accept(r)) out.push(r);
  }
  return out;
}

const isJsTest = (r) =>
  /\.(test|spec)\.[cm]?[tj]sx?$/.test(r) || /(^|\/)(__tests__|__mocks__|mocks?|fixtures|e2e)\//.test(r) ||
  /(^|\/)(testkit|mock[A-Za-z]*|[A-Za-z]*\.mock)\.[tj]sx?$/.test(r) || /\.d\.ts$/.test(r);
const isRustTest = (r) =>
  /(^|\/)(tests|benches|examples)\//.test(r) || /(^|\/)(tests|test_[^/]*|[^/]*_tests?)\.rs$/.test(r);

function codeLines(text, lang) {
  let lines = text.split("\n");
  if (lang === "rs") {
    const cut = lines.findIndex((l) => /^#\[cfg\(test\)\]/.test(l));
    if (cut >= 0) lines = lines.slice(0, cut);
  }
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
    out.push([i + 1, lines[i]]);
  }
  return out;
}

const V = (check, file, line, detail) => ({ check, file, line, detail });
const P = (check, file, reason) => ({ pending: true, check, file, detail: reason });

// ---------- (1) lockfiles ----------
function denied(name) {
  const cands = [name];
  if (name.startsWith("@")) {
    const [scope, pkg] = name.slice(1).split("/");
    cands.push(scope, pkg || "");
  }
  return DENY_PACKAGES.find((d) =>
    cands.some((c) => (d.endsWith("*") ? c.startsWith(d.slice(0, -1)) : c === d)),
  );
}

export function cargoPackages(text) {
  const pkgs = [];
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^name = "([^"]+)"/m.exec(block)?.[1];
    if (!name) continue;
    const version = /^version = "([^"]+)"/m.exec(block)?.[1] ?? "";
    const dm = /^dependencies = \[([\s\S]*?)^\]/m.exec(block);
    const deps = dm ? [...dm[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
    pkgs.push({ name, version, deps });
  }
  return pkgs;
}

export function pnpmNames(text) {
  const names = new Set();
  let section = "";
  for (const line of text.split("\n")) {
    if (/^[A-Za-z]/.test(line)) section = line.replace(/:.*$/, "");
    if (section !== "packages" && section !== "snapshots") continue;
    const m = /^ {2}'?([^'\s][^']*?)'?:\s*$/.exec(line);
    if (!m) continue;
    const key = m[1].replace(/\(.*$/, "");
    const at = key.lastIndexOf("@");
    names.add(at > 0 ? key.slice(0, at) : key);
  }
  return names;
}

export function checkLockfiles(root) {
  const out = [];
  const cargo = read(root, "Cargo.lock");
  if (cargo) {
    for (const p of cargoPackages(cargo)) {
      const d = denied(p.name);
      if (d) out.push(V("lock-deny", "Cargo.lock", null, `package ${p.name} matches deny rule ${d}`));
    }
  }
  const locks = ["pnpm-lock.yaml"];
  for (const e of safeDirs(root)) locks.push(`${e}/pnpm-lock.yaml`);
  for (const rel of locks) {
    const t = read(root, rel);
    if (!t) continue;
    for (const n of pnpmNames(t)) {
      const d = denied(n);
      if (d) out.push(V("lock-deny", rel, null, `package ${n} matches deny rule ${d}`));
    }
  }
  return out;
}

function safeDirs(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// ---------- (2) + (8) CSP and capabilities ----------
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+\.localhost)$/i;
function loopbackSource(tok) {
  const m = /^http:\/\/([^/:]+|\[::1\])(:(\d+|\*))?\/?$/i.exec(tok);
  return !!m && LOOPBACK.test(m[1]);
}
const KEYWORD = /^'(self|none|unsafe-inline)'$/;

export function checkCsp(root) {
  const file = "src-tauri/tauri.conf.json";
  const t = read(root, file);
  if (t === null) return [P("csp", file, "file missing")];
  let conf;
  try {
    conf = JSON.parse(t);
  } catch {
    return [V("csp", file, null, "not valid JSON")];
  }
  const csp = conf?.app?.security?.csp ?? conf?.tauri?.security?.csp;
  if (typeof csp !== "string") return [V("csp", file, null, "no CSP string")];
  const out = [];
  for (const dir of csp.split(";").map((s) => s.trim()).filter(Boolean)) {
    const [name, ...toks] = dir.split(/\s+/);
    for (const tok of toks) {
      const ok = KEYWORD.test(tok) || tok === "ipc:" || tok === "data:" || loopbackSource(tok);
      if (!ok) out.push(V("csp", file, null, `directive ${name} has a source outside self/ipc:/data:/loopback`));
      if (name === "frame-src" && !loopbackSource(tok) && tok !== "'none'") {
        out.push(V("csp", file, null, "frame-src is not loopback-only"));
      }
    }
  }
  return out;
}

export function checkCapabilities(root) {
  const out = [];
  const dir = "src-tauri/capabilities";
  const files = walk(root, dir, (r) => r.endsWith(".json"));
  if (!files.length) return [P("capabilities", dir, "no capability files")];
  const perms = new Set();
  for (const f of files) {
    let j;
    try {
      j = JSON.parse(read(root, f));
    } catch {
      out.push(V("capabilities", f, null, "not valid JSON"));
      continue;
    }
    if ("remote" in j) out.push(V("capabilities", f, null, "has a remote section"));
    for (const p of j.permissions ?? []) {
      if (typeof p !== "string") out.push(V("capabilities", f, null, "non-string permission entry"));
      else perms.add(p);
    }
  }
  const extra = [...perms].filter((p) => !EXPECTED_PERMISSIONS.includes(p));
  const missing = EXPECTED_PERMISSIONS.filter((p) => !perms.has(p));
  for (const p of extra) out.push(V("capabilities", dir, null, `unrecorded permission ${p}`));
  for (const p of missing) out.push(V("capabilities", dir, null, `recorded permission ${p} no longer present (update the record)`));
  return out;
}

// ---------- (3) UI network APIs ----------
const UI_NET = [
  [/\bfetch\s*\(/, "fetch("],
  [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
  [/\bsendBeacon\b/, "sendBeacon"],
  [/\bnew\s+WebSocket\b/, "WebSocket"],
  [/\bEventSource\b/, "EventSource"],
];
// The git fetch IPC wrapper is a method call `.fetch(` (or a definition `fetch(...)` in a git IPC file)
// on the typed bindings object, not the browser API. Allowlisted by exact file name and pattern.
export const UI_FETCH_ALLOW = [/(^|\/)bindings(\.ts|\/)/];
// a typed declaration `fetch(repoId: string)` or a member call `x.fetch(` (never window./globalThis.)
export function isGitFetchWrapper(line) {
  if (/\b(window|globalThis|self)\.fetch\b/.test(line)) return false;
  return /^\s*(async\s+)?fetch\??\s*\(\s*\w+\??\s*:/.test(line) || /\w\.fetch\s*\(/.test(line);
}

export function checkUiSources(root) {
  const out = [];
  for (const f of walk(root, "ui/src", (r) => /\.[cm]?[tj]sx?$/.test(r) && !isJsTest(r))) {
    for (const [n, line] of codeLines(read(root, f), "js")) {
      for (const [re, label] of UI_NET) {
        if (!re.test(line)) continue;
        if (label === "fetch(" && (UI_FETCH_ALLOW.some((a) => a.test(f)) || isGitFetchWrapper(line))) continue;
        out.push(V("ui-net", f, n, `browser network API ${label}`));
      }
    }
  }
  return out;
}

// ---------- (6) sidecar ----------
const NODE_NET = [
  [/node:(http2?|https|net|tls|dgram|dns)\b/, "node network builtin"],
  [/\bfrom\s+["'](http2?|https|net|tls|dgram|dns)["']/, "node network builtin"],
  [/\brequire\(\s*["'](http2?|https|net|tls|dgram|dns)["']\s*\)/, "node network builtin"],
  [/\bfetch\s*\(/, "fetch("],
  [/\bWebSocket\b/, "WebSocket"],
  [/(?:\bfrom\s+|\brequire\(\s*|\bimport\(\s*)["'](?:node:)?(?:undici|node-fetch|axios|got|ky|superagent|needle)["']/, "HTTP client package"],
];

export function checkSidecar(root, privacy) {
  const out = [];
  for (const f of walk(root, "sidecar/src", (r) => /\.[cm]?[tj]sx?$/.test(r) && !isJsTest(r))) {
    if (f === SIDECAR_NET_FILE) {
      if (privacy !== null && !privacy.includes("sdk-install")) {
        out.push(V("sidecar-net", "docs/privacy.md", null, `${SIDECAR_NET_FILE} is not named`));
      }
      continue;
    }
    for (const [n, line] of codeLines(read(root, f), "js")) {
      for (const [re, label] of NODE_NET) if (re.test(line)) out.push(V("sidecar-net", f, n, label));
    }
  }
  return out;
}

// ---------- (4) manifests, (7) Rust sources and graph ----------
function crateOf(rel) {
  const m = /^crates\/([^/]+)\//.exec(rel);
  if (m) return m[1];
  if (rel.startsWith("src-tauri/")) return "src-tauri";
  return "";
}

export function manifestDeps(text) {
  const deps = new Set();
  let inDeps = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    const h = /^\[(.+)\]$/.exec(line);
    if (h) {
      const hd = h[1];
      const sub = /(?:^|\.)(?:dev-|build-)?dependencies\.([A-Za-z0-9_-]+)$/.exec(hd);
      if (sub) deps.add(sub[1]);
      inDeps = /(^|\.)(dev-|build-)?dependencies$/.test(hd);
      continue;
    }
    if (!inDeps) continue;
    const k = /^([A-Za-z0-9_-]+)\s*=/.exec(line);
    if (k) {
      deps.add(k[1]);
      const pk = /package\s*=\s*"([^"]+)"/.exec(line);
      if (pk) deps.add(pk[1]);
    }
  }
  return deps;
}

export function checkManifests(root) {
  const out = [];
  const files = ["Cargo.toml", ...walk(root, "crates", (r) => r.endsWith("/Cargo.toml")), ...walk(root, "src-tauri", (r) => r === "src-tauri/Cargo.toml")];
  for (const f of files) {
    const t = read(root, f);
    if (!t) continue;
    const crate = f === "Cargo.toml" ? "" : crateOf(f);
    if (ALLOWED_CRATES.includes(crate)) continue;
    for (const d of manifestDeps(t)) {
      if (NET_DEPS.includes(d)) out.push(V("cargo-net", f, null, `dependency ${d} outside the allowed crates`));
    }
  }
  return out;
}

const RUST_NET = [
  [/\bTcpStream\b/, "TcpStream"],
  [/\bUdpSocket\b/, "UdpSocket"],
  [/Command::new\(\s*"curl"/, "curl"],
  [/\buse\s+curl\b|\bcurl::/, "curl"],
  [/\bureq\b/, "ureq"],
];

export function checkRustSources(root) {
  const out = [];
  const files = [...walk(root, "crates", (r) => r.endsWith(".rs") && !isRustTest(r)), ...walk(root, "src-tauri/src", (r) => r.endsWith(".rs") && !isRustTest(r))];
  for (const f of files) {
    if (ALLOWED_CRATES.includes(crateOf(f)) || RUST_NET_ALLOW.includes(f)) continue;
    for (const [n, line] of codeLines(read(root, f), "rs")) {
      for (const [re, label] of RUST_NET) if (re.test(line)) out.push(V("rust-net", f, n, label));
    }
  }
  return out;
}

function allowedLockNames(root) {
  const names = new Set();
  for (const c of ALLOWED_CRATES) {
    const t = read(root, `crates/${c}/Cargo.toml`);
    const n = t && /^\s*name\s*=\s*"([^"]+)"/m.exec(t)?.[1];
    names.add(n || `intely-${c.replace(/_/g, "-")}`);
  }
  return names;
}

export function checkGraph(root) {
  const t = read(root, "Cargo.lock");
  if (t === null) return [P("graph", "Cargo.lock", "file missing")];
  const pkgs = cargoPackages(t);
  const byName = new Map();
  for (const p of pkgs) (byName.get(p.name) ?? byName.set(p.name, []).get(p.name)).push(p);
  if (!byName.has(ROOT_PACKAGE)) return [V("graph", "Cargo.lock", null, `root package ${ROOT_PACKAGE} not found`)];
  const allowed = allowedLockNames(root);
  const key = (p) => `${p.name}@${p.version}`;
  const resolve = (dep) => {
    const [name, version] = dep.split(" ");
    const c = byName.get(name) ?? [];
    return version ? c.filter((p) => p.version === version) : c;
  };
  const seen = new Set();
  const via = new Map();
  const queue = [...byName.get(ROOT_PACKAGE)];
  for (const r of queue) seen.add(key(r));
  const hits = new Map();
  while (queue.length) {
    const p = queue.shift();
    if (allowed.has(p.name)) continue; // do not descend: whatever they reach is reachable only through them
    for (const d of p.deps) {
      for (const q of resolve(d)) {
        if (IGNORED_EDGES.some(([a, b]) => a === p.name && b === q.name)) continue;
        if (seen.has(key(q))) continue;
        seen.add(key(q));
        via.set(key(q), p.name);
        if (GRAPH_WATCH.includes(q.name)) hits.set(q.name, p.name);
        queue.push(q);
      }
    }
  }
  return [...hits].map(([name, parent]) =>
    V("graph", "Cargo.lock", null, `${name} reachable without an allowed crate (nearest dependent: ${parent})`),
  );
}

// ---------- (5) + (9) privacy.md ----------
export function checkPrivacy(root, privacy) {
  const file = "docs/privacy.md";
  if (privacy === null) return [P("privacy", file, "docs/privacy.md is not written yet (task R10)")];
  const out = [];
  for (const c of ALLOWED_CRATES) {
    const variants = [c, c.replace(/_/g, "-")];
    if (!variants.some((v) => privacy.includes(v))) out.push(V("privacy", file, null, `allowed crate ${c} is not named`));
  }
  if (privacy.includes("ferencfarkas09.github.io") && !IDLE_MARK.test(privacy)) {
    out.push(V("privacy", file, null, "update-check sentence without the idle-socket result (packaging smoke S-10)"));
  }
  return out;
}

// ---------- (10) updater endpoints ----------
export function checkEndpoints(root) {
  const file = "crates/updater/src/endpoints.rs";
  const t = read(root, file);
  if (t === null) return [P("endpoints", file, "crates/updater is not built yet")];
  const out = [];
  const hostOk = (h) => UPDATER_HOSTS.includes(h) || UPDATER_LOOPBACK_HOSTS.includes(h) || UPDATER_HOST_SUFFIXES.some((s) => h.endsWith(s) && h.length > s.length);
  const lines = codeLines(t, "rs");
  for (const [n, line] of lines) {
    for (const m of line.matchAll(/"([^"\\]*)"/g)) {
      const lit = m[1];
      const url = /^https?:\/\/([^/?#:]+)/i.exec(lit);
      const host = url ? url[1].toLowerCase() : /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(lit) && !/\.(json|sig|tar|gz|rs|toml)$/i.test(lit) ? lit.toLowerCase() : null;
      if (host && !host.startsWith("{") && !hostOk(host)) out.push(V("endpoints", file, n, `host ${host} is not in the recorded list`));
      if (url && /[?#]/.test(lit)) out.push(V("endpoints", file, n, "URL literal carries a query string or fragment"));
    }
    if (/format!\(\s*"[^"]*:\/\/[^"]*\?/.test(line)) out.push(V("endpoints", file, n, "URL builder emits a query string"));
  }
  return out;
}

// ---------- driver ----------
export function runAll(root) {
  const privacy = read(root, "docs/privacy.md");
  const groups = [
    ["lock-deny", () => checkLockfiles(root)],
    ["csp", () => checkCsp(root)],
    ["ui-net", () => checkUiSources(root)],
    ["cargo-net", () => checkManifests(root)],
    ["privacy", () => checkPrivacy(root, privacy)],
    ["sidecar-net", () => checkSidecar(root, privacy)],
    ["rust-net", () => checkRustSources(root)],
    ["graph", () => checkGraph(root)],
    ["capabilities", () => checkCapabilities(root)],
    ["endpoints", () => checkEndpoints(root)],
  ];
  return groups.map(([id, fn]) => ({ id, items: fn() }));
}

function main(argv) {
  let root = DEFAULT_ROOT;
  let release = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") root = resolvePath(argv[++i] ?? "");
    else if (argv[i] === "--release") release = true;
    else if (argv[i] === "--json") json = true;
    else {
      console.error(`unknown argument: ${argv[i]}`);
      return 3;
    }
  }
  if (!existsSync(root)) {
    console.error(`root not found: ${root}`);
    return 3;
  }
  const res = runAll(root);
  let fails = 0;
  const lines = [];
  for (const g of res) {
    const bad = g.items.filter((x) => !x.pending);
    const pend = g.items.filter((x) => x.pending);
    for (const x of bad) {
      fails++;
      lines.push(`FAIL ${x.check} ${x.file}${x.line ? `:${x.line}` : ""}${x.detail ? ` ${x.detail}` : ""}`);
    }
    for (const x of pend) {
      if (release) {
        fails++;
        lines.push(`FAIL ${x.check} ${x.file} ${x.detail} (--release)`);
      } else lines.push(`PENDING ${x.check} ${x.file} ${x.detail}`);
    }
    if (!g.items.length) lines.push(`OK ${g.id}`);
  }
  if (json) console.log(JSON.stringify({ ok: fails === 0, results: res }, null, 2));
  else console.log(lines.join("\n"));
  console.log(`RESULT verify-no-telemetry ${fails ? "FAIL" : "OK"}`);
  return fails ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
export { relative as _relative };

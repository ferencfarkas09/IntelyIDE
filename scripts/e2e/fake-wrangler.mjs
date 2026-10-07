#!/usr/bin/env node
// A fake `wrangler` for the `cf` e2e scenario ((design notes: remote-cloudflare-spec) 11.4). It never contacts Cloudflare and reads no
// credential: the only network it touches is the loopback relay of the scenario. The app runs it through the INTELY_WRANGLER_BIN seam
// (E2E jail, inside the fixture root) with a scrubbed environment, so everything it needs is found next to its own file:
//
//   <FAKE_DIR>/bin/wrangler        this file (a copy)
//   <FAKE_DIR>/setup.json          { kit, serveDir, port, version, tokenMarker, accounts? }   written by scripts/e2e/run.sh setup_cf
//   <FAKE_DIR>/scenario.json       { loggedIn?, accounts?, nameCheck?, noSubdomain?, permission?, deployFail?, secretFail?, tamper? }
//   <FAKE_DIR>/state.json          { loggedIn }  (login writes it after a delay, logout clears it)
//   <FAKE_DIR>/calls.jsonl         one line per call: { ts, argv, bin, envNames, tokenInEnv, tokenMarkerInEnv, stdinSha256?, ... }
//   <FAKE_DIR>/secrets.json        { KEY: sha256 of the value read from stdin }   (hashes only, never values)
//
// `deploy` copies the staged dist (next to the --config file) into setup.serveDir, which the loopback relay serves as its static
// assets, so the Verify step compares like with like. Scenario flags: nameCheck "free" (default) | "foreign" | "mine-unstamped";
// noSubdomain, permission, deployFail, secretFail (booleans); tamper { file } swaps one served file after the copy ("sw.js" or any path).
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const self = realpathSync(process.argv[1]);
// next to its own file (<FAKE>/bin/wrangler), or, when it is the kit's node_modules/.bin copy (the READONLY + INTELY_CLOUD case), at <fixture>/fake
const FAKE = process.env.INTELY_FAKE_WRANGLER_DIR || (existsSync(join(dirname(dirname(self)), "setup.json")) ? dirname(dirname(self)) : join(dirname(self), "../../../../fake"));
const read = (f, d) => { try { return JSON.parse(readFileSync(join(FAKE, f), "utf8")); } catch { return d; } };
const setup = read("setup.json", null);
if (!setup) { console.error("fake wrangler: no setup.json next to " + self); process.exit(97); }
const scenario = read("scenario.json", {});
const args = process.argv.slice(2);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tokenInEnv = !!process.env.CLOUDFLARE_API_TOKEN;
const call = {
  ts: Date.now(),
  argv: args,
  bin: self,
  envNames: Object.keys(process.env).sort(),
  tokenInEnv,
  tokenMarkerInEnv: tokenInEnv && process.env.CLOUDFLARE_API_TOKEN === setup.tokenMarker,
  accountEnv: process.env.CLOUDFLARE_ACCOUNT_ID ?? null,
  cwd: process.cwd(),
  home: process.env.HOME ?? null,
};
const log = (extra = {}) => appendFileSync(join(FAKE, "calls.jsonl"), JSON.stringify({ ...call, ...extra }) + "\n");
const done = (code, extra) => { log({ exit: code, ...extra }); process.exit(code); };
const fail = (code, msg, extra) => { console.error(msg); done(code, extra); };

const accounts = scenario.accounts ?? setup.accounts ?? [
  { id: "a1b2c3d4e5f60718293a4b5c6d7e8f90", name: "E2E Personal" },
  { id: "0f9e8d7c6b5a49382716a5b4c3d2e1f0", name: "E2E Team" },
];
const state = () => read("state.json", { loggedIn: scenario.loggedIn === true });
const loggedIn = () => tokenInEnv || state().loggedIn === true;
const needLogin = () => fail(1, "You are not authenticated. Please run `wrangler login`.");

/** Reads a JSONC file the way wrangler does: comments are not inside strings. */
function jsonc(path) {
  const t = readFileSync(path, "utf8");
  let out = "", inStr = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i], n = t[i + 1];
    if (inStr) { out += c; if (c === "\\") out += t[++i]; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && n === "/") { while (i < t.length && t[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < t.length && !(t[i] === "*" && t[i + 1] === "/")) i++; i++; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function checkConfig(name) {
  const cfgPath = flag("--config");
  if (!cfgPath || !existsSync(cfgPath)) fail(2, "fake wrangler: --config file missing: " + cfgPath);
  const cfg = jsonc(cfgPath);
  if (cfg.name !== name) fail(2, `fake wrangler: config name ${cfg.name} differs from --name ${name}`);
  const base = dirname(cfgPath);
  const dist = join(base, "dist");
  if (!existsSync(join(dist, "bundle.json")) || !existsSync(join(dist, "index.html"))) fail(2, "fake wrangler: the staged dist is missing next to the config");
  const main = join(base, cfg.main ?? "kit/src/index.ts");
  if (!existsSync(main)) fail(2, "fake wrangler: main does not exist: " + main);
  return { cfg, base, dist, main };
}

/** The kit's own verifier on the staged dist (key pinned only by self-consistency here; the pin is the Mac's business). */
function verifyStaged(dist) {
  const r = spawnSync(process.execPath, [join(setup.kit, "remote-relay/scripts/verify-bundle.mjs"), "--dist", dist, "--json"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { /* below */ }
  if (r.status !== 0 || !j?.ok) fail(2, "fake wrangler: the staged bundle does not verify: " + (j?.reason ?? r.stderr ?? r.stdout));
  return j;
}

const cmd = args[0];
if (cmd === "--version" || cmd === "-v") {
  console.log(` ⛅️ wrangler ${setup.version}`);
  done(0);
}

if (cmd === "login") {
  const device = args.includes("--device");
  console.log(device ? "Attempting to login via OAuth (device flow)..." : "Attempting to login via OAuth...");
  console.log("Opening a link in your default browser: https://dash.cloudflare.com/oauth2/auth?response_type=code&client_id=fake-e2e&state=e2e-state-value&code_challenge=e2e");
  await sleep(scenario.loginDelayMs ?? 1500);
  writeFileSync(join(FAKE, "state.json"), JSON.stringify({ loggedIn: true }));
  console.log("Successfully logged in.");
  done(0);
}

if (cmd === "logout") {
  writeFileSync(join(FAKE, "state.json"), JSON.stringify({ loggedIn: false }));
  console.log("Successfully logged out.");
  done(0);
}

if (cmd === "whoami") {
  if (!loggedIn()) needLogin();
  console.log(JSON.stringify({ loggedIn: true, authType: tokenInEnv ? "API Token" : "OAuth Token", email: "e2e.user@example.test", accounts }));
  done(0);
}

if (cmd === "deployments" && args[1] === "list") {
  if (!loggedIn()) needLogin();
  const nc = scenario.nameCheck ?? "free";
  if (nc === "free") fail(1, "This Worker does not exist on your account. [code: 10007]");
  console.log("Created:     2026-01-01T00:00:00.000Z\nAuthor:      someone@example.test\nSource:      Upload\nMessage:     someone else's worker\nVersion(s):  (100%) 00000000-0000-0000-0000-000000000000");
  done(0);
}

if (cmd === "deploy") {
  const name = flag("--name");
  if (!loggedIn()) needLogin();
  const { dist, base } = checkConfig(name);
  if (args.includes("--dry-run")) {
    const outdir = flag("--outdir");
    if (!outdir) fail(2, "fake wrangler: --outdir missing");
    mkdirSync(outdir, { recursive: true });
    writeFileSync(join(outdir, "index.js"), "// fake bundle\n");
    // the module list the Mac checks: every source lies inside the snapshot
    writeFileSync(join(outdir, "index.js.map"), JSON.stringify({ version: 3, sources: [join(base, "kit/src/index.ts")], mappings: "" }));
    console.log("Total Upload: 1.00 KiB / gzip: 0.50 KiB\n--dry-run: exiting now.");
    done(0);
  }
  if (!flag("--message")?.startsWith("intely-relay:")) fail(2, "fake wrangler: the deployment message stamp is missing");
  const outFile = process.env.WRANGLER_OUTPUT_FILE_PATH;
  if (scenario.permission) fail(1, "A request to the Cloudflare API (/accounts/x/workers/scripts/y) failed.\nYou do not have permission to do this. [code: 10023]");
  if (scenario.noSubdomain) fail(1, "You need to register a workers.dev subdomain before publishing to workers.dev [code: 10063]");
  if (scenario.deployFail) {
    if (outFile) appendFileSync(outFile, JSON.stringify({ type: "command-failed", version: 1, code: 10000, message: "Authentication error" }) + "\n");
    fail(1, "Deploy failed on purpose (fake wrangler scenario)");
  }
  const v = verifyStaged(dist);
  // publish: the loopback relay serves setup.serveDir
  // (the directory itself stays: the relay's asset watcher follows the path)
  mkdirSync(setup.serveDir, { recursive: true });
  for (const e of readdirSync(setup.serveDir)) rmSync(join(setup.serveDir, e), { recursive: true, force: true });
  cpSync(dist, setup.serveDir, { recursive: true });
  // every published file is probed (not _headers/_redirects, which the asset server consumes): the relay's asset cache may still hold the previous deploy's copy of any of them
  let listed = [];
  try { listed = JSON.parse(readFileSync(join(setup.serveDir, "bundle.json"), "utf8")).files.map((f) => f.path).filter((f) => f !== "_headers" && f !== "_redirects"); } catch {}
  const probes = ["bundle.json", ...listed];
  if (scenario.tamper?.file) {
    const f = join(setup.serveDir, scenario.tamper.file);
    writeFileSync(f, readFileSync(f, "utf8") + "\n/* tampered after signing */\n");
    if (!probes.includes(scenario.tamper.file)) probes.push(scenario.tamper.file);
  }
  // wrangler returns when the version is live: wait until the relay serves what was just published
  const deadline = Date.now() + 45_000;
  for (;;) {
    let ok = true;
    for (const p of probes) {
      try {
        const r = await fetch(`http://127.0.0.1:${setup.port}/${p}`, { cache: "no-store" });
        if (!r.ok || sha(Buffer.from(await r.arrayBuffer())) !== sha(readFileSync(join(setup.serveDir, p)))) ok = false;
      } catch { ok = false; }
    }
    if (ok) break;
    if (Date.now() > deadline) fail(1, "fake wrangler: the loopback relay did not pick up the published files");
    await sleep(300);
  }
  if (outFile) {
    appendFileSync(outFile, JSON.stringify({ type: "wrangler-session", version: 1, wrangler_version: setup.version }) + "\n");
    appendFileSync(outFile, JSON.stringify({ type: "deploy", version: 1, worker_name: name, version_id: "e2e-" + sha(String(Date.now())).slice(0, 12), targets: [`http://127.0.0.1:${setup.port}`] }) + "\n");
  }
  console.log(`Uploaded ${name}\nDeployed ${name} triggers\n  http://127.0.0.1:${setup.port}`);
  done(0, { deployedManifest: v.hash, tampered: scenario.tamper?.file ?? null, served: readdirSync(setup.serveDir).length });
}

if (cmd === "secret" && args[1] === "put") {
  const key = args[2];
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const value = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  const secrets = read("secrets.json", {});
  if (scenario.secretFail && key === "VAPID_PUBLIC_KEY") fail(1, "A request to the Cloudflare API failed. [code: 10000]", { key, stdinSha256: sha(value) });
  secrets[key] = sha(value);
  writeFileSync(join(FAKE, "secrets.json"), JSON.stringify(secrets));
  console.log(`Success! Uploaded secret ${key}`);
  done(0, { key, stdinSha256: sha(value), stdinBytes: value.length });
}

if (cmd === "delete") {
  if (!loggedIn()) needLogin();
  if (!args.includes("--force")) { for await (const _ of process.stdin) { /* the confirmation answer */ } }
  console.log("Successfully deleted " + flag("--name"));
  done(0);
}

if (cmd === "rollback") {
  if (!loggedIn()) needLogin();
  console.log("Successfully rolled back");
  done(0);
}

fail(64, "fake wrangler: unsupported command: " + args.join(" "));

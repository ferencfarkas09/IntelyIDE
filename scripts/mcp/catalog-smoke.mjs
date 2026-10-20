#!/usr/bin/env node
// Starts every program of the MCP catalog (ui/src/modules/mcp/catalog.json) the way the IDE would, does the MCP handshake
// (initialize, then tools/list) and reports what answered. Run it when an entry is added or a pinned version is bumped.
//   node scripts/mcp/catalog-smoke.mjs [--file catalog.json] [--only id,id] [--latest] [--timeout 120] [--json]
// stdio entries are started with dummy values for their secrets, a scratch HOME and a scratch working directory, and are
// killed afterwards. http entries are only listed (they need the service, and an account for most). --latest compares each
// pinned package with the newest version on the npm registry and does not start anything. Exit: 0 all answered, 1 a failure.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const file = resolve(value("--file", join(HERE, "../../ui/src/modules/mcp/catalog.json")));
const only = value("--only", "")?.split(",").filter(Boolean);
const timeoutMs = Number(value("--timeout", "120")) * 1000;
const entries = JSON.parse(readFileSync(file, "utf8")).filter((e) => !only?.length || only.includes(e.id));

/** What a program needs to reach a registry behind a proxy or a company certificate; nothing else of this environment is handed on. */
const NETWORK_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "npm_config_cafile", "npm_config_registry", "npm_config_proxy", "npm_config_https_proxy"];
/** Shared by the runs, so a package is downloaded once. */
const NPM_CACHE = join(tmpdir(), "intely-mcp-smoke-npm-cache");

/** `pkg@1.2.3` or `@scope/pkg@1.2.3` among the arguments of an npx entry. */
const pinnedPackage = (e) => {
  const arg = (e.args ?? []).find((a) => !a.startsWith("-"));
  const at = arg?.lastIndexOf("@") ?? -1;
  return arg && at > 0 ? { name: arg.slice(0, at), version: arg.slice(at + 1) } : null;
};

function latest() {
  let behind = 0;
  for (const e of entries.filter((x) => x.command === "npx")) {
    const pkg = pinnedPackage(e);
    if (!pkg) {
      console.log(`?    ${e.id}: no pinned package in the arguments`);
      continue;
    }
    const view = (field) => spawnSync("npm", ["view", pkg.name, field], { encoding: "utf8" });
    const version = view("version");
    const info = { version: version.stdout.trim(), deprecated: view("deprecated").stdout.trim() };
    if (version.status !== 0 || !info.version) {
      console.log(`?    ${e.id}: the registry did not answer for ${pkg.name}`);
      continue;
    }
    const newer = info.version !== pkg.version;
    if (newer || info.deprecated) behind++;
    console.log(`${info.deprecated ? "DEPR" : newer ? "NEW " : "ok  "} ${e.id}: ${pkg.name} pinned ${pkg.version}, registry ${info.version}${info.deprecated ? " (deprecated)" : ""}`);
  }
  return behind;
}

/** One stdio server: spawn it, handshake, list the tools, kill the process group. */
function probe(e) {
  return new Promise((done) => {
    const home = mkdtempSync(join(tmpdir(), "intely-mcp-smoke-"));
    const env = { PATH: process.env.PATH, HOME: home, TMPDIR: home, CI: "1", npm_config_cache: NPM_CACHE, npm_config_update_notifier: "false", npm_config_audit: "false", npm_config_fund: "false" };
    for (const name of NETWORK_VARS) if (process.env[name] !== undefined) env[name] = process.env[name];
    for (const v of e.env ?? []) env[v.name] = v.smoke ?? (v.secret ? "dummy-value-for-the-smoke-test" : (v.value ?? ""));
    const started = Date.now();
    const child = spawn(e.command, e.args ?? [], { cwd: home, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let buffer = "";
    let stderr = "";
    let finished = false;
    const result = { id: e.id };
    const finish = (extra) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      rmSync(home, { recursive: true, force: true });
      done({ ...result, ms: Date.now() - started, ...extra });
    };
    const timer = setTimeout(() => finish({ ok: false, error: `no answer within ${timeoutMs / 1000} s`, stderr: stderr.slice(-300) }), timeoutMs);
    const send = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
    child.on("error", (err) => finish({ ok: false, error: `could not start: ${err.message}` }));
    child.on("exit", (code) => finish({ ok: false, error: `exited with code ${code} before it answered`, stderr: stderr.slice(-300) }));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.on("data", (d) => {
      buffer += d;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1 && msg.result) {
          result.server = `${msg.result.serverInfo?.name ?? "?"} ${msg.result.serverInfo?.version ?? ""}`.trim();
          result.protocol = msg.result.protocolVersion;
          send({ method: "notifications/initialized" });
          send({ id: 2, method: "tools/list", params: {} });
        } else if (msg.id === 1 && msg.error) {
          finish({ ok: false, error: `initialize refused: ${msg.error.message}` });
        } else if (msg.id === 2) {
          const tools = msg.result?.tools ?? [];
          finish({ ok: !msg.error, tools: tools.length, sample: tools.slice(0, 4).map((t) => t.name), ...(msg.error ? { error: msg.error.message } : {}) });
        }
      }
    });
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "intely-catalog-smoke", version: "1" } } });
  });
}

if (flag("--latest")) process.exit(latest() ? 1 : 0);

const results = [];
for (const e of entries) {
  if (e.transport === "http") {
    results.push({ id: e.id, skipped: "http: needs the service (and usually an account)" });
    continue;
  }
  process.stderr.write(`starting ${e.id} ...\n`);
  results.push(await probe(e));
}
if (flag("--json")) console.log(JSON.stringify(results, null, 2));
else {
  for (const r of results) {
    if (r.skipped) console.log(`skip ${r.id}: ${r.skipped}`);
    else if (r.ok) console.log(`ok   ${r.id}: ${r.server} (MCP ${r.protocol}), ${r.tools} tools, ${(r.ms / 1000).toFixed(1)} s  [${r.sample.join(", ")}${r.tools > r.sample.length ? ", ..." : ""}]`);
    else console.log(`FAIL ${r.id}: ${r.error}${r.stderr ? `\n       ${r.stderr.replace(/\s+/g, " ").trim()}` : ""}`);
  }
}
process.exit(results.some((r) => r.ok === false) ? 1 : 0);

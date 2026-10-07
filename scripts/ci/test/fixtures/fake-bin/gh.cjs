// Fake `gh` for the verify-tag and verify-repo-settings tests (no network, no login).
//
// Supported:  gh api [-X GET] <endpoint> [--jq <expr>]    gh repo view --json nameWithOwner --jq .nameWithOwner
// Fixtures:   $FAKE_GH_DIR/<endpoint without query, "/" replaced by "__">.json
//             optional per-call sequence: <name>.json.1, .json.2, ... (the n-th call with the same endpoint and
//             --jq expression reads .json.<n>, or the highest existing one)
//             <name>.err: the call fails with that text on stderr (for example "gh: Not Found (HTTP 404)")
//             a missing fixture fails with "gh: Not Found (HTTP 404)"
// Every call is logged to $FAKE_LOG as `gh <METHOD> <endpoint>`; a method other than GET is also logged as
// `WRITE-ATTEMPT`, so the tests can prove that only reads happened.
// The --jq subset is what the scripts use: dotted paths with optional [] iteration (`.a.b`, `.a[].c`).
"use strict";
const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const dir = process.env.FAKE_GH_DIR || "";
const logFile = process.env.FAKE_LOG || "";
const log = (line) => { if (logFile) fs.appendFileSync(logFile, line + "\n"); };

function fail(msg, code) { process.stderr.write(msg + "\n"); process.exit(code || 1); }

function evalJq(expr, data) {
  const e = expr.trim();
  if (e === ".") return [data];
  if (!/^(\.[A-Za-z_][A-Za-z0-9_]*|\[\])+$/.test(e)) fail(`fake gh: unsupported --jq expression ${e}`, 98);
  const tokens = e.match(/\.[A-Za-z_][A-Za-z0-9_]*|\[\]/g);
  let cur = [data];
  for (const t of tokens) {
    const next = [];
    for (const v of cur) {
      if (t === "[]") { if (Array.isArray(v)) next.push(...v); }
      else { next.push(v !== null && typeof v === "object" ? (v[t.slice(1)] === undefined ? null : v[t.slice(1)]) : null); }
    }
    cur = next;
  }
  return cur;
}
const show = (v) => (typeof v === "string" ? v : JSON.stringify(v));

if (argv[0] === "repo" && argv[1] === "view") {
  log("gh GET repo-view");
  process.stdout.write((process.env.FAKE_REPO || "example-org/example-repo") + "\n");
  process.exit(0);
}
if (argv[0] !== "api") fail(`fake gh: unexpected command ${argv.join(" ")}`, 99);

let method = "GET";
let jq = null;
let endpoint = null;
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-X" || a === "--method") method = argv[++i];
  else if (a === "--jq" || a === "-q") jq = argv[++i];
  else if (a.startsWith("-")) { /* flags like --paginate are ignored */ if (a === "-f" || a === "-F" || a === "--input") method = method === "GET" ? "POST" : method; }
  else endpoint = a;
}
if (!endpoint) fail("fake gh: no endpoint", 99);
log(`gh ${method} ${endpoint}`);
if (method !== "GET") { log(`WRITE-ATTEMPT ${method} ${endpoint}`); fail("fake gh: refusing a non-GET request", 97); }

const name = endpoint.split("?")[0].replace(/^\//, "").replace(/\//g, "__");
const seqKey = name + "-" + (jq || "").replace(/[^A-Za-z0-9]/g, "_");
const counterFile = path.join(dir, `.count-${seqKey}`);
let n = 1;
try { n = parseInt(fs.readFileSync(counterFile, "utf8"), 10) + 1; } catch { n = 1; }
fs.writeFileSync(counterFile, String(n));

const errFile = path.join(dir, name + ".err");
if (fs.existsSync(errFile)) fail(fs.readFileSync(errFile, "utf8").trim());

let file = path.join(dir, name + ".json");
const seq = [];
for (let i = 1; fs.existsSync(`${file}.${i}`); i++) seq.push(`${file}.${i}`);
if (seq.length) file = seq[Math.min(n, seq.length) - 1];
if (!fs.existsSync(file)) fail("gh: Not Found (HTTP 404)");

const raw = fs.readFileSync(file, "utf8");
if (jq === null) { process.stdout.write(raw.endsWith("\n") ? raw : raw + "\n"); process.exit(0); }
let data;
try { data = JSON.parse(raw); } catch { fail("fake gh: fixture is not JSON", 99); }
for (const v of evalJq(jq, data)) process.stdout.write(show(v) + "\n");

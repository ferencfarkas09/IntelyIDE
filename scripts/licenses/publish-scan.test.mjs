import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileAllowlist, compileLocalNeedles, entropy, scan, windows, WINDOW } from "./publish-scan.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCAN = join(HERE, "publish-scan.mjs");
const GENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// Seeded values are assembled at runtime so this file stays clean under its own scan.
const SECRET = "s3cretPassw0rd";
const JWT = "eyJhbGciOiJIUzI1" + ".eyJzdWIiOiIxMjM0NTY3" + ".SflKxwRJSMeKKF2QT4fw";
const SEEDS = {
  "private-key": "-----BEGIN " + "RSA PRIVATE KEY-----",
  "pem-block": "-----BEGIN " + "CERTIFICATE-----",
  "mongodb-credentials": "uri = mongodb+srv://admin:" + SECRET + "@cluster.example.net/db",
  "url-credentials": "broker = mqtt://u:" + "pw@host",
  jwt: "t = " + JWT,
  "owner-path": "cwd = /" + "Users/carol/project",
  "anthropic-key": "k = sk-" + "ant-api03-AbCdEf123456",
  "github-token": "t = gh" + "p_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
  "aws-access-key": "k = AK" + "IA" + "ABCDEFGHIJKLMNOP",
  "cloudflare-token": "t = cf" + "ut_" + "a1B2c3D4e5F6g7H8i9J0k1L2",
  "npm-token": "t = np" + "m_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5",
  "npm-auth-token": "//registry.example.test/:_auth" + "Token=abc",
  "slack-token": "t = xo" + "xb-1234567890-abcdefghij",
  "google-api-key": "k = AI" + "za" + "x".repeat(35),
  "stripe-key": "k = sk" + "_live_" + "abc",
  "openai-project-key": "k = sk-" + "proj-abc",
  "bearer-token": "Authorization: Bear" + "er abcdefghijklmnopqrstuvwx",
  "basic-auth-header": "Authorization: " + "Basic dXNlcjpwdw==",
  "credential-assignment": "pass" + "word = 'hunter2hunter2'",
  "token-assignment": "client" + "_secret = 'abcdefghijkl1234'",
  "password-text": "row.pass" + "wordText = x",
  "personal-email": "me: jane.doe" + "@gmail.com",
  "email-address": "mail bob" + "@acme-corp.hu",
  // provider token shapes added after the R4 verifier round
  "aws-secret-key": "aws_secret" + "_access_key = '" + "Ab".repeat(20) + "'",
  "gitlab-token": "t = glp" + "at-" + "AbCdEf".repeat(4),
  "huggingface-token": "t = hf" + "_" + "AbCdEf".repeat(6),
  "sendgrid-key": "k = S" + "G." + "A".repeat(20) + "." + "B".repeat(20),
  "twilio-sid": "s = A" + "C" + "0123456789abcdef".repeat(2),
  "mailgun-key": "k = ke" + "y-" + "0123456789abcdef".repeat(2),
  "telegram-bot-token": "t = 1234567890" + ":" + "A".repeat(35),
  "discord-bot-token": "t = M" + "A".repeat(23) + "." + "B".repeat(6) + "." + "C".repeat(27),
  "slack-webhook": "u = https://hooks.slack" + ".com/services/" + "T0AAAAAAA/B0BBBBBBB/" + "C".repeat(24),
  "openai-legacy-key": "k = sk" + "-" + "A".repeat(48),
  "google-oauth-secret": "k = GOC" + "SPX-" + "A".repeat(28),
  "digitalocean-token": "t = dop" + "_v1_" + "a".repeat(64),
  "pypi-token": "t = pypi" + "-AgEI" + "A".repeat(40),
  "shopify-token": "t = shp" + "at_" + "a".repeat(32),
  "linear-key": "k = lin" + "_api_" + "A".repeat(40),
  "notion-secret": "k = sec" + "ret_" + "A".repeat(43),
  "azure-storage-key": "c = Account" + "Key=" + "A".repeat(44) + "==",
  "minisign-secret-key": "# untrusted comment: " + "minisign " + ["encrypted", "secret", "key"].join(" "),
  "secret-env-assignment": "APPLE_CERT" + "IFICATE=" + "MIIAb1".repeat(8),
};
const ENTROPY_TOKEN = "aB3dE9fG1hJ7kL5mN2pQ8rS4tU6vW0xYz";
const UUID = "123e4567-e89b-12d3-a456-426614174000";
const CLEAN_NEAR_MISSES = [
  "see https://example.com/home/page and http://localhost:3000/x and git@host:repo",
  "cwd = /" + "Users/you/project and /" + "Users/example/x and /" + "Users/user/x",
  "runner at /home/runner/work and /home/you/x and a route /api/home/list",
  "path C:\\\\" + "Users\\\\name\\\\x and C:\\" + "Users\\Public\\x",
  "contact noreply@" + "example.com, bot@users.noreply.github.com, a@noreply.github.com, me@" + "anthropic.com, x@host.test, y@db.example.net",
  "icon@" + "2x.png and lodash@4.17.21 and react@18.x and @scope/pkg@latest",
  "a sk_ prefix, sk-ant, AIza too short, xattr -l file, 'Basic' auth word",
  "-----BEGIN " + "-----",
  "not-a-url://host:8080/path and https://host:8080/x and ssh://git@host:22/x",
];

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), "publish-scan-"));
  dirs.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root, env: GENV });
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  execFileSync("git", ["add", "-A"], { cwd: root, env: GENV });
  return root;
}
const run = (args) => spawnSync(process.execPath, [SCAN, ...args], { encoding: "utf8", env: GENV });
const rules = (res) => res.hits.map((h) => h.rule).sort();

function seeded() {
  const files = {};
  for (const [rule, text] of Object.entries(SEEDS)) files[`src/${rule}.txt`] = `ok\n${text}\n`;
  files["fixtures/blob.txt"] = `ok\nkey ${ENTROPY_TOKEN}\n`;
  files["spikes/sdk/evidence/run.json"] = `{"session":"${UUID}"}\n`;
  files["docs/PROGRESS.md"] = "x\n";
  files["docs/MORNING.md"] = "x\n";
  files["README.md"] = "clean\n";
  return files;
}

test("one seeded hit per rule exits 1, reports file:line + rule, never the value", () => {
  const root = repo(seeded());
  const r = run(["--root", root]);
  assert.equal(r.status, 1);
  for (const rule of Object.keys(SEEDS)) assert.match(r.stdout, new RegExp(`src/${rule}\\.txt:2 ${rule}`));
  assert.match(r.stdout, /fixtures\/blob\.txt:2 high-entropy-fixture/);
  assert.match(r.stdout, /spikes\/sdk\/evidence\/run\.json:1 session-id-evidence/);
  assert.match(r.stdout, /docs\/PROGRESS\.md: TRACKED/);
  assert.match(r.stdout, /docs\/MORNING\.md: TRACKED/);
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp([SECRET, ENTROPY_TOKEN, UUID, "bob", "carol", "jane.doe", "acme-corp", "SflKxwRJ", "hunter2"].join("|")));
  assert.doesNotMatch(r.stdout, /README/);
});

test("each seeded line triggers exactly its own rule (no accidental double reports)", () => {
  for (const [rule, text] of Object.entries(SEEDS)) {
    const res = scan(repo({ "src/a.txt": `${text}\n` }));
    assert.deepEqual(rules(res), [rule], rule);
  }
});

test("signing secrets in environment style are caught (upper-case names with SECRET/PRIVATE_KEY/CERTIFICATE)", () => {
  const b64 = Buffer.from("untrusted comment: rsign " + ["encrypted", "secret", "key"].join(" ") + "\nRWRTY0" + "Iy" + "A1".repeat(30)).toString("base64");
  const cases = [
    ["TAURI_SIGNING_PRIVATE" + "_KEY=" + b64, ["minisign-secret-key", "token-assignment"]],
    ["export SIGNING_PRIVATE" + "_KEY=" + "Ab1".repeat(10), ["token-assignment"]],
    ["AWS_SECRET" + "_ACCESS_KEY=" + "Ab1".repeat(14), ["aws-secret-key", "secret-env-assignment"]],
    ["STRIPE_SECRET" + "='" + "Ab1".repeat(10) + "'", ["secret-env-assignment"]],
    ["hex secret" + "_key = '" + "a1".repeat(16) + "'", []],
    ["rk" + "_live_" + "abc and whsec" + "_" + "A".repeat(20), ["stripe-key"]],
  ];
  for (const [text, expect] of cases) {
    const got = new Set(rules(scan(repo({ "src/a.txt": text + "\n" }))));
    for (const r of expect) assert.ok(got.has(r), `${r} missing for ${text.slice(0, 24)}: ${[...got]}`);
    if (expect.length) assert.ok(got.size >= 1);
  }
});

test("the public minisign comment lines and placeholders are not secrets", () => {
  const ok = [
    "untrusted comment: " + "minisign public key: ABCDEF0123456789",
    "untrusted comment: signature from tauri " + "secret key",
    "APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}",
    "APPLE_CERTIFICATE=$APPLE_CERTIFICATE_BASE64_VALUE_FROM_ENV_1",
    "TAURI_SIGNING_PRIVATE" + "_KEY=<paste the key here 12345678>",
  ];
  assert.deepEqual(scan(repo({ "src/a.txt": ok.join("\n") + "\n" })).hits, []);
});

test("worktree and list modes never open an .env file (reported as unscanned, even when unreadable)", () => {
  const root = repo({ "src/a.txt": "ok\n", ".env.example": "A=1\n" });
  writeFileSync(join(root, ".env"), "TOKEN=" + "a".repeat(40) + "\n");
  execFileSync("git", ["add", "-f", ".env"], { cwd: root, env: GENV });
  chmodSync(join(root, ".env"), 0o000);
  const res = scan(root, [], { source: "worktree" });
  assert.deepEqual(res.hits.map((h) => `${h.file}:${h.rule}`), [".env:unscanned"]);
  const list = scan(root, [], { source: "list", files: ["src/a.txt", ".env", "sub/.env.local", ".env.example"] });
  assert.deepEqual(list.hits.map((h) => `${h.file}:${h.rule}`), [".env:unscanned"]);
});

test("negatives: near misses, generic example paths and reserved e-mail domains stay clean", () => {
  const res = scan(repo({ "src/a.txt": CLEAN_NEAR_MISSES.join("\n") + "\n" }));
  assert.deepEqual(res.hits, []);
});

test("negative: gatekeeper advice is only flagged in doc text files", () => {
  const advice = ["run xattr -dr com.apple.quarantine App.app", "sudo spctl --add x", "spctl --master-disable"];
  const doc = scan(repo({ "docs/install.md": advice.join("\n") + "\n" }));
  assert.deepEqual(doc.hits.map((h) => `${h.line}:${h.rule}`), ["1:gatekeeper-advice", "2:gatekeeper-advice", "3:gatekeeper-advice"]);
  assert.deepEqual(scan(repo({ "scripts/notes.rs": advice.join("\n") + "\n", "docs/ok.md": "xattr -l file\n" })).hits, []);
});

test("owner-path: home directories and Windows profiles are flagged, generic examples are not", () => {
  const body = ["/home/" + "carol/work", "C:\\\\" + "Users\\\\dave\\\\x", "C:\\" + "Users\\erin\\x"].join("\n") + "\n";
  assert.deepEqual(scan(repo({ "a.txt": body })).hits.map((h) => `${h.line}:${h.rule}`), ["1:owner-path", "2:owner-path", "3:owner-path"]);
});

test("allowlisted fixture exits 0", () => {
  const root = repo({ "src/a.txt": SEEDS["owner-path"] + "\n", "docs/notes.md": "clean\n" });
  const al = join(root, "allow.json");
  writeFileSync(al, JSON.stringify({ allow: [{ path: "src/**", rule: "owner-path", reason: "documented example" }] }));
  const r = run(["--root", root, "--allowlist", al]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /0 hits, 1 allowlisted/);
});

test("allowlist is rule specific and needs a reason", () => {
  const root = repo({ "src/a.txt": SEEDS.jwt + "\n" });
  const wrongRule = scan(root, [{ path: "src/**", rule: "owner-path", reason: "x" }]);
  assert.equal(wrongRule.counts.jwt, 1);
  assert.throws(() => compileAllowlist([{ path: "a", rule: "jwt", reason: " " }]), /reason/);
  assert.throws(() => compileAllowlist([{ path: "a", rule: "jwt" }]), /reason/);
});

test("allowlist: rule * is accepted only for the two crypto-vector fixture trees", () => {
  assert.doesNotThrow(() => compileAllowlist([{ path: "remote-relay/tests/fixtures/**", rule: "*", reason: "vectors" }]));
  assert.doesNotThrow(() => compileAllowlist([{ path: "crates/relay_bundle/tests/fixtures/**", rule: "*", reason: "vectors" }]));
  for (const path of ["crates/remote/tests/**", "**/tests/**", "src/**", "**"]) assert.throws(() => compileAllowlist([{ path, rule: "*", reason: "x" }]), /only allowed/, path);
});

test("the shipped allowlist is valid: every entry has a reason and rule * stays on the fixture trees", () => {
  const j = JSON.parse(readFileSync(join(HERE, "publish-scan.json"), "utf8"));
  assert.ok(j.allow.length > 0);
  assert.doesNotThrow(() => compileAllowlist(j.allow));
  for (const e of j.allow) assert.ok(e.reason.trim().length > 8, `${e.path} ${e.rule}`);
  // a broad tests glob must be per rule, never a catch-all
  assert.ok(!j.allow.some((e) => e.rule === "*" && /\*\*\/tests|crates\/remote/.test(e.path)));
});

test("clean tree, image files and untracked private paths are not flagged", () => {
  const root = repo({ "a.txt": "hello\n", "img.png": Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(SEEDS.jwt)]), "ico.icns": Buffer.from([0, 0, 0]), "f.woff2": Buffer.from([0, 1]) });
  const res = scan(root);
  assert.deepEqual(res.hits, []);
  assert.deepEqual(res.privateTracked, []);
});

test("a PNG-named file is ignored by the text scanner even when it holds a secret as text", () => {
  assert.deepEqual(scan(repo({ "shot.png": SEEDS.jwt + "\n", "big.png": Buffer.alloc(5 * 1024 * 1024, 65) })).hits, []);
});

test("tracked .scratch paths are reported", () => {
  const root = repo({ ".scratch/x.log": "n\n" });
  assert.deepEqual(scan(root).privateTracked, [".scratch/x.log"]);
});

test("entropy heuristic: hashes and words pass, random mixed tokens flag", () => {
  assert.ok(entropy(ENTROPY_TOKEN) >= 4.5);
  const root = repo({ "fixtures/h.txt": "sha " + "a".repeat(40) + " " + "0123456789abcdef".repeat(4) + "\nsome_long_identifier_name_for_a_test_function\n" });
  assert.deepEqual(scan(root).hits, []);
});

test("credential-assignment ignores placeholders and empty values", () => {
  const body = ["pass" + "word = ''", "pass" + "word: <your password>", "secret = ${SECRET}", "api_key = xxxxxxxx", "pass" + "word=redacted", "const secret = someVariableName;", "secret: \"changes.guard.secret\"", "const secret = makeSecret();"].join("\n") + "\n";
  assert.deepEqual(scan(repo({ "src/a.ts": body })).hits, []);
});

test("environment problem exits 3 for a bad allowlist", () => {
  const root = repo({ "a.txt": "x\n" });
  const al = join(root, "bad.json");
  writeFileSync(al, JSON.stringify({ allow: [{ path: "a" }] }));
  assert.equal(run(["--root", root, "--allowlist", al]).status, 3);
});

// ---- blind spots ((design notes: public-release-spec) 3.6 item 6)

test("windows: a short line is one window, a long one overlaps by 1 KiB and covers every character", () => {
  assert.deepEqual([...windows("abc")], ["abc"]);
  const long = "x".repeat(3 * WINDOW + 5);
  const w = [...windows(long)];
  assert.ok(w.length >= 4);
  assert.ok(w.every((s) => s.length <= WINDOW));
  assert.equal(w[0].length, WINDOW);
});

test("a 30 000 char single-line JSON is scanned: secrets deep in the line and across a window boundary are found", () => {
  const filler = '"a":1,'.repeat(5000); // 30 000 chars
  const deep = `{${filler}"t":"${JWT}"}`;
  assert.ok(deep.length > 30000);
  assert.deepEqual(rules(scan(repo({ "data/deep.json": deep }))), ["jwt"]);
  const at = WINDOW - 10; // the token straddles the end of the first window
  const straddle = "y".repeat(at) + " " + JWT + "z".repeat(20000);
  assert.deepEqual(rules(scan(repo({ "data/straddle.json": straddle }))), ["jwt"]);
  assert.deepEqual(scan(repo({ "data/clean.json": `{${filler}}` })).hits, []);
});

test("a 5 MiB text file and a NUL-containing non-image file FAIL as unscanned, never skip silently", () => {
  const root = repo({ "big.txt": "a".repeat(5 * 1024 * 1024) + "\n", "blob.dat": Buffer.concat([Buffer.from("ok"), Buffer.from([0]), Buffer.from("ok")]), "small.txt": "fine\n" });
  const res = scan(root);
  assert.deepEqual(res.hits.map((h) => `${h.file} ${h.rule}`).sort(), ["big.txt unscanned", "blob.dat unscanned"]);
  const r = run(["--root", root]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /big\.txt:0 unscanned/);
  // a reviewed entry with a reason can accept one of them, and only that one
  const res2 = scan(root, [{ path: "blob.dat", rule: "unscanned", reason: "binary test blob" }]);
  assert.deepEqual(res2.hits.filter((h) => !h.allowed).map((h) => h.file), ["big.txt"]);
});

test("a NUL after the first 8 KiB is still unscanned", () => {
  const buf = Buffer.concat([Buffer.from("a".repeat(9000)), Buffer.from([0]), Buffer.from("tail")]);
  assert.deepEqual(rules(scan(repo({ "late.bin": buf }))), ["unscanned"]);
});

test("the default read path is the INDEX: a staged secret is found although the work tree is clean, and the reverse", () => {
  const root = repo({ "a.txt": `${SEEDS.jwt}\n`, "b.txt": "clean\n" });
  writeFileSync(join(root, "a.txt"), "clean now\n"); // unstaged fix
  writeFileSync(join(root, "b.txt"), `${SEEDS.jwt}\n`); // unstaged secret
  assert.deepEqual(scan(root).hits.map((h) => h.file), ["a.txt"]);
  assert.deepEqual(scan(root, [], { source: "worktree" }).hits.map((h) => h.file), ["b.txt"]);
  assert.deepEqual(scan(root, [], { source: "list", files: ["a.txt", "b.txt"] }).hits.map((h) => h.file), ["b.txt"]);
  assert.equal(run(["--root", root]).status, 1);
  assert.match(run(["--root", root, "--worktree"]).stdout, /b\.txt:1 jwt/);
  const list = join(root, "list.txt");
  writeFileSync(list, "b.txt\n");
  assert.match(run(["--root", root, "--files-from", list]).stdout, /b\.txt:1 jwt/);
  writeFileSync(list, "a.txt\n");
  assert.equal(run(["--root", root, "--files-from", list]).status, 0);
});

test("--files-from also works before anything is staged (untracked files) and checks private paths in the list", () => {
  const root = mkdtempSync(join(tmpdir(), "publish-scan-"));
  dirs.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root, env: GENV });
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs/PROGRESS.md"), "x\n");
  writeFileSync(join(root, "x.txt"), `${SEEDS.jwt}\n`);
  const res = scan(root, [], { source: "list", files: ["x.txt", "docs/PROGRESS.md", "missing.txt"] });
  assert.deepEqual(res.privateTracked, ["docs/PROGRESS.md"]);
  assert.deepEqual(res.hits.map((h) => `${h.file} ${h.rule}`).sort(), ["docs/PROGRESS.md private-path-tracked", "x.txt jwt"]);
});

// ---- local needles (owner-specific, untracked)

const NEEDLES = { rules: [{ id: "owner-word", pattern: "acme[- ]?corp", flags: "i" }], literals: ["lit-" + "eral-9f3"] };

test("local needles are loaded only when the file exists; content and file names are matched; values never printed", () => {
  const files = { "src/a.txt": "we are ACME Corp here\n", "docs/acme-corp-notes.txt": "clean\n", "src/b.txt": "token lit-" + "eral-9f3 end\n", "src/c.txt": "ok\n" };
  const root = repo(files);
  const without = run(["--root", root]);
  assert.equal(without.status, 0);
  assert.match(without.stdout, /local needles absent/);
  mkdirSync(join(root, "scripts/licenses"), { recursive: true });
  writeFileSync(join(root, "scripts/licenses/publish-scan.local.json"), JSON.stringify(NEEDLES));
  execFileSync("git", ["add", "-A"], { cwd: root, env: GENV });
  const withLocal = run(["--root", root]);
  assert.equal(withLocal.status, 1);
  assert.match(withLocal.stdout, /src\/a\.txt:1 owner-word/);
  assert.match(withLocal.stdout, /docs\/acme-corp-notes\.txt:0 owner-word/); // the file NAME
  assert.match(withLocal.stdout, /src\/b\.txt:1 local-literal/);
  assert.doesNotMatch(withLocal.stdout + withLocal.stderr, /lit-eral|ACME Corp/);
  assert.doesNotMatch(withLocal.stdout, /src\/c\.txt/);
  assert.match(withLocal.stdout, /local needles loaded/);
});

test("local needles: a literal in a file name is a hit, --local-needles points elsewhere, bad files exit 3, --require-local-needles fails when absent", () => {
  const root = repo({ ["dir/lit-" + "eral-9f3.txt"]: "ok\n", "z.txt": "ok\n" });
  const nf = join(root, "n.json");
  writeFileSync(nf, JSON.stringify({ literals: NEEDLES.literals }));
  const r = run(["--root", root, "--local-needles", nf]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /:0 local-literal/);
  writeFileSync(nf, JSON.stringify({ rules: [{ id: "x", pattern: "(", flags: "" }] }));
  assert.equal(run(["--root", root, "--local-needles", nf]).status, 3);
  writeFileSync(nf, JSON.stringify({ rules: [{ id: "x", pattern: "a", flags: "g" }] }));
  assert.equal(run(["--root", root, "--local-needles", nf]).status, 3);
  assert.equal(run(["--root", root, "--require-local-needles"]).status, 3);
  assert.throws(() => compileLocalNeedles({ literals: [""] }), /literal/);
  assert.throws(() => compileLocalNeedles({ rules: [{ id: "", pattern: "a" }] }), /id and pattern/);
});

test("local needles can be allowlisted by the id they report", () => {
  const root = repo({ "src/a.txt": "ACME corp\n" });
  const local = compileLocalNeedles(NEEDLES);
  assert.equal(scan(root, [], { local }).counts["owner-word"], 1);
  assert.deepEqual(scan(root, [{ path: "src/**", rule: "owner-word", reason: "reviewed example" }], { local }).counts, {});
});

test("the public scanner source carries no owner names (they live in the untracked local file)", () => {
  const src = readFileSync(SCAN, "utf8");
  const owner = new RegExp(["Hap" + "py", "happy" + "gastro", "happy" + "solutions", "Fec" + "ny"].join("|"));
  assert.doesNotMatch(src, owner);
});

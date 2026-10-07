// node scripts/sign-bundle.mjs --dist ../remote-web/dist --key ~/path/outside/repo/bundle-ed25519.pem [--gen-key] [--seq <n>] [--json]
//   or:   ... | node scripts/sign-bundle.mjs --dist <dir> --key-stdin      (PEM on stdin; MANUAL use only: the IDE signs in Rust)
// Writes <dist>/bundle.json in format v2. --seq defaults to the clock in seconds. --json prints exactly one JSON line
// {hash, pub, seq, files} (files = number of signed files) and nothing else on stdout.
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { MANIFEST_NAME, newKeyPem, signBundle } from "./bundle-lib.mjs";

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const has = (n) => process.argv.includes(n);
const die = (msg, code = 2) => { console.error(msg); process.exit(code); };
const dist = arg("--dist"), keyPath = arg("--key");
if (!dist || (!keyPath && !has("--key-stdin")) || (keyPath && has("--key-stdin"))) die("usage: sign-bundle.mjs --dist <dir> (--key <pem outside the repo> [--gen-key] | --key-stdin) [--seq <n>] [--json]");
let seq;
if (has("--seq")) {
  const raw = arg("--seq");
  if (!/^(0|[1-9][0-9]{0,15})$/.test(raw ?? "") || !Number.isSafeInteger(Number(raw))) die("--seq must be a plain integer between 0 and 2^53-1");
  seq = Number(raw);
}
let pem;
if (has("--key-stdin")) {
  pem = readFileSync(0);
} else {
  if (!existsSync(keyPath)) {
    if (!has("--gen-key")) die("key file missing (pass --gen-key to create it; keep it off Cloudflare and out of git)");
    mkdirSync(dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, newKeyPem(), { mode: 0o600 });
    chmodSync(keyPath, 0o600);
  }
  pem = readFileSync(keyPath);
}
let b;
try { b = signBundle(dist, pem, { seq }); } catch (e) { die(`sign failed: ${e.message}`, 1); }
writeFileSync(join(dist, MANIFEST_NAME), JSON.stringify(b));
if (has("--json")) console.log(JSON.stringify({ hash: b.manifestSha256, pub: b.pubkey, seq: b.seq, files: b.files.length }));
else console.log(`signed ${b.files.length} files (format v2, seq ${b.seq})\nbundle hash: ${b.manifestSha256}\npublic key (pin this on the Mac): ${b.pubkey}`);

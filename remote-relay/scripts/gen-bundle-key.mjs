// node scripts/gen-bundle-key.mjs --out ~/path/outside/repo/bundle-ed25519.pem [--force] [--json]
// MANUAL tool: creates an Ed25519 signing key (PKCS8 PEM, mode 0600) and prints its public half. A custom-URL user pastes the
// public key into Settings > Remote; the IDE itself generates and keeps its key in Rust (Keychain) and never runs this script.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createPrivateKey } from "node:crypto";
import { fingerprint, newKeyPem, rawPub } from "./bundle-lib.mjs";

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const has = (n) => process.argv.includes(n);
const out = arg("--out");
if (!out) { console.error("usage: gen-bundle-key.mjs --out <pem path outside the repo> [--force] [--json]"); process.exit(2); }
if (existsSync(out) && !has("--force")) { console.error(`${out} exists; refusing to overwrite a signing key (pass --force to replace it)`); process.exit(2); }
mkdirSync(dirname(out), { recursive: true });
const pem = newKeyPem();
writeFileSync(out, pem, { mode: 0o600 });
chmodSync(out, 0o600);
const pub = rawPub(createPrivateKey(pem));
if (has("--json")) console.log(JSON.stringify({ pub, fingerprint: fingerprint(pub), path: out }));
else console.log(`wrote ${out} (0600, keep it off Cloudflare and out of git)\npublic key: ${pub}\nfingerprint: ${fingerprint(pub)}`);

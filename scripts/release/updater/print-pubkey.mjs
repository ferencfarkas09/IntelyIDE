#!/usr/bin/env node
// Prints what the owner pastes into crates/updater/src/keys.rs for one tauri public key file, and
// the key id and fingerprint to publish out of band (updater spec 4.7, 6.3, (design notes: updater-keys)).
//
//   node print-pubkey.mjs <key.pub> [--role Feed|FeedStandby|Artifact]
//
// Reads a PUBLIC key file only; refuses anything that looks like a private key.
// Exit: 0, 1 unreadable or not a public key, 2 usage.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROLES } from "./lib/keys-rs.mjs";
import { parsePublicKey, fingerprint } from "./lib/minisign.mjs";

const args = process.argv.slice(2);
let file;
let role = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--role") role = args[++i];
  else if (args[i].startsWith("-")) {
    console.error("usage: print-pubkey.mjs <key.pub> [--role Feed|FeedStandby|Artifact]");
    process.exit(2);
  } else file = args[i];
}
if (!file || (role !== null && !ROLES.includes(role))) {
  console.error("usage: print-pubkey.mjs <key.pub> [--role Feed|FeedStandby|Artifact]");
  process.exit(2);
}

let text;
try {
  text = readFileSync(resolve(file), "utf8").trim();
} catch {
  console.error(`print-pubkey: cannot read ${file}`);
  process.exit(1);
}
if (!file.endsWith(".pub") && !/^[A-Za-z0-9+/=\s]+$/.test(text)) {
  console.error("print-pubkey: that is not a public key file");
  process.exit(1);
}
let key;
try {
  key = parsePublicKey(text);
} catch (e) {
  console.error(`print-pubkey: ${e.message} (give the .pub file, never the private key)`);
  process.exit(1);
}
const fp = fingerprint(key.pk);
console.log(`key id       ${key.id}`);
console.log(`fingerprint  ${fp.match(/.{1,8}/g).join(" ")}`);
console.log("");
console.log("keys.rs line (set the role; the id is the 16 hex digits above):");
console.log(`    TrustedKey { id: Cow::Borrowed("${key.id}"), public_b64: Cow::Borrowed("${text.replace(/\s+/g, "")}"), role: Role::${role ?? "<Feed|FeedStandby|Artifact>"} },`);
console.log("");
console.log("publish out of band (SECURITY.md, the website, the signed tag message), one line per key:");
console.log(`    ${role ?? "<role>"} ${key.id} sha256:${fp}`);

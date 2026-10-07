// node scripts/verify-bundle.mjs --dist <dir> [--pub <base64url raw key>] [--min-seq <n>] [--allow-v1] [--json]   (exit 1 on any mismatch)
// --pub pins the signing key (the root of trust); without it the key inside bundle.json is only checked for self-consistency.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST_NAME, verifyDist } from "./bundle-lib.mjs";

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const has = (n) => process.argv.includes(n);
const dist = arg("--dist");
if (!dist) { console.error("usage: verify-bundle.mjs --dist <dir> [--pub <key>] [--min-seq <n>] [--allow-v1] [--json]"); process.exit(2); }
let minSeq;
if (has("--min-seq")) {
  const raw = arg("--min-seq");
  if (!/^(0|[1-9][0-9]{0,15})$/.test(raw ?? "")) { console.error("--min-seq must be a plain integer"); process.exit(2); }
  minSeq = Number(raw);
}
let r;
try {
  r = verifyDist(dist, JSON.parse(readFileSync(join(dist, MANIFEST_NAME), "utf8")), { pin: arg("--pub"), minSeq, allowV1: has("--allow-v1") });
} catch (e) {
  r = { ok: false, code: "format", reason: `cannot read ${MANIFEST_NAME}: ${e.message}` };
}
if (has("--json")) console.log(JSON.stringify(r));
else console.log(r.ok ? `ok ${r.hash}` : `FAIL ${r.reason}`);
process.exit(r.ok ? 0 : 1);

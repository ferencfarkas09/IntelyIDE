// Reads the trust anchors out of crates/updater/src/keys.rs (spec 4.7) without a Rust toolchain.
// Tolerant of formatting; strict about what it finds. U1 owns the file; this is its only consumer
// on the script side.
import { fingerprint, parsePublicKey } from "./minisign.mjs";

export const ROLES = ["Feed", "FeedStandby", "Artifact"];
export const PLACEHOLDER = "REPLACE_WITH_PUBLIC_KEY";
export const PLACEHOLDER_ID = "REPLACE_WITH_KEY_ID";

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1"); // base64 has no whitespace, so a "//" inside a key survives
}

/** @returns {{keys: {id, publicB64, role, placeholder}[], floor: number|null}} */
export function parseKeysRs(source) {
  const src = stripComments(source);
  const keys = [];
  // TRUSTED_KEYS holds either `placeholder(Role::X)` calls (the file as shipped by U1) or
  // `TrustedKey { id: Cow::Borrowed("..."), public_b64: Cow::Borrowed("..."), role: Role::X }`
  // literals (what print-pubkey.mjs prints); plain "..." strings are accepted too.
  const list = /TRUSTED_KEYS[^=]*=\s*&\[([\s\S]*?)\n?\];/.exec(src)?.[1] ?? "";
  for (const m of list.matchAll(/placeholder\(\s*Role::(\w+)\s*\)/g)) keys.push({ id: PLACEHOLDER_ID, publicB64: PLACEHOLDER, role: m[1], placeholder: true });
  for (const m of list.matchAll(/TrustedKey\s*\{([^}]*)\}/g)) {
    const body = m[1];
    const str = (field) => new RegExp(`\\b${field}\\s*:\\s*(?:Cow::Borrowed\\(\\s*)?"([^"]*)"`).exec(body)?.[1];
    const id = str("id");
    const pub = str("public_b64");
    const role = /\brole\s*:\s*Role::(\w+)/.exec(body)?.[1];
    if (id === undefined || pub === undefined || role === undefined) continue;
    keys.push({ id, publicB64: pub, role, placeholder: pub.includes(PLACEHOLDER) || id.includes(PLACEHOLDER_ID) });
  }
  const f = /\bINITIAL_FEED_FLOOR\s*:\s*u64\s*=\s*(\d[\d_]*)\s*;/.exec(src);
  return { keys, floor: f ? Number(f[1].replace(/_/g, "")) : null };
}

/** Decode every non-placeholder key; returns {keys: [...with pk, fingerprint, comment], problems}. */
export function decodeKeys(parsed) {
  const out = [];
  const problems = [];
  for (const k of parsed.keys) {
    if (k.placeholder) {
      problems.push(`placeholder key (role ${k.role})`);
      continue;
    }
    if (!ROLES.includes(k.role)) {
      problems.push(`unknown role ${k.role} for key ${k.id}`);
      continue;
    }
    try {
      const pub = parsePublicKey(k.publicB64);
      if (!/^[0-9A-F]{16}$/i.test(k.id)) problems.push(`key id ${JSON.stringify(k.id)} is not 16 hex digits`);
      else if (k.id.toUpperCase() !== pub.id) problems.push(`key id ${k.id} does not match the key (${pub.id})`);
      if (pub.commentId && pub.commentId !== pub.id) problems.push(`key ${pub.id}: comment names ${pub.commentId}`);
      out.push({ ...k, id: pub.id, pk: pub.pk, comment: pub.comment, fingerprint: fingerprint(pub.pk) });
    } catch (e) {
      problems.push(`key ${k.id} (${k.role}): ${e.message}`);
    }
  }
  return { keys: out, problems };
}

export function keySetSignature(keys) {
  return keys
    .map((k) => `${k.role}:${k.id}:${k.publicB64}`)
    .sort()
    .join("\n");
}

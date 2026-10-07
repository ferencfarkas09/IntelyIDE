// Feed schema 1 (updater spec 4.6): one builder and one validator, shared by make-feed.mjs and
// verify-feed.mjs so the generator can never write what the verifier refuses (and vice versa).
// The Rust client re-validates the same rules in crates/updater/src/feed.rs.
import {
  ARCHES,
  BLOCK_REASONS,
  FEED_KEYS,
  LIMITS,
  MIN_OS,
  archOfFeedKey,
  artifactName,
  compareVersions,
  downloadUrl,
  isVersion,
  parseVersion,
  releaseNotesUrl,
  validateProjectLink,
  versionFitsChannel,
} from "../names.mjs";

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const HEX16 = /^[0-9a-fA-F]{16}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const TOP_KEYS = [
  "schema",
  "channel",
  "seq",
  "generatedAt",
  "validUntil",
  "version",
  "pub_date",
  "notes",
  "notesUrl",
  "minOs",
  "nativeSwitchOk",
  "entitlementsChange",
  "revoke",
  "floorReset",
  "blockInstall",
  "withdrawn",
  "minFrom",
  "platforms",
];
const ENTRY_KEYS = ["url", "signature", "bytes", "sha256", "unpackedBytes"];

export function isRfc3339(s) {
  return typeof s === "string" && RFC3339.test(s) && !Number.isNaN(Date.parse(s));
}

/** `str::lines().count()` of the Rust client: a final newline does not start another line. */
function rustLineCount(s) {
  const parts = s.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.length;
}

/** Control characters other than \n and \t, and Unicode format characters (bidi, zero width). */
export function notesProblem(notes) {
  if (typeof notes !== "string") return "notes must be a string";
  if (Buffer.byteLength(notes, "utf8") > LIMITS.notesBytes) return `notes longer than ${LIMITS.notesBytes} bytes`;
  if (rustLineCount(notes) > LIMITS.notesLines) return `notes longer than ${LIMITS.notesLines} lines`;
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(notes)) return "notes contain control characters";
  if (/\p{Cf}/u.test(notes)) return "notes contain Unicode format characters";
  return null;
}

/**
 * Make release notes fit the feed: normalise line ends, drop forbidden characters, cut at 200
 * lines and 8 KiB (on a character boundary) and say so. Returns {text, truncated}.
 */
export function fitNotes(raw) {
  let t = String(raw).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").replace(/\p{Cf}/gu, "");
  const note = "\n\n(Release notes shortened. The full notes are on the release page.)\n";
  let truncated = false;
  const lines = t.split("\n");
  if (lines.length > LIMITS.notesLines - 3) {
    t = lines.slice(0, LIMITS.notesLines - 3).join("\n");
    truncated = true;
  }
  const room = LIMITS.notesBytes - Buffer.byteLength(note, "utf8");
  if (Buffer.byteLength(t, "utf8") > (truncated ? room : LIMITS.notesBytes)) {
    let cut = t;
    while (Buffer.byteLength(cut, "utf8") > room) cut = cut.slice(0, Math.max(0, cut.length - Math.ceil((Buffer.byteLength(cut, "utf8") - room) / 4)));
    if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
    t = cut;
    truncated = true;
  }
  if (truncated) t = t.replace(/\s+$/, "") + note;
  return { text: t, truncated };
}

/**
 * Build the feed object in schema order. `input` is already parsed (see make-feed.mjs).
 * Throws on anything the validator would refuse.
 */
export function buildFeed(input) {
  const o = {};
  o.schema = 1;
  o.channel = input.channel;
  o.seq = input.seq;
  o.generatedAt = input.generatedAt;
  if (input.validUntil) o.validUntil = input.validUntil;
  o.version = input.version;
  if (input.pubDate) o.pub_date = input.pubDate;
  o.notes = input.notes;
  o.notesUrl = input.notesUrl ?? releaseNotesUrl(input.version);
  o.minOs = input.minOs ?? MIN_OS;
  if (input.nativeSwitchOk) o.nativeSwitchOk = true;
  if (input.entitlementsChange) o.entitlementsChange = true;
  if (input.revoke?.length) o.revoke = input.revoke.map((s) => s.toUpperCase());
  if (input.floorReset !== undefined && input.floorReset !== null) o.floorReset = input.floorReset;
  if (input.blockInstall?.length) o.blockInstall = input.blockInstall.map((b) => ({ upTo: b.upTo, reason: b.reason }));
  o.withdrawn = input.withdrawn ?? [];
  if (input.minFrom) o.minFrom = input.minFrom;
  o.platforms = {};
  for (const arch of ARCHES) {
    const a = input.assets?.[arch];
    if (!a) continue;
    o.platforms[FEED_KEYS[arch]] = {
      url: downloadUrl(input.version, arch),
      signature: a.signature,
      bytes: a.bytes,
      sha256: a.sha256,
      unpackedBytes: a.unpackedBytes,
    };
  }
  const problems = validateFeed(o, { channel: input.channel });
  if (problems.length) throw new Error(`refusing to write an invalid feed:\n  ${problems.join("\n  ")}`);
  return o;
}

/** Canonical bytes: exactly what is signed. */
export function feedBytes(obj) {
  return Buffer.from(JSON.stringify(obj, null, 2) + "\n", "utf8");
}

/** @returns {string[]} problems (empty = valid) */
export function validateFeed(f, { channel } = {}) {
  const p = [];
  if (f === null || typeof f !== "object" || Array.isArray(f)) return ["feed is not an object"];
  for (const k of Object.keys(f)) if (!TOP_KEYS.includes(k)) p.push(`unknown field ${JSON.stringify(k)}`);
  if (f.schema !== 1) p.push("schema must be 1");
  if (channel && f.channel !== channel) p.push(`channel ${JSON.stringify(f.channel)} is not the requested ${channel}`);
  if (f.channel !== "stable" && f.channel !== "alpha") p.push("channel must be stable or alpha");
  if (!Number.isInteger(f.seq) || f.seq < 1 || f.seq > LIMITS.seqMax) p.push("seq must be an integer in 1..2^40");
  if (!isRfc3339(f.generatedAt)) p.push("generatedAt must be an RFC 3339 UTC time");
  if (f.validUntil !== undefined && !isRfc3339(f.validUntil)) p.push("validUntil must be an RFC 3339 UTC time");
  if (f.pub_date !== undefined && !isRfc3339(f.pub_date)) p.push("pub_date must be an RFC 3339 UTC time");
  if (!isVersion(f.version)) p.push("version must be strict SemVer");
  else if (f.channel && !versionFitsChannel(f.version, f.channel)) p.push("stable forbids a pre-release version");
  const np = notesProblem(f.notes);
  if (np) p.push(np);
  if (f.notesUrl !== undefined && !validateProjectLink(f.notesUrl)) p.push("notesUrl is not a project link");
  if (f.minOs !== undefined && !/^\d+(\.\d+){1,2}$/.test(String(f.minOs))) p.push("minOs must look like 13.5");
  for (const b of ["nativeSwitchOk", "entitlementsChange"]) if (f[b] !== undefined && typeof f[b] !== "boolean") p.push(`${b} must be a boolean`);
  if (f.revoke !== undefined) {
    if (!Array.isArray(f.revoke) || f.revoke.length > LIMITS.revoke) p.push(`revoke must be an array of at most ${LIMITS.revoke}`);
    else if (f.revoke.some((id) => typeof id !== "string" || !HEX16.test(id))) p.push("revoke entries must be 16 hex digits");
  }
  if (f.floorReset !== undefined && (!Number.isInteger(f.floorReset) || f.floorReset < 1 || f.floorReset > LIMITS.seqMax)) p.push("floorReset must be an integer >= 1");
  if (f.blockInstall !== undefined) {
    if (!Array.isArray(f.blockInstall) || f.blockInstall.length > LIMITS.blockInstall) p.push(`blockInstall must be an array of at most ${LIMITS.blockInstall}`);
    else
      for (const b of f.blockInstall) {
        if (!b || typeof b !== "object" || !isVersion(b.upTo) || !BLOCK_REASONS.includes(b.reason)) p.push("blockInstall entries need a SemVer upTo and a known reason");
      }
  }
  if (f.withdrawn !== undefined) {
    if (!Array.isArray(f.withdrawn) || f.withdrawn.length > LIMITS.withdrawn) p.push(`withdrawn must be an array of at most ${LIMITS.withdrawn}`);
    else if (f.withdrawn.some((v) => !isVersion(v))) p.push("withdrawn entries must be strict versions");
  }
  if (f.minFrom !== undefined && !isVersion(f.minFrom)) p.push("minFrom must be strict SemVer");
  if (f.platforms === null || typeof f.platforms !== "object" || Array.isArray(f.platforms)) {
    p.push("platforms must be an object");
    return p;
  }
  if (Object.keys(f.platforms).length === 0) p.push("platforms is empty");
  for (const [key, e] of Object.entries(f.platforms)) {
    const arch = archOfFeedKey(key);
    if (!arch) {
      p.push(`unknown platform ${JSON.stringify(key)}`);
      continue;
    }
    if (!e || typeof e !== "object") {
      p.push(`${key}: entry is not an object`);
      continue;
    }
    for (const k of Object.keys(e)) if (!ENTRY_KEYS.includes(k)) p.push(`${key}: unknown field ${JSON.stringify(k)}`);
    if (isVersion(f.version) && e.url !== downloadUrl(f.version, arch)) p.push(`${key}: url is not the one built from the constants`);
    if (typeof e.signature !== "string" || e.signature.length === 0 || e.signature.length > LIMITS.entrySigBytes || !/^[A-Za-z0-9+/]+={0,2}$/.test(e.signature)) p.push(`${key}: signature missing, not base64 or over 2 KiB`);
    if (!Number.isInteger(e.bytes) || e.bytes < LIMITS.artifactMin || e.bytes > LIMITS.artifactMax) p.push(`${key}: bytes outside 1 MiB..512 MiB`);
    if (typeof e.sha256 !== "string" || !HEX64.test(e.sha256)) p.push(`${key}: sha256 must be 64 lowercase hex digits`);
    if (!Number.isInteger(e.unpackedBytes) || e.unpackedBytes < 1 || e.unpackedBytes > LIMITS.unpackedMax) p.push(`${key}: unpackedBytes outside 1..1.5 GiB`);
  }
  return p;
}

export { artifactName, compareVersions, parseVersion };

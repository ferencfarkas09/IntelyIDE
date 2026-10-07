// The one place that names every updater thing (updater spec 4.6). Mirrored by
// crates/updater/src/endpoints.rs and checked against it, site/site.config.json and the UI link
// prefixes by check-updater-config.mjs (gate G0). The constants are compiled into every installed
// client, so a change here is a release-engineering decision, not a refactor.

export const REPO_SLUG = "ferencfarkas09/IntelyIDE";
export const PAGES_HOST = "ferencfarkas09.github.io";
export const PAGES_BASE_PATH = "/IntelyIDE";
export const RAW_HOST = "raw.githubusercontent.com";
export const RAW_FEED_DIR = "/ferencfarkas09/IntelyIDE/main/site/data/update";
export const RELEASE_HOST = "github.com";
export const RELEASE_PATH_PREFIX = "/ferencfarkas09/IntelyIDE/releases/download/";
export const CDN_SUFFIX = ".githubusercontent.com";
export const USER_AGENT = "IntelyIDE-updater";
export const PRODUCT = "IntelyIDE";
export const APP_NAME = "IntelyIDE.app";
export const MIN_OS = "13.5";

export const CHANNELS = ["stable", "alpha"];
export const ARCHES = ["x64", "aarch64"];
export const FEED_KEYS = { x64: "darwin-x86_64", aarch64: "darwin-aarch64" };
export const BLOCK_REASONS = ["updaterBug", "migration", "security"];

// Limits (spec 4.6 table); the Rust side has the same numbers in limits.rs.
export const LIMITS = {
  feedBytes: 256 * 1024,
  sigBytes: 4 * 1024,
  entrySigBytes: 2 * 1024,
  notesBytes: 8 * 1024,
  notesLines: 200,
  revoke: 8,
  blockInstall: 4,
  withdrawn: 16,
  artifactMin: 1024 * 1024,
  artifactMax: 512 * 1024 * 1024,
  unpackedMax: 1.5 * 1024 * 1024 * 1024,
  seqMax: 2 ** 40,
  seqJump: 1000,
};

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

/** Strict SemVer without build metadata and without a leading v; null when invalid. */
export function parseVersion(v) {
  if (typeof v !== "string" || v.length === 0 || v.length > 64) return null;
  const m = SEMVER.exec(v);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split(".") : [],
    text: v,
  };
}

export function isVersion(v) {
  return parseVersion(v) !== null;
}

/** SemVer precedence (negative, 0, positive). Throws on an invalid version. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`invalid version: ${!x ? a : b}`);
  for (const k of ["major", "minor", "patch"]) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (x.pre.length === 0 && y.pre.length === 0) return 0;
  if (x.pre.length === 0) return 1;
  if (y.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      if (Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1;
    } else if (pn !== qn) return pn ? -1 : 1;
    else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

function needVersion(version) {
  if (!isVersion(version)) throw new Error(`not a strict SemVer version: ${JSON.stringify(version)}`);
}

function needArch(arch) {
  if (!ARCHES.includes(arch)) throw new Error(`unknown arch token: ${JSON.stringify(arch)}`);
}

export function tagName(version) {
  needVersion(version);
  return `v${version}`;
}

export function feedKey(arch) {
  needArch(arch);
  return FEED_KEYS[arch];
}

export function archOfFeedKey(key) {
  return Object.keys(FEED_KEYS).find((a) => FEED_KEYS[a] === key) ?? null;
}

export function artifactName(version, arch) {
  needVersion(version);
  needArch(arch);
  return `${PRODUCT}_${version}_${arch}.app.tar.gz`;
}

export function downloadUrl(version, arch) {
  return `https://${RELEASE_HOST}${RELEASE_PATH_PREFIX}${tagName(version)}/${artifactName(version, arch)}`;
}

export function releaseNotesUrl(version) {
  return `https://${RELEASE_HOST}/${REPO_SLUG}/releases/tag/${tagName(version)}`;
}

export function manifestName(arch) {
  needArch(arch);
  return `updater-manifest-${arch}.json`;
}

function needChannel(channel) {
  if (!CHANNELS.includes(channel)) throw new Error(`unknown channel: ${JSON.stringify(channel)}`);
}

export function feedFileName(channel) {
  needChannel(channel);
  return `${channel}.json`;
}

/** Feed base 1 (Pages) and base 2 (raw mirror), in client order. */
export function feedUrls(channel) {
  needChannel(channel);
  return [
    `https://${PAGES_HOST}${PAGES_BASE_PATH}/update/${channel}.json`,
    `https://${RAW_HOST}${RAW_FEED_DIR}/${channel}.json`,
  ];
}

/** Channels a release is written into: no pre-release part -> stable and alpha; else alpha only. */
export function channelsFor(version) {
  needVersion(version);
  return parseVersion(version).pre.length === 0 ? ["stable", "alpha"] : ["alpha"];
}

/** Stable forbids a pre-release part. */
export function versionFitsChannel(version, channel) {
  needChannel(channel);
  return channel === "alpha" || parseVersion(version)?.pre.length === 0;
}

/**
 * The link rule of spec 4.6 (twin of validate_project_link in endpoints.rs and of the TS rule in the UI).
 * Works on the RAW string: the WHATWG URL parser would already normalise the dangerous parts away.
 */
export function validateProjectLink(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return false;
  if (/[^\u0021-\u007e]|\\/.test(raw)) return false; // printable ASCII only, no backslash
  const m = /^https:\/\/([^/?#]*)(\/[^?#]*)?(?:[?#].*)?$/.exec(raw);
  if (!m) return false;
  const authority = m[1].toLowerCase();
  const path = m[2] ?? "";
  if (authority.includes("@") || authority.includes(":")) return false;
  let prefix;
  if (authority === "github.com") prefix = "/ferencfarkas09/IntelyIDE/";
  else if (authority === PAGES_HOST) prefix = "/IntelyIDE/";
  else return false;
  if (/%2e|%2f|%5c/i.test(path)) return false;
  if (path.includes("//")) return false;
  const segs = path.split("/").slice(1);
  if (segs.some((s) => s === "." || s === "..")) return false;
  return path.startsWith(prefix);
}

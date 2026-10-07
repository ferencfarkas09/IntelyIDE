#!/usr/bin/env node
// Gate G21: the updater configuration is releasable (updater spec 4.7, 11.2 U11). Read-only; no
// network, no key. Fails while ANY of these holds:
//   keys     keys.rs holds a placeholder, lacks a Feed key, a Feed-standby key or two Artifact keys,
//            repeats a key, or holds a key labelled as a test key
//   floor    INITIAL_FEED_FLOOR is below the seq of a committed site/data/update/*.json
//   prev-tag the key set differs from the one at --prev-tag (unless --allow-rotation and the
//            rotation keeps one Artifact key and one Feed or Feed-standby key of the old set)
//   prints   the published fingerprint list (--fingerprints, SECURITY.md, SECURITY.md at --prev-tag)
//            is missing or differs from the set
//   consts   endpoints.rs, names.mjs, site/site.config.json and the UI link prefixes disagree
//   owners   .github/CODEOWNERS does not cover keys.rs, endpoints.rs, scripts/release/updater,
//            site/data/update, .github/workflows and .gitattributes
//   secrets  a private-key-looking string is anywhere in the tree (docs/ is exempt: it names the text)
//   signer   (--artifact <tarball>) the key that signed the artifact is not an Artifact key of the set
//
//   node check-updater-config.mjs [--root <dir>] [--prev-tag <tag>] [--allow-rotation]
//        [--fingerprints <file>]... [--artifact <tarball>]
// Exit: 0 all pass, 1 at least one failure, 2 usage.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeKeys, keySetSignature, parseKeysRs } from "./lib/keys-rs.mjs";
import { verifySignature } from "./lib/minisign.mjs";
import {
  CDN_SUFFIX,
  PAGES_BASE_PATH,
  PAGES_HOST,
  PRODUCT,
  RAW_FEED_DIR,
  RAW_HOST,
  RELEASE_HOST,
  RELEASE_PATH_PREFIX,
  REPO_SLUG,
  USER_AGENT,
} from "./names.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const USAGE = "usage: check-updater-config.mjs [--root <dir>] [--prev-tag <tag>] [--allow-rotation] [--fingerprints <file>]... [--artifact <tarball>]";

const o = { root: resolve(HERE, "../../.."), prevTag: null, allowRotation: false, fingerprints: [], artifact: null };
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) {
        console.error(`check-updater-config: ${a} needs a value\n${USAGE}`);
        process.exit(2);
      }
      return argv[++i];
    };
    if (a === "--root") o.root = resolve(val());
    else if (a === "--prev-tag") o.prevTag = val();
    else if (a === "--allow-rotation") o.allowRotation = true;
    else if (a === "--fingerprints") o.fingerprints.push(resolve(val()));
    else if (a === "--artifact") o.artifact = resolve(val());
    else {
      console.error(`check-updater-config: unknown argument ${a}\n${USAGE}`);
      process.exit(2);
    }
  }
}

const results = [];
function check(name, problems) {
  results.push({ name, problems });
}
const read = (rel) => {
  const p = join(o.root, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
};
function git(args) {
  const r = spawnSync("git", ["-C", o.root, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  return r.status === 0 ? r.stdout : null;
}

// ---- keys -------------------------------------------------------------------------------
const KEYS_RS = "crates/updater/src/keys.rs";
const keysSrc = read(KEYS_RS);
let parsed = { keys: [], floor: null };
let decoded = { keys: [], problems: [] };
{
  const p = [];
  if (keysSrc === null) p.push(`${KEYS_RS} does not exist (task U1 has not produced the crate)`);
  else {
    parsed = parseKeysRs(keysSrc);
    decoded = decodeKeys(parsed);
    p.push(...decoded.problems);
    if (parsed.keys.length === 0) p.push("TRUSTED_KEYS is empty");
    const by = (r) => decoded.keys.filter((k) => k.role === r);
    if (by("Feed").length < 1) p.push("no Feed key");
    if (by("FeedStandby").length < 1) p.push("no Feed-standby key");
    if (by("Artifact").length < 2) p.push(`${by("Artifact").length} Artifact key(s); the CI key and an offline spare are both required`);
    const seenId = new Set();
    const seenPub = new Set();
    for (const k of decoded.keys) {
      if (seenId.has(k.id)) p.push(`key ${k.id} appears twice`);
      if (seenPub.has(k.publicB64)) p.push(`public key of ${k.id} appears twice`);
      seenId.add(k.id);
      seenPub.add(k.publicB64);
      if (/test|throwaway/i.test(k.comment ?? "")) p.push(`key ${k.id} is labelled as a test key`);
    }
  }
  check("keys", p);
}

// ---- floor ------------------------------------------------------------------------------
{
  const p = [];
  if (keysSrc !== null && parsed.floor === null) p.push("INITIAL_FEED_FLOOR not found in keys.rs");
  const dir = join(o.root, "site/data/update");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((n) => /\.json$/.test(n))) {
      try {
        const seq = JSON.parse(readFileSync(join(dir, f), "utf8")).seq;
        if (!Number.isInteger(seq)) p.push(`site/data/update/${f}: no integer seq`);
        else if (parsed.floor !== null && parsed.floor < seq) p.push(`INITIAL_FEED_FLOOR ${parsed.floor} is below the committed ${f} seq ${seq}`);
      } catch {
        p.push(`site/data/update/${f}: not JSON`);
      }
    }
  }
  check("floor", p);
}

// ---- previous tag -----------------------------------------------------------------------
let rotating = false;
if (o.prevTag) {
  const p = [];
  const prevSrc = git(["show", `${o.prevTag}:${KEYS_RS}`]);
  if (prevSrc === null) p.push(`cannot read ${KEYS_RS} at ${o.prevTag}`);
  else {
    const prev = decodeKeys(parseKeysRs(prevSrc)).keys;
    const cur = decoded.keys;
    if (keySetSignature(prev) !== keySetSignature(cur)) {
      rotating = true;
      if (!o.allowRotation) p.push("the key set differs from the previous release tag (a key swap hidden in a pull request is the classic update-channel attack); follow the rotation procedure and pass --allow-rotation");
      else {
        const keepA = cur.some((k) => k.role === "Artifact" && prev.some((x) => x.role === "Artifact" && x.id === k.id));
        const keepF = cur.some((k) => k.role !== "Artifact" && prev.some((x) => x.role !== "Artifact" && x.id === k.id));
        if (!keepA) p.push("rotation keeps no Artifact key of the previous set: installed clients could not verify the next release");
        if (!keepF) p.push("rotation keeps no Feed or Feed-standby key of the previous set: installed clients could not verify the next feed");
        if (p.length === 0) console.log("NOTE rotation allowed: the key set differs from the previous tag and keeps an old Artifact key and an old feed key");
      }
    }
  }
  check("prev-tag", p);
}

// ---- fingerprints -----------------------------------------------------------------------
{
  const p = [];
  const sources = [];
  for (const f of o.fingerprints) sources.push({ where: f, text: existsSync(f) ? readFileSync(f, "utf8") : null });
  if (o.fingerprints.length === 0) {
    sources.push({ where: "SECURITY.md", text: read("SECURITY.md") });
    if (o.prevTag) sources.push({ where: `SECURITY.md at ${o.prevTag}`, text: git(["show", `${o.prevTag}:SECURITY.md`]), lenient: rotating });
  }
  const re = /\b(FeedStandby|Feed|Artifact)\s+([0-9A-Fa-f]{16})\b(?:\s+sha256:([0-9A-Fa-f]{64}))?/g;
  for (const s of sources) {
    if (s.text === null) {
      p.push(`${s.where}: not found; the published fingerprint list is required`);
      continue;
    }
    const listed = new Map();
    for (const m of s.text.matchAll(re)) listed.set(m[2].toUpperCase(), { role: m[1], sha: m[3]?.toUpperCase() });
    if (listed.size === 0) {
      p.push(`${s.where}: no "Role KEYID [sha256:FINGERPRINT]" lines (print-pubkey.mjs prints them)`);
      continue;
    }
    for (const k of decoded.keys) {
      const l = listed.get(k.id);
      if (!l) {
        if (!s.lenient) p.push(`${s.where}: key ${k.id} (${k.role}) is not listed`);
      } else {
        if (l.role !== k.role) p.push(`${s.where}: key ${k.id} is listed as ${l.role}, the tree says ${k.role}`);
        if (l.sha && l.sha !== k.fingerprint) p.push(`${s.where}: fingerprint of ${k.id} differs`);
      }
    }
    // During a rotation the previous tag's list names keys that are being retired: only keys that
    // exist in both must agree.
    if (!s.lenient) for (const id of listed.keys()) if (!decoded.keys.some((k) => k.id === id)) p.push(`${s.where}: lists key ${id} that is not in keys.rs`);
  }
  check("fingerprints", p);
}

// ---- constants --------------------------------------------------------------------------
{
  const p = [];
  const ep = read("crates/updater/src/endpoints.rs");
  if (ep === null) p.push("crates/updater/src/endpoints.rs does not exist (task U1)");
  else {
    const consts = new Map([...ep.matchAll(/pub const (\w+)\s*:\s*&str\s*=\s*"([^"]*)"\s*;/g)].map((m) => [m[1], m[2]]));
    const expect = {
      REPO_SLUG,
      PAGES_HOST,
      PAGES_BASE_PATH,
      RAW_HOST,
      RAW_FEED_DIR,
      RELEASE_HOST,
      RELEASE_PATH_PREFIX,
      CDN_SUFFIX,
      PRODUCT_NAME: PRODUCT,
    };
    for (const [k, v] of Object.entries(expect)) {
      if (!consts.has(k)) p.push(`endpoints.rs has no const ${k} (names.mjs: ${JSON.stringify(v)})`);
      else if (consts.get(k) !== v) p.push(`endpoints.rs ${k} = ${JSON.stringify(consts.get(k))}, names.mjs says ${JSON.stringify(v)}`);
    }
    for (const [h, pre] of [[RELEASE_HOST, `/${REPO_SLUG}/`], [PAGES_HOST, `${PAGES_BASE_PATH}/`]]) {
      if (!new RegExp(`\\(\\s*"${h.replace(/\./g, "\\.")}"\\s*,\\s*"${pre.replace(/[./]/g, "\\$&")}"\\s*\\)`).test(ep)) p.push(`endpoints.rs PROJECT_LINK_PREFIXES lacks (${JSON.stringify(h)}, ${JSON.stringify(pre)})`);
    }
    const crateSrc = readdirSync(join(o.root, "crates/updater/src")).filter((n) => n.endsWith(".rs")).map((n) => readFileSync(join(o.root, "crates/updater/src", n), "utf8")).join("\n");
    if (!crateSrc.includes(`"${USER_AGENT}"`)) p.push(`no Rust source under crates/updater/src holds the User-Agent ${JSON.stringify(USER_AGENT)}`);
  }
  const cfgText = read("site/site.config.json");
  if (cfgText === null) p.push("site/site.config.json does not exist");
  else {
    try {
      const c = JSON.parse(cfgText);
      if (c.siteUrl !== `https://${PAGES_HOST}`) p.push(`site.config.json siteUrl ${c.siteUrl} is not https://${PAGES_HOST}`);
      if (c.basePath !== PAGES_BASE_PATH) p.push(`site.config.json basePath ${c.basePath} is not ${PAGES_BASE_PATH}`);
      if (c.repoUrl !== `https://${RELEASE_HOST}/${REPO_SLUG}`) p.push(`site.config.json repoUrl ${c.repoUrl} is not https://${RELEASE_HOST}/${REPO_SLUG}`);
    } catch {
      p.push("site/site.config.json is not JSON");
    }
  }
  const notes = read("ui/src/modules/updater/notes.ts");
  if (notes === null) p.push("ui/src/modules/updater/notes.ts does not exist (task U8)");
  else
    for (const l of [`/${REPO_SLUG}/`, `${PAGES_BASE_PATH}/`, RELEASE_HOST, PAGES_HOST]) if (!notes.includes(l)) p.push(`notes.ts lacks the link rule part ${JSON.stringify(l)}`);
  check("constants", p);
}

// ---- code owners ------------------------------------------------------------------------
{
  const p = [];
  const co = read(".github/CODEOWNERS");
  if (co === null) p.push(".github/CODEOWNERS does not exist");
  else {
    const tokens = co
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.split(/\s+/)[0]);
    const covers = (t, r) => {
      if (t === r) return true;
      const dir = t.replace(/\*+$/, "");
      return dir.endsWith("/") && r.startsWith(dir);
    };
    for (const r of ["/crates/updater/src/keys.rs", "/crates/updater/src/endpoints.rs", "/scripts/release/updater/x", "/site/data/update/x", "/.github/workflows/x", "/.gitattributes"]) {
      if (!tokens.some((t) => covers(t, r))) p.push(`CODEOWNERS does not cover ${r.replace(/\/x$/, "/")}`);
    }
  }
  check("owners", p);
}

// ---- private-key-looking strings --------------------------------------------------------
{
  const p = [];
  // Built from parts so that this file does not match its own scan.
  const header = ["untrusted comment: rsign", ["encrypted", "secret", "key"].join(" ")].join(" ");
  const needles = [header.slice(25), "RWRTY0" + "Iy", Buffer.from(header).toString("base64").slice(0, 40)];
  const SKIP_DIR = new Set([".git", "node_modules", "target", ".scratch", "dist", "dist-release", ".tauri"]);
  const SKIP_EXT = /\.(png|jpe?g|gif|ico|icns|woff2?|ttf|otf|dmg|zip|gz|tgz|pdf|wasm|node|dylib|a|rlib|bin)$/i;
  let files = null;
  const listed = existsSync(join(o.root, ".git")) ? git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]) : null;
  if (listed !== null) files = listed.split("\0").filter(Boolean);
  else {
    files = [];
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) {
          if (!SKIP_DIR.has(e.name)) walk(join(d, e.name));
        } else if (e.isFile()) files.push(relative(o.root, join(d, e.name)));
      }
    };
    walk(o.root);
  }
  for (const rel of files) {
    if (rel.startsWith("docs/") || SKIP_EXT.test(rel) || rel.split("/").some((s) => SKIP_DIR.has(s))) continue;
    if (/\.key$/.test(rel)) {
      p.push(`${rel}: a *.key file is in the tree`);
      continue;
    }
    const abs = join(o.root, rel);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > 5 * 1024 * 1024) continue;
    const text = readFileSync(abs, "latin1");
    for (const n of needles) if (text.includes(n)) p.push(`${rel}: contains a private-key-looking string`);
  }
  check("secrets", p);
}

// ---- the signer of a fresh artifact -----------------------------------------------------
if (o.artifact) {
  const p = [];
  const sig = `${o.artifact}.sig`;
  if (!existsSync(o.artifact) || !existsSync(sig)) p.push("artifact or its .sig is missing");
  else {
    const r = verifySignature(readFileSync(o.artifact), readFileSync(sig, "utf8").trim(), decoded.keys.filter((k) => k.role === "Artifact"));
    if (!r.ok) p.push(`the artifact signature does not verify against the Artifact keys of keys.rs: ${r.error}`);
  }
  check("signer", p);
}

let failed = 0;
for (const r of results) {
  if (r.problems.length === 0) console.log(`PASS ${r.name}`);
  else {
    failed++;
    for (const m of r.problems) console.error(`FAIL ${r.name}: ${m}`);
  }
}
process.exit(failed ? 1 : 0);

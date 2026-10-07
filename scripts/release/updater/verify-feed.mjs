#!/usr/bin/env node
// Re-validates a signed feed (and optionally its artifacts) the way an installed client would,
// offline (updater spec 4.13 item 4, 4.6 verification order, 10.6).
//
//   node verify-feed.mjs [<feed.json>] --channel <stable|alpha> [--sig <file>] [--tag v<version>]
//        [--keys <keys.rs>] [--key <Feed|FeedStandby|Artifact>=<file.pub>]...
//        [--artifact <tarball>]... [--url <feed url> [--allow-loopback]] [--rust]
//
// Keys come from crates/updater/src/keys.rs (placeholders are refused) unless --key is given,
// which replaces the embedded set (throwaway keys in tests and in the credential-free dry run).
// Checks: file signature and trusted comment (file: <channel>.json, version: equal to the feed's,
// no duplicate or unknown field, legacy signatures refused), signer role Feed or FeedStandby, the
// schema rules, tag agreement, revoke/floorReset only from the standby, and for every --artifact the
// size, SHA-256, the Artifact-role signature (trusted comment file:/version:), the tarball audit and
// the unpacked build.json version. --url fetches the deployed pair (only the two official feed bases,
// or 127.0.0.1 with --allow-loopback) and, when a local file is also given, requires identical bytes.
// --rust additionally runs the Rust client verifier (cargo example verify_feed) when it exists.
// This is an independent second implementation of crates/updater verification, not a substitute
// for its tests. Exit: 0 verified, 1 problems, 2 usage.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateFeed } from "./lib/feed.mjs";
import { decodeKeys, parseKeysRs } from "./lib/keys-rs.mjs";
import { parsePublicKey, verifySignature } from "./lib/minisign.mjs";
import { auditEntries, readTarGz, unpackedBytes } from "./lib/tar.mjs";
import { APP_NAME, CHANNELS, LIMITS, archOfFeedKey, artifactName, feedFileName, feedUrls, isVersion } from "./names.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "../../..");
const USAGE =
  "usage: verify-feed.mjs [<feed.json>] --channel <stable|alpha> [--sig <file>] [--tag v<version>] [--keys <keys.rs>] [--key <Role>=<file.pub>]... [--artifact <tarball>]... [--url <feed url> [--allow-loopback]] [--rust]";

class Usage extends Error {}

function parseArgs(argv) {
  const o = { artifacts: [], keyArgs: [], allowLoopback: false, rust: false, root: DEFAULT_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Usage(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--channel") o.channel = val();
    else if (a === "--sig") o.sig = resolve(val());
    else if (a === "--tag") o.tag = val();
    else if (a === "--keys") o.keysFile = resolve(val());
    else if (a === "--key") o.keyArgs.push(val());
    else if (a === "--artifact") o.artifacts.push(resolve(val()));
    else if (a === "--url") o.url = val();
    else if (a === "--allow-loopback") o.allowLoopback = true;
    else if (a === "--rust") o.rust = true;
    else if (a === "--root") o.root = resolve(val());
    else if (a === "-h" || a === "--help") throw new Usage("help");
    else if (a.startsWith("--")) throw new Usage(`unknown argument ${a}`);
    else if (o.feed) throw new Usage("one feed file only");
    else o.feed = resolve(a);
  }
  if (!CHANNELS.includes(o.channel)) throw new Usage("--channel stable|alpha is required");
  if (!o.feed && !o.url) throw new Usage("give a feed file or --url");
  return o;
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof Usage)) throw e;
  console.error(e.message === "help" ? USAGE : `verify-feed: ${e.message}\n${USAGE}`);
  process.exit(e.message === "help" ? 0 : 2);
}

const problems = [];
const bad = (m) => problems.push(m);
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

function loadKeys() {
  if (opts.keyArgs.length) {
    const keys = [];
    for (const spec of opts.keyArgs) {
      const m = /^(Feed|FeedStandby|Artifact)=(.+)$/.exec(spec);
      if (!m) throw new Usage(`bad --key ${spec} (want Role=<file.pub>)`);
      const p = parsePublicKey(readFileSync(resolve(m[2]), "utf8").trim());
      keys.push({ ...p, role: m[1] });
    }
    return keys;
  }
  const file = opts.keysFile ?? join(opts.root, "crates/updater/src/keys.rs");
  if (!existsSync(file)) {
    bad(`${file} does not exist (task U1 has not produced the crate yet); pass --key Role=<file.pub> to verify against explicit keys`);
    return [];
  }
  const { keys, problems: kp } = decodeKeys(parseKeysRs(readFileSync(file, "utf8")));
  for (const p of kp) bad(`keys.rs: ${p}`);
  if (keys.length === 0 && kp.length === 0) bad("keys.rs holds no trusted keys");
  return keys;
}

async function fetchBytes(url, limit) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, { redirect: "error", signal: ctl.signal, headers: { Accept: "application/json", "Cache-Control": "no-cache" } });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > limit) throw new Error("body too large");
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

function urlAllowed(u) {
  const official = feedUrls(opts.channel);
  if (official.includes(u)) return true;
  if (!opts.allowLoopback) return false;
  try {
    const x = new URL(u);
    return x.protocol === "http:" && x.hostname === "127.0.0.1" && x.pathname.endsWith(`/${feedFileName(opts.channel)}`);
  } catch {
    return false;
  }
}

let feedBuf;
let sigText;
try {
  const keys = loadKeys();

  if (opts.url) {
    if (!urlAllowed(opts.url)) throw new Usage(`--url must be one of ${feedUrls(opts.channel).join(" or ")}${opts.allowLoopback ? "" : " (loopback needs --allow-loopback)"}`);
    try {
      feedBuf = await fetchBytes(opts.url, LIMITS.feedBytes);
      sigText = (await fetchBytes(`${opts.url}.sig`, LIMITS.sigBytes)).toString("utf8").trim();
    } catch (e) {
      throw new Error(`cannot fetch ${opts.url}: ${e.message}`);
    }
    if (opts.feed) {
      const local = readFileSync(opts.feed);
      if (!local.equals(feedBuf)) bad(`the deployed feed differs from ${opts.feed}`);
      const localSig = existsSync(opts.sig ?? `${opts.feed}.sig`) ? readFileSync(opts.sig ?? `${opts.feed}.sig`, "utf8").trim() : null;
      if (localSig !== null && localSig !== sigText) bad("the deployed signature differs from the local one");
    }
  } else {
    const sigPath = opts.sig ?? `${opts.feed}.sig`;
    if (!existsSync(opts.feed)) throw new Error(`${opts.feed} does not exist`);
    if (!existsSync(sigPath)) throw new Error(`${sigPath} does not exist`);
    if (statSync(opts.feed).size > LIMITS.feedBytes) throw new Error(`feed larger than ${LIMITS.feedBytes} bytes`);
    feedBuf = readFileSync(opts.feed);
    if (statSync(sigPath).size > LIMITS.sigBytes) throw new Error(`signature larger than ${LIMITS.sigBytes} bytes`);
    sigText = readFileSync(sigPath, "utf8").trim();
  }

  // 1. signature
  const feedKeys = keys.filter((k) => k.role === "Feed" || k.role === "FeedStandby");
  const res = verifySignature(feedBuf, sigText, feedKeys);
  let signerRole = null;
  let feed = null;
  if (!res.ok) {
    const other = keys.find((k) => k.id === res.id && k.role === "Artifact");
    bad(other ? `feed is signed by an Artifact key (${res.id}): a key of one role never verifies the other kind of file` : `feed signature: ${res.error}`);
  } else {
    signerRole = res.key.role;
    if (res.trusted.file !== feedFileName(opts.channel)) bad(`trusted comment file: is ${JSON.stringify(res.trusted.file)}, expected ${feedFileName(opts.channel)}`);
    if (res.trusted.version === undefined) bad("trusted comment has no version: field (sign with --app-version; sign-feed.sh does)");
  }

  // 2. content
  try {
    feed = JSON.parse(feedBuf.toString("utf8"));
  } catch {
    bad("feed is not valid UTF-8 JSON");
  }
  if (feed) {
    for (const p of validateFeed(feed, { channel: opts.channel })) bad(`feed: ${p}`);
    if (res.ok && res.trusted.version !== undefined && res.trusted.version !== feed.version) bad(`signed version ${res.trusted.version} differs from the feed's ${feed.version}`);
    if (opts.tag !== undefined) {
      if (!/^v/.test(opts.tag) || opts.tag.slice(1) !== feed.version) bad(`tag ${opts.tag} does not match feed version ${feed.version}`);
    }
    if (signerRole === "Feed") {
      if (feed.revoke?.length) bad("revoke is present but the signer is not a Feed-standby key (clients ignore it)");
      if (feed.floorReset !== undefined) bad("floorReset is present but the signer is not a Feed-standby key (clients ignore it)");
    }
    if (feed.revoke?.length && res.ok) {
      for (const id of feed.revoke) {
        const k = keys.find((x) => x.id === id.toUpperCase());
        if (k && k.role === "FeedStandby") bad(`revoke names the Feed-standby key ${id}: nothing revokes a standby key`);
        if (id.toUpperCase() === res.id) bad("a key cannot revoke itself");
      }
    }

    // 3. artifacts
    const artifactKeys = keys.filter((k) => k.role === "Artifact");
    for (const tar of opts.artifacts) {
      const name = basename(tar);
      const entryKey = Object.keys(feed.platforms ?? {}).find((k) => {
        const arch = archOfFeedKey(k);
        return arch && isVersion(feed.version) && artifactName(feed.version, arch) === name;
      });
      if (!entryKey) {
        bad(`${name}: no platform entry of feed version ${feed.version} has this file name`);
        continue;
      }
      const entry = feed.platforms[entryKey];
      if (!existsSync(tar)) {
        bad(`${name}: file does not exist`);
        continue;
      }
      const data = readFileSync(tar);
      if (data.length !== entry.bytes) bad(`${name}: ${data.length} bytes, feed says ${entry.bytes}`);
      if (sha256(data) !== entry.sha256) bad(`${name}: SHA-256 differs from the feed`);
      const sigFile = `${tar}.sig`;
      if (!existsSync(sigFile)) bad(`${name}: ${basename(sigFile)} is missing`);
      else if (readFileSync(sigFile, "utf8").trim() !== entry.signature) bad(`${name}: the .sig file differs from the feed's signature`);
      const ar = verifySignature(data, entry.signature, artifactKeys);
      if (!ar.ok) {
        const other = keys.find((k) => k.id === ar.id && k.role !== "Artifact");
        bad(other ? `${name}: signed by a ${other.role} key; only an Artifact key may sign an artifact` : `${name}: artifact signature: ${ar.error}`);
      } else {
        if (ar.trusted.file !== name) bad(`${name}: trusted comment file: is ${JSON.stringify(ar.trusted.file)}`);
        if (ar.trusted.version !== undefined && ar.trusted.version !== feed.version) bad(`${name}: signed version ${ar.trusted.version} differs from the feed's`);
        if (ar.trusted.version === undefined) bad(`${name}: trusted comment has no version: field`);
      }
      try {
        const buildPath = `${APP_NAME}/Contents/Resources/build.json`;
        const { entries, files } = await readTarGz(tar, { capture: new Set([buildPath]) });
        for (const p of auditEntries(entries, APP_NAME)) bad(`${name}: ${p}`);
        if (unpackedBytes(entries) !== entry.unpackedBytes) bad(`${name}: unpacked size ${unpackedBytes(entries)} differs from the feed's ${entry.unpackedBytes}`);
        if (!files[buildPath]) bad(`${name}: no ${buildPath}`);
        else {
          let b;
          try {
            b = JSON.parse(files[buildPath].toString("utf8"));
          } catch {
            bad(`${name}: build.json is not JSON`);
          }
          if (b && b.version !== feed.version) bad(`${name}: build.json version ${b.version} differs from the feed's ${feed.version}`);
        }
      } catch (e) {
        bad(`${name}: cannot read the tarball (${e.message})`);
      }
    }
    if (res.ok && problems.length === 0) {
      console.log(`OK ${opts.channel} ${feed.version} seq ${feed.seq} signed by ${signerRole} ${res.id}${opts.artifacts.length ? `; ${opts.artifacts.length} artifact(s) verified` : ""}`);
    }
  }
} catch (e) {
  if (e instanceof Usage) {
    console.error(`verify-feed: ${e.message}\n${USAGE}`);
    process.exit(2);
  }
  bad(e.message);
}

if (problems.length === 0 && opts.rust) {
  // The Rust client verifier (crates/updater/examples/verify_feed.rs, task U1): the real client code.
  // `--key` overrides exist only in its debug build, which is what `cargo run` builds.
  const example = join(opts.root, "crates/updater/examples/verify_feed.rs");
  if (!existsSync(example)) {
    console.error("verify-feed: --rust needs crates/updater/examples/verify_feed.rs; the Rust cross-check did NOT run");
    process.exit(2);
  }
  const roleArg = { Feed: "feed", FeedStandby: "standby", Artifact: "artifact" };
  const keyArgs = opts.keyArgs.flatMap((k) => ["--key", `${roleArg[k.split("=")[0]]}=${k.slice(k.indexOf("=") + 1)}`]);
  const lock = join(opts.root, "scripts/with-build-lock.sh");
  const runCargo = (extra) => {
    const cargo = ["cargo", "run", "-j", "2", "-q", "-p", "intely-updater", "--example", "verify_feed", "--", ...extra];
    const [cmd, args] = existsSync(lock) ? ["bash", [lock, "nice", "-n", "10", ...cargo]] : ["nice", ["-n", "10", ...cargo]];
    return spawnSync(cmd, args, { cwd: opts.root, encoding: "utf8" });
  };
  const jobs = [];
  if (opts.feed) jobs.push([basename(opts.feed), ["feed", opts.feed, `${opts.feed}.sig`, "--channel", opts.channel, ...keyArgs]]);
  else bad("--rust needs a local feed file");
  for (const a of opts.artifacts) {
    const m = /^IntelyIDE_(.+)_(x64|aarch64)\.app\.tar\.gz$/.exec(basename(a));
    jobs.push([basename(a), ["file", a, `${a}.sig`, "--name", basename(a), ...(m ? ["--version", m[1]] : []), ...keyArgs]]);
  }
  for (const [label, args] of jobs) {
    const r = runCargo(args);
    if (r.status !== 0) bad(`the Rust client verifier rejected ${label}: ${(r.stdout || r.stderr || "").trim().split("\n").pop()}`);
    else console.log(`OK rust client verifier agrees on ${label}`);
  }
}

if (problems.length) {
  for (const p of problems) console.error(`FAIL ${p}`);
  process.exit(1);
}

#!/usr/bin/env node
// Builds the unsigned update feed(s), schema 1 (updater spec 4.6, 4.13 item 4). Offline, no key,
// no network: sizes and SHA-256 are recomputed from the tarballs the owner downloaded and
// attested; nothing is taken from a CI-produced manifest. Signing is sign-feed.sh.
//
//   node make-feed.mjs --version <semver> [--channel auto|stable|alpha ...] --notes <file>
//        --asset x64=<tarball> [--asset aarch64=<tarball>] --out <dir>
//        [--seq <n> | --seq stable=<n> --seq alpha=<n>] [--site-dir <dir>] [--valid-for-days 45]
//        [--block-install <upTo>:<reason>]... [--withdraw <version>]... [--min-from <version>]
//        [--native-switch-ok] [--entitlements-change] [--revoke <16 hex id>]... [--floor-reset <n>]
//        [--generated-at <rfc3339>] [--pub-date <rfc3339>] [--min-os 13.5] [--notes-url <url>]
//
// <tarball>.sig must sit next to each tarball. --channel auto (the default) writes a release
// without a pre-release part into stable and alpha, a pre-release into alpha only. --site-dir is
// READ ONLY here: it supplies the previous seq (seq = previous + 1 when --seq is omitted).
// Exit: 0 written, 1 refused, 2 usage.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { feedBytes, buildFeed, fitNotes } from "./lib/feed.mjs";
import { readTarGz, unpackedBytes } from "./lib/tar.mjs";
import {
  ARCHES,
  APP_NAME,
  BLOCK_REASONS,
  CHANNELS,
  LIMITS,
  artifactName,
  channelsFor,
  feedFileName,
  isVersion,
  versionFitsChannel,
} from "./names.mjs";

const USAGE =
  "usage: make-feed.mjs --version <semver> [--channel auto|stable|alpha] --notes <file> --asset <x64|aarch64>=<tarball>... --out <dir> [--seq <n>|<channel>=<n>] [--site-dir <dir>] [--valid-for-days <n>] [--block-install <upTo>:<reason>] [--withdraw <v>] [--min-from <v>] [--native-switch-ok] [--entitlements-change] [--revoke <id>] [--floor-reset <n>] [--generated-at <t>] [--pub-date <t>] [--min-os <v>] [--notes-url <url>]";

class Usage extends Error {}

function parseArgs(argv) {
  const o = { channels: [], seqs: {}, assets: {}, blockInstall: [], withdrawn: [], revoke: [], validDays: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Usage(`${a} needs a value`);
      return argv[++i];
    };
    switch (a) {
      case "--version": o.version = val(); break;
      case "--channel": o.channels.push(val()); break;
      case "--notes": o.notes = val(); break;
      case "--out": o.out = resolve(val()); break;
      case "--site-dir": o.siteDir = resolve(val()); break;
      case "--seq": {
        const v = val();
        const m = /^(?:(stable|alpha)=)?(\d+)$/.exec(v);
        if (!m) throw new Usage(`bad --seq ${v}`);
        o.seqs[m[1] ?? "*"] = Number(m[2]);
        break;
      }
      case "--asset": {
        const v = val();
        const m = /^(x64|aarch64)=(.+)$/.exec(v);
        if (!m) throw new Usage(`bad --asset ${v} (want x64=<tarball> or aarch64=<tarball>)`);
        if (o.assets[m[1]]) throw new Usage(`--asset ${m[1]} given twice`);
        o.assets[m[1]] = resolve(m[2]);
        break;
      }
      case "--valid-for-days": o.validDays = Number(val()); break;
      case "--block-install": {
        const v = val();
        const [upTo, reason] = v.split(":");
        o.blockInstall.push({ upTo, reason });
        break;
      }
      case "--withdraw": o.withdrawn.push(val()); break;
      case "--min-from": o.minFrom = val(); break;
      case "--native-switch-ok": o.nativeSwitchOk = true; break;
      case "--entitlements-change": o.entitlementsChange = true; break;
      case "--revoke": o.revoke.push(val()); break;
      case "--floor-reset": o.floorReset = Number(val()); break;
      case "--generated-at": o.generatedAt = val(); break;
      case "--pub-date": o.pubDate = val(); break;
      case "--min-os": o.minOs = val(); break;
      case "--notes-url": o.notesUrl = val(); break;
      case "-h":
      case "--help": throw new Usage("help");
      default: throw new Usage(`unknown argument ${a}`);
    }
  }
  for (const k of ["version", "notes", "out"]) if (!o[k]) throw new Usage(`--${k} is required`);
  if (Object.keys(o.assets).length === 0) throw new Usage("at least one --asset is required");
  if (o.validDays !== null && !(Number.isInteger(o.validDays) && o.validDays >= 1 && o.validDays <= 3650)) throw new Usage("--valid-for-days must be a whole number of days");
  if (o.floorReset !== undefined && !(Number.isInteger(o.floorReset) && o.floorReset >= 1)) throw new Usage("--floor-reset must be an integer >= 1");
  return o;
}

function refuse(msg) {
  console.error(`make-feed: ${msg}`);
  process.exit(1);
}

function previousSeq(siteDir, channel) {
  if (!siteDir) return null;
  const f = join(siteDir, feedFileName(channel));
  if (!existsSync(f)) return null;
  try {
    const j = JSON.parse(readFileSync(f, "utf8"));
    return Number.isInteger(j.seq) ? j.seq : null;
  } catch {
    refuse(`cannot read the previous feed ${f}`);
  }
}

async function readAsset(arch, tarball, version) {
  const want = artifactName(version, arch);
  if (basename(tarball) !== want) refuse(`${arch}: the file must be named ${want}, not ${basename(tarball)}`);
  const sigPath = `${tarball}.sig`;
  if (!existsSync(tarball)) refuse(`${arch}: ${tarball} does not exist`);
  if (!existsSync(sigPath)) refuse(`${arch}: refusing an architecture without a signature (${sigPath} is missing)`);
  const signature = readFileSync(sigPath, "utf8").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) refuse(`${arch}: ${sigPath} is not a tauri signature file`);
  const bytes = statSync(tarball).size;
  const sha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  let entries;
  try {
    ({ entries } = await readTarGz(tarball));
  } catch (e) {
    refuse(`${arch}: ${want} is not a readable tar.gz (${e.message})`);
  }
  if (!entries.some((e) => e.name.replace(/\/+$/, "") === APP_NAME)) refuse(`${arch}: ${want} has no top-level ${APP_NAME}`);
  const unpacked = unpackedBytes(entries);
  const mf = join(tarball, "..", `updater-manifest-${arch}.json`);
  if (existsSync(mf)) {
    try {
      const m = JSON.parse(readFileSync(mf, "utf8"));
      if (m.bytes !== bytes || m.sha256 !== sha256) refuse(`${arch}: ${basename(mf)} disagrees with the tarball (recomputed values are used, but this means the file was swapped)`);
    } catch (e) {
      if (e instanceof SyntaxError) refuse(`${arch}: ${basename(mf)} is not JSON`);
      throw e;
    }
  }
  return { signature, bytes, sha256, unpackedBytes: unpacked };
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof Usage)) throw e;
  console.error(e.message === "help" ? USAGE : `make-feed: ${e.message}\n${USAGE}`);
  process.exit(e.message === "help" ? 0 : 2);
}

if (!isVersion(opts.version)) refuse(`${JSON.stringify(opts.version)} is not a strict SemVer version (no leading v, no build metadata)`);
for (const b of opts.blockInstall) if (!isVersion(b.upTo) || !BLOCK_REASONS.includes(b.reason)) refuse(`--block-install wants <semver>:<${BLOCK_REASONS.join("|")}>`);
for (const w of opts.withdrawn) if (!isVersion(w)) refuse(`--withdraw ${w} is not a strict version`);
if (opts.minFrom !== undefined && !isVersion(opts.minFrom)) refuse("--min-from is not a strict version");
if (opts.revoke.length > LIMITS.revoke || opts.blockInstall.length > LIMITS.blockInstall || opts.withdrawn.length > LIMITS.withdrawn) refuse("too many --revoke, --block-install or --withdraw entries");
for (const id of opts.revoke) if (!/^[0-9a-fA-F]{16}$/.test(id)) refuse(`--revoke ${id}: a key id is 16 hex digits`);

let channels;
if (opts.channels.length === 0 || (opts.channels.length === 1 && opts.channels[0] === "auto")) channels = channelsFor(opts.version);
else {
  channels = [...new Set(opts.channels)];
  for (const c of channels) {
    if (!CHANNELS.includes(c)) refuse(`unknown channel ${c}`);
    if (!versionFitsChannel(opts.version, c)) refuse(`${opts.version} has a pre-release part and cannot go into the ${c} channel`);
  }
}

let rawNotes;
try {
  rawNotes = readFileSync(opts.notes, "utf8");
} catch {
  refuse(`cannot read the notes file ${opts.notes}`);
}
const notes = fitNotes(rawNotes);
if (notes.truncated) console.error("make-feed: the release notes were shortened to fit the feed limits");

const assets = {};
for (const arch of ARCHES) if (opts.assets[arch]) assets[arch] = await readAsset(arch, opts.assets[arch], opts.version);

const generatedAt = opts.generatedAt ?? new Date().toISOString().replace(/\.\d+Z$/, "Z");
let validUntil;
if (opts.validDays) {
  const t = Date.parse(generatedAt);
  if (Number.isNaN(t)) refuse("--generated-at is not a time");
  validUntil = new Date(t + opts.validDays * 86400000).toISOString().replace(/\.\d+Z$/, "Z");
}

if (Object.keys(opts.seqs).length > 1 && opts.seqs["*"] !== undefined) refuse("mix of --seq <n> and --seq <channel>=<n>");
mkdirSync(opts.out, { recursive: true });
const written = [];
for (const channel of channels) {
  const prev = previousSeq(opts.siteDir, channel);
  let seq = opts.seqs[channel] ?? opts.seqs["*"];
  if (opts.seqs["*"] !== undefined && channels.length > 1) refuse("--seq <n> is ambiguous for two channels; use --seq stable=<n> --seq alpha=<n>");
  if (seq === undefined) seq = (prev ?? 0) + 1;
  if (prev !== null) {
    if (seq <= prev && opts.floorReset === undefined) refuse(`${channel}: seq ${seq} is not above the committed feed's ${prev} (every client rejects it); use ${prev + 1}`);
    if (seq > prev + LIMITS.seqJump && opts.floorReset === undefined) refuse(`${channel}: seq ${seq} jumps more than ${LIMITS.seqJump} above ${prev}`);
  }
  let feed;
  try {
    feed = buildFeed({
      channel,
      seq,
      generatedAt,
      validUntil,
      version: opts.version,
      pubDate: opts.pubDate,
      notes: notes.text,
      notesUrl: opts.notesUrl,
      minOs: opts.minOs,
      nativeSwitchOk: opts.nativeSwitchOk,
      entitlementsChange: opts.entitlementsChange,
      revoke: opts.revoke,
      floorReset: opts.floorReset,
      blockInstall: opts.blockInstall,
      withdrawn: opts.withdrawn,
      minFrom: opts.minFrom,
      assets,
    });
  } catch (e) {
    refuse(e.message);
  }
  const file = join(opts.out, feedFileName(channel));
  writeFileSync(file, feedBytes(feed));
  rmSync(`${file}.sig`, { force: true }); // a signature of older bytes must never sit beside new bytes
  written.push(file);
}
for (const f of written) console.log(f);

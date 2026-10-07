#!/usr/bin/env node
// Renders the GitHub release notes ((design notes: release-ci-spec) 4.6, task RC2). Offline, deterministic, no dependency.
//
//   node scripts/release/notes.mjs --version <X.Y.Z> --release-json <release-<arch>.json>... [--out <file>]
//        [--repo OWNER/REPO] [--team-id <ID>] [--changelog <file>] [--template <file>] [--footer <file>]
//
// Placeholders of the template: SUMMARY INSTALL VERIFY WHATS_CHANGED KNOWN_LIMITATIONS UPGRADE SECURITY.
// The finished text is passed through the RULES of scripts/licenses/publish-scan.mjs (plus the owner's local needles
// when that untracked file exists); any hit exits 1 and names the rule and line, never the value.
// --team-id is the expected Developer ID Team ID (public, not a secret); it is required when an asset is notarized.
// Exit codes: 0 ok, 1 content check failed, 2 usage or input error.

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RULES, loadLocalNeedles, windows } from "../licenses/publish-scan.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TEMPLATES = join(ROOT, "scripts/release/templates");
export const PLACEHOLDERS = ["SUMMARY", "INSTALL", "VERIFY", "WHATS_CHANGED", "KNOWN_LIMITATIONS", "UPGRADE", "SECURITY"];
const FALLBACK_TEMPLATE = PLACEHOLDERS.map((p) => `{{${p}}}`).join("\n\n") + "\n";
const NAME_RE = /^IntelyIDE_(\d+\.\d+\.\d+)_(aarch64|x64)\.dmg$/;
const ARCH_LABEL = { aarch64: "Apple silicon (aarch64)", x64: "Intel (x64)" };

class Fail extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

// Packaging spec Appendix B, verbatim.
const GATEKEEPER_ADHOC =
  "This build is signed ad hoc and is not notarized by Apple, because the project does not have a paid Apple Developer membership. macOS will refuse the first launch with a message that Apple could not verify IntelyIDE, and the dialog shows no developer name. To open it, after verifying the download: (macOS 15 and later) open System Settings > Privacy & Security, scroll to the message about IntelyIDE, click Open Anyway and confirm with your password; (macOS 13 and 14) right-click the app and choose Open. Never disable Gatekeeper system-wide and never run commands from a web page to get around it. After every update macOS may ask again for Keychain and folder access, because an ad-hoc build has no stable identity; tokens saved in the Keychain may need to be re-entered, and if you deny the Keychain prompt the app keeps them in memory only and you will lose them when you quit. A notarized build, when available, is the recommended download. If you prefer, build from source: locally built apps carry no quarantine flag.";
const GATEKEEPER_NOTARIZED = "Open the app; macOS asks once to confirm that it was downloaded from the Internet.";
const INSTALL_STEPS = "Open the DMG, drag IntelyIDE to Applications, eject the image. Do not run the app from the disk image.";
const PLATFORM =
  "Built for macOS 13.5 (Ventura) or later; tested on macOS 26 only. Apple silicon: take the `aarch64` DMG (first launch untested on hardware until these notes say otherwise). The `x64` DMG also runs on Apple silicon under Rosetta 2, more slowly, and Apple may remove Rosetta in a future macOS. The `x64` build is the last Intel line: macOS 26 is the last release for Intel Macs.";
const NOT_IN_BUILD = [
  "The Claude Agent SDK and the `claude` command-line tool: you install your own `claude`; the app offers a confirm-first installer for the pinned SDK version (nothing is downloaded without your click).",
  "Git: the Xcode Command Line Tools provide it (`xcode-select --install`).",
  "MongoDB AI-find and deploying the Remote relay: both need a source checkout.",
];
const UPDATES =
  "IntelyIDE has no telemetry. Once a day, and when you choose Check for updates, it downloads one small signed feed file from the project's GitHub Pages site (ferencfarkas09.github.io); the request carries no identifier and can be switched off in Settings. An update is installed only after your click and after its signature has been verified. The bundled Node.js and the pinned SDK version change only with a new IntelyIDE release.";
const SAFETY =
  "IntelyIDE is alpha software and starts writable: commits, pushes and file changes happen when you ask. Agents ask for approval by default and are blocked from committing and pushing by several best-effort layers; they are not a sandbox. Use it on repositories you can restore.";

const rel = (file) => file.split("/").pop();

function parseJson(text, file) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Fail(`${rel(file)}: not valid JSON`, 2);
  }
}

function readText(file, what) {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    throw new Fail(`${what}: cannot read ${file} (${e.code ?? e.message})`, 2);
  }
}

/** The CHANGELOG section of `version`: { date, body } or throws. */
export function changelogSection(text, version) {
  const lines = text.split(/\r?\n/);
  const head = new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\](?:\\s*-\\s*(\\S+))?\\s*$`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) throw new Fail(`CHANGELOG has no section "## [${version}]"`);
  let end = lines.findIndex((l, i) => i > start && /^## \[/.test(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end);
  // trailing link-reference definitions belong to the file, not to the section
  while (body.length && (/^\s*$/.test(body.at(-1)) || /^\[[^\]]+\]:\s/.test(body.at(-1)))) body.pop();
  const text2 = body.join("\n").replace(/^\s*\n/, "");
  if (!body.some((l) => l.trim() && !/^#{1,6}\s/.test(l))) throw new Fail(`CHANGELOG section [${version}] has no entries`);
  return { date: head.exec(lines[start])[1] ?? null, body: text2.trimEnd() };
}

/** First block of consecutive non-empty lines that is not a heading. */
export function firstParagraph(body) {
  const out = [];
  for (const line of body.split("\n")) {
    if (/^#{1,6}\s/.test(line) || !line.trim()) {
      if (out.length) break;
      continue;
    }
    out.push(line.trimEnd());
  }
  return out.join("\n");
}

function signingOf(j) {
  return { mode: j.signing?.mode ?? j.pk?.signing?.mode ?? (j.signed ? "developer-id" : "adhoc"), notarized: j.notarized === true };
}

function loadAssets(releaseJsons, version) {
  const assets = [];
  const problems = [];
  for (const { file, json } of releaseJsons) {
    const m = typeof json.file === "string" ? NAME_RE.exec(json.file) : null;
    if (!m) {
      problems.push(`${file}: file name ${JSON.stringify(json.file)} does not match IntelyIDE_<version>_<aarch64|x64>.dmg`);
      continue;
    }
    if (m[1] !== version || json.version !== version) problems.push(`${file}: version differs from ${version}`);
    if (!/^[0-9a-f]{64}$/.test(json.sha256 ?? "")) problems.push(`${file}: sha256 is not 64 lowercase hex characters`);
    assets.push({ name: json.file, arch: m[2], sha256: json.sha256, ...signingOf(json) });
  }
  if (problems.length) throw new Fail(problems.map((p) => `notes: FAIL ${p}`).join("\n"), 2);
  return assets.sort((a, b) => (a.arch < b.arch ? -1 : a.arch > b.arch ? 1 : 0));
}

const stateOf = (a) => (a.notarized ? "Developer ID signed and notarized" : a.mode === "adhoc" ? "ad-hoc signed, not notarized" : `${a.mode} signed, not notarized`);

export function renderSections({ version, assets, repo, teamId, section }) {
  const anyAdhoc = assets.some((a) => a.mode === "adhoc" && !a.notarized);
  const anyNotarized = assets.some((a) => a.notarized);
  if (anyNotarized && !teamId) throw new Fail("an asset is notarized: pass --team-id <expected Developer ID Team ID>", 2);

  const table = [
    "| Asset | Architecture | SHA-256 |",
    "|---|---|---|",
    ...assets.map((a) => `| \`${a.name}\` | ${ARCH_LABEL[a.arch]} | \`${a.sha256}\` |`),
  ].join("\n");
  const states = assets.map((a) => `- \`${a.name}\`: ${stateOf(a)}`).join("\n");
  const install = [table, "Signing state:\n\n" + states, INSTALL_STEPS, PLATFORM];
  if (anyAdhoc) install.push("**First launch, ad-hoc signed build.** " + GATEKEEPER_ADHOC);
  if (anyNotarized) install.push("**First launch, notarized build.** " + GATEKEEPER_NOTARIZED);

  const file = assets[0].name.replace(/_(aarch64|x64)\.dmg$/, "_<arch>.dmg");
  const verify = [
    "1. Corruption check only (the checksum file comes from this same release page): `shasum -a 256 --ignore-missing -c SHA256SUMS`",
    `2. Provenance (which workflow and commit produced the file; it does not prove the content is safe): \`gh attestation verify ${file} --repo ${repo} --signer-workflow ${repo}/.github/workflows/release.yml --source-ref refs/tags/v${version}\``,
  ];
  if (anyNotarized) {
    verify.push(
      `3. Signature: \`codesign -dv --verbose=4 /Applications/IntelyIDE.app\` and compare the TeamIdentifier line with the expected Developer ID Team ID: **${teamId}**`,
      "4. Gatekeeper assessment: `spctl --assess --type execute --verbose /Applications/IntelyIDE.app`",
    );
  }
  if (anyAdhoc) verify.push("", "Ad-hoc builds carry no Developer ID identity to compare; the attestation is the check.");

  const limitations = [
    "Not in this build:\n\n" + NOT_IN_BUILD.map((l) => `- ${l}`).join("\n"),
    "The arm64 DMG is untested on Apple Silicon hardware until these notes say otherwise.",
    "Ad-hoc builds may ask again for Keychain and folder access after every update.",
  ];
  const upgrade = [UPDATES];
  const security = [
    SAFETY,
    "Corresponding source: the tag archive of this release (`v" + version + "`). The Node.js license and notices are in `Contents/Resources/legal/` inside the app.",
  ];
  return {
    SUMMARY: firstParagraph(section.body),
    INSTALL: install.join("\n\n"),
    VERIFY: verify.join("\n"),
    WHATS_CHANGED: section.body,
    KNOWN_LIMITATIONS: limitations.join("\n\n"),
    UPGRADE: upgrade.join("\n\n"),
    SECURITY: security.join("\n\n"),
  };
}

export function fill(template, values) {
  const found = [...template.matchAll(/\{\{([^{}]*)\}\}/g)].map((m) => m[1].trim());
  const unknown = found.filter((n) => !PLACEHOLDERS.includes(n));
  if (unknown.length) throw new Fail(`notes: FAIL template has unknown placeholder(s): ${[...new Set(unknown)].join(", ")}`);
  const out = template.replace(/\{\{\s*([A-Z_]+)\s*\}\}/g, (_, n) => values[n]);
  const empty = PLACEHOLDERS.filter((n) => found.includes(n) && !String(values[n] ?? "").trim());
  if (empty.length) throw new Fail(`notes: FAIL placeholder(s) rendered empty: ${empty.join(", ")}`);
  const leftover = out.match(/\{\{[^{}]*\}\}/);
  if (leftover) throw new Fail("notes: FAIL unfilled placeholder in the output (a value contains {{ }})");
  return out;
}

/** Hits of the publish-scan RULES on `text`, as [{rule, line}]; the value is never returned. */
export function scanText(text, name = "release-notes.md", local = null) {
  const rules = RULES.filter((r) => !r.files || r.files.test(name));
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const found = new Set();
    for (const w of windows(line)) {
      for (const r of rules) if (r.re.test(w)) found.add(r.id);
      if (local) {
        for (const r of local.rules) if (r.re.test(w)) found.add(r.id);
        if (local.literals.some((l) => w.includes(l))) found.add("local-literal");
      }
    }
    for (const rule of found) hits.push({ rule, line: i + 1 });
  });
  return hits;
}

function parseArgs(argv) {
  const o = { version: null, releaseJson: [], out: null, repo: null, teamId: null, changelog: join(ROOT, "CHANGELOG.md"), template: join(TEMPLATES, "release-notes.md"), footer: join(TEMPLATES, "release-footer.md") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Fail(`${a} needs a value`, 2);
      return argv[++i];
    };
    if (a === "--version") o.version = val();
    else if (a === "--release-json") {
      o.releaseJson.push(resolve(val()));
      while (argv[i + 1] && !argv[i + 1].startsWith("--")) o.releaseJson.push(resolve(argv[++i]));
    } else if (a === "--out") o.out = resolve(val());
    else if (a === "--repo") o.repo = val();
    else if (a === "--team-id") o.teamId = val();
    else if (a === "--changelog") o.changelog = resolve(val());
    else if (a === "--template") o.template = resolve(val());
    else if (a === "--footer") o.footer = resolve(val());
    else throw new Fail(`unknown argument ${a}`, 2);
  }
  if (!/^\d+\.\d+\.\d+$/.test(o.version ?? "")) throw new Fail("--version <X.Y.Z> is required", 2);
  if (!o.releaseJson.length) throw new Fail("--release-json is required", 2);
  return o;
}

function defaultRepo() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const url = JSON.parse(readFileSync(join(ROOT, "scripts/licenses/policy.json"), "utf8")).sourceUrl ?? "";
    return /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(url)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function main(argv) {
  try {
    const o = parseArgs(argv);
    const repo = o.repo ?? defaultRepo();
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? "")) throw new Fail("--repo OWNER/REPO is required (or set GITHUB_REPOSITORY)", 2);
    if (o.teamId !== null && !/^[A-Z0-9]{10}$/.test(o.teamId)) throw new Fail("--team-id must be the 10-character Apple Team ID", 2);
    const assets = loadAssets(o.releaseJson.map((f) => ({ file: rel(f), json: parseJson(readText(f, "release json"), f) })), o.version);
    const section = changelogSection(readText(o.changelog, "CHANGELOG"), o.version);
    let template;
    if (existsSync(o.template)) template = readText(o.template, "template");
    else {
      console.error(`notes: template ${rel(o.template)} not found, using the built-in section order`);
      template = FALLBACK_TEMPLATE;
    }
    const footer = existsSync(o.footer) ? readText(o.footer, "footer").trim() : "";
    const body = fill(template, renderSections({ version: o.version, assets, repo, teamId: o.teamId, section }));
    const text = body.trimEnd() + (footer ? `\n\n---\n\n${footer}\n` : "\n");
    const hits = scanText(text, "release-notes.md", loadLocalNeedles(ROOT));
    if (hits.length) {
      console.error(hits.map((h) => `notes: FAIL publish-scan rule ${h.rule} at line ${h.line}`).join("\n"));
      return 1;
    }
    if (o.out) {
      mkdirSync(dirname(o.out), { recursive: true });
      const tmp = `${o.out}.tmp-${process.pid}`;
      writeFileSync(tmp, text);
      renameSync(tmp, o.out);
      console.log(`notes: wrote ${o.out}`);
    } else process.stdout.write(text);
    return 0;
  } catch (e) {
    if (e instanceof Fail) {
      console.error(e.message.startsWith("notes") ? e.message : `notes: ${e.message}`);
      return e.code;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));

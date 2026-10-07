// SPDX-License-Identifier: GPL-3.0-or-later
// Structural tests of the .github files and CODEOWNERS (release spec 7.5 to 7.9, task R14).
// Line-based on purpose: no YAML library is a dependency. No network, no git write.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { globToRegExp } from "../licenses/lib/reuse.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

// ---------------------------------------------------------------- helpers

/** Top-level `key:` names of a YAML document (lines with no indentation). */
export function topLevelKeys(text) {
  return [...text.matchAll(/^([A-Za-z_][\w-]*):/gm)].map((m) => m[1]);
}

/** All `id:` values of an issue form body (indented `id:` lines). */
export function formIds(text) {
  return [...text.matchAll(/^\s+(?:-\s+)?id:\s*([^\s#]+)\s*$/gm)].map((m) => m[1]);
}

/** The labels array of an issue form: `labels: ["a", "b"]`. */
export function formLabels(text) {
  const m = text.match(/^labels:\s*\[(.*)\]\s*$/m);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/** Validate one issue form; returns a list of problems. */
export function checkIssueForm(text) {
  const problems = [];
  const keys = topLevelKeys(text);
  for (const k of ["name", "description", "body"]) {
    if (!keys.includes(k)) problems.push(`missing top-level ${k}`);
  }
  const ids = formIds(text);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) problems.push(`duplicate id: ${[...new Set(dup)].join(", ")}`);
  return problems;
}

/** Parse labels.yml (a flat list of name/color/description) into objects. */
export function parseLabels(text) {
  const labels = [];
  let cur = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    let m;
    if ((m = line.match(/^- name:\s*(.+)$/))) {
      cur = { name: m[1].replace(/^["']|["']$/g, "") };
      labels.push(cur);
    } else if (cur && (m = line.match(/^ {2}(color|description):\s*(.+)$/))) {
      cur[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return labels;
}

/** CODEOWNERS lines: [{pattern, owners, line}] ignoring comments and blanks. */
export function parseCodeowners(text) {
  const out = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const parts = line.split(/\s+/);
    out.push({ pattern: parts[0], owners: parts.slice(1), line: i + 1 });
  });
  return out;
}

/** Does a CODEOWNERS pattern match a repo-relative path (gitignore-like subset used here)? */
export function codeownersMatches(pattern, path) {
  const anchored = pattern.startsWith("/");
  let p = anchored ? pattern.slice(1) : pattern;
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);
  const base = globToRegExp(p).source.replace(/^\^/, "").replace(/\$$/, "");
  const prefix = anchored || p.includes("/") ? "^" : "^(?:.*/)?";
  // matches the path itself (files only when not dirOnly) or anything below it
  const re = new RegExp(`${prefix}${base}(?:/.*)?$`, "s");
  if (!re.test(path)) return false;
  if (dirOnly) return new RegExp(`${prefix}${base}/.*$`, "s").test(path);
  return true;
}

/** The files of the public set: scripts/release/public-set.json when it exists, else the git-visible tree. */
export function publicFiles(root = ROOT) {
  const listed = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
  const setPath = join(root, "scripts/release/public-set.json");
  let include = ["**"];
  let exclude = ["site/**", "**/node_modules/**", "**/target/**", "**/dist/**", "**/.scratch/**", "**/.claude/**", "scripts/release/maintainer/**"];
  if (existsSync(setPath)) {
    try {
      const set = JSON.parse(readFileSync(setPath, "utf8"));
      if (Array.isArray(set.include) && Array.isArray(set.exclude)) ({ include, exclude } = set);
    } catch {
      // being written by R1 right now: use the built-in approximation
    }
  }
  const inc = include.map(globToRegExp);
  const exc = exclude.map(globToRegExp);
  return listed.filter((f) => existsSync(join(root, f)) && inc.some((r) => r.test(f)) && !exc.some((r) => r.test(f)));
}

/** Dependabot (line based): blocks per ecosystem. */
export function parseDependabot(text) {
  const blocks = text.split(/^\s*-\s*package-ecosystem:\s*/m).slice(1);
  return blocks.map((b) => {
    const eco = b.split("\n")[0].trim();
    const dirs = [];
    const one = b.match(/^\s+directory:\s*"?([^"\s#]+)"?/m);
    if (one) dirs.push(one[1]);
    const many = b.match(/^\s+directories:\s*\[([^\]]*)\]/m);
    if (many) dirs.push(...many[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean));
    const ignored = [...b.matchAll(/dependency-name:\s*"([^"]+)"/g)].map((m) => m[1]);
    return { eco, dirs, ignored };
  });
}

const PINNED = ["@anthropic-ai/claude-agent-sdk", "@anthropic-ai/sdk", "@modelcontextprotocol/sdk", "zod"];

// ---------------------------------------------------------------- data

// Paths that sibling tasks create later (spec 7.7). The CI spec X1 list and this list must stay equal.
// deny.toml (CI RC7) and SECURITY.md (R13) are not in the spec list but do not exist yet either.
// /site/data/release.json is excluded from the public set (site/** is private in the first commit),
// so it can never match there; it stays tolerated until the site is published.
const futurePaths = [
  "/crates/core/src/runtime.rs",
  "/src-tauri/src/modules/sdk_setup.rs",
  "/sidecar/src/sdk-install.ts",
  "/src-tauri/entitlements-node.plist",
  "/scripts/release/node-pin.json",
  "/scripts/release/forbidden-strings.txt",
  "/scripts/ci/",
  "/scripts/release-mac.sh",
  "/src-tauri/tauri.release.conf.json",
  "/src-tauri/Info.plist",
  "/src-tauri/build.rs",
  "/src-tauri/src/integrity.rs",
  "/src-tauri/src/modules/updater.rs",
  "/site/data/release.json",
  "/site/data/update/",
  "/deny.toml",
  "/SECURITY.md",
];

// Every path of the spec 7.7 block must have an owner line.
const mustCover = [
  "/crates/agent_core/src/policy/", "/crates/agent_gate/", "/crates/agent_host/",
  "/crates/core/src/jail.rs", "/crates/core/src/exec.rs", "/crates/core/src/guard.rs", "/crates/core/src/env.rs", "/crates/core/src/runtime.rs",
  "/crates/settings/src/secrets.rs",
  "/src-tauri/capabilities/", "/src-tauri/src/agents.rs", "/src-tauri/src/modules/sdk_setup.rs", "/src-tauri/tauri.conf.json",
  "/src-tauri/tauri.release.conf.json", "/src-tauri/Info.plist", "/src-tauri/entitlements-node.plist", "/src-tauri/build.rs", "/src-tauri/src/integrity.rs",
  "/src-tauri/src/modules/updater.rs", "/site/data/release.json",
  "/sidecar/src/env.ts", "/sidecar/src/sdk.ts", "/sidecar/src/sdk-install.ts", "/sidecar/src/adapters/",
  "/crates/remote/", "/crates/relay_bundle/", "/crates/relay_deploy/", "/remote-relay/", "/remote-web/",
  "/crates/preview-proxy/", "/crates/mongo/", "/crates/term/",
  "/sidecar/sdk-pin/", "/sidecar/package.json", "/package.json", "/pnpm-workspace.yaml", "/pnpm-lock.yaml", "/Cargo.lock",
  "/remote-relay/pnpm-lock.yaml", "/remote-web/pnpm-lock.yaml", "/deny.toml",
  "/scripts/release/node-pin.json", "/scripts/release/forbidden-strings.txt",
  "/docs/safety.md", "/SECURITY.md", "/LICENSE", "/LICENSES/", "/REUSE.toml", "/TRADEMARKS.md", "/THIRD_PARTY_LICENSES.md",
  "/.github/", "/scripts/release/", "/scripts/release-mac.sh", "/scripts/ci/", "/scripts/licenses/",
];

const FORMS = [".github/ISSUE_TEMPLATE/bug_report.yml", ".github/ISSUE_TEMPLATE/feature_request.yml"];
const labelsYml = parseLabels(read(".github/labels.yml"));
const labelNames = new Set(labelsYml.map((l) => l.name));

// ---------------------------------------------------------------- helper self-tests (negative cases)

test("checkIssueForm flags missing keys and duplicate ids", () => {
  assert.deepEqual(checkIssueForm("name: x\ndescription: y\nbody:\n  - type: input\n    id: a\n"), []);
  assert.match(checkIssueForm("name: x\nbody:\n").join(), /missing top-level description/);
  assert.match(checkIssueForm("name: x\ndescription: y\nbody:\n  - id: a\n  - id: a\n").join(), /duplicate id: a/);
});

test("codeownersMatches follows the gitignore subset used here", () => {
  assert.ok(codeownersMatches("/crates/agent_gate/", "crates/agent_gate/src/shim.rs"));
  assert.ok(!codeownersMatches("/crates/agent_gate/", "crates/agent_gate"));
  assert.ok(codeownersMatches("/LICENSE", "LICENSE"));
  assert.ok(!codeownersMatches("/LICENSE", "LICENSES/GPL-3.0-or-later.txt"));
  assert.ok(codeownersMatches("/package.json", "package.json"));
  assert.ok(!codeownersMatches("/package.json", "ui/package.json"));
  assert.ok(codeownersMatches("/scripts/release/", "scripts/release/github-files.test.mjs"));
  assert.ok(!codeownersMatches("/scripts/release/", "scripts/releases/x"));
});

test("parseDependabot reads directories and ignores", () => {
  const b = parseDependabot(
    'version: 2\nupdates:\n  - package-ecosystem: npm\n    directories: ["/", "/ui"]\n    ignore:\n      - dependency-name: "zod"\n  - package-ecosystem: cargo\n    directory: /\n',
  );
  assert.deepEqual(b[0], { eco: "npm", dirs: ["/", "/ui"], ignored: ["zod"] });
  assert.deepEqual(b[1], { eco: "cargo", dirs: ["/"], ignored: [] });
});

// ---------------------------------------------------------------- issue forms

test("issue forms have name, description, body and unique ids", () => {
  for (const f of FORMS) {
    assert.deepEqual(checkIssueForm(read(f)), [], f);
    assert.ok(formIds(read(f)).length > 0, `${f} has ids`);
  }
});

test("every label referenced by the forms exists in labels.yml", () => {
  for (const f of FORMS) {
    const used = formLabels(read(f));
    assert.ok(used.length > 0, `${f} declares labels`);
    for (const l of used) assert.ok(labelNames.has(l), `${f}: label ${l} missing from labels.yml`);
  }
  assert.deepEqual(formLabels(read(FORMS[0])), ["bug", "needs-triage"]);
  assert.deepEqual(formLabels(read(FORMS[1])), ["enhancement", "needs-triage"]);
});

test("config.yml disables blank issues and links discussions, advisories and the FAQ", () => {
  const c = read(".github/ISSUE_TEMPLATE/config.yml");
  assert.match(c, /^blank_issues_enabled: false$/m);
  assert.match(c, /contact_links:/);
  assert.match(c, /github\.com\/ferencfarkas09\/IntelyIDE\/discussions/);
  assert.match(c, /github\.com\/ferencfarkas09\/IntelyIDE\/security\/advisories\/new/);
  assert.match(c, /docs\/faq\.md/);
  assert.match(c, /https:\/\/intelyide\.com$/m);
});

test("bug form warns about refusals.log and run logs and requires the key fields", () => {
  const t = read(FORMS[0]);
  assert.match(t, /refusals\.log/);
  assert.match(t, /runs\/\*\.jsonl/);
  for (const id of ["version", "macos", "arch", "install", "steps", "actual", "checks"]) {
    assert.ok(formIds(t).includes(id), `id ${id}`);
  }
  assert.match(t, /Intel/);
  assert.match(t, /Apple Silicon/);
  assert.match(t, /placeholder: 1\.0\.1/);
  assert.ok(!/alpha/i.test(t));
  assert.match(t, /render: shell/);
  const checks = t.slice(t.indexOf("id: checks"));
  assert.equal((checks.match(/required: true/g) || []).length, 2, "two required checkboxes");
  // the version, steps and actual inputs are required
  for (const id of ["version", "macos", "arch", "install", "steps", "actual"]) {
    const from = t.indexOf(`id: ${id}`);
    const next = t.indexOf("  - type:", from);
    assert.match(t.slice(from, next === -1 ? undefined : next), /required: true/, `${id} is required`);
  }
});

test("feature form has the area dropdown and the maintainer acknowledgement", () => {
  const t = read(FORMS[1]);
  for (const a of ["Changes and Git", "Agents", "Remote", "Database", "Preview", "i18n", "Other"]) assert.ok(t.includes(`- ${a}`), a);
  assert.match(t, /one maintainer and may take time/);
  assert.ok(!/alpha|beta/i.test(t));
  assert.ok(!existsSync(join(ROOT, ".github/ISSUE_TEMPLATE/third.yml")));
});

// ---------------------------------------------------------------- PR template

test("PR template has the sections and checklist of 7.6", () => {
  const t = read(".github/PULL_REQUEST_TEMPLATE.md");
  for (const h of ["Summary", "Linked issue", "Type", "Checklist"]) assert.match(t, new RegExp(`^## ${h}$`, "m"), h);
  for (const needle of [
    "git commit -s", "AI assistance", "Tests were added or updated", "No real repositories, secrets or personal data",
    "Safety layers", "privacy.md", "light and dark screenshots", "`t()`", "CHANGELOG.md", "skip-changelog", "pnpm licenses:check",
  ]) {
    assert.ok(t.includes(needle), `PR template mentions ${needle}`);
  }
  for (const k of ["Bug fix", "Feature", "Docs", "Refactor"]) assert.ok(t.includes(k), k);
  assert.ok(!/Co-Authored-By|Generated with/i.test(t));
});

// ---------------------------------------------------------------- labels

test("labels.yml has the 19 labels of 7.9 with valid unique names and colours", () => {
  const expected = {
    bug: "d73a4a", enhancement: "a2eeef", safety: "b60205", security: "7f0000", documentation: "0075ca",
    "good first issue": "7057ff", "help wanted": "008672", "needs-triage": "fbca04", question: "d876e3",
    "area:changes": "c5def5", "area:agents": "c5def5", "area:remote": "c5def5", "area:database": "c5def5",
    "area:preview": "c5def5", "area:i18n": "c5def5", breaking: "e99695", dependencies: "0366d6",
    "skip-changelog": "ededed", wontfix: "ffffff",
  };
  assert.equal(labelsYml.length, Object.keys(expected).length);
  assert.equal(labelNames.size, labelsYml.length, "unique names");
  for (const l of labelsYml) {
    assert.equal(l.color, expected[l.name], `colour of ${l.name}`);
    assert.match(l.color, /^[0-9a-f]{6}$/);
    assert.ok(l.description && l.description.length <= 100, `${l.name} description (GitHub limit 100)`);
    assert.ok(l.name.length <= 50);
  }
  assert.deepEqual(Object.keys(expected).filter((n) => !labelNames.has(n)), []);
});

// ---------------------------------------------------------------- CODEOWNERS

const owners = parseCodeowners(read(".github/CODEOWNERS"));

test("every CODEOWNERS line is a path followed by an owner handle", () => {
  assert.ok(owners.length > 0);
  for (const o of owners) {
    assert.ok(o.owners.length >= 1, `line ${o.line}: no owner`);
    assert.ok(o.pattern.startsWith("/"), `line ${o.line}: pattern must be anchored`);
    for (const h of o.owners) {
      // `@<owner-handle>` is the placeholder of D-P14 until the owner supplies the handle
      assert.match(h, /^@(?:<owner-handle>|[A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9._-]+)?)$/, `line ${o.line}: bad owner ${h}`);
    }
  }
  const pats = owners.map((o) => o.pattern);
  assert.equal(new Set(pats).size, pats.length, "no duplicate patterns");
});

test("every CODEOWNERS pattern matches at least one file of the public set (except futurePaths)", () => {
  const files = publicFiles();
  assert.ok(files.length > 100, "public file list looks plausible");
  const dead = owners.filter((o) => !files.some((f) => codeownersMatches(o.pattern, f))).map((o) => o.pattern);
  const stale = dead.filter((p) => !futurePaths.includes(p));
  assert.deepEqual(stale, [], `dead CODEOWNERS patterns (no file in the public set): ${stale.join(", ")}`);
  const stillMissing = futurePaths.filter((p) => dead.includes(p));
  if (stillMissing.length) console.log(`# futurePaths still without a file (${stillMissing.length}): ${stillMissing.join(" ")}`);
  const nowPresent = futurePaths.filter((p) => !dead.includes(p));
  if (nowPresent.length) console.log(`# futurePaths now present, entry can be dropped: ${nowPresent.join(" ")}`);
});

test("futurePaths only names paths that CODEOWNERS actually lists", () => {
  const pats = new Set(owners.map((o) => o.pattern));
  for (const p of futurePaths) assert.ok(pats.has(p), `futurePaths entry ${p} is not in CODEOWNERS`);
});

test("the must-cover list of 7.7 all has an owner line", () => {
  const pats = new Set(owners.map((o) => o.pattern));
  const missing = mustCover.filter((p) => !pats.has(p));
  assert.deepEqual(missing, [], `no owner line for: ${missing.join(", ")}`);
});

// ---------------------------------------------------------------- dependabot (only when the CI task has written it)

test("dependabot.yml, when present, matches the constraints of 7.8", { skip: !existsSync(join(ROOT, ".github/dependabot.yml")) }, () => {
  const blocks = parseDependabot(read(".github/dependabot.yml"));
  assert.ok(blocks.length > 0);
  for (const b of blocks) {
    assert.ok(!b.dirs.includes("/sidecar/sdk-pin"), "/sidecar/sdk-pin is never a Dependabot directory");
    if (b.eco === "npm") {
      for (const d of b.dirs) {
        const dir = d === "/" ? "" : d.replace(/^\//, "");
        assert.ok(existsSync(join(ROOT, dir, "package.json")), `npm directory ${d} has no package.json`);
      }
      for (const p of PINNED) assert.ok(b.ignored.includes(p), `npm block must ignore ${p}`);
    }
    if (b.eco === "cargo") {
      for (const d of b.dirs) assert.ok(existsSync(join(ROOT, d.replace(/^\//, ""), "Cargo.toml")), `cargo directory ${d} has no Cargo.toml`);
    }
  }
  const pin = JSON.parse(read("sidecar/sdk-pin/package.json")).dependencies;
  const sidecar = JSON.parse(read("sidecar/package.json"));
  const sc = { ...sidecar.dependencies, ...sidecar.devDependencies, ...sidecar.peerDependencies };
  assert.ok(sc[PINNED[0]], "sidecar/package.json lists the SDK");
  for (const p of PINNED) {
    assert.ok(pin[p], `sdk-pin pins ${p}`);
    if (sc[p]) assert.equal(sc[p], pin[p], `sidecar/package.json and sdk-pin disagree on ${p}`);
  }
});

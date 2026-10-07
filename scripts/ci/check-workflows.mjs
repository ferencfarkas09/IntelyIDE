#!/usr/bin/env node
// Workflow linter ((design notes: release-ci-spec) 5.2, 5.6, 5.7): enforces the rules every GitHub workflow of this
// repository obeys. Read-only: it reads .github/workflows/*.yml, .github/dependabot.yml,
// .github/runner-labels.json and the root package.json, and writes nothing.
//
//   node scripts/ci/check-workflows.mjs [--strict] [--today YYYY-MM-DD] [--json]
//        [--root DIR] [--labels FILE] [files...]
//
// Output: `file:line rule message` per finding. Exit 0 clean, 1 findings, 2 usage, 3 unreadable or
// unsupported YAML (the mini parser refuses anything it does not understand, scripts/ci/lib/mini-yaml.mjs).
// --strict additionally fails on `PIN-ME` (anywhere under <root>/.github). Without it, `@PIN-ME # vX.Y.Z` is
// accepted as work in progress; every other unpinned ref fails in both modes.
//
// Rule ids are the numbers of spec section 5.2 (5.2.1 .. 5.2.13), plus: 5.6 (pins), retire (runner label
// retirement), needs (job graph), dependabot. Rules are chosen by the file's base name (release.yml, ci.yml,
// codeql.yml, audit.yml); any other workflow gets the generic rules and the "no secrets" rule.
// Where the spec contradicts itself the linter follows spec 5.4 / 5.5 (see the notes at ENV_JOBS etc.).

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseDocument, YamlError, entry, get } from "./lib/mini-yaml.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "../..");

// Jobs that may carry `continue-on-error: true`, per workflow file (5.2.8); each needs a comment naming the decision.
const CONTINUE_ON_ERROR_ALLOW = {
  "ci.yml": ["i18n-full", "publish-scan-full"],
  "codeql.yml": ["codeql-rust"],
  "audit.yml": ["cargo-advisories", "pnpm-audit", "pins-verify", "node-security"],
};
const DECISION_COMMENT = /\b(?:RD|PD|D|O|C|V|G)\d+\b|decision/i;
// `ci-ok` must depend on all of these in ci.yml (spec X8 / 5.3).
const CI_OK_REQUIRED = ["lint-workflows", "js", "gates", "rust", "deny", "dco", "dependency-review", "release-verify"];
const BANNED_LABELS = new Set(["macos-13", "macos-14"]);
// GitHub-hosted images only: `macos-15`, `macos-15-intel`, `ubuntu-24.04`, `windows-2025`. `self-hosted` and any
// custom label would run untrusted pull-request code on a machine this repository does not control.
const HOSTED_LABEL = /^(macos|ubuntu|windows)-\d+(\.\d+)?(-(intel|arm64|xlarge|large))?$/;
// Spec 5.2.5 says `sign` is the only job with an environment, but 5.4 adds `feed` (updater key). Both are allowed;
// `sign` is held to the strict step list, `feed` to "Tauri key only, install with --ignore-scripts".
const ENV_JOBS = new Set(["sign", "feed"]);
// Spec 5.2.3 allows artifact consumers with privileges only in `publish`; 5.4 has `sign` and `feed` download
// artifacts of the same run too. All three are allowed in release.yml, nothing else anywhere.
const ARTIFACT_PRIVILEGED = new Set(["sign", "feed", "publish"]);
const SIGN_USES = new Set(["actions/checkout", "actions/download-artifact", "actions/upload-artifact"]);
const THIRD_PARTY_TOOLCHAIN = /^(?:dtolnay\/rust-toolchain|actions-rs\/|moonrepo\/setup-rust|ructions\/)/i;
const PINNED_USES = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^@\s]+)?@([0-9a-f]{40}|PIN-ME)$/;
const VERSION_COMMENT = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?(?:\s|$)/;

class Usage extends Error {}

// ---------------------------------------------------------------- helpers over the AST

const isMap = (n) => n && n.t === "map";
const isSeq = (n) => n && n.t === "seq";
const isScalar = (n) => n && n.t === "scalar";
const text = (n) => (isScalar(n) && n.value !== null ? String(n.text) : "");
const items = (n) => (isSeq(n) ? n.items : []);
const entries = (n) => (isMap(n) ? n.entries : []);

// Lines of a run-like scalar as [{ text, line }], with real line numbers for block scalars.
function scalarLines(n) {
  if (!isScalar(n) || n.value === null) return [];
  if (n.srcLines) return n.srcLines.map((t, i) => ({ text: t, line: n.bodyLine + i }));
  return String(n.value)
    .split("\n")
    .map((t) => ({ text: t, line: n.line }));
}

function walk(node, visit, path = []) {
  visit(node, path);
  if (isMap(node)) for (const e of node.entries) walk(e.value, visit, [...path, e.key]);
  else if (isSeq(node)) node.items.forEach((it, i) => walk(it, visit, [...path, i]));
}

function actionName(value) {
  const at = value.lastIndexOf("@");
  return at < 0 ? value : value.slice(0, at);
}

function jobsOf(doc) {
  return entries(get(doc.root, "jobs")).map((e) => ({ id: e.key, line: e.keyLine, node: e.value }));
}

function triggers(doc) {
  const on = get(doc.root, "on");
  if (isScalar(on)) return [{ name: text(on), line: on.line }];
  if (isSeq(on)) return on.items.map((it) => ({ name: text(it), line: it.line }));
  return entries(on).map((e) => ({ name: e.key, line: e.keyLine }));
}

// ---------------------------------------------------------------- per-workflow rules

function checkWorkflow(file, doc, ctx) {
  const name = basename(file);
  const isRelease = name === "release.yml";
  const isCi = name === "ci.yml";
  const add = (line, rule, message) => ctx.add(file, line, rule, message);
  const root = doc.root;
  if (!isMap(root)) {
    add(1, "5.2.1", "a workflow must be a mapping");
    return;
  }
  const jobs = jobsOf(doc);
  const jobIds = new Set(jobs.map((j) => j.id));

  for (const t of triggers(doc)) {
    if (t.name === "pull_request_target") add(t.line, "5.2.3", "pull_request_target is not allowed");
    if (t.name === "workflow_run") add(t.line, "5.2.3", "workflow_run is not allowed");
    if (t.name === "issue_comment") add(t.line, "5.2.3", "issue_comment is not allowed (it runs on the default branch for any commenter)");
  }

  // 5.2.1 permissions
  const topPerm = entry(root, "permissions");
  if (!topPerm) add(root.line, "5.2.1", "missing top-level `permissions: {}`");
  else if (!isMap(topPerm.value) || topPerm.value.entries.length) {
    add(topPerm.keyLine, "5.2.1", "top-level permissions must be exactly `{}`");
  }
  for (const job of jobs) {
    const pe = entry(job.node, "permissions");
    if (!pe) {
      if (!entry(job.node, "uses")) add(job.line, "5.2.1", `job ${job.id} does not state its own permissions`);
      continue;
    }
    if (isScalar(pe.value)) {
      add(pe.keyLine, "5.2.1", `job ${job.id} uses the blanket permissions "${text(pe.value)}"`);
      continue;
    }
    const where = `${job.id} in ${name}`;
    for (const p of entries(pe.value)) {
      const level = text(p.value);
      if (level === "write") {
        const ok =
          (isRelease && job.id === "publish" && ["contents", "id-token", "attestations"].includes(p.key)) ||
          (name === "codeql.yml" && p.key === "security-events");
        if (!ok) add(p.keyLine, "5.2.1", `\`${p.key}: write\` is not allowed in ${where}`);
      } else if (p.key === "actions" && level === "read") {
        // Spec 5.2.1 says verify-tag only, but 5.5 gives codeql.yml `actions: read` (CodeQL needs it).
        if (!((isRelease && job.id === "verify-tag") || name === "codeql.yml")) {
          add(p.keyLine, "5.2.1", `\`actions: read\` is only allowed in verify-tag (and codeql.yml), not ${where}`);
        }
      } else if (p.key === "id-token") {
        add(p.keyLine, "5.2.1", `\`id-token\` is not allowed in ${where}`);
      }
    }
  }

  // job graph
  for (const job of jobs) {
    const ne = entry(job.node, "needs");
    if (!ne) continue;
    for (const n of isSeq(ne.value) ? ne.value.items : [ne.value]) {
      if (isScalar(n) && !jobIds.has(text(n))) add(n.line, "needs", `job ${job.id} needs "${text(n)}", which does not exist`);
    }
  }
  if (isCi) {
    const ok = jobs.find((j) => j.id === "ci-ok");
    if (!ok) {
      add(entry(root, "jobs")?.keyLine || 1, "needs", "ci.yml has no `ci-ok` job (the one required status check)");
    } else {
      const ne = entry(ok.node, "needs");
      const have = new Set((isSeq(ne?.value) ? ne.value.items : ne ? [ne.value] : []).map(text));
      for (const req of CI_OK_REQUIRED) {
        if (!have.has(req)) add(ne ? ne.keyLine : ok.line, "needs", `ci-ok does not depend on ${req}`);
      }
      const cond = entry(ok.node, "if");
      if (!cond || !/always\(\)/.test(text(cond.value))) {
        add(cond ? cond.keyLine : ok.line, "needs", "ci-ok must run with `if: always()` so a skipped need cannot hide a failure");
      }
    }
  }

  // 5.2.6 concurrency
  if (isCi || isRelease) {
    const conc = entry(root, "concurrency");
    if (!conc || !isMap(conc.value)) {
      add(conc ? conc.keyLine : root.line, "5.2.6", `${name} needs a top-level \`concurrency\` mapping`);
    } else {
      const cip = entry(conc.value, "cancel-in-progress");
      const v = cip ? text(cip.value) : "";
      const at = cip ? cip.keyLine : conc.keyLine;
      if (isRelease && v !== "false") add(at, "5.2.6", "a release run is never cancelled: cancel-in-progress must be false");
      if (isCi && !/pull_request/.test(v)) {
        add(at, "5.2.6", "cancel-in-progress must be true for pull requests only (github.event_name == 'pull_request')");
      }
    }
  }

  const wfEnv = get(root, "env");
  const rv = entry(wfEnv, "RUST_VERSION");
  let anyRustup = false;
  let usesRustCache = false;
  let hasIncremental = text(get(wfEnv, "CARGO_INCREMENTAL")) === "0";

  for (const job of jobs) {
    const jid = job.id;
    const env = entry(job.node, "environment");
    const jobUses = entry(job.node, "uses");
    if (jobUses && isScalar(jobUses.value)) checkUses(jobUses.value, ctx, add);
    if (text(get(get(job.node, "env"), "CARGO_INCREMENTAL")) === "0") hasIncremental = true;

    if (!jobUses) {
      if (!entry(job.node, "timeout-minutes")) add(job.line, "5.2.4", `job ${jid} has no timeout-minutes`);
      checkRunsOn(job, ctx, add);
    }

    if (env) {
      if (isCi) add(env.keyLine, "5.2.11", `ci.yml must not use an environment (job ${jid})`);
      else if (!isRelease) add(env.keyLine, "5.2.5", `${name} must not use an environment (job ${jid})`);
      else if (!ENV_JOBS.has(jid)) add(env.keyLine, "5.2.5", `only the sign and feed jobs may declare an environment, not ${jid}`);
    }

    const coe = entry(job.node, "continue-on-error");
    if (coe && text(coe.value) !== "false") {
      if (!(CONTINUE_ON_ERROR_ALLOW[name] || []).includes(jid)) {
        add(coe.keyLine, "5.2.8", `continue-on-error is not allowed on job ${jid} in ${name}`);
      } else if (!hasDecisionComment(doc, coe)) {
        add(coe.keyLine, "5.2.8", `continue-on-error on ${jid} needs a comment naming the decision that makes it non-blocking`);
      }
    }

    const steps = items(get(job.node, "steps")).filter(isMap);
    let downloads = false;
    for (const step of steps) {
      const ue = entry(step, "uses");
      const u = ue && isScalar(ue.value) ? ue.value : null;
      const withMap = get(step, "with");
      const scoe = entry(step, "continue-on-error");
      if (scoe && text(scoe.value) !== "false") {
        add(scoe.keyLine, "5.2.8", "continue-on-error is only allowed on the allowlisted jobs, not on a step");
      }
      if (u) {
        checkUses(u, ctx, add);
        const an = actionName(text(u));
        const at = u.line;
        if (/^actions\/download-artifact/.test(an)) downloads = true;
        if (an === "actions/checkout") {
          const pc = entry(withMap, "persist-credentials");
          if (!pc || text(pc.value) !== "false") add(at, "5.2.4", "actions/checkout needs `persist-credentials: false`");
        }
        if (an === "actions/setup-node") {
          const nv = entry(withMap, "node-version");
          if (!nv || text(nv.value) !== "24") add(nv ? nv.keyLine : at, "5.2.10", "setup-node must use `node-version: 24`");
        }
        if (THIRD_PARTY_TOOLCHAIN.test(an)) {
          add(at, "5.2.10", 'Rust comes from `rustup toolchain install "$RUST_VERSION"`, not a third-party action');
        }
        if (/rust-cache/i.test(an)) {
          usesRustCache = true;
          if (isCi) {
            const si = entry(withMap, "save-if");
            if (!si || !/refs\/heads\/main/.test(text(si.value))) {
              add(si ? si.keyLine : at, "5.2.9", "rust-cache needs `save-if: ${{ github.ref == 'refs/heads/main' }}`");
            }
            const cf = entry(withMap, "cache-on-failure");
            if (!cf || text(cf.value) !== "true") add(cf ? cf.keyLine : at, "5.2.9", "rust-cache needs `cache-on-failure: true`");
          }
        }
        if (!isRelease && /^actions\/cache(\/save)?$/i.test(an)) {
          add(at, "5.2.9", "actions/cache saves from pull request runs (cache poisoning); use rust-cache with `save-if` on main, or actions/cache/restore");
        }
        if (isRelease) {
          if (/(^|\/)[^/@]*cache[^/@]*(\/[^@]*)?$/i.test(an)) add(at, "5.2.9", `release.yml uses no cache action (${an})`);
          for (const k of ["cache", "cache-dependency-path"]) {
            const ce = entry(withMap, k);
            if (ce) add(ce.keyLine, "5.2.9", `release.yml uses no cache input (\`${k}\`)`);
          }
          if (jid === "publish" && /^pnpm\//.test(an)) add(at, "5.2.13", "the publish job runs no package manager");
          if (jid === "sign" && env && !SIGN_USES.has(an)) {
            add(at, "5.2.5", `the sign job may only use checkout, download-artifact and upload-artifact, not ${an}`);
          }
        }
        if (isCi && /^actions\/download-artifact/.test(an)) add(at, "5.2.11", "ci.yml has no job that consumes an artifact");
        if (an === "actions/github-script") {
          const sc = entry(withMap, "script");
          if (sc) checkInjection(scalarLines(sc.value), add);
        }
      }
      const run = entry(step, "run");
      if (run) {
        const lines = scalarLines(run.value);
        checkRun(lines, isRelease, add);
        if (lines.some((l) => /\brustup\s+toolchain\s+install\b/.test(l.text))) {
          anyRustup = true;
          if (!lines.some((l) => /rustup\s+toolchain\s+install\s+"\$RUST_VERSION"/.test(l.text))) {
            add(run.keyLine, "5.2.10", 'use `rustup toolchain install "$RUST_VERSION" --profile minimal`');
          }
        }
        if (isRelease && jid === "sign" && env && (u || !/^bash scripts\/ci\/[A-Za-z0-9_.-]+\.sh$/.test(text(run.value).trim()))) {
          add(run.keyLine, "5.2.5", "a step of the sign job may only run `bash scripts/ci/<name>.sh`");
        }
        // 5.2.7: a scripts/ci script that downloads something must verify a sha256
        for (const l of lines) {
          const m = /^\s*bash\s+(scripts\/ci\/[A-Za-z0-9_.-]+\.sh)\b/.exec(l.text);
          if (!m) continue;
          const p = join(ctx.root, m[1]);
          if (existsSync(p)) {
            const src = readFileSync(p, "utf8");
            if (/\b(curl|wget)\b/.test(src) && !/sha256/.test(src)) {
              add(l.line, "5.2.7", `${m[1]} downloads a tool but never mentions sha256 (pin the version and verify the hash)`);
            }
          }
        }
        if (isRelease && jid === "publish") {
          for (const l of lines) {
            if (/(^|[\s;&|(])(pnpm|npm|npx|yarn|cargo|corepack)(\s|$)/.test(l.text)) {
              add(l.line, "5.2.13", "the publish job runs no package manager (pnpm, npm, cargo): Node built-ins only");
            }
          }
        }
        if (isRelease && jid === "feed") {
          for (const l of lines) {
            if (/(^|[\s;&|(])(pnpm|npm|yarn)\s+(i|install|add)\b/.test(l.text) && !(/--ignore-scripts/.test(l.text) && /--frozen-lockfile/.test(l.text))) {
              add(l.line, "5.2.5", "the feed job installs with `--frozen-lockfile --ignore-scripts` only");
            }
          }
        }
      }
    }

    // 5.2.3: an artifact consumer must not hold privileges
    const writes = entries(get(job.node, "permissions")).some((p) => text(p.value) === "write");
    let jobSecrets = false;
    walk(job.node, (n) => {
      if (isScalar(n) && /\bsecrets\s*(\.|\[|\))/.test(String(n.text))) jobSecrets = true;
    });
    if (downloads && (env || jobSecrets || writes) && !(isRelease && ARTIFACT_PRIVILEGED.has(jid))) {
      add(job.line, "5.2.3", `job ${jid} downloads an artifact and holds a secret, an environment or a write token`);
    }
  }

  checkSecrets(file, name, doc, ctx, isRelease);

  if (anyRustup && (!rv || !/^\d+\.\d+\.\d+$/.test(text(rv.value)))) {
    add(rv ? rv.keyLine : root.line, "5.2.10", "RUST_VERSION must be set in the workflow env to an exact x.y.z version");
  }
  if (isCi && usesRustCache && !hasIncremental) {
    add(root.line, "5.2.9", 'ci.yml with rust-cache sets `CARGO_INCREMENTAL: "0"`');
  }
}

function hasDecisionComment(doc, coeEntry) {
  const same = coeEntry.value.comment;
  if (same && DECISION_COMMENT.test(same)) return true;
  for (let l = coeEntry.keyLine - 1; l >= coeEntry.keyLine - 3; l--) {
    const c = doc.comments.get(l);
    if (c === undefined) break;
    if (DECISION_COMMENT.test(c)) return true;
  }
  return false;
}

function checkUses(node, ctx, add) {
  const v = text(node);
  if (v.startsWith("./")) return;
  if (v.startsWith("docker://")) {
    add(node.line, "5.2.2", "docker:// references are not used");
    return;
  }
  const m = PINNED_USES.exec(v);
  if (!m) {
    add(node.line, "5.2.2", `\`${v}\` is not pinned to a full 40-hex commit SHA`);
    return;
  }
  if (!node.comment || !VERSION_COMMENT.test(node.comment)) {
    add(node.line, "5.6", `\`${v}\` needs a version comment (# vX.Y.Z)`);
  }
  if (m[1] === "PIN-ME" && ctx.strict) add(node.line, "5.6", "PIN-ME: the action is not pinned yet");
}

function checkRunsOn(job, ctx, add) {
  const ro = entry(job.node, "runs-on");
  if (!ro) {
    add(job.line, "5.2.4", `job ${job.id} has no runs-on`);
    return;
  }
  if (!isScalar(ro.value)) {
    add(ro.keyLine, "5.2.4", "runs-on must be a single explicit label");
    return;
  }
  const labels = [];
  const v = text(ro.value);
  const m = /^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}$/.exec(v);
  if (m) {
    const matrix = get(get(job.node, "strategy"), "matrix");
    const vals = [];
    for (const it of items(get(matrix, "include"))) {
      const e = entry(it, m[1]);
      if (e) vals.push(e.value);
    }
    const direct = get(matrix, m[1]);
    if (isSeq(direct)) vals.push(...direct.items);
    if (!vals.length) add(ro.keyLine, "5.2.4", `runs-on uses matrix.${m[1]}, which the matrix does not define`);
    for (const x of vals) labels.push({ label: text(x), line: x.line });
  } else if (v.includes("${{")) {
    add(ro.keyLine, "5.2.4", "runs-on must be an explicit label, not an expression");
  } else {
    labels.push({ label: v, line: ro.keyLine });
  }
  for (const { label, line } of labels) {
    if (/-latest$/.test(label)) add(line, "5.2.4", `runner label ${label} is floating; use an explicit label`);
    else if (BANNED_LABELS.has(label)) add(line, "5.2.4", `runner label ${label} is not allowed`);
    else if (!HOSTED_LABEL.test(label)) add(line, "5.2.4", `runner label ${label} is not a GitHub-hosted image (self-hosted and custom labels are not allowed)`);
    const ret = ctx.labels.get(label);
    if (ret) {
      const days = (Date.parse(ret + "T00:00:00Z") - Date.parse(ctx.today + "T00:00:00Z")) / 86400000;
      if (days <= 30) {
        add(line, "retire", days < 0 ? `runner label ${label} was retired on ${ret}` : `runner label ${label} is retired on ${ret} (within 30 days)`);
      }
    }
  }
}

function checkInjection(lines, add) {
  for (const l of lines) {
    if (l.text.trimStart().startsWith("#")) continue;
    const m = /\$\{\{\s*(github\.event\.|github\.head_ref|github\.ref_name|inputs\.)/.exec(l.text);
    if (m) add(l.line, "5.2.3", `\`\${{ ${m[1]}... }}\` inside a run block: pass it through env: and use "$VAR"`);
  }
}

function checkRun(lines, isRelease, add) {
  checkInjection(lines, add);
  for (const l of lines) {
    const t = l.text;
    if (t.trimStart().startsWith("#")) continue;
    if (/\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/.test(t)) add(l.line, "5.2.3", "curl | sh is not allowed");
    if (isRelease && (/(^|[\s;&|(])set\s+-[A-Za-z]*x/.test(t) || /set\s+-o\s+xtrace/.test(t) || /\b(ba)?sh\s+-[A-Za-z]*x/.test(t))) {
      add(l.line, "5.2.3", "no `set -x` in release.yml");
    }
    if (/(^|[\s;&|(`])(curl|wget)(\s|$)/.test(t)) add(l.line, "5.2.7", "run blocks do not call curl or wget; tools are installed inside scripts/ci/*.sh");
    if (/\bbrew\s+install\b/.test(t)) add(l.line, "5.2.7", "run blocks do not call brew install");
    if (/\bnpm\s+(i|install|add)\b.*(\s-g\b|--global)/.test(t)) add(l.line, "5.2.7", "run blocks do not call npm i -g");
    if (/\bpip3?\s+install\b/.test(t)) add(l.line, "5.2.7", "run blocks do not call pip install");
    if (/\bcargo\s+install\b/.test(t)) add(l.line, "5.2.7", "run blocks do not call cargo install");
    if (/\bpnpm\s+(i|install)\b/.test(t) && !/--frozen-lockfile\b/.test(t)) add(l.line, "5.2.10", "pnpm install needs --frozen-lockfile");
  }
}

// 5.2.5: where `secrets.` may appear.
function checkSecrets(file, name, doc, ctx, isRelease) {
  const add = (line, msg) => ctx.add(file, line, "5.2.5", msg);
  walk(doc.root, (n, full) => {
    if (isMap(n)) {
      for (const e of n.entries) if (e.key === "secrets") add(e.keyLine, "`secrets:` (inherit or pass-through) is not allowed");
    }
    if (!isScalar(n) || n.value === null) return;
    const re = /\bsecrets\s*(?:\.\s*([A-Za-z0-9_]+)|\[|\))/g;
    let m;
    while ((m = re.exec(String(n.text)))) {
      const secret = m[1] || "";
      if (secret === "GITHUB_TOKEN") {
        add(n.line, "secrets.GITHUB_TOKEN is never used; pass `github.token` through env:");
      } else if (!isRelease) {
        add(n.line, `${name} references no secrets (found secrets.${secret})`);
      } else {
        const jobId = full[0] === "jobs" ? full[1] : "";
        const inStepEnv = full[0] === "jobs" && full[2] === "steps" && full[4] === "env";
        if (!inStepEnv || !ENV_JOBS.has(jobId)) add(n.line, `secrets.${secret} may appear only in the env of a step of the sign or feed job`);
        else if (jobId === "sign" && !/^APPLE_/.test(secret)) add(n.line, `secrets.${secret}: only the Apple secrets belong in the sign job`);
        else if (jobId === "feed" && !/^TAURI_SIGNING_/.test(secret)) add(n.line, `secrets.${secret}: the feed job holds the updater key only`);
      }
    }
  });
}

// ---------------------------------------------------------------- dependabot.yml

function checkDependabot(file, doc, ctx) {
  const add = (line, msg) => ctx.add(file, line, "dependabot", msg);
  const root = doc.root;
  if (!isMap(root)) return add(1, "dependabot.yml must be a mapping");
  const ver = entry(root, "version");
  if (!ver || text(ver.value) !== "2") add(ver ? ver.keyLine : 1, "`version: 2` is required");
  const updatesLine = entry(root, "updates")?.keyLine || 1;
  const ecosystems = new Set();
  let sdkIgnored = false;
  for (const u of items(get(root, "updates"))) {
    const eco = text(get(u, "package-ecosystem"));
    ecosystems.add(eco);
    const dirs = [];
    const d = entry(u, "directory");
    if (d) dirs.push({ dir: text(d.value), line: d.keyLine });
    for (const x of items(get(u, "directories"))) dirs.push({ dir: text(x), line: x.line });
    for (const { dir, line } of dirs) {
      if (/(^|\/)sdk-pin\/?$/.test(dir)) add(line, "/sidecar/sdk-pin must not be listed: the SDK pin is changed by hand");
      if (eco === "npm" && !existsSync(join(ctx.root, dir, "package.json"))) add(line, `npm directory ${dir} contains no package.json`);
    }
    if (eco === "npm") {
      for (const ig of items(get(u, "ignore"))) {
        if (text(get(ig, "dependency-name")) === "@anthropic-ai/claude-agent-sdk") sdkIgnored = true;
      }
    }
  }
  for (const eco of ["cargo", "npm", "github-actions"]) {
    if (!ecosystems.has(eco)) add(updatesLine, `missing the ${eco} ecosystem`);
  }
  if (ecosystems.has("npm") && !sdkIgnored) add(updatesLine, "the npm block must ignore @anthropic-ai/claude-agent-sdk (dependency-name)");
}

// ---------------------------------------------------------------- driver

function readLabels(path) {
  const map = new Map();
  if (!existsSync(path)) return map;
  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new YamlError(`runner-labels.json is not valid JSON: ${e.message}`, 1);
  }
  if (!Array.isArray(data)) throw new YamlError("runner-labels.json must be an array", 1);
  for (const it of data) {
    if (!it || typeof it.label !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(String(it.retiredOn))) {
      throw new YamlError('runner-labels.json entries look like {"label":"macos-14","retiredOn":"YYYY-MM-DD"}', 1);
    }
    map.set(it.label, it.retiredOn);
  }
  return map;
}

function listFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) listFiles(p, out);
    else if (st.isFile() && st.size < 2_000_000) out.push(p);
  }
  return out;
}

export function checkFiles(opts) {
  const root = resolve(opts.root || DEFAULT_ROOT);
  const findings = [];
  const warnings = [];
  const errors = [];
  const shown = (p) => {
    const r = relative(process.cwd(), p);
    return r && !r.startsWith("..") ? r : p;
  };
  const ctx = {
    root,
    strict: !!opts.strict,
    today: opts.today || new Date().toISOString().slice(0, 10),
    labels: new Map(),
    add(file, line, rule, message) {
      findings.push({ file: shown(file), line, rule, message });
    },
  };
  const labelsPath = opts.labels ? resolve(opts.labels) : join(root, ".github/runner-labels.json");
  try {
    ctx.labels = readLabels(labelsPath);
  } catch (e) {
    errors.push({ file: shown(labelsPath), line: e.line || 1, message: e.message });
  }

  let files = (opts.files || []).map((f) => resolve(f));
  if (!files.length) {
    const wf = join(root, ".github/workflows");
    if (existsSync(wf)) {
      files = readdirSync(wf)
        .filter((n) => /\.ya?ml$/.test(n))
        .sort()
        .map((n) => join(wf, n));
    }
    const dep = join(root, ".github/dependabot.yml");
    if (existsSync(dep)) files.push(dep);
    if (!files.length) warnings.push({ file: shown(wf), line: 0, message: "no workflow files found" });
  }

  for (const f of files) {
    let src;
    try {
      src = readFileSync(f, "utf8");
    } catch (e) {
      errors.push({ file: shown(f), line: 0, message: `cannot read file: ${e.code || e.message}` });
      continue;
    }
    let doc;
    try {
      doc = parseDocument(src);
    } catch (e) {
      if (!(e instanceof YamlError)) throw e;
      errors.push({ file: shown(f), line: e.line, message: e.message });
      continue;
    }
    if (/^dependabot\.ya?ml$/.test(basename(f))) checkDependabot(f, doc, ctx);
    else checkWorkflow(f, doc, ctx);
  }

  // PIN-ME anywhere under .github fails the strict lint (5.2.2, 5.6)
  if (ctx.strict) {
    for (const p of listFiles(join(root, ".github"))) {
      let src;
      try {
        src = readFileSync(p, "utf8");
      } catch {
        continue;
      }
      src.split("\n").forEach((l, i) => {
        if (l.includes("PIN-ME")) ctx.add(p, i + 1, "5.6", "PIN-ME must be resolved before the strict lint passes");
      });
    }
  }

  // 5.2.12 packageManager integrity (warning only)
  try {
    const pj = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (typeof pj.packageManager === "string" && !/\+sha(256|512)\./.test(pj.packageManager)) {
      warnings.push({
        file: shown(join(root, "package.json")),
        line: 0,
        rule: "5.2.12",
        message: "packageManager has no integrity suffix (+sha512...); run `corepack use` to add it",
      });
    }
  } catch {
    // no root package.json: nothing to warn about
  }

  const seen = new Set();
  const unique = findings.filter((f) => {
    const k = `${f.file}:${f.line}:${f.rule}:${f.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  unique.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  return { findings: unique, warnings, errors, files: files.length };
}

const USAGE = "usage: check-workflows.mjs [--strict] [--today YYYY-MM-DD] [--json] [--root DIR] [--labels FILE] [files...]";

function parseArgs(argv) {
  const o = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => {
      if (i + 1 >= argv.length) throw new Usage(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--strict") o.strict = true;
    else if (a === "--json") o.json = true;
    else if (a === "--today") {
      o.today = need();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(o.today) || Number.isNaN(Date.parse(o.today))) throw new Usage("--today needs YYYY-MM-DD");
    } else if (a === "--root") o.root = need();
    else if (a === "--labels") o.labels = need();
    else if (a === "-h" || a === "--help") o.help = true;
    else if (a.startsWith("--")) throw new Usage(`unknown option ${a}`);
    else o.files.push(a);
  }
  return o;
}

export function main(argv, out = console.log, errOut = console.error) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    errOut(`${e.message}\n${USAGE}`);
    return 2;
  }
  if (o.help) {
    out(USAGE);
    return 0;
  }
  const r = checkFiles(o);
  if (o.json) {
    out(JSON.stringify({ findings: r.findings, warnings: r.warnings, errors: r.errors, files: r.files }, null, 2));
  } else {
    for (const e of r.errors) errOut(`${e.file}:${e.line} unreadable ${e.message}`);
    for (const f of r.findings) out(`${f.file}:${f.line} ${f.rule} ${f.message}`);
    for (const w of r.warnings) errOut(`${w.file}:${w.line} warning${w.rule ? " " + w.rule : ""} ${w.message}`);
    out(`check-workflows: ${r.files} file(s), ${r.findings.length} finding(s)${o.strict ? " (strict)" : ""}`);
  }
  if (r.errors.length) return 3;
  return r.findings.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}

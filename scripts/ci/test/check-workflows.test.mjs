import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const CLI = join(ROOT, "scripts/ci/check-workflows.mjs");
const CLEAN = join(HERE, "fixtures/workflows/clean");
const TODAY = "2026-10-04";
const tmps = [];
after(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

const read = (n) => readFileSync(join(CLEAN, n), "utf8");

// Build a throwaway repo root with the clean fixtures; `mutate` maps a file name to a text transform.
function mkRoot(mutate = {}, { packageManager = "pnpm@11.5.3+sha512.abc", extra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cw-"));
  tmps.push(dir);
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  const texts = {};
  for (const n of ["ci.yml", "release.yml", "codeql.yml", "audit.yml"]) {
    texts[n] = (mutate[n] || ((t) => t))(read(n));
    writeFileSync(join(dir, ".github/workflows", n), texts[n]);
  }
  texts["dependabot.yml"] = (mutate["dependabot.yml"] || ((t) => t))(read("dependabot.yml"));
  writeFileSync(join(dir, ".github/dependabot.yml"), texts["dependabot.yml"]);
  copyFileSync(join(CLEAN, "runner-labels.json"), join(dir, ".github/runner-labels.json"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", packageManager }));
  mkdirSync(join(dir, "ui"));
  writeFileSync(join(dir, "ui/package.json"), "{}");
  for (const [p, body] of Object.entries(extra)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  return { dir, texts };
}

function run(dir, args = []) {
  const r = spawnSync(process.execPath, [CLI, "--root", dir, "--today", TODAY, ...args], { encoding: "utf8", cwd: dir });
  const findings = r.stdout
    .split("\n")
    .map((l) => /^(\S+?):(\d+) (\S+) (.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ file: m[1], line: Number(m[2]), rule: m[3], message: m[4] }));
  return { code: r.status, out: r.stdout, err: r.stderr, findings };
}

const rep = (from, to) => (t) => {
  assert.ok(t.includes(from), `fixture no longer contains: ${from}`);
  return t.replace(from, to);
};
const repAll = (from, to) => (t) => {
  assert.ok(t.includes(from), `fixture no longer contains: ${from}`);
  return t.split(from).join(to);
};
const lineOf = (text, needle) => {
  const i = text.split("\n").findIndex((l) => l.includes(needle));
  assert.ok(i >= 0, `needle not in mutated text: ${needle}`);
  return i + 1;
};

const S1 = "1".repeat(40);
const S2 = "2".repeat(40);
const S4 = "4".repeat(40);
const signCheckout = `      - uses: actions/checkout@${S1} # v7.0.1\n        with: { persist-credentials: false }\n      - uses: actions/download-artifact@${"8".repeat(40)} # v8.0.1\n        with: { name: "stage-\${{ matrix.arch }}", path: out }\n      - name: Detect signing`;

// [title, file, mutate, rule, needle, extra CLI args]
const NEGATIVES = [
  ["environment job contains setup-node", "release.yml", rep(signCheckout, signCheckout.replace("      - name: Detect signing", `      - uses: actions/setup-node@${S2} # v7.0.0 MARK\n        with: { node-version: 24 }\n      - name: Detect signing`)), "5.2.5", "v7.0.0 MARK"],
  ["environment job runs pnpm", "release.yml", rep("run: bash scripts/ci/cleanup-keychain.sh", "run: pnpm exec tauri signer MARK"), "5.2.5", "tauri signer MARK"],
  ["environment job runs node", "release.yml", rep("run: bash scripts/ci/cleanup-keychain.sh", "run: node scripts/x.mjs MARK"), "5.2.5", "x.mjs MARK"],
  ["environment job: bash with other path", "release.yml", rep("run: bash scripts/ci/cleanup-keychain.sh", "run: bash scripts/release/x.sh MARK"), "5.2.5", "x.sh MARK"],
  ["cache action in release.yml", "release.yml", rep("      - name: Toolchain\n", `      - uses: Swatinem/rust-cache@${S4} # v2.9.2 MARK\n      - name: Toolchain\n`), "5.2.9", "rust-cache@"],
  ["cache: input in release.yml", "release.yml", repAll("with: { node-version: 24 }", "with: { node-version: 24, cache: pnpm }"), "5.2.9", "cache: pnpm"],
  ["secrets in ci.yml", "ci.yml", rep("NEEDS_JSON: ${{ toJSON(needs) }}", "NEEDS_JSON: ${{ secrets.FOO }}"), "5.2.5", "secrets.FOO"],
  ["secrets outside a step env", "release.yml", rep("    permissions: { contents: write, id-token: write, attestations: write }", "    env:\n      X: ${{ secrets.APPLE_CERTIFICATE }} MARK\n    permissions: { contents: write, id-token: write, attestations: write }"), "5.2.5", "secrets.APPLE_CERTIFICATE }} MARK"],
  ["secrets.GITHUB_TOKEN", "release.yml", rep("secrets.APPLE_API_ISSUER }}", "secrets.GITHUB_TOKEN }}"), "5.2.5", "secrets.GITHUB_TOKEN"],
  ["Apple secret in feed", "release.yml", rep("TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.APPLE_API_KEY }}"), "5.2.5", "secrets.APPLE_API_KEY }}"],
  ["feed installs with scripts", "release.yml", rep("pnpm install --frozen-lockfile --ignore-scripts", "pnpm install --frozen-lockfile # MARK"), "5.2.5", "frozen-lockfile # MARK"],
  ["pull_request_target", "ci.yml", rep("  workflow_dispatch:\npermissions: {}", "  workflow_dispatch:\n  pull_request_target: # MARK\npermissions: {}"), "5.2.3", "pull_request_target"],
  ["workflow_run", "ci.yml", rep("  workflow_dispatch:\npermissions: {}", "  workflow_dispatch:\n  workflow_run: # MARK\npermissions: {}"), "5.2.3", "workflow_run"],
  ["ref is not 40 hex", "ci.yml", rep(`actions/checkout@${S1} # v7.0.1`, "actions/checkout@v4 # v7.0.1"), "5.2.2", "checkout@v4"],
  ["missing version comment", "ci.yml", rep(`actions/setup-node@${S2} # v7.0.0`, `actions/setup-node@${S2}`), "5.6", `setup-node@${S2}`],
  ["malformed version comment", "ci.yml", rep(`actions/setup-node@${S2} # v7.0.0`, `actions/setup-node@${S2} # latest`), "5.6", `setup-node@${S2}`],
  ["PIN-ME fails with --strict", "ci.yml", rep(`actions/setup-node@${S2} # v7.0.0`, "actions/setup-node@PIN-ME # v7.0.0"), "5.6", "PIN-ME", ["--strict"]],
  ["publish job runs pnpm", "release.yml", rep("          node scripts/release/notes.mjs\n", "          node scripts/release/notes.mjs\n          pnpm exec foo MARK\n"), "5.2.13", "pnpm exec foo MARK"],
  ["publish job runs cargo", "release.yml", rep("          node scripts/release/notes.mjs\n", "          node scripts/release/notes.mjs\n          cargo build MARK\n"), "5.2.13", "cargo build MARK"],
  ["github.ref_name inside run", "release.yml", rep('--ci-release --tag "$TAG"', '--ci-release --tag "${{ github.ref_name }}"'), "5.2.3", "--tag \"${{ github.ref_name"],
  ["github.event.* inside run", "ci.yml", rep('--range "$BASE_SHA..$HEAD_SHA"', '--range "${{ github.event.pull_request.base.sha }}"'), "5.2.3", "github.event.pull_request.base.sha }}\""],
  ["inputs.* inside run", "ci.yml", rep("      - run: pnpm i18n:check", "      - run: echo ${{ inputs.name }} MARK"), "5.2.3", "inputs.name"],
  ["curl | sh", "ci.yml", rep("      - run: pnpm i18n:check", "      - run: curl -sSf https://x.example/i.sh | sh MARK"), "5.2.3", "curl -sSf"],
  ["docker:// reference", "ci.yml", rep("      - run: node scripts/ci/check-workflows.mjs --strict", "      - uses: docker://alpine:3 # MARK\n      - run: node scripts/ci/check-workflows.mjs --strict"), "5.2.2", "docker://"],
  ["set -x in release.yml", "release.yml", rep("          bash scripts/release-mac.sh --sums-only", "          set -x\n          bash scripts/release-mac.sh --sums-only"), "5.2.3", "set -x"],
  ["continue-on-error outside the allowlist", "ci.yml", rep("  lint-workflows:\n", "  lint-workflows:\n    continue-on-error: true # RD1 MARK\n"), "5.2.8", "continue-on-error: true # RD1 MARK"],
  ["continue-on-error without a decision comment", "audit.yml", rep("continue-on-error: true # RD9: advisory only", "continue-on-error: true"), "5.2.8", "continue-on-error: true"],
  ["continue-on-error in release.yml", "release.yml", rep("  verify-tag:\n", "  verify-tag:\n    continue-on-error: true # RD1 MARK\n"), "5.2.8", "continue-on-error: true # RD1 MARK"],
  ["ubuntu-latest", "ci.yml", rep("runs-on: ubuntu-24.04", "runs-on: ubuntu-latest"), "5.2.4", "ubuntu-latest"],
  ["self-hosted runner", "ci.yml", rep("runs-on: macos-15", "runs-on: self-hosted"), "5.2.4", "self-hosted"],
  ["custom runner label", "release.yml", rep("os: macos-15-intel", "os: my-big-mac"), "5.2.4", "my-big-mac"],
  ["issue_comment", "ci.yml", rep("  workflow_dispatch:\npermissions: {}", "  workflow_dispatch:\n  issue_comment: # MARK\npermissions: {}"), "5.2.3", "issue_comment"],
  ["ref is a 7-hex abbreviation", "ci.yml", rep(`actions/checkout@${S1} # v7.0.1`, "actions/checkout@abcdef1 # v7.0.1"), "5.2.2", "checkout@abcdef1"],
  ["macos-13", "ci.yml", rep("runs-on: macos-15", "runs-on: macos-13"), "5.2.4", "macos-13"],
  ["macos-14", "ci.yml", rep("runs-on: macos-15", "runs-on: macos-14"), "5.2.4", "macos-14"],
  ["runner label inside the retirement window", "release.yml", (t) => t, "retire", "os: macos-15-intel", ["--today", "2027-08-15"]],
  ["runner label past retiredOn", "release.yml", (t) => t, "retire", "os: macos-15-intel", ["--today", "2027-09-01"]],
  ["ci-ok misses a need", "ci.yml", rep(", release-verify]", "]"), "needs", "needs: [lint-workflows"],
  ["a need that does not exist", "ci.yml", rep("needs: [lint-workflows,", "needs: [ghost, lint-workflows,"), "needs", "needs: [ghost"],
  ["ci-ok without always()", "ci.yml", rep("    if: always()\n", "    if: success()\n"), "needs", "if: success()"],
  ["dependabot without the SDK ignore", "dependabot.yml", rep('    ignore:\n      - dependency-name: "@anthropic-ai/claude-agent-sdk"\n', ""), "dependabot", "updates:"],
  ["dependabot lists sdk-pin", "dependabot.yml", (t) => t + '  - package-ecosystem: npm\n    directory: "/sidecar/sdk-pin"\n    schedule:\n      interval: weekly\n', "dependabot", "sdk-pin"],
  ["dependabot missing github-actions", "dependabot.yml", rep("  - package-ecosystem: github-actions\n    directory: \"/\"\n    schedule:\n      interval: weekly\n", ""), "dependabot", "updates:"],
  ["checkout without persist-credentials", "ci.yml", rep(`actions/checkout@${S1} # v7.0.1\n        with: { persist-credentials: false }`, `actions/checkout@${S1} # v7.0.1\n        with: { fetch-depth: 1 }`), "5.2.4", "checkout@"],
  ["job without timeout-minutes", "ci.yml", rep("    timeout-minutes: 10\n", ""), "5.2.4", "  lint-workflows:"],
  ["top-level permissions grant something", "ci.yml", rep("permissions: {}\nconcurrency", "permissions: { contents: read }\nconcurrency"), "5.2.1", "permissions: { contents: read }"],
  ["write permission outside publish", "release.yml", rep("permissions: { contents: read, actions: read }", "permissions: { contents: write, actions: read }"), "5.2.1", "contents: write, actions"],
  ["actions: read outside verify-tag", "ci.yml", rep("permissions: { contents: read }", "permissions: { contents: read, actions: read }"), "5.2.1", "actions: read"],
  ["environment in ci.yml", "ci.yml", rep("  lint-workflows:\n", "  lint-workflows:\n    environment: release # MARK\n"), "5.2.11", "environment: release"],
  ["environment on a non-sign job", "release.yml", rep("  build:\n    needs: verify-tag\n", "  build:\n    needs: verify-tag\n    environment: release # MARK\n"), "5.2.5", "environment: release"],
  ["artifact consumer with a write token", "release.yml", rep("  verify:\n    needs: sign\n    runs-on: ${{ matrix.os }}\n    timeout-minutes: 45\n    permissions: { contents: read }", "  verify:\n    needs: sign\n    runs-on: ${{ matrix.os }}\n    timeout-minutes: 45\n    permissions: { contents: write }"), "5.2.3", "  verify:"],
  ["artifact download in ci.yml", "ci.yml", rep("      - run: node scripts/ci/check-workflows.mjs --strict", `      - uses: actions/download-artifact@${"8".repeat(40)} # v8.0.1 MARK\n      - run: node scripts/ci/check-workflows.mjs --strict`), "5.2.11", "download-artifact"],
  ["release run cancelled in progress", "release.yml", rep("cancel-in-progress: false", "cancel-in-progress: true"), "5.2.6", "cancel-in-progress: true"],
  ["ci always cancels", "ci.yml", rep("cancel-in-progress: ${{ github.event_name == 'pull_request' }}", "cancel-in-progress: true"), "5.2.6", "cancel-in-progress: true"],
  ["pnpm install without --frozen-lockfile", "ci.yml", rep("      - run: pnpm install --frozen-lockfile", "      - run: pnpm install"), "5.2.10", "pnpm install"],
  ["node 22", "ci.yml", rep("with: { node-version: 24 }", "with: { node-version: 22 }"), "5.2.10", "node-version: 22"],
  ["third-party Rust toolchain action", "ci.yml", rep("      - run: rustup toolchain install", `      - uses: dtolnay/rust-toolchain@${S4} # v1.0.0 MARK\n      - run: rustup toolchain install`), "5.2.10", "dtolnay"],
  ["actions/cache in ci.yml", "ci.yml", rep("      - run: pnpm i18n:check", `      - uses: actions/cache@${S4} # v4.2.0 MARK\n      - run: pnpm i18n:check`), "5.2.9", "actions/cache@"],
  ["rust-cache without save-if", "ci.yml", rep("          save-if: ${{ github.ref == 'refs/heads/main' }}\n", ""), "5.2.9", "rust-cache@"],
  ["brew install", "ci.yml", rep("      - run: pnpm i18n:check", "      - run: brew install foo MARK"), "5.2.7", "brew install"],
  ["cargo install", "ci.yml", rep("      - run: pnpm i18n:check", "      - run: cargo install foo MARK"), "5.2.7", "cargo install"],
  ["npm i -g", "ci.yml", rep("      - run: pnpm i18n:check", "      - run: npm i -g foo MARK"), "5.2.7", "npm i -g"],
  ["curl in a run block", "ci.yml", rep("      - run: pnpm i18n:check", "      - run: curl -o x https://x.example MARK"), "5.2.7", "curl -o x"],
];

test("the clean fixtures pass the strict lint with a pinned date", () => {
  const { dir } = mkRoot();
  const r = run(dir, ["--strict"]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(r.findings, []);
  assert.match(r.out, /5 file\(s\), 0 finding\(s\) \(strict\)/);
  assert.equal(r.err, "", "no warning when packageManager has an integrity suffix");
});

for (const [title, file, mutate, rule, needle, args = []] of NEGATIVES) {
  test(`negative: ${title}`, () => {
    const { dir, texts } = mkRoot({ [file]: mutate });
    const r = run(dir, args);
    assert.equal(r.code, 1, `expected findings\n${r.out}${r.err}`);
    const line = lineOf(texts[file], needle);
    const hit = r.findings.find((f) => f.file.endsWith(`.github/${file === "dependabot.yml" ? "" : "workflows/"}${file}`) && f.rule === rule && f.line === line);
    assert.ok(hit, `expected ${file}:${line} ${rule}\ngot:\n${r.out}`);
  });
}

test("PIN-ME with a version comment passes the non-strict lint", () => {
  const { dir } = mkRoot({ "ci.yml": rep(`actions/setup-node@${S2} # v7.0.0`, "actions/setup-node@PIN-ME # v7.0.0") });
  assert.equal(run(dir).code, 0);
  const strict = run(dir, ["--strict"]);
  assert.equal(strict.code, 1);
  assert.ok(strict.findings.some((f) => f.rule === "5.6"));
});

test("PIN-ME anywhere under .github fails only the strict lint", () => {
  const { dir } = mkRoot({}, { extra: { ".github/notes.md": "todo PIN-ME\n" } });
  assert.equal(run(dir).code, 0);
  const strict = run(dir, ["--strict"]);
  assert.equal(strict.code, 1);
  assert.ok(strict.findings.some((f) => f.file.endsWith("notes.md") && f.line === 1));
});

test("a scripts/ci script that downloads must mention sha256", () => {
  const bad = mkRoot({}, { extra: { "scripts/ci/detect-signing.sh": "curl -O https://x.example/t\n" } });
  const r = run(bad.dir);
  assert.equal(r.code, 1);
  assert.ok(r.findings.some((f) => f.rule === "5.2.7" && /detect-signing\.sh/.test(f.message)), r.out);
  const ok = mkRoot({}, { extra: { "scripts/ci/detect-signing.sh": "curl -O https://x.example/t\nsha256sum -c sums\n" } });
  assert.equal(run(ok.dir).code, 0);
});

test("a missing packageManager integrity suffix is a warning, not a failure", () => {
  const { dir } = mkRoot({}, { packageManager: "pnpm@11.5.3" });
  const r = run(dir, ["--strict"]);
  assert.equal(r.code, 0);
  assert.match(r.err, /warning 5\.2\.12/);
  const j = JSON.parse(run(dir, ["--json"]).out);
  assert.equal(j.warnings[0].rule, "5.2.12");
  assert.deepEqual(j.findings, []);
});

test("unsupported YAML exits 3 with file:line", () => {
  const cases = [
    ["multi-document", (t) => t + "---\nx: 1\n", /multi-document/],
    ["anchor", rep('RUST_VERSION: "1.96.0"', 'RUST_VERSION: &rv "1.96.0"'), /anchors/],
    ["alias", rep('RUST_VERSION: "1.96.0"', "RUST_VERSION: *rv"), /aliases/],
    ["tag", rep('RUST_VERSION: "1.96.0"', "RUST_VERSION: !!str 1.96.0"), /tags/],
    ["tab", rep("  CARGO_TERM_COLOR: never", "\tCARGO_TERM_COLOR: never"), /tabs/],
    ["merge key", rep("env:\n  RUST_VERSION", "env:\n  <<: {a: 1}\n  RUST_VERSION"), /merge/],
  ];
  for (const [title, mutate, re] of cases) {
    const { dir, texts } = mkRoot({ "ci.yml": mutate });
    const r = run(dir);
    assert.equal(r.code, 3, `${title}\n${r.out}${r.err}`);
    const m = /ci\.yml:(\d+) unreadable (.*)/.exec(r.err);
    assert.ok(m, `${title}: ${r.err}`);
    assert.match(m[2], re);
    assert.ok(Number(m[1]) >= 1 && Number(m[1]) <= texts["ci.yml"].split("\n").length, title);
  }
});

test("explicit file arguments are linted by their base name", () => {
  const { dir } = mkRoot();
  const r = run(dir, [join(dir, ".github/workflows/release.yml"), join(dir, ".github/workflows/ci.yml")]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /2 file\(s\)/);
});

test("usage errors exit 2", () => {
  const { dir } = mkRoot();
  assert.equal(run(dir, ["--bogus"]).code, 2);
  assert.equal(run(dir, ["--today", "tomorrow"]).code, 2);
});

test("the real tree is readable by the linter (never exit 2 or 3)", () => {
  const r = spawnSync(process.execPath, [CLI, "--today", TODAY], { encoding: "utf8", cwd: ROOT });
  assert.ok(r.status === 0 || r.status === 1, `${r.stdout}${r.stderr}`);
});

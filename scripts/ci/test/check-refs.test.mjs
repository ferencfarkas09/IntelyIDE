import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { X1_PATTERNS, commandsOf, safe } from "./../check-refs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const CLI = join(ROOT, "scripts/ci/check-refs.mjs");
const OK = join(HERE, "fixtures/refs/ok");
const tmps = [];
after(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

// A throwaway copy of the clean fixture tree; `edit(dir, rd, wr)` mutates it.
function mkRoot(edit) {
  const dir = mkdtempSync(join(tmpdir(), "cr-"));
  tmps.push(dir);
  cpSync(OK, dir, { recursive: true });
  for (const f of ["scripts/a.sh", "scripts/ci/run-sign.sh", "scripts/release-mac.sh"]) chmodSync(join(dir, f), 0o755);
  if (edit) edit(dir, (p) => readFileSync(join(dir, p), "utf8"), (p, t) => writeFileSync(join(dir, p), t));
  return dir;
}

function run(dir, args = []) {
  const r = spawnSync(process.execPath, [CLI, "--root", dir, ...args], { encoding: "utf8", cwd: dir });
  const findings = r.stdout
    .split("\n")
    .map((l) => /^(\S+?):(\d+) (\S+) (.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ file: m[1], line: Number(m[2]), rule: m[3], message: m[4] }));
  return { code: r.status, findings, stdout: r.stdout, stderr: r.stderr };
}

const rules = (r) => r.findings.map((f) => f.rule);

test("the clean fixture tree passes", () => {
  const r = run(mkRoot(), ["--strict"]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(r.findings, []);
});

test("a script that does not exist is flagged with its line", () => {
  const dir = mkRoot((d, rd, wr) => wr(".github/workflows/ci.yml", rd(".github/workflows/ci.yml").replace("node scripts/b.mjs", "node scripts/nope.mjs")));
  const r = run(dir);
  assert.equal(r.code, 1);
  assert.deepEqual(rules(r), ["script-missing"]);
  assert.match(r.findings[0].message, /nope\.mjs/);
  assert.equal(r.findings[0].file, ".github/workflows/ci.yml");
  assert.equal(r.findings[0].line, 12);
});

test("bash and ./ scripts: missing file and missing executable bit", () => {
  const miss = run(mkRoot((d, rd, wr) => wr(".github/workflows/ci.yml", rd(".github/workflows/ci.yml").replace("bash scripts/a.sh\n", "bash scripts/gone.sh\n"))));
  assert.deepEqual(rules(miss), ["script-missing"]);
  const noexec = run(mkRoot((d) => chmodSync(join(d, "scripts/a.sh"), 0o644)));
  assert.deepEqual(rules(noexec), ["script-exec"]);
  const absent = run(mkRoot((d, rd, wr) => wr(".github/workflows/ci.yml", rd(".github/workflows/ci.yml").replace("./scripts/a.sh", "./scripts/zz.sh"))));
  assert.deepEqual(rules(absent), ["script-missing"]);
});

test("variables, globs and node --test arguments are not resolved", () => {
  const dir = mkRoot((d, rd, wr) =>
    wr(".github/workflows/ci.yml", rd(".github/workflows/ci.yml").replace("node --test \"scripts/**/*.test.mjs\"", "node --test \"nothing/**/*.test.mjs\"\n          bash \"$HOME/x.sh\"\n          node -e 'process.exit(0)'")),
  );
  assert.deepEqual(run(dir).findings, []);
});

test("a package script that does not exist is flagged (root, run, and --filter)", () => {
  const edit = (from, to) => (d, rd, wr) => wr(".github/workflows/ci.yml", rd(".github/workflows/ci.yml").replace(from, to));
  const root = run(mkRoot(edit("pnpm ci:lint", "pnpm ci:missing")));
  assert.deepEqual(rules(root), ["pnpm-script"]);
  assert.match(root.findings[0].message, /ci:missing/);
  const viaRun = run(mkRoot(edit("pnpm ci:lint", "pnpm run ci:missing")));
  assert.deepEqual(rules(viaRun), ["pnpm-script"]);
  const filt = run(mkRoot(edit("pnpm --filter @fx/ui test", "pnpm --filter @fx/ui nosuch")));
  assert.deepEqual(rules(filt), ["pnpm-script"]);
  assert.match(filt.findings[0].message, /@fx\/ui/);
  const pkg = run(mkRoot(edit("pnpm --filter @fx/ui test", "pnpm --filter @fx/nobody test")));
  assert.deepEqual(rules(pkg), ["pnpm-script"]);
  assert.match(pkg.findings[0].message, /no package/);
});

test("built-in pnpm commands are not looked up as scripts", () => {
  const dir = mkRoot((d, rd, wr) => wr(".github/workflows/ci.yml", rd(".github/workflows/ci.yml").replace("pnpm install --frozen-lockfile", "pnpm install --frozen-lockfile && pnpm dlx something && pnpm audit")));
  assert.deepEqual(run(dir).findings, []);
});

test("a run block that does not parse with bash -n is flagged at its line", () => {
  const dir = mkRoot((d, rd, wr) => wr(".github/workflows/ci.yml", rd(".github/workflows/ci.yml").replace("bash scripts/a.sh\n", "bash scripts/a.sh\n          if true; then\n")));
  const r = run(dir);
  assert.deepEqual(rules(r), ["bash-n"]);
});

test("${{ }} expressions inside a block do not break bash -n", () => {
  const dir = mkRoot((d, rd, wr) => wr(".github/workflows/ci.yml", rd(".github/workflows/ci.yml").replace("pnpm exec tsc --noEmit", 'echo "${{ matrix.arch }} ${{ github.sha }}"')));
  assert.deepEqual(run(dir).findings, []);
});

test("uses: ./local must exist", () => {
  const dir = mkRoot((d, rd, wr) => wr(".github/workflows/ci.yml", rd(".github/workflows/ci.yml").replace("      - run: pnpm install", "      - uses: ./.github/actions/nope\n      - run: pnpm install")));
  const r = run(dir);
  assert.deepEqual(rules(r), ["uses-local"]);
  const ok = mkRoot((d, rd, wr) => {
    mkdirSync(join(d, ".github/actions/mine"), { recursive: true });
    writeFileSync(join(d, ".github/actions/mine/action.yml"), "name: mine\nruns: { using: composite, steps: [] }\n");
    wr(".github/workflows/ci.yml", rd(".github/workflows/ci.yml").replace("      - run: pnpm install", "      - uses: ./.github/actions/mine\n      - run: pnpm install"));
  });
  assert.deepEqual(run(ok).findings, []);
});

test("release-mac.sh must know every flag and stage that release.yml and run-sign.sh pass", () => {
  const noStage = run(mkRoot((d, rd, wr) => wr("scripts/release-mac.sh", rd("scripts/release-mac.sh").replaceAll("--stage", "--phase"))));
  assert.ok(rules(noStage).every((x) => x === "stage-flag") && noStage.findings.length >= 1);
  assert.match(noStage.stdout, /--stage/);
  const noVerify = run(mkRoot((d, rd, wr) => wr("scripts/release-mac.sh", rd("scripts/release-mac.sh").replace("build | sign | verify", "build | sign"))));
  assert.deepEqual(rules(noVerify), ["stage-flag"]);
  assert.match(noVerify.findings[0].message, /verify/);
  const noStyle = run(mkRoot((d, rd, wr) => wr("scripts/release-mac.sh", rd("scripts/release-mac.sh").replace("--require-style", "--style"))));
  assert.deepEqual(rules(noStyle), ["stage-flag"]);
  assert.match(noStyle.findings[0].file, /run-sign\.sh$/);
});

test("secrets table: a secret missing from the table, and the reverse", () => {
  const missing = run(mkRoot((d, rd, wr) => wr("docs/release-ci-checklist.md", rd("docs/release-ci-checklist.md").replace("| `APPLE_API_KEY` | secret | notarization |\n", ""))));
  assert.deepEqual(rules(missing), ["secrets-table"]);
  assert.match(missing.findings[0].message, /APPLE_API_KEY/);
  const extra = run(mkRoot((d, rd, wr) => wr("docs/release-ci-checklist.md", rd("docs/release-ci-checklist.md").replace("## Other", "| `APPLE_EXTRA` | secret | unused |\n\n## Other"))));
  assert.deepEqual(rules(extra), ["secrets-table"]);
  assert.match(extra.findings[0].message, /APPLE_EXTRA/);
  assert.match(extra.findings[0].file, /release-ci-checklist\.md$/);
  const variable = run(mkRoot((d, rd, wr) => wr("docs/release-ci-checklist.md", rd("docs/release-ci-checklist.md").replace("| `APPLE_SIGNING_IDENTITY` | variable | identity |\n", ""))));
  assert.deepEqual(rules(variable), ["secrets-table"]);
});

test("secrets table: a missing checklist is a finding only when release.yml uses secrets", () => {
  const gone = run(mkRoot((d) => rmSync(join(d, "docs/release-ci-checklist.md"))));
  assert.deepEqual(rules(gone), ["secrets-table"]);
  const noRelease = run(mkRoot((d) => {
    rmSync(join(d, "docs/release-ci-checklist.md"));
    rmSync(join(d, ".github/workflows/release.yml"));
  }));
  assert.deepEqual(noRelease.findings, []);
});

test("CODEOWNERS: each X1 pattern is required", () => {
  for (const pat of X1_PATTERNS) {
    const dir = mkRoot((d, rd, wr) => wr(".github/CODEOWNERS", rd(".github/CODEOWNERS").split("\n").filter((l) => l.split(/\s+/)[0] !== pat).join("\n")));
    const r = run(dir);
    assert.deepEqual(rules(r), ["codeowners"], pat);
    assert.ok(r.findings[0].message.includes(pat), pat);
  }
});

test("CODEOWNERS: a parent directory pattern covers a control path; a missing file is not checked", () => {
  const dir = mkRoot((d, rd, wr) => wr(".github/CODEOWNERS", rd(".github/CODEOWNERS").replace("/scripts/ci/ ", "/scripts/ ")));
  assert.deepEqual(run(dir).findings, []);
  assert.deepEqual(run(mkRoot((d) => rmSync(join(d, ".github/CODEOWNERS")))).findings, []);
});

test("PIN-ME in a .pin file: a finding with --strict, a warning without", () => {
  const edit = (d, rd, wr) => wr("scripts/ci/x.pin", rd("scripts/ci/x.pin").replace(/sha256=.*/, "sha256=PIN-ME"));
  const strict = run(mkRoot(edit), ["--strict"]);
  assert.equal(strict.code, 1);
  assert.deepEqual(rules(strict), ["pin-me"]);
  assert.equal(strict.findings[0].line, 2);
  const loose = run(mkRoot(edit));
  assert.equal(loose.code, 0);
  assert.match(loose.stderr, /pin-me/);
});

test("unsupported YAML exits 3 with a line number; usage errors exit 2", () => {
  const bad = run(mkRoot((d, rd, wr) => wr(".github/workflows/ci.yml", "a: &x 1\n")));
  assert.equal(bad.code, 3);
  assert.match(bad.stdout, /ci\.yml:1 unreadable/);
  assert.equal(spawnSync(process.execPath, [CLI, "--nope"], { encoding: "utf8" }).status, 2);
});

test("escaping: control characters and a leading :: are neutralised", () => {
  assert.equal(safe("a\nb"), "a\\nb");
  assert.ok(!safe("::error::x").startsWith("::"));
  assert.ok(!safe("x\r\n::set-output").includes("\n"));
  const dir = mkRoot((d, rd, wr) => wr(".github/workflows/ci.yml", rd(".github/workflows/ci.yml").replace("node scripts/b.mjs", "node scripts/x\\ ::y.mjs")));
  const r = run(dir);
  assert.equal(r.code, 1);
  for (const l of r.stdout.split("\n").filter(Boolean)) assert.ok(!l.startsWith("::"), l);
});

test("commandsOf splits operators, strips quotes and comments", () => {
  assert.deepEqual(commandsOf('a "b c" && d; e | f # g'), [["a", "b c"], ["d"], ["e"], ["f"]]);
  assert.deepEqual(commandsOf("x=$(node s.mjs)"), [["x=$"], ["node", "s.mjs"]]);
});

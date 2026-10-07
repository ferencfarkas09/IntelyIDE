import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv, inlineInfo, runChecks } from "./check.mjs";

const REAL = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CHECK = join(REAL, "scripts/licenses/check.mjs");
const HOLDER = JSON.parse(readFileSync(join(REAL, "scripts/licenses/policy.json"), "utf8")).copyrightHolder;
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const GENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const REUSE_OK = `version = 1\n[[annotations]]\npath = "**"\nprecedence = "aggregate"\nSPDX-FileCopyrightText = "2026 ${HOLDER}"\nSPDX-License-Identifier = "GPL-3.0-or-later"\n`;

/** Throwaway repo under mktemp: git init happens inside the temp dir only. */
function fixture(extra = {}, { cargo = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "licenses-check-"));
  dirs.push(root);
  const files = {
    "package.json": JSON.stringify({ name: "x", license: "GPL-3.0-or-later" }),
    "src/a.ts": "export const a = 1;\n",
    "REUSE.toml": REUSE_OK,
    ...extra,
  };
  if (cargo) {
    files["Cargo.toml"] ??= '[workspace]\nmembers = ["crates/a"]\nresolver = "2"\n\n[workspace.package]\nlicense = "GPL-3.0-or-later"\n';
    files["crates/a/Cargo.toml"] ??= '[package]\nname = "a"\nversion = "0.0.0"\nedition = "2021"\nlicense.workspace = true\n';
    files["crates/a/src/lib.rs"] = "pub fn a() {}\n";
  }
  mkdirSync(join(root, "LICENSES"), { recursive: true });
  copyFileSync(join(REAL, "LICENSE"), join(root, "LICENSE"));
  copyFileSync(join(REAL, "LICENSE"), join(root, "LICENSES/GPL-3.0-or-later.txt"));
  mkdirSync(join(root, "scripts/licenses"), { recursive: true });
  copyFileSync(join(REAL, "scripts/licenses/policy.json"), join(root, "scripts/licenses/policy.json"));
  for (const [rel, body] of Object.entries(files)) {
    if (body === null) continue;
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  execFileSync("git", ["init", "-q"], { cwd: root, env: GENV });
  execFileSync("git", ["add", "-A"], { cwd: root, env: GENV });
  return root;
}

const cli = (root, ...args) => {
  const r = spawnSync(process.execPath, [CHECK, "--root", root, ...args], { encoding: "utf8", env: GENV });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

test("a clean fixture passes (exit 0) and prints a one-line summary", () => {
  const r = cli(fixture());
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /licenses:check \(fast\) - \d+ tracked files/);
  assert.match(r.out, /^ok: 0 finding/m);
});

test("foreign SPDX id in a source file exits 1 and names the file", () => {
  const root = fixture({ "src/b.ts": "// SPDX-License-Identifier: AGPL-3.0-only\nexport {};\n" });
  const r = cli(root);
  assert.equal(r.code, 1);
  assert.match(r.out, /\[inline-spdx\] src\/b\.ts/);
});

test("allowlisted foreign id needs an override block and LICENSES/<id>.txt", () => {
  const vendored = { "vendor/v.js": "// SPDX-License-Identifier: MIT\n// SPDX-FileCopyrightText: 2020 Someone\nexport {};\n" };
  assert.equal(cli(fixture(vendored)).code, 1);
  const override = `${REUSE_OK}\n[[annotations]]\npath = "vendor/**"\nprecedence = "override"\nSPDX-FileCopyrightText = "2020 Someone"\nSPDX-License-Identifier = "MIT"\n`;
  const noText = cli(fixture({ ...vendored, "REUSE.toml": override }));
  assert.equal(noText.code, 1);
  assert.match(noText.out, /LICENSES\/MIT\.txt missing/);
  const ok = cli(fixture({ ...vendored, "REUSE.toml": override, "LICENSES/MIT.txt": "MIT License\n" }));
  assert.equal(ok.code, 0, ok.out);
});

test("comments that merely mention the tag, and .env files, are ignored", () => {
  const root = fixture({
    "docs/n.md": "- SPDX-License-Identifier: GPL-2.0-only is rejected by policy\n",
    "src/t.ts": 'const s = "// SPDX-License-Identifier: AGPL-3.0-only";\n',
    ".env.local": "# SPDX-License-Identifier: AGPL-3.0-only\n",
  });
  const r = cli(root);
  assert.equal(r.code, 0, r.out);
});

test("package.json with a wrong or missing license exits 1", () => {
  const r = cli(fixture({ "ui/package.json": JSON.stringify({ name: "ui", license: "MIT" }), "sidecar/package.json": JSON.stringify({ name: "s" }) }));
  assert.equal(r.code, 1);
  assert.match(r.out, /\[package-json\] ui\/package\.json/);
  assert.match(r.out, /\[package-json\] sidecar\/package\.json/);
});

test("file not covered by REUSE.toml exits 1 naming the file", () => {
  const partial = REUSE_OK.replace('path = "**"', 'path = "src/**"');
  const r = cli(fixture({ "REUSE.toml": partial, "top.txt": "x\n" }));
  assert.equal(r.code, 1);
  assert.match(r.out, /\[reuse-coverage\] top\.txt/);
});

test("broken REUSE.toml (package-level key) exits 1", () => {
  const r = cli(fixture({ "REUSE.toml": `version = 1\nSPDX-PackageName = "x"\n` }));
  assert.equal(r.code, 1);
  assert.match(r.out, /\[reuse\] REUSE\.toml/);
});

test("LICENSES text differing from LICENSE exits 1", () => {
  const r = cli(fixture({ "LICENSES/GPL-3.0-or-later.txt": "tampered\n" }));
  assert.equal(r.code, 1);
  assert.match(r.out, /\[licenses-text\] LICENSES\/GPL-3\.0-or-later\.txt/);
});

test("holder mismatch between REUSE.toml and policy.json exits 1", () => {
  const r = cli(fixture({ "REUSE.toml": REUSE_OK.replace(HOLDER, "Someone Else") }));
  assert.equal(r.code, 1);
  assert.match(r.out, /\[holder\] REUSE\.toml/);
  const tp = cli(fixture({ "THIRD_PARTY_LICENSES.md": "# Third party\nCopyright: Someone Else\n" }));
  assert.equal(tp.code, 1);
  assert.match(tp.out, /\[holder\] THIRD_PARTY_LICENSES\.md/);
  assert.equal(cli(fixture({ "THIRD_PARTY_LICENSES.md": `# Third party\nCopyright: ${HOLDER}\n` })).code, 0);
});

test("--release fails on unresolved placeholders, fast mode does not", () => {
  const root = fixture({ "README.md": "License <repo URL, D7>\n" });
  assert.notEqual(cli(root, "--release").code, 0);
  assert.match(cli(root, "--release").out, /\[placeholder\] README\.md/);
  assert.equal(cli(root).code, 0);
  const holderPh = fixture({ "REUSE.toml": REUSE_OK.replace(HOLDER, "<copyright holder, D1>") });
  assert.match(cli(holderPh, "--release").out, /placeholder/);
});

test("wording parity: pending in fast mode, an error with --release", () => {
  const files = {
    "README.md": "GPL-3.0-or-later, any later version\n",
    "ui/src/shell/aboutText.ts": "// GPL-3.0-or-later, any later version\n",
    "ui/src/i18n/locales/en/about.json": '{"a":"GPL-3.0-or-later or any later version"}\n',
  };
  const ok = fixture(files);
  assert.equal(cli(ok, "--release").code, 0, cli(ok, "--release").out);
  const bad = fixture({ ...files, "README.md": "nothing\n" });
  assert.equal(cli(bad).code, 0);
  assert.match(cli(bad).out, /pending L4\/L5/);
  const rel = cli(bad, "--release");
  assert.equal(rel.code, 1);
  assert.match(rel.out, /\[wording\] README\.md/);
  assert.doesNotMatch(rel.out, /aboutText/);
});

test("bundle guards: SDK in meta.json, externalBin/resources, size cap", () => {
  const meta = fixture({ "x.txt": "x\n" });
  mkdirSync(join(meta, "sidecar/dist"), { recursive: true });
  writeFileSync(join(meta, "sidecar/dist/meta.json"), JSON.stringify({ inputs: { "node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@1/node_modules/@anthropic-ai/claude-agent-sdk/x.js": {} } }));
  const r = cli(meta);
  assert.equal(r.code, 1);
  assert.match(r.out, /\[sdk-bundle\] sidecar\/dist\/meta\.json/);
  writeFileSync(join(meta, "sidecar/dist/meta.json"), JSON.stringify({ inputs: { "sidecar/src/index.ts": {} } }));
  assert.equal(cli(meta).code, 0);

  const tauri = fixture({ "src-tauri/tauri.conf.json": JSON.stringify({ bundle: { resources: { "../node_modules/@anthropic-ai/claude-agent-sdk": "sdk" } } }) });
  assert.match(cli(tauri).out, /\[sdk-bundle\] src-tauri\/tauri\.conf\.json/);

  for (const bin of ["binaries/claude", "binaries/claude-aarch64-apple-darwin"]) {
    const cli_ = fixture({ "src-tauri/tauri.conf.json": JSON.stringify({ bundle: { externalBin: [bin] } }) });
    assert.match(cli(cli_).out, /\[sdk-bundle\] src-tauri\/tauri\.conf\.json/, bin);
  }
  const ok = fixture({ "src-tauri/tauri.conf.json": JSON.stringify({ bundle: { externalBin: ["binaries/claudette-helper"], resources: ["LICENSE"] } }) });
  assert.equal(cli(ok).code, 0);

  const big = fixture();
  mkdirSync(join(big, "ui/src/shell/licenses/data"), { recursive: true });
  writeFileSync(join(big, "ui/src/shell/licenses/data/index.json"), "x".repeat(1_600_000));
  assert.match(cli(big).out, /\[size-cap\]/);
});

test("cargo: missing license is pending with --allow-pending-cargo, an error without", () => {
  const files = { "crates/a/Cargo.toml": '[package]\nname = "a"\nversion = "0.0.0"\nedition = "2021"\n' };
  const root = fixture(files, { cargo: true });
  const strict = cli(root);
  assert.equal(strict.code, 1, strict.out);
  assert.match(strict.out, /\[cargo-license\] crates\/a\/Cargo\.toml/);
  const lax = cli(root, "--allow-pending-cargo");
  assert.equal(lax.code, 0, lax.out);
  assert.match(lax.out, /pending L8/);
});

test("cargo: a wrong license is an error even with --allow-pending-cargo; a correct workspace passes", () => {
  const bad = fixture({ "crates/a/Cargo.toml": '[package]\nname = "a"\nversion = "0.0.0"\nedition = "2021"\nlicense = "MIT"\n' }, { cargo: true });
  const r = cli(bad, "--allow-pending-cargo");
  assert.equal(r.code, 1);
  assert.match(r.out, /expected "GPL-3\.0-or-later"/);
  const good = cli(fixture({}, { cargo: true }));
  assert.equal(good.code, 0, good.out);
  assert.match(good.out, /1 cargo members \(1 inherit license\)/);
  const noWs = fixture({ "Cargo.toml": '[workspace]\nmembers = ["crates/a"]\nresolver = "2"\n' }, { cargo: true });
  assert.match(cli(noWs).out, /workspace\.package/);
});

test("--third-party: missing gen.mjs is an environment problem (3); a failing gen exit code is surfaced", () => {
  const root = fixture();
  assert.equal(cli(root, "--third-party").code, 3);
  const drift = fixture({ "scripts/licenses/gen.mjs": "console.error('drift in cargo:x@1'); process.exit(1);\n" });
  const r = cli(drift, "--third-party");
  assert.equal(r.code, 1);
  assert.match(r.out, /\[third-party\]/);
  assert.match(r.out, /drift in cargo:x@1/);
  const ok = fixture({ "scripts/licenses/gen.mjs": "process.exit(process.argv.includes('--check') ? 0 : 9);\n" });
  assert.equal(cli(ok, "--third-party").code, 0);
});

test("outside a git repository is an environment problem (3)", () => {
  const root = mkdtempSync(join(tmpdir(), "licenses-nogit-"));
  dirs.push(root);
  mkdirSync(join(root, "scripts/licenses"), { recursive: true });
  copyFileSync(join(REAL, "scripts/licenses/policy.json"), join(root, "scripts/licenses/policy.json"));
  const r = spawnSync(process.execPath, [CHECK, "--root", root], { encoding: "utf8", env: { ...GENV, GIT_CEILING_DIRECTORIES: tmpdir() } });
  assert.equal(r.status, 3, r.stdout + r.stderr);
});

test("child environment carries no credentials and isolates git/npm/cargo config", () => {
  const env = childEnv.call(null);
  const saved = { ...process.env };
  process.env.NPM_TOKEN = "t";
  process.env.GITHUB_TOKEN = "t";
  process.env.ANTHROPIC_API_KEY = "k";
  process.env.CARGO_REGISTRIES_X_TOKEN = "t";
  try {
    const e = childEnv();
    for (const k of Object.keys(e)) assert.ok(!/TOKEN|KEY|SECRET|^NPM_|CARGO_REGISTRIES/.test(k) || k === "NPM_CONFIG_GLOBALCONFIG", k);
    assert.equal(e.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(e.GIT_CONFIG_SYSTEM, "/dev/null");
    assert.equal(e.npm_config_userconfig, "/dev/null");
    assert.equal(e.CARGO_NET_OFFLINE, "true");
  } finally {
    for (const k of ["NPM_TOKEN", "GITHUB_TOKEN", "ANTHROPIC_API_KEY", "CARGO_REGISTRIES_X_TOKEN"]) delete process.env[k];
    Object.assign(process.env, saved);
  }
  assert.ok(env);
});

test("inlineInfo only reads tags in comment lines", () => {
  assert.deepEqual(inlineInfo("// SPDX-License-Identifier: MIT\n# SPDX-FileCopyrightText: 2020 A\n").licenses, ["MIT"]);
  assert.deepEqual(inlineInfo("/* SPDX-License-Identifier: Apache-2.0 */").licenses, ["Apache-2.0"]);
  assert.deepEqual(inlineInfo("<!-- SPDX-License-Identifier: MIT -->").licenses, ["MIT"]);
  assert.deepEqual(inlineInfo('x = "SPDX-License-Identifier: MIT"').licenses, []);
  assert.deepEqual(inlineInfo("- SPDX-License-Identifier: MIT").licenses, []);
});

test("the real tree passes in fast mode (cargo pending allowed)", () => {
  const r = runChecks({ root: REAL, allowPendingCargo: true });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.env, []);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GIT_PREFIX, LicenseToolError, assertSafeOutput, firstLine, gitEnv, maskHome, protectedDirs, runTool, scrubbedEnv } from "./lib/env.mjs";

const dirty = {
  PATH: process.env.PATH,
  HOME: "/home/someone",
  LANG: "en_US.UTF-8",
  LC_ALL: "C",
  TMPDIR: "/tmp",
  GITHUB_TOKEN: "ghp_x",
  NPM_TOKEN: "npm_x",
  NODE_AUTH_TOKEN: "x",
  npm_config__authToken: "x",
  NPM_CONFIG_REGISTRY: "https://evil.example",
  CARGO_REGISTRIES_FOO_TOKEN: "x",
  CARGO_REGISTRY_TOKEN: "x",
  ANTHROPIC_API_KEY: "sk-ant-x",
  AWS_SECRET_ACCESS_KEY: "x",
  SSH_AUTH_SOCK: "/x",
};

test("child env has no credentials; only the allow-list plus the neutralising variables", () => {
  const env = scrubbedEnv({ base: dirty });
  for (const k of Object.keys(env)) {
    assert.ok(!/TOKEN|KEY|SECRET|CARGO_REGISTRIES/i.test(k), k);
    if (/^npm_/i.test(k)) assert.ok(["npm_config_userconfig", "NPM_CONFIG_GLOBALCONFIG", "npm_config_offline"].includes(k), k);
  }
  assert.equal(env.npm_config_userconfig, "/dev/null");
  assert.equal(env.NPM_CONFIG_GLOBALCONFIG, "/dev/null");
  assert.equal(env.CARGO_NET_OFFLINE, "true");
  assert.equal(env.CARGO_HOME, "/home/someone/.cargo");
  assert.equal(env.LC_ALL, "C");
  assert.equal(env.NPM_CONFIG_REGISTRY, undefined);
  assert.equal(scrubbedEnv({ base: dirty, cargoHome: "/c" }).CARGO_HOME, "/c");
});

test("the pnpm store location passes through (without it `pnpm licenses list` cannot find what `pnpm install` stored), nothing else of pnpm does", () => {
  const base = { ...dirty, PNPM_HOME: "/home/runner/setup-pnpm/node_modules/.bin", XDG_DATA_HOME: "/home/runner/.local/share", PNPM_AUTH_TOKEN: "x", pnpm_config_registry: "https://evil.example" };
  const env = scrubbedEnv({ base });
  assert.equal(env.PNPM_HOME, "/home/runner/setup-pnpm/node_modules/.bin");
  assert.equal(env.XDG_DATA_HOME, "/home/runner/.local/share");
  assert.equal(env.PNPM_AUTH_TOKEN, undefined);
  assert.equal(env.pnpm_config_registry, undefined);
});

test("git is hardened: isolated config, no hooks, no fsmonitor", () => {
  const env = gitEnv(dirty);
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(env.GIT_CONFIG_SYSTEM, "/dev/null");
  assert.ok(GIT_PREFIX.includes("core.hooksPath=/dev/null") && GIT_PREFIX.includes("core.fsmonitor=false") && GIT_PREFIX.includes("--no-optional-locks"));
});

/** A fake tool on disk that records its argv and the names+values of its environment. */
function fakeTool(dir, name, exit = 0) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n{ echo "ARGV:$*"; env; } > "${dir}/${name}.rec"\necho '{"ok":true}'\nexit ${exit}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

test("fake cargo and npm record argv and a credential-free env through runTool", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lic-env-"));
  fakeTool(dir, "cargo");
  fakeTool(dir, "npm");
  const env = scrubbedEnv({ base: { ...dirty, PATH: `${dir}:/usr/bin:/bin`, HOME: dir } });
  for (const tool of ["cargo", "npm"]) {
    const r = runTool(tool, ["metadata", "--offline"], { env, cwd: dir });
    assert.equal(r.status, 0);
    const rec = fs.readFileSync(path.join(dir, `${tool}.rec`), "utf8");
    assert.match(rec, /ARGV:metadata --offline/);
    assert.ok(!/GITHUB_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN|CARGO_REGISTR|ANTHROPIC|AWS_|SSH_AUTH/.test(rec));
    assert.match(rec, /npm_config_userconfig=\/dev\/null/);
    assert.match(rec, /NPM_CONFIG_GLOBALCONFIG=\/dev\/null/);
  }
});

test("a missing tool is an environment error (exit 3) naming the tool", () => {
  assert.throws(
    () => runTool("definitely-not-a-tool-xyz", [], { env: { PATH: "/usr/bin" } }),
    (e) => e instanceof LicenseToolError && e.exitCode === 3 && /definitely-not-a-tool-xyz/.test(e.message),
  );
});

test("home is masked in messages", () => {
  assert.equal(maskHome(`${os.homedir()}/x/y`), "~/x/y");
  assert.equal(firstLine(`boom ${os.homedir()}/z\nsecond`), "boom ~/z");
});

test("output directories: project and temp are fine, real repos and elsewhere exit 3", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "lic-proj-"));
  assert.doesNotThrow(() => assertSafeOutput(path.join(project, "out", "new"), project));
  assert.doesNotThrow(() => assertSafeOutput(path.join(os.tmpdir(), "somewhere"), project));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "lic-realrepo-"));
  assert.throws(() => assertSafeOutput(path.join(repo, "x"), project, [repo]), (e) => e.exitCode === 3 && e.code === "unsafe_output");
  assert.throws(() => assertSafeOutput("/Users/example/Projects/shop-backend/out", project, ["/Users/example/Projects/shop-backend"]), (e) => e.exitCode === 3);
  assert.throws(() => assertSafeOutput(path.join(os.homedir(), "Desktop", "x"), project), (e) => e.exitCode === 3);
});

test("protectedDirs reads the colon-separated INTELY_PROTECTED_DIRS and defaults to none", () => {
  assert.deepEqual(protectedDirs({}), []);
  assert.deepEqual(protectedDirs({ INTELY_PROTECTED_DIRS: "/a/b: /c :" }), ["/a/b", "/c"]);
});

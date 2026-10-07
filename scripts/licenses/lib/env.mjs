// Child-process environment and runner for the licence tooling (offline, no credentials).
// The promise "never reads tokens or config" is enforced here: cargo, pnpm and git read their own config files, so the
// environment handed to them is an allow-list plus variables that neutralise those config files.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Typed failure; `exitCode` follows gen.mjs: 2 policy/content failure, 3 environment problem. */
export class LicenseToolError extends Error {
  /** @param {string} message @param {string} code @param {2 | 3} exitCode */
  constructor(message, code, exitCode = 2) {
    super(message);
    this.name = "LicenseToolError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

// PNPM_HOME and XDG_DATA_HOME decide where pnpm looks for its content store; without them `pnpm licenses list` cannot find the
// index files of what `pnpm install` stored (CI: ERR_PNPM_MISSING_PACKAGE_INDEX_FILE). Both are plain paths, never credentials.
const ALLOWED = new Set(["PATH", "HOME", "TMPDIR", "LANG", "PNPM_HOME", "XDG_DATA_HOME"]);
const allowed = (k) => ALLOWED.has(k) || k.startsWith("LC_");

/** Replaces the home directory with ~ so messages and logs carry no machine paths. */
export function maskHome(text, home = os.homedir()) {
  return home && home.length > 1 ? String(text).split(home).join("~") : String(text);
}

/**
 * Allow-listed environment for cargo / pnpm / npm children.
 * @param {{ base?: Record<string, string | undefined>, cargoHome?: string, extra?: Record<string, string> }} [opts]
 */
export function scrubbedEnv({ base = process.env, cargoHome, extra = {} } = {}) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && allowed(k)) env[k] = v;
  const home = env.HOME ?? os.homedir();
  env.HOME = home;
  env.CARGO_HOME = cargoHome ?? path.join(home, ".cargo");
  env.CARGO_NET_OFFLINE = "true";
  env.npm_config_offline = "true";
  env.npm_config_userconfig = "/dev/null";
  env.NPM_CONFIG_GLOBALCONFIG = "/dev/null";
  env.CI = "true"; // pnpm: never prompt
  return { ...env, ...extra };
}

/** Git is hardened: no fsmonitor, no hooks, no user/system config, no optional locks. */
export const GIT_PREFIX = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];

export function gitEnv(base = process.env) {
  const env = scrubbedEnv({ base });
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  return env;
}

/**
 * Runs a tool without a shell. A missing tool is an environment problem (exit 3).
 * @param {string} cmd @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string, string>, timeoutMs?: number, maxBuffer?: number }} [opts]
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
export function runTool(cmd, args, { cwd, env = scrubbedEnv(), timeoutMs = 120_000, maxBuffer = 256 * 1024 * 1024 } = {}) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", shell: false, timeout: timeoutMs, maxBuffer });
  if (r.error) {
    if (r.error.code === "ENOENT") throw new LicenseToolError(`required tool not found: ${cmd}`, "tool_missing", 3);
    throw new LicenseToolError(`${cmd} failed to run: ${r.error.code ?? r.error.message}`, "tool_failed", 3);
  }
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** First line of a tool's stderr, home-masked and capped: enough to explain, never a dump. */
export function firstLine(text) {
  return maskHome(String(text).trim().split("\n")[0] ?? "").slice(0, 200);
}

/** Directories that must never receive tool output: the colon-separated INTELY_PROTECTED_DIRS (empty by default). */
export function protectedDirs(env = process.env) {
  return String(env.INTELY_PROTECTED_DIRS ?? "").split(":").map((d) => d.trim()).filter(Boolean);
}

/**
 * Output directories must be inside the project or a temp dir and never inside a protected directory (INTELY_PROTECTED_DIRS) (exit 3).
 * @param {string} target @param {string} projectRoot @param {string[]} [realRepos]
 */
export function assertSafeOutput(target, projectRoot, realRepos = protectedDirs()) {
  const real = (p) => {
    let cur = path.resolve(p);
    const tail = [];
    while (!fs.existsSync(cur) && path.dirname(cur) !== cur) {
      tail.unshift(path.basename(cur));
      cur = path.dirname(cur);
    }
    return path.join(fs.realpathSync(cur), ...tail);
  };
  const t = real(target);
  const within = (p, root) => p === root || p.startsWith(root + path.sep);
  if (realRepos.some((r) => within(t, real(r)))) throw new LicenseToolError("output path is inside a real repository", "unsafe_output", 3);
  const ok = [real(projectRoot), real(os.tmpdir()), "/private/tmp", "/tmp", "/private/var/folders"].some((r) => within(t, r));
  if (!ok) throw new LicenseToolError("output path is outside the project and the temp directories", "unsafe_output", 3);
  return t;
}

// Deterministic git runner ((design notes: release-ci-spec) 6.2 "Determinism rules"). The child environment is built from
// scratch, never inherited: no INTELY_*, APPLE_*, GH_TOKEN, GIT_DIR, GIT_AUTHOR_* ... can leak in.
import { execFileSync } from "node:child_process";
import { DemoError } from "./errors.mjs";

const SAFE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin";

/** The only variables a demo git process sees. */
export function gitEnv(extra = {}) {
  return {
    PATH: process.env.PATH || SAFE_PATH,
    TZ: "UTC",
    LC_ALL: "C",
    LANG: "C",
    HOME: "/nonexistent",
    XDG_CONFIG_HOME: "/nonexistent",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_ASKPASS: "/usr/bin/false",
    GIT_EDITOR: "/usr/bin/true",
    GIT_MERGE_AUTOEDIT: "no",
    // Every ref update (reflogs!) carries this fixed identity unless a step overrides it, so repository files are reproducible.
    GIT_COMMITTER_NAME: "release-bot",
    GIT_COMMITTER_EMAIL: "release-bot@fernbank.example",
    GIT_COMMITTER_DATE: "1790611200 +0000",
    GIT_PAGER: "cat",
    ...extra,
  };
}

/** Variables that pin author and committer to one step. `at` is an ISO instant in UTC. */
export function identityEnv(author, at) {
  const epoch = Math.floor(Date.parse(at) / 1000);
  const date = `${epoch} +0000`;
  return {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
    GIT_COMMITTER_DATE: date,
  };
}

// Per-command configuration: nothing here is written to the repository unless stated in build.mjs.
const BASE_ARGS = ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.autocrlf=false", "-c", "core.fsmonitor=false", "-c", "protocol.file.allow=always"];

/** Runs git in `cwd` and returns stdout (utf8). Throws DemoError(1) with git's stderr on failure. */
export function git(cwd, args, { input, env, raw = false } = {}) {
  try {
    const out = execFileSync("git", [...BASE_ARGS, ...args], { cwd, env: gitEnv(env), input, maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
    return raw ? out : out.toString("utf8");
  } catch (e) {
    const err = e.stderr ? e.stderr.toString("utf8").trim() : e.message;
    throw new DemoError(`git ${args.slice(0, 3).join(" ")} failed in ${cwd}: ${err}`, 1);
  }
}

/** Like git() but returns null instead of throwing when git exits non-zero. */
export function gitTry(cwd, args, opts) {
  try {
    return git(cwd, args, opts);
  } catch {
    return null;
  }
}

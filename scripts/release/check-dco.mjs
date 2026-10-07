#!/usr/bin/env node
// DCO check ((design notes: public-release-spec) task R20): every commit in a range needs a `Signed-off-by:` trailer
// whose e-mail equals the author's e-mail. Read-only: only `git log --format` runs, nothing is written.
// Merge commits are exempt. A bot author is exempt only when `--bot-login` equals `--pr-author` (the PR
// author login, passed by the caller from the CI event, never taken from the commit text).
// Exit codes: 0 all signed, 1 violations, 3 environment problem (bad range, not a repository).
//
//   node scripts/release/check-dco.mjs --range <base>..<head> [--root <dir>]
//        [--bot-login 'dependabot[bot]' --pr-author <login>]

import { execFileSync } from "node:child_process";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolvePath(HERE, "../..");
const GIT_ARGS = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];
const FS = "\x1f";
const RS = "\x1e";
const TS = "\x1d";

class EnvError extends Error {}

function gitLog(root, range) {
  const env = {};
  for (const k of ["PATH", "HOME", "TMPDIR", "LANG"]) if (process.env[k] !== undefined) env[k] = process.env[k];
  Object.assign(env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });
  const fmt = `--format=%H${FS}%an${FS}%ae${FS}%P${FS}%(trailers:key=Signed-off-by,valueonly,separator=%x1d)${RS}`;
  try {
    return execFileSync("git", [...GIT_ARGS, "log", fmt, range, "--"], {
      cwd: root,
      env,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
  } catch (e) {
    throw new EnvError(`git log failed for the range: ${String(e.stderr || e.message).split("\n")[0]}`);
  }
}

export function parseLog(text) {
  return text
    .split(RS)
    .map((r) => r.replace(/^\n+/, ""))
    .filter((r) => r.trim())
    .map((r) => {
      const [sha, name, email, parents, trailers = ""] = r.split(FS);
      return {
        sha,
        name,
        email,
        merge: parents.trim().split(/\s+/).filter(Boolean).length > 1,
        signoffs: trailers.split(TS).map((t) => t.trim()).filter(Boolean),
      };
    });
}

// `Name <mail>` and nothing after the closing bracket (git's own sign-off line has no trailing text)
const mailOf = (s) => (/^[^<>]+<([^<>\s]+@[^<>\s]+)>$/.exec(s.trim())?.[1] ?? "").toLowerCase();

export function evaluate(commits, { botLogin = "", prAuthor = "" } = {}) {
  const botExempt = botLogin !== "" && botLogin === prAuthor;
  const out = [];
  for (const c of commits) {
    if (c.merge) continue;
    if (botExempt && c.name === botLogin) continue;
    const author = c.email.trim().toLowerCase();
    const mails = c.signoffs.map(mailOf);
    if (!mails.length) out.push({ sha: c.sha, reason: "no Signed-off-by trailer" });
    else if (!author || !mails.includes(author)) out.push({ sha: c.sha, reason: "Signed-off-by e-mail differs from the author e-mail" });
  }
  return out;
}

function main(argv) {
  let root = DEFAULT_ROOT;
  let range = "";
  let botLogin = "";
  let prAuthor = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") root = resolvePath(argv[++i] ?? "");
    else if (a === "--range") range = argv[++i] ?? "";
    else if (a === "--bot-login") botLogin = argv[++i] ?? "";
    else if (a === "--pr-author") prAuthor = argv[++i] ?? "";
    else {
      console.error(`unknown argument: ${a}`);
      return 3;
    }
  }
  if (!range || range.startsWith("-")) {
    console.error("usage: check-dco.mjs --range <base>..<head> [--root <dir>] [--bot-login <login> --pr-author <login>]");
    return 3;
  }
  let commits;
  try {
    commits = parseLog(gitLog(root, range));
  } catch (e) {
    if (e instanceof EnvError) {
      console.error(e.message);
      return 3;
    }
    throw e;
  }
  const bad = evaluate(commits, { botLogin, prAuthor });
  for (const b of bad) console.log(`FAIL dco ${b.sha.slice(0, 12)} ${b.reason}`);
  console.log(`checked ${commits.length} commit(s)`);
  console.log(`RESULT check-dco ${bad.length ? "FAIL" : "OK"}`);
  return bad.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}

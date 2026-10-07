// Builds one demo repository (work tree + bare remote) from a data module, deterministically.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { originUrl } from "./brand.mjs";
import { DemoError } from "./errors.mjs";
import { safeJoin, writeText } from "./fs.mjs";
import { git, gitTry, identityEnv } from "./git.mjs";
import { fileExec, fileText } from "./schema.mjs";

const DEFAULT_HOOKS = { "pre-commit": "#!/bin/sh\necho 'pre-commit: lint ok'\n" };

const REPO_CONFIG = [
  ["core.autocrlf", "false"],
  ["core.filemode", "true"],
  ["core.ignorecase", "false"],
  ["commit.gpgsign", "false"],
  ["gc.auto", "0"],
];

function pruneEmptyDirs(repo, rel) {
  let dir = dirname(join(repo, rel));
  while (dir !== repo && dir.startsWith(repo)) {
    if (!existsSync(dir) || readdirSync(dir).length) break;
    rmdirSync(dir);
    dir = dirname(dir);
  }
}

/** Applies a `changes` map to the work tree: null deletes, { renameFrom } moves, anything else writes. */
function applyChanges(repo, changes) {
  const entries = Object.entries(changes);
  const moved = new Map();
  for (const [path, v] of entries) {
    if (v === null) {
      const full = safeJoin(repo, path);
      if (!existsSync(full)) throw new DemoError(`change deletes ${path}, which does not exist`, 1);
      rmSync(full);
      pruneEmptyDirs(repo, path);
    } else if (typeof v === "object" && "renameFrom" in v) {
      const from = safeJoin(repo, v.renameFrom);
      if (!existsSync(from)) throw new DemoError(`change renames ${v.renameFrom}, which does not exist`, 1);
      moved.set(path, { text: v.text ?? readFileSync(from, "utf8"), exec: (statSync(from).mode & 0o111) !== 0 });
      rmSync(from);
      pruneEmptyDirs(repo, v.renameFrom);
    }
  }
  for (const [path, v] of entries) {
    if (v === null) continue;
    if (typeof v === "object" && "renameFrom" in v) {
      const m = moved.get(path);
      writeText(repo, path, m.text, m.exec);
    } else writeText(repo, path, fileText(v), fileExec(v));
  }
}

function commitStep(repo, step, brand, { allowEmpty = false } = {}) {
  const author = brand.authors[step.author];
  const env = identityEnv(author, step.at);
  applyChanges(repo, step.changes);
  git(repo, ["add", "-A", "--", "."]);
  if (!allowEmpty && gitTry(repo, ["diff", "--cached", "--quiet"]) !== null) throw new DemoError(`step "${step.message.split("\n")[0]}" changes nothing`, 1);
  git(repo, ["commit", "-q", "--no-verify", "-F", "-"], { input: step.message + "\n", env });
}

function switchTo(repo, branch) {
  const exists = gitTry(repo, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]) !== null;
  git(repo, exists ? ["switch", "-q", branch] : ["switch", "-q", "-c", branch]);
}

const head = (repo) => git(repo, ["rev-parse", "HEAD"]).trim();

function assertHeadMatchesFiles(repo, mod) {
  const tracked = git(repo, ["ls-files", "-z"]).split("\0").filter(Boolean).sort();
  const want = Object.keys(mod.files).sort();
  const extra = tracked.filter((p) => !(p in mod.files));
  const missing = want.filter((p) => !tracked.includes(p));
  if (extra.length || missing.length) throw new DemoError(`${mod.id}: module.files does not match the HEAD tree (only in HEAD: ${extra.join(", ") || "-"}; only in files: ${missing.join(", ") || "-"})`, 1);
  for (const [p, v] of Object.entries(mod.files)) {
    const full = join(repo, p);
    if (readFileSync(full, "utf8") !== fileText(v)) throw new DemoError(`${mod.id}: module.files[${p}] differs from the committed content`, 1);
    if (((statSync(full).mode & 0o111) !== 0) !== fileExec(v)) throw new DemoError(`${mod.id}: module.files[${p}] executable bit differs`, 1);
  }
}

function applyWorktree(repo, w) {
  for (const [p, v] of Object.entries(w.modify ?? {})) writeText(repo, p, fileText(v), fileExec(v));
  for (const [p, v] of Object.entries(w.stageAdd ?? {})) {
    writeText(repo, p, fileText(v), fileExec(v));
    git(repo, ["add", "--", p]);
  }
  for (const p of w.delete ?? []) {
    const full = safeJoin(repo, p);
    if (!existsSync(full)) throw new DemoError(`worktree.delete: ${p} does not exist`, 1);
    rmSync(full);
  }
  for (const r of w.stageRename ?? []) {
    mkdirSync(dirname(safeJoin(repo, r.to)), { recursive: true });
    git(repo, ["mv", "--", r.from, r.to]);
    if (r.text !== undefined) writeText(repo, r.to, r.text, (statSync(join(repo, r.to)).mode & 0o111) !== 0);
    git(repo, ["add", "--", r.to]);
  }
  if (w.stage?.length) git(repo, ["add", "--", ...w.stage]);
  for (const [p, v] of Object.entries(w.thenModify ?? {})) writeText(repo, p, fileText(v), fileExec(v));
  for (const [p, v] of Object.entries(w.untracked ?? {})) writeText(repo, p, fileText(v), fileExec(v));
}

/** Builds `<root>/repos/<id>` and `<root>/remotes/<id>.git`. Returns a small summary. */
export function buildRepo(root, mod, brand) {
  const repo = join(root, "repos", mod.id);
  const bare = join(root, "remotes", `${mod.id}.git`);
  mkdirSync(repo, { recursive: true });
  mkdirSync(bare, { recursive: true });
  git(root, ["init", "-q", "-b", "main", "--template=", "--bare", bare]);
  git(root, ["init", "-q", "-b", "main", "--template=", repo]);
  for (const [k, v] of REPO_CONFIG) {
    git(repo, ["config", "--local", k, v]);
    git(bare, ["config", "--local", k, v]);
  }
  const fictional = originUrl(brand, mod.id);
  git(repo, ["remote", "add", "origin", fictional]);
  // The UI shows the fictional URL; the effective (rewritten) URL is the local bare repository, which the jail accepts.
  git(repo, ["config", "--local", `url.${bare}.insteadOf`, fictional]);

  // ---- history
  let cur = "main";
  mod.history.forEach((step) => {
    if (step.branch && step.branch !== cur) {
      switchTo(repo, step.branch);
      cur = step.branch;
    }
    if (step.merge) {
      const before = head(repo);
      git(repo, ["merge", "-q", "--no-ff", "--no-verify", "-m", step.merge.message, step.merge.from], { env: identityEnv(brand.authors[step.author], step.at) });
      if (head(repo) === before) throw new DemoError(`${mod.id}: merge of ${step.merge.from} into ${cur} created no commit (nothing to merge)`, 1);
    } else commitStep(repo, step, brand);
    if (step.tag) {
      const name = typeof step.tag === "string" ? step.tag : step.tag.name;
      const msg = (typeof step.tag === "object" && step.tag.message) || `Release ${name}`;
      git(repo, ["tag", "-a", name, "-m", msg], { env: identityEnv(brand.authors[step.author], step.at) });
    }
  });
  if (cur !== mod.branch) switchTo(repo, mod.branch);
  assertHeadMatchesFiles(repo, mod);

  // ---- remote state: everything pushed except what `upstream` says is ahead; `upstreamExtra` is remote-only
  const up = { ahead: 0, behind: 0, ...(mod.upstream ?? {}) };
  const localBranches = git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n").filter(Boolean).sort();
  for (const b of localBranches) if (b !== mod.branch) git(repo, ["push", "-q", "origin", `refs/heads/${b}:refs/heads/${b}`]);
  const tip = head(repo);
  const remoteTip = up.ahead ? git(repo, ["rev-parse", `HEAD~${up.ahead}`]).trim() : tip;
  let pushed = remoteTip;
  if (up.behind) {
    git(repo, ["switch", "-q", "--detach", remoteTip]);
    for (const step of mod.upstreamExtra) commitStep(repo, step, brand);
    pushed = head(repo);
    git(repo, ["switch", "-q", mod.branch]);
  }
  git(repo, ["push", "-q", "origin", `${pushed}:refs/heads/${mod.branch}`]);
  for (const rb of mod.remoteOnlyBranches ?? []) git(repo, ["push", "-q", "origin", `${rb.from}^{commit}:refs/heads/${rb.name}`]);
  git(repo, ["fetch", "-q", "origin"]);
  for (const b of localBranches) git(repo, ["branch", "-q", `--set-upstream-to=origin/${b}`, b]);
  const remoteHeads = git(repo, ["for-each-ref", "--format=%(refname)", "refs/remotes/origin"]).split("\n").filter((r) => r && !r.endsWith("/HEAD"));
  for (const tag of git(repo, ["tag", "-l"]).split("\n").filter(Boolean)) {
    const c = git(repo, ["rev-list", "-n1", tag]).trim();
    if (remoteHeads.some((r) => gitTry(repo, ["merge-base", "--is-ancestor", c, r]) !== null)) git(repo, ["push", "-q", "origin", `refs/tags/${tag}`]);
  }
  const counts = git(repo, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]).trim().split(/\s+/).map(Number);
  if (counts[0] !== up.ahead || counts[1] !== up.behind) throw new DemoError(`${mod.id}: ahead/behind is ${counts[0]}/${counts[1]}, module asked for ${up.ahead}/${up.behind}`, 1);

  // ---- hooks (only after the last commit), then the uncommitted state
  const hooks = { ...DEFAULT_HOOKS, ...(mod.hooks ?? {}) };
  mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
  for (const [name, text] of Object.entries(hooks)) {
    const f = join(repo, ".git", "hooks", name);
    writeFileSync(f, text);
    chmodSync(f, 0o755);
  }
  applyWorktree(repo, mod.worktree);
  return { id: mod.id, branch: mod.branch, head: tip, commits: Number(git(repo, ["rev-list", "--count", "HEAD"]).trim()) };
}

/** A tiny extra repository (welcome screen entries): one commit by the release bot at the start of the window. */
export function buildExtraRepo(root, entry, brand) {
  const repo = join(root, "extra", entry.id);
  mkdirSync(repo, { recursive: true });
  git(root, ["init", "-q", "-b", "main", "--template=", repo]);
  for (const [k, v] of REPO_CONFIG) git(repo, ["config", "--local", k, v]);
  writeText(repo, "README.md", `# ${entry.name}\n\nPlaceholder repository for the ${brand.company} demo workspace.\n`);
  git(repo, ["add", "-A", "--", "."]);
  git(repo, ["commit", "-q", "--no-verify", "-F", "-"], { input: "chore: initial commit\n", env: identityEnv(brand.authors["release-bot"], `${brand.anchor.start}T09:00:00Z`) });
  return repo;
}

// The required-outcomes table of (design notes: release-ci-spec) 6.2, as data, plus the checks that compare a generated
// repository with a row. A module may carry its own row in `expect` (fixtures); otherwise OUTCOMES[id] is used.
//
// Row fields (all optional except branch):
//   branch, ahead, behind            current branch and its distance from origin/<branch>
//   commits [min,max], merges (min)  size of the HEAD history, number of merge commits (at least)
//   tags []                          exact set of tags
//   otherLocalBranches [], merged [] exact set of other local branches; those of them that are merged into HEAD
//   remoteOnly []                    branches that exist on origin only
//   worktree {...}                   counts from `git status --porcelain=v2 -uall`; a number is exact, [min,max] a range;
//                                    categories left out must be 0:
//     modified       entries with a work-tree modification (Y = M, includes partially staged files)
//     added          staged additions (X = A)         renamed   staged renames (type 2 entries)
//     deleted        deletions in the index or the work tree
//     stagedOnly     entries whose change is only staged (X set, Y clean)
//     partiallyStaged  entries modified both in the index and afterwards (X = M, Y = M)
//     untrackedFiles untracked files that are neither inside one of untrackedDirs nor listed in untrackedNamed
//     untrackedDirs  { "dir/": fileCount }   untrackedNamed [paths]
//   someFileHunks n                  some changed file has exactly n hunks against HEAD (multiHunkFile: some file has >= n)
import { existsSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { git, gitTry } from "./git.mjs";

const range = (v) => (Array.isArray(v) ? v : [v, v]);

export const OUTCOMES = {
  "fb-api": {
    branch: "feature/order-refunds",
    ahead: 3,
    behind: 0,
    commits: [36, 40],
    merges: 3,
    tags: ["v1.8.0", "v1.9.0"],
    otherLocalBranches: ["fix/rounding-totals", "main"],
    merged: ["fix/rounding-totals"],
    remoteOnly: ["release/1.9"],
    worktree: { modified: 6, added: 2, deleted: 1, renamed: 1, partiallyStaged: 1, untrackedFiles: 2, untrackedDirs: { "dump_2026-09-30/": 2 }, untrackedNamed: [".env"] },
    someFileHunks: 3,
  },
  "fb-web": {
    branch: "feature/checkout-redesign",
    ahead: 2,
    behind: 0,
    commits: [28, 34],
    merges: 2,
    tags: ["v2.4.0"],
    otherLocalBranches: ["main"],
    worktree: { modified: 9, added: 1, renamed: 1, untrackedFiles: 3 },
  },
  "fb-mobile": {
    branch: "main",
    ahead: 1,
    behind: 0,
    commits: [24, 28],
    merges: 1,
    tags: ["v0.9.0"],
    otherLocalBranches: ["develop"],
    worktree: { modified: 3, untrackedFiles: 1 },
  },
  "fb-infra": {
    branch: "chore/bump-postgres",
    ahead: 0,
    behind: 1,
    commits: [22, 26],
    merges: 1,
    tags: ["v3.1.0"],
    otherLocalBranches: ["main"],
    worktree: { modified: 2, stagedOnly: 1, added: [0, 1], renamed: [0, 1] },
    multiHunkFile: 2,
  },
};

/** Parses `git status --porcelain=v2 -uall` into entries. */
export function parseStatus(text) {
  const out = { entries: [], untracked: [] };
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("? ")) out.untracked.push(line.slice(2));
    else if (line.startsWith("1 ")) {
      const f = line.split(" ");
      out.entries.push({ type: 1, x: f[1][0], y: f[1][1], path: f.slice(8).join(" ") });
    } else if (line.startsWith("2 ")) {
      const f = line.split(" ");
      out.entries.push({ type: 2, x: f[1][0], y: f[1][1], path: f.slice(9).join(" ").split("\t")[0] });
    } else if (line.startsWith("u ")) out.entries.push({ type: "u", x: "U", y: "U", path: line });
  }
  return out;
}

export function worktreeCounts(repo) {
  const st = parseStatus(git(repo, ["status", "--porcelain=v2", "--untracked-files=all"]));
  const e = st.entries;
  return {
    entries: e,
    untracked: st.untracked,
    modified: e.filter((x) => x.type === 1 && x.y === "M").length,
    added: e.filter((x) => x.x === "A").length,
    deleted: e.filter((x) => x.x === "D" || x.y === "D").length,
    renamed: e.filter((x) => x.type === 2).length,
    stagedOnly: e.filter((x) => x.x !== "." && x.y === ".").length,
    partiallyStaged: e.filter((x) => x.type === 1 && x.x === "M" && x.y === "M").length,
    unmerged: e.filter((x) => x.type === "u").length,
  };
}

export function hunkCounts(repo) {
  const out = {};
  const files = git(repo, ["diff", "HEAD", "--name-only", "-z"]).split("\0").filter(Boolean);
  for (const f of files) out[f] = git(repo, ["diff", "HEAD", "--unified=3", "--no-color", "--", f]).split("\n").filter((l) => l.startsWith("@@")).length;
  return out;
}

const eqSet = (a, b) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

/** Compares one repository with its row. Returns a list of problems. */
export function checkOutcomes(root, id, row) {
  const repo = join(root, "repos", id);
  const p = [];
  const bad = (m) => p.push(`${id}: ${m}`);
  if (!existsSync(repo)) return [`${id}: repository is missing`];
  const branch = git(repo, ["symbolic-ref", "--short", "HEAD"]).trim();
  if (row.branch !== undefined && branch !== row.branch) bad(`on branch ${branch}, expected ${row.branch}`);
  const upstream = git(repo, ["for-each-ref", "--format=%(upstream:short)", `refs/heads/${branch}`]).trim();
  if (upstream !== `origin/${branch}`) bad(`upstream is "${upstream}", expected origin/${branch}`);
  else {
    const [a, b] = git(repo, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]).trim().split(/\s+/).map(Number);
    if (row.ahead !== undefined && a !== row.ahead) bad(`ahead ${a}, expected ${row.ahead}`);
    if (row.behind !== undefined && b !== row.behind) bad(`behind ${b}, expected ${row.behind}`);
  }
  const commits = Number(git(repo, ["rev-list", "--count", "HEAD"]).trim());
  if (row.commits && (commits < row.commits[0] || commits > row.commits[1])) bad(`${commits} commits, expected ${row.commits[0]} to ${row.commits[1]}`);
  const merges = Number(git(repo, ["rev-list", "--merges", "--count", "HEAD"]).trim());
  if (row.merges !== undefined && merges < row.merges) bad(`${merges} merge commits, expected at least ${row.merges}`);
  const tags = git(repo, ["tag", "-l"]).split("\n").filter(Boolean);
  if (row.tags && !eqSet(tags, row.tags)) bad(`tags [${tags}] differ from [${row.tags}]`);
  for (const t of tags) if (git(repo, ["cat-file", "-t", t]).trim() !== "tag") bad(`tag ${t} is not annotated`);
  const locals = git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n").filter(Boolean);
  const others = locals.filter((b) => b !== branch);
  if (row.otherLocalBranches && !eqSet(others, row.otherLocalBranches)) bad(`other local branches [${others}] differ from [${row.otherLocalBranches}]`);
  if (row.merged) for (const b of row.merged) if (!locals.includes(b) || spawnMerged(repo, b) === false) bad(`branch ${b} is not merged into HEAD`);
  const remotes = git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"]).split("\n").filter((r) => r && r !== "origin" && r !== "origin/HEAD").map((r) => r.slice(7));
  if (row.remoteOnly) {
    const ro = remotes.filter((r) => !locals.includes(r));
    if (!eqSet(ro, row.remoteOnly)) bad(`remote-only branches [${ro}] differ from [${row.remoteOnly}]`);
  }

  if (row.worktree) {
    const w = row.worktree;
    const c = worktreeCounts(repo);
    for (const k of ["modified", "added", "deleted", "renamed", "stagedOnly", "partiallyStaged"]) {
      if ((k === "stagedOnly" || k === "partiallyStaged") && w[k] === undefined) continue; // overlap with added/renamed/modified
      const [lo, hi] = range(w[k] ?? 0);
      if (c[k] < lo || c[k] > hi) bad(`work tree: ${c[k]} ${k}, expected ${lo === hi ? lo : `${lo} to ${hi}`}`);
    }
    if (c.unmerged) bad(`work tree: ${c.unmerged} unmerged entries`);
    let rest = [...c.untracked];
    for (const [dir, n] of Object.entries(w.untrackedDirs ?? {})) {
      const inDir = rest.filter((f) => f.startsWith(dir));
      if (inDir.length !== n) bad(`untracked directory ${dir} holds ${inDir.length} files, expected ${n}`);
      rest = rest.filter((f) => !f.startsWith(dir));
    }
    for (const f of w.untrackedNamed ?? []) {
      if (!rest.includes(f)) bad(`untracked file ${f} is missing`);
      rest = rest.filter((x) => x !== f);
    }
    const [lo, hi] = range(w.untrackedFiles ?? 0);
    if (rest.length < lo || rest.length > hi) bad(`${rest.length} other untracked files, expected ${lo === hi ? lo : `${lo} to ${hi}`}`);
  }
  if (row.someFileHunks !== undefined || row.multiHunkFile !== undefined) {
    const hunks = Object.values(hunkCounts(repo));
    if (row.someFileHunks !== undefined && !hunks.includes(row.someFileHunks)) bad(`no changed file has exactly ${row.someFileHunks} hunks (found ${hunks.join(", ") || "none"})`);
    if (row.multiHunkFile !== undefined && !hunks.some((h) => h >= row.multiHunkFile)) bad(`no changed file has ${row.multiHunkFile} or more hunks`);
  }
  return p;
}

function spawnMerged(repo, b) {
  try {
    git(repo, ["merge-base", "--is-ancestor", b, "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/** Generic structure checks every generated repository must pass, with or without a row. */
export function checkStructure(root, id, brand) {
  const repo = join(root, "repos", id);
  const bare = join(root, "remotes", `${id}.git`);
  const p = [];
  const bad = (m) => p.push(`${id}: ${m}`);
  if (!existsSync(repo)) return [`${id}: repository is missing`];
  if (!existsSync(bare)) bad("bare remote is missing");
  const shown = git(repo, ["config", "--get", "remote.origin.url"]).trim();
  const want = `git@${brand.gitHost}:${brand.gitGroup}/${id}.git`;
  if (shown !== want) bad(`origin URL shown is ${shown}, expected ${want}`);
  const effective = git(repo, ["remote", "get-url", "origin"]).trim();
  if (effective !== bare) bad(`effective origin URL is ${effective}, expected the local bare repository`);
  if (!effective.startsWith(root + sep)) bad("effective origin URL is outside the demo root");
  const hook = join(repo, ".git", "hooks", "pre-commit");
  if (!existsSync(hook) || (statSync(hook).mode & 0o111) === 0) bad("pre-commit hook is missing or not executable");
  if (gitTry(repo, ["config", "--local", "--get", "core.hooksPath"]) !== null) bad("core.hooksPath is set in the repository config");
  return p;
}

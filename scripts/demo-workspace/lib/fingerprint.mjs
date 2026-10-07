// Reproducibility fingerprint of a generated demo root: refs (branch tips, tags), `git status` hash and file-tree hash
// per repository, plus the bare remotes' refs. No absolute path ever enters a hash.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { sha256, walkFiles } from "./fs.mjs";
import { git } from "./git.mjs";

const sub = (root, d) => {
  try {
    return readdirSync(join(root, d)).sort();
  } catch {
    return [];
  }
};

export const refsOf = (dir) => git(dir, ["for-each-ref", "--format=%(refname) %(objectname) %(*objectname)"]).split("\n").filter(Boolean).sort().join("\n");

export function treeHash(repo) {
  const lines = walkFiles(repo, [".git"]).map((p) => `${p}\0${statSync(join(repo, p)).mode & 0o111 ? "x" : "-"}\0${sha256(readFileSync(join(repo, p)))}`);
  return sha256(lines.join("\n"));
}

export const statusOf = (repo) => git(repo, ["status", "--porcelain=v2", "--branch", "--untracked-files=all"]);

export function fingerprint(root) {
  const repos = {};
  for (const id of sub(root, "repos")) {
    const dir = join(root, "repos", id);
    repos[id] = { refs: sha256(refsOf(dir)), status: sha256(statusOf(dir)), tree: treeHash(dir) };
  }
  const remotes = {};
  for (const n of sub(root, "remotes")) remotes[n] = sha256(refsOf(join(root, "remotes", n)));
  const extra = {};
  for (const id of sub(root, "extra")) extra[id] = { refs: sha256(refsOf(join(root, "extra", id))), tree: treeHash(join(root, "extra", id)) };
  const out = { repos, remotes, extra };
  return { ...out, overall: sha256(JSON.stringify(out)) };
}

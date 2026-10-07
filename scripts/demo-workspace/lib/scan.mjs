// Scans everything a generated demo repository contains: file names, file contents (work tree, so untracked files
// too), commit messages, author and committer identities, branch and tag names and tag messages.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { walkFiles } from "./fs.mjs";
import { git } from "./git.mjs";
import { scanText } from "./rules.mjs";

export function scanRepo(root, id, { needles = null } = {}) {
  const repo = join(root, "repos", id);
  const hits = [];
  const problems = [];
  const add = (where, text, name = "") => hits.push(...scanText(where, text, { needles, name }));
  for (const f of walkFiles(repo, [".git"])) {
    add(`${id}: file name ${f}`, f);
    const raw = readFileSync(join(repo, f));
    const text = raw.toString("utf8");
    if (text.includes("�") || raw.includes(0)) {
      problems.push(`${id}: ${f} is not valid UTF-8 text`);
      continue;
    }
    if (text.includes(root)) problems.push(`${id}: ${f} contains the generator root path`);
    add(`${id}: ${f}`, text, f);
  }
  const log = git(repo, ["log", "--all", "-z", "--format=%H%n%an%n%ae%n%cn%n%ce%n%B"]).split("\0").filter(Boolean);
  for (const c of log) add(`${id}: commit ${c.slice(0, 10)}`, c);
  const refs = git(repo, ["for-each-ref", "--format=%(refname)%0a%(taggername)%0a%(taggeremail)%0a%(contents)%00"]).split("\0").map((r) => r.replace(/^\n/, "")).filter(Boolean);
  for (const r of refs) add(`${id}: ref ${r.split("\n")[0]}`, r);
  return { hits, problems };
}

// A path from the page is a claim. It must name a file inside a registered repo, lexically (this file) and then through
// the real file system when the editor opens it (core::guard resolves symlinks; crates/preview-proxy/src/jail.rs does
// the same check for a future Rust-side resolver).

import { isCleanPathText } from "./protocol";

export interface RepoRoot {
  id: string;
  path: string;
}

export interface ResolvedPath {
  repoId: string;
  /** Repo-relative, forward slashes, NFC. */
  path: string;
  /** Inside node_modules or .pnpm: the page is showing library code. */
  thirdParty: boolean;
}

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/** Collapses `//` and `.`; refuses `..` (a traversal claim is never "fixed up"). */
function cleanSegments(p: string): string[] | undefined {
  const out: string[] = [];
  for (const s of p.split("/")) {
    if (s === "..") return undefined;
    if (s === "" || s === ".") continue;
    out.push(s);
  }
  return out;
}

export function resolveHintPath(file: string, repos: readonly RepoRoot[], defaultRepoId?: string): ResolvedPath | undefined {
  if (!isCleanPathText(file)) return undefined;
  const nfc = file.normalize("NFC");
  const segs = cleanSegments(nfc);
  if (!segs || segs.length === 0) return undefined;
  let repo: RepoRoot | undefined;
  let rel: string[];
  if (nfc.startsWith("/")) {
    // longest root wins; compare whole path segments so /repo/admin never matches /repo/admin-evil
    let best: { repo: RepoRoot; n: number } | undefined;
    for (const r of repos) {
      const rootSegs = cleanSegments(trimSlash(r.path).normalize("NFC"));
      if (!rootSegs || rootSegs.length === 0 || rootSegs.length >= segs.length) continue;
      if (rootSegs.every((s, i) => s === segs[i]) && (!best || rootSegs.length > best.n)) best = { repo: r, n: rootSegs.length };
    }
    if (!best) return undefined;
    repo = best.repo;
    rel = segs.slice(best.n);
  } else {
    repo = repos.find((r) => r.id === defaultRepoId);
    if (!repo) return undefined;
    rel = segs;
  }
  const path = rel.join("/");
  return { repoId: repo.id, path, thirdParty: /(^|\/)(node_modules|\.pnpm)\//.test(path) };
}

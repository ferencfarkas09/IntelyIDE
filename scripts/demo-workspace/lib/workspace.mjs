// workspace.json (pinned mode, same shape as scripts/make-fixture-workspace.sh) and, with --registry, the registry
// workspaces.json plus workspaces/<id>.json (crates/core/src/registry/model.rs, version 1).
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { epoch } from "./brand.mjs";

const PALETTE = ["#4caf7d", "#8b6cf0", "#f0a23a", "#3b9ae8", "#e5534b", "#d96ba0", "#2fb5a8", "#8a8f98"];

const json = (v) => JSON.stringify(v, null, 2) + "\n";

function repoMeta(brand, id, i) {
  const b = brand.repos.find((r) => r.id === id);
  return { id, name: b?.name ?? id, color: b?.color ?? PALETTE[i % PALETTE.length], badge: b?.badge ?? id.replace(/^fb-/, "").slice(0, 2).toUpperCase() };
}

const repoConfig = (brand, root, id, i, dir = "repos") => ({ ...repoMeta(brand, id, i), path: join(root, dir, id), order: i, pushTargets: {} });

function writePrivate(file, text) {
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Writes <root>/workspace.json for the given repo ids (generation order). */
export function writePinned(root, brand, ids) {
  const ws = {
    version: 1,
    repos: ids.map((id, i) => repoConfig(brand, root, id, i)),
    protectedBranches: brand.protectedBranches,
    settings: { messageMode: "shared", untrackedChecked: false },
  };
  writeFileSync(join(root, "workspace.json"), json(ws));
}

/** Registry mode: the "Fernbank" workspace plus the extra welcome-screen entries. Timestamps derive from the frozen clock. */
export function writeRegistry(root, brand, ids) {
  const now = epoch(brand.anchor.now) * 1000;
  const day = 86_400_000;
  const dirMode = 0o700;
  mkdirSync(join(root, "workspaces"), { recursive: true, mode: dirMode });
  chmodSync(join(root, "workspaces"), dirMode);
  const workspaces = [
    { id: brand.workspace.id, name: brand.workspace.name, color: brand.workspace.color, order: 0, createdAt: now - 30 * day, lastOpenedAt: now, origin: "created" },
    ...brand.extraWorkspaces.map((w, i) => ({ id: w.id, name: w.name, color: w.color, order: i + 1, createdAt: now - (20 - i * 5) * day, lastOpenedAt: now - (2 + i * 5) * day, origin: i === 0 ? "created" : "scanned" })),
  ];
  const settings = { messageMode: "shared", untrackedChecked: false };
  const main = { version: 1, repos: ids.map((id, i) => repoConfig(brand, root, id, i)), protectedBranches: brand.protectedBranches, liveBranches: {}, settings };
  writePrivate(join(root, "workspaces", `${brand.workspace.id}.json`), json(main));
  for (const w of brand.extraWorkspaces) {
    const repo = { id: w.repo.id, name: w.repo.name, color: w.color, badge: w.repo.badge, path: join(root, "extra", w.repo.id), order: 0, pushTargets: {} };
    writePrivate(join(root, "workspaces", `${w.id}.json`), json({ version: 1, repos: [repo], protectedBranches: brand.protectedBranches, liveBranches: {}, settings }));
  }
  writePrivate(join(root, "workspaces.json"), json({ version: 1, rev: 1, activeId: brand.workspace.id, workspaces }));
}

// Turns a validated hint into an editor tab, or a candidate list. Pure of the DOM: the overlay feeds it.

import { t } from "../../i18n";
import type { SearchIpc } from "../../ipc/search";
import { findDefinitions, type Candidate } from "./nameLookup";
import { resolveHintPath, type RepoRoot } from "./paths";
import type { SourceHint } from "./protocol";

/** How sure we are, shown to the user: an exact source position, or only a name matched in the repo. */
export type Confidence = "exact" | "name";

export type Outcome =
  | { kind: "opened"; repoId: string; path: string; line: number; col: number; confidence: Confidence; thirdParty: boolean; note?: string }
  | { kind: "pick"; name: string; candidates: Candidate[]; note?: string }
  | { kind: "none"; reason: string };

export interface OpenDeps {
  repos: () => readonly RepoRoot[];
  /** The preview tab's repo: resolves relative paths and narrows the name search. */
  repoId?: string;
  search: SearchIpc;
  /** `execute` of the command registry; resolves false when the editor is not available. */
  execute: (id: string, args?: unknown) => Promise<boolean>;
}

async function openAt(deps: OpenDeps, repoId: string, path: string, line: number, col: number): Promise<boolean> {
  return deps.execute("editor.openFile", { repoId, path, line, column: col });
}

export async function handleHint(hint: SourceHint, deps: OpenDeps): Promise<Outcome> {
  let note: string | undefined;
  if (hint.file) {
    const r = resolveHintPath(hint.file, deps.repos(), deps.repoId);
    if (r) {
      const ok = await openAt(deps, r.repoId, r.path, hint.line, hint.col);
      if (ok) return { kind: "opened", repoId: r.repoId, path: r.path, line: hint.line, col: hint.col, confidence: "exact", thirdParty: r.thirdParty };
      return { kind: "none", reason: t("pvi.editorNA") };
    }
    // The claimed file is not inside any registered repo: never open it, and never trust the rest of the claim either.
    note = t("pvi.outside");
  }
  if (!hint.componentName) return { kind: "none", reason: note ?? t("pvi.nothing") };
  const scope = deps.repoId ? [deps.repoId] : deps.repos().map((r) => r.id);
  const found = await findDefinitions(deps.search, hint.componentName, scope);
  if (found.length === 0) return { kind: "none", reason: note ? t("pvi.noDefNote", { name: hint.componentName, note }) : t("pvi.noDef", { name: hint.componentName }) };
  if (found.length === 1) {
    const c = found[0]!;
    const ok = await openAt(deps, c.repoId, c.path, c.line, c.col);
    return ok ? { kind: "opened", repoId: c.repoId, path: c.path, line: c.line, col: c.col, confidence: "name", thirdParty: false, note } : { kind: "none", reason: t("pvi.editorNA") };
  }
  return { kind: "pick", name: hint.componentName, candidates: found, note };
}

/** The user chose one of the candidates. The path comes from our own search, but it still goes through the same check. */
export async function openCandidate(c: Candidate, deps: OpenDeps): Promise<boolean> {
  const repo = deps.repos().find((r) => r.id === c.repoId);
  if (!repo) return false;
  const r = resolveHintPath(c.path, [repo], repo.id);
  return r ? openAt(deps, r.repoId, r.path, c.line, c.col) : false;
}

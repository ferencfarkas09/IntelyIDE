import { createSignal } from "solid-js";
import { t } from "../i18n";
import type { WorkspaceSummary } from "../ipc/workspaces";
import { workspace } from "./workspace";
import { activeSummary, workspaces } from "./workspaces";

/*
 * Which agent runs belong to the open workspace ((design notes: workspaces-spec) 4.7, decision D12). Run records are not stamped with a
 * workspace: a run belongs to the open workspace when every repository id it used resolves in it. The others (History, the
 * sessions list, session search, the Context cockpit) are hidden behind "Show other workspaces", stay read-only and never
 * flow into a prompt.
 */

const [showOther, setShowOther] = createSignal(false);
/** The "Show other workspaces" toggle; a page reload (every switch) resets it. */
export const showOtherWorkspaces = showOther;
export const setShowOtherWorkspaces = setShowOther;

/** Every repo id of the run is one of `known`. A run without repositories belongs everywhere. */
export const resolvesIn = (repoIds: readonly string[], known: readonly string[]): boolean => repoIds.every((id) => known.includes(id));

/** The ids of the repositories of the open workspace. */
export const knownRepoIds = (): string[] => (workspace()?.repos ?? []).map((r) => r.id);

/** True for a run that does not resolve in the open workspace. With no workspace open nothing is foreign. */
export function isForeign(repoIds: readonly string[]): boolean {
  const ws = workspace();
  return !!ws && !resolvesIn(repoIds, ws.repos.map((r) => r.id));
}

/** Another workspace that holds all the run's repositories (the one to open to continue), if there is one. */
export function ownerOf(repoIds: readonly string[], list: readonly WorkspaceSummary[] = workspaces()): WorkspaceSummary | undefined {
  if (repoIds.length === 0) return undefined;
  const open = activeSummary()?.id;
  return list.find((w) => w.id !== open && resolvesIn(repoIds, w.repos.map((r) => r.id)));
}

/** "Open workspace X to continue", or the plain statement when no workspace holds all of the run's repositories. */
export function foreignReason(repoIds: readonly string[]): string {
  const owner = ownerOf(repoIds);
  return owner ? t("scope.openToContinue", { name: owner.name }) : t("scope.otherWorkspace");
}

/** The rows that belong to the open workspace, plus the foreign ones when the toggle is on. */
export function scopeRows<T extends { repoIds: readonly string[] }>(rows: readonly T[]): T[] {
  return showOther() ? [...rows] : rows.filter((r) => !isForeign(r.repoIds));
}

/** How many of the rows the toggle hides right now. */
export const hiddenCount = (rows: readonly { repoIds: readonly string[] }[]): number => (showOther() ? 0 : rows.filter((r) => isForeign(r.repoIds)).length);

/** Role defaults and the like: only the ids that exist in the open workspace. */
export const knownOnly = (ids: readonly string[] | undefined): string[] => (ids ?? []).filter((id) => knownRepoIds().includes(id));

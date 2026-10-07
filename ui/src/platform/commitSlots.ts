import type { Component } from "solid-js";
import { createRegistry } from "./registry";

export interface CommitPanelSlot {
  id: string;
  order?: number;
  /** Rendered in the Commit panel above the Commit button. Must render nothing when it has nothing to say. */
  component: Component;
}

const slots = createRegistry<CommitPanelSlot>((s) => s.order ?? 100, "commit-panel");

/** A module adds a block to the Commit tool window (the pre-commit checks panel). */
export const registerCommitPanelSlot = slots.register;
export const commitPanelSlots = slots.items;
export const resetCommitPanelSlots = slots.clear;

export interface CommitGuardContext {
  /** The files about to be committed, per repo (repo-relative paths). */
  repos: { repoId: string; paths: string[] }[];
}

export interface CommitGuard {
  id: string;
  /** Resolves false to stop the commit (the user said no); a guard that throws is skipped, it never blocks a commit by failing. */
  check: (ctx: CommitGuardContext) => Promise<boolean>;
}

const guards = createRegistry<CommitGuard>(() => 0, "commit-guard");

/** A module asks one more question before a commit starts (the secret-in-diff confirmation). */
export const registerCommitGuard = guards.register;
export const resetCommitGuards = guards.clear;

/** Runs the guards one after the other; the first "no" stops the commit. */
export async function runCommitGuards(ctx: CommitGuardContext): Promise<boolean> {
  for (const g of guards.items()) {
    try {
      if (!(await g.check(ctx))) return false;
    } catch (e) {
      console.error(`Commit guard "${g.id}" failed`, e);
    }
  }
  return true;
}

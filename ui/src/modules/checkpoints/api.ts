// Backend of checkpoints: the `checkpoints_*` commands in the app, an in-memory fixture in a plain browser so the timeline can be
// shown and tested. Nothing here starts a restore on its own: `restore` and `restoreConfig` carry the person's confirmation.
import { call } from "../../ipc/rpc";
import { inTauri } from "../l10n/api";
import type { CheckpointSettings, ConfigCopy, FileDiff, RepoPlan, RepoRestore, RunCheckpoint } from "./types";

export interface CheckpointsApi {
  list(runId: string): Promise<RunCheckpoint[]>;
  /** A named save point of every repository of the run; resolves to its step number. */
  save(runId: string, label: string): Promise<number>;
  /** Dry run: touches nothing. */
  plan(runId: string, seq: number): Promise<RepoPlan[]>;
  restore(runId: string, seq: number, opts: { confirm: boolean; overwriteConflicts: boolean }): Promise<RepoRestore[]>;
  /** Files that differ between two steps (`to` null = the working tree now). Read-only. */
  compare(runId: string, repoId: string, from: number, to: number | null): Promise<FileDiff[]>;
  patch(runId: string, repoId: string, from: number, to: number | null, path: string): Promise<string>;
  settings(): Promise<CheckpointSettings>;
  setProtectConfig(on: boolean): Promise<CheckpointSettings>;
  config(runId: string, seq: number): Promise<ConfigCopy[]>;
  restoreConfig(runId: string, seq: number, repoId: string, paths: string[], consent: boolean): Promise<string[]>;
}

const tauriApi: CheckpointsApi = {
  list: (runId) => call("checkpoints_list", { runId }),
  save: (runId, label) => call("checkpoints_save", { runId, label }),
  plan: (runId, seq) => call("checkpoints_plan", { runId, seq }),
  restore: (runId, seq, opts) => call("checkpoints_restore", { runId, seq, confirm: opts.confirm, overwriteConflicts: opts.overwriteConflicts }),
  compare: (runId, repoId, from, to) => call("checkpoints_compare", { runId, repoId, from, to }),
  patch: (runId, repoId, from, to, path) => call("checkpoints_patch", { runId, repoId, from, to, path }),
  settings: () => call("checkpoints_settings"),
  setProtectConfig: (on) => call("checkpoints_set_protect_config", { on }),
  config: (runId, seq) => call("checkpoints_config", { runId, seq }),
  restoreConfig: (runId, seq, repoId, paths, consent) => call("checkpoints_restore_config", { runId, seq, repoId, paths, consent }),
};

let override: CheckpointsApi | undefined;
export const setCheckpointsApi = (api: CheckpointsApi | undefined): void => void (override = api);

let mock: CheckpointsApi | undefined;
export function checkpointsApi(): CheckpointsApi {
  if (override) return override;
  if (inTauri()) return tauriApi;
  return (mock ??= createMockCheckpoints());
}

const NAMES = [".env", ".env.local", ".env.development", ".env.development.local", ".env.test", ".env.test.local", ".env.production", ".env.production.local", ".env.staging", ".env.staging.local"];

/** A fixture timeline per run: the start, two agent steps (a screen and its styles, then a new component) and a save point. */
export function createMockCheckpoints(): CheckpointsApi {
  const now = Math.floor(Date.now() / 1000);
  const runs = new Map<string, RunCheckpoint[]>();
  let protect = false;
  const steps = (runId: string): RunCheckpoint[] => {
    if (!runs.has(runId)) {
      const repo = "app";
      runs.set(runId, [
        { seq: 0, kind: "start", label: null, createdAt: now - 1800, repos: [{ repoId: repo, files: 120, changed: 0 }], changed: 0 },
        { seq: 1, kind: "end", label: null, createdAt: now - 1200, repos: [{ repoId: repo, files: 121, changed: 3 }], changed: 3 },
        { seq: 2, kind: "save", label: "Login screen works", createdAt: now - 900, repos: [{ repoId: repo, files: 121, changed: 0 }], changed: 0 },
        { seq: 3, kind: "end", label: null, createdAt: now - 300, repos: [{ repoId: repo, files: 123, changed: 4 }], changed: 4 },
      ]);
    }
    return runs.get(runId)!;
  };
  const files: FileDiff[] = [
    { path: "src/screens/Login.tsx", change: "modified", additions: 24, deletions: 6, binary: false },
    { path: "src/screens/Login.module.scss", change: "modified", additions: 12, deletions: 2, binary: false },
    { path: "src/components/PasswordField.tsx", change: "created", additions: 41, deletions: 0, binary: false },
    { path: "src/old/LoginForm.tsx", change: "deleted", additions: 0, deletions: 58, binary: false },
  ];
  return {
    list: async (runId) => steps(runId).map((s) => ({ ...s, repos: s.repos.map((r) => ({ ...r })) })),
    save: async (runId, label) => {
      const list = steps(runId);
      const seq = list[list.length - 1].seq + 1;
      list.push({ seq, kind: "save", label: label.trim() || null, createdAt: Math.floor(Date.now() / 1000), repos: list[list.length - 1].repos.map((r) => ({ ...r, changed: 0 })), changed: 0 });
      return seq;
    },
    plan: async (runId, seq) => {
      const repoId = steps(runId)[0].repos[0].repoId;
      const last = steps(runId).at(-1)!.seq;
      if (seq >= last) return [{ repoId, seq, overwrite: [], recreate: [], delete: [], conflicts: [], headChanged: false, protected: [] }];
      return [{ repoId, seq, overwrite: ["src/screens/Login.tsx", "src/screens/Login.module.scss"], recreate: ["src/old/LoginForm.tsx"], delete: ["src/components/PasswordField.tsx"], conflicts: ["src/screens/Login.module.scss"], headChanged: false, protected: [{ path: ".env", reason: "secret" }] }];
    },
    restore: async (runId, seq, opts) => {
      if (!opts.confirm) throw Object.assign(new Error("restoring overwrites files; review the list and confirm"), { code: "confirmRequired" });
      const [p] = await createMockCheckpoints().plan(runId, seq);
      const keep = (f: string) => !opts.overwriteConflicts && p.conflicts.includes(f);
      return [{ repoId: p.repoId, overwritten: p.overwrite.filter((f) => !keep(f)), recreated: p.recreate.filter((f) => !keep(f)), deleted: p.delete.filter((f) => !keep(f)), kept: opts.overwriteConflicts ? [] : p.conflicts }];
    },
    compare: async (_runId, _repoId, from, to) => (to !== null && to <= from ? [] : files.slice(0, to === null ? 4 : Math.min(4, 1 + (to - from)))),
    patch: async (_runId, _repoId, _from, _to, path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,4 @@\n import { View } from "react-native";\n-export const Login = () => <View />;\n+export const Login = () => (\n+  <View style={styles.page} />\n+);\n`,
    settings: async () => ({ protectConfig: protect, names: NAMES }),
    setProtectConfig: async (on) => ((protect = on), { protectConfig: protect, names: NAMES }),
    config: async (runId, seq) => (protect && seq > 0 ? [{ repoId: steps(runId)[0].repos[0].repoId, path: ".env.local", size: 182, state: "differs" }] : []),
    restoreConfig: async (_runId, _seq, _repoId, paths, consent) => {
      if (!consent) throw Object.assign(new Error("writing config files back needs your consent"), { code: "confirmRequired" });
      return paths;
    },
  };
}

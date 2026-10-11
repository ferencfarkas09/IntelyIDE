import type { Unsubscribe } from "./index";
import { call, subscribe } from "./rpc";

/** One synced file: `path` is `CLAUDE.md` or `memory/<name>.md`; `author` is the teammate who wrote the version everyone has. */
export interface TeamMemoryFile {
  path: string;
  version: number;
  author: string;
  ts: number;
}

/** Both of you changed `path`: the teammate's text is the file now, yours waits in `file` (next to it) for a decision. */
export interface TeamMemoryConflict {
  path: string;
  file: string;
  theirs: string;
  ts: number;
}

/** A teammate's version of `CLAUDE.md` that is not written until you apply it. */
export interface TeamMemoryPending {
  path: string;
  author: string;
  ts: number;
  /** They deleted the file. */
  deleted: boolean;
}

export interface TeamMemoryPendingAsk {
  project: string;
  projectName: string;
  path: string;
  author: string;
}

export interface TeamMemoryProject {
  key: string;
  name: string;
  /** `CLAUDE.md` is shared for this project (its own switch in Settings > Team). */
  claudeMd: boolean;
  pending: TeamMemoryPending[];
  files: TeamMemoryFile[];
  conflicts: TeamMemoryConflict[];
}

export interface TeamMemoryStatus {
  /** At least one project is switched on in Settings > Team. */
  enabled: boolean;
  connected: boolean;
  syncing: boolean;
  projects: TeamMemoryProject[];
  /** Epoch ms of the last finished round; 0 before the first. */
  lastSync: number;
  error: string | null;
  /** Payloads from the relay that failed the signature or path checks in the last round. */
  rejected: number;
  /** Local files left alone in the last round (symlink, over 240 KB, over the 500-file cap). */
  skipped: number;
}

export type TeamMemoryChoice = "mine" | "theirs";
export type TeamMemoryPendingChoice = "apply" | "ignore";

export interface TeamMemoryIpc {
  status(): Promise<TeamMemoryStatus>;
  syncNow(): Promise<void>;
  /** `theirs` drops your copy; `mine` puts it back as the file and shares it on the next round. */
  resolve(project: string, path: string, choice: TeamMemoryChoice): Promise<void>;
  onChanged(cb: () => void): Unsubscribe;
  /** This machine's `CLAUDE.md` and the held teammate version, for "View diff". */
  pendingDiff(project: string, path: string): Promise<{ current: string; incoming: string }>;
  /** `apply` writes the teammate's `CLAUDE.md`; `ignore` keeps yours until they change it again. */
  pendingResolve(project: string, path: string, choice: TeamMemoryPendingChoice): Promise<void>;
  /** A teammate changed a `CLAUDE.md`: it waits for you. */
  onPending(cb: (p: TeamMemoryPendingAsk) => void): Unsubscribe;
}

export function createTauriTeamMemory(): TeamMemoryIpc {
  return {
    status: () => call("team_memory_status"),
    syncNow: () => call("team_memory_sync_now"),
    resolve: (project, path, choice) => call("team_memory_resolve", { project, path, choice }),
    onChanged: (cb) => subscribe<null>("team:memory", () => cb()),
    pendingDiff: (project, path) => call("team_memory_pending_diff", { project, path }),
    pendingResolve: (project, path, choice) => call("team_memory_pending_resolve", { project, path, choice }),
    onPending: (cb) => subscribe<TeamMemoryPendingAsk>("team:memory-pending", cb),
  };
}

export function createMockTeamMemory(now: () => number = Date.now): TeamMemoryIpc {
  const cbs = new Set<() => void>();
  const pendingCbs = new Set<(p: TeamMemoryPendingAsk) => void>();
  const emit = () => cbs.forEach((cb) => cb());
  const t = now();
  const status: TeamMemoryStatus = {
    enabled: true,
    connected: true,
    syncing: false,
    lastSync: t - 42_000,
    error: null,
    rejected: 0,
    skipped: 0,
    projects: [
      {
        key: "0a1b2c3d4e5f60718293a4b5c6d7e8f9",
        name: "widgets",
        claudeMd: true,
        pending: [{ path: "CLAUDE.md", author: "Jordan", ts: t - 300_000, deleted: false }],
        files: [
          { path: "CLAUDE.md", version: 4, author: "Jordan", ts: t - 3_600_000 },
          { path: "memory/MEMORY.md", version: 12, author: "Riley", ts: t - 600_000 },
          { path: "memory/feedback_testing.md", version: 2, author: "You", ts: t - 86_400_000 },
          { path: "memory/project_release.md", version: 6, author: "Jordan", ts: t - 120_000 },
        ],
        conflicts: [{ path: "memory/project_release.md", file: "project_release.conflict-Sam-1700000000000.md", theirs: "Jordan", ts: t - 120_000 }],
      },
    ],
  };
  return {
    async status() {
      return structuredClone(status);
    },
    async syncNow() {
      status.lastSync = now();
      emit();
    },
    async resolve(project, path, choice) {
      const p = status.projects.find((x) => x.key === project);
      if (!p?.conflicts.some((c) => c.path === path)) throw { code: "team", message: "no such conflict" };
      p.conflicts = p.conflicts.filter((c) => c.path !== path);
      if (choice === "mine") {
        const f = p.files.find((x) => x.path === path);
        if (f) Object.assign(f, { version: f.version + 1, author: "You", ts: now() });
      }
      emit();
    },
    onChanged(cb) {
      cbs.add(cb);
      return () => void cbs.delete(cb);
    },
    async pendingDiff(project, path) {
      if (!status.projects.some((x) => x.key === project && x.pending.some((p) => p.path === path))) throw { code: "team", message: "no such pending change" };
      return { current: "# Rules\nUse tabs.\nRun the tests.", incoming: "# Rules\nUse spaces.\nRun the tests.\nNever force-push." };
    },
    async pendingResolve(project, path, choice) {
      const p = status.projects.find((x) => x.key === project);
      if (!p?.pending.some((x) => x.path === path)) throw { code: "team", message: "no such pending change" };
      p.pending = p.pending.filter((x) => x.path !== path);
      if (choice === "apply") p.files.push({ path, version: 5, author: "Jordan", ts: now() });
      emit();
    },
    onPending(cb) {
      pendingCbs.add(cb);
      return () => void pendingCbs.delete(cb);
    },
  };
}

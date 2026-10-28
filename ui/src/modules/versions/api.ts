// Backend of the Versions panel: `versions_scan` / `versions_plan` / `versions_apply` in the app, an in-memory fixture
// in a plain browser (a mobile app with a Node package, plus two smaller repos) so the panel can be shown and tested.
import { call } from "../../ipc/rpc";
import { repos } from "../../store/workspace";
import { inTauri } from "../l10n/api";
import type { Change, Field, FilePlan, Kind, RepoVersions, Role } from "./types";

export interface VersionsApi {
  /** Every repository of the workspace, with the version fields found in it. */
  scan(): Promise<RepoVersions[]>;
  /** The exact diff of the changes of one repository; writes nothing. */
  plan(repoId: string, changes: Change[]): Promise<FilePlan[]>;
  /** Writes the changes of one repository (all or nothing); returns the files written. */
  apply(repoId: string, changes: Change[]): Promise<string[]>;
}

const tauriApi: VersionsApi = {
  scan: () => call("versions_scan"),
  plan: (repoId, changes) => call("versions_plan", { repoId, changes }),
  apply: (repoId, changes) => call("versions_apply", { repoId, changes }),
};

let override: VersionsApi | undefined;
export const setVersionsApi = (api: VersionsApi | undefined): void => void (override = api);

let mock: VersionsApi | undefined;
export function versionsApi(): VersionsApi {
  if (override) return override;
  if (inTauri()) return tauriApi;
  return (mock ??= createMockVersions(() => repos().map((r) => r.id)));
}

const field = (path: string, kind: Kind, key: string, role: Role, value: string, extra: Partial<Field> = {}): Field => ({ id: `${path}#${key}`, path, kind, key, role, value, occurrences: 1, mixed: false, numeric: role === "build", companions: [], ...extra });

/** The first repository is shaped like a mobile app with a Node package; the others are smaller. */
function seed(index: number): Field[] {
  if (index === 0) {
    return [
      field("android/app/build.gradle", "gradle", "versionCode", "build", "12"),
      field("android/app/build.gradle", "gradle", "versionName", "version", "1.4.0"),
      field("ios/App.xcodeproj/project.pbxproj", "pbxproj", "CURRENT_PROJECT_VERSION", "build", "45", { occurrences: 3, mixed: true }),
      field("ios/App.xcodeproj/project.pbxproj", "pbxproj", "MARKETING_VERSION", "version", "1.2.3", { occurrences: 3, mixed: true }),
      field("package.json", "packageJson", "version", "version", "3.88.7", { companions: ["package-lock.json"] }),
    ];
  }
  if (index === 1) return [field("package.json", "packageJson", "version", "version", "2.4.1")];
  if (index === 2) return [field("package.json", "packageJson", "version", "version", "0.9.0"), field("src-tauri/Cargo.toml", "cargo", "package.version", "version", "0.9.0"), field("src-tauri/tauri.conf.json", "tauri", "version", "version", "0.9.0")];
  return [];
}

export function createMockVersions(repoIds: () => string[]): VersionsApi {
  const state = new Map<string, Field[]>();
  const fieldsOf = (id: string): Field[] => {
    if (!state.has(id)) state.set(id, seed(Math.max(0, repoIds().indexOf(id))));
    return state.get(id)!;
  };
  const check = (repoId: string, changes: Change[]): Field[] => {
    const fields = fieldsOf(repoId);
    return changes.map((c) => {
      const f = fields.find((x) => x.id === c.id);
      if (!f) return Promise.reject({ code: "stale", message: `${c.id} is no longer in the repository` }) as never;
      if (f.value !== c.from) return Promise.reject({ code: "stale", message: `${c.id} changed since it was read: it is ${f.value} now, not ${c.from}` }) as never;
      return f;
    });
  };
  return {
    scan: async () => repoIds().map((repoId) => ({ repoId, fields: structuredClone(fieldsOf(repoId)), truncated: false, skipped: [] })),
    plan: async (repoId, changes) => {
      const found = check(repoId, changes);
      const byPath = new Map<string, string[]>();
      changes.forEach((c, i) => {
        const f = found[i];
        const lines = byPath.get(f.path) ?? [];
        lines.push(`-  ${f.key}: ${f.value}`, `+  ${f.key}: ${c.to}`);
        byPath.set(f.path, lines);
        for (const lock of f.companions) byPath.set(lock, [`-  "version": "${f.value}"`, `+  "version": "${c.to}"`]);
      });
      return [...byPath.entries()].map(([path, lines]) => ({ path, diff: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${lines.join("\n")}\n` }));
    },
    apply: async (repoId, changes) => {
      const found = check(repoId, changes);
      const paths = new Set<string>();
      changes.forEach((c, i) => {
        found[i].value = c.to;
        found[i].mixed = false;
        paths.add(found[i].path);
        found[i].companions.forEach((p) => paths.add(p));
      });
      return [...paths];
    },
  };
}

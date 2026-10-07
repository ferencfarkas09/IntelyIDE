// Backend of the expanded Doctor: `gitx_doctor` and `gitx_refresh_env` in the app, a deterministic fixture in a plain
// browser (and in tests, which can swap it with `setDoctorApi`). `?doctor=clean` shows an all-green report.
import { call } from "../../ipc/rpc";
import { inTauri } from "../l10n/api";
import type { DoctorCheck, DoctorItem, DoctorReport } from "./doctorTypes";

export interface DoctorApi {
  run(): Promise<DoctorReport>;
  /** The one fix: probe the login shell again. */
  refreshEnv(): Promise<void>;
}

const tauriApi: DoctorApi = {
  run: () => call("gitx_doctor"),
  refreshEnv: () => call("gitx_refresh_env"),
};

let override: DoctorApi | undefined;
export const setDoctorApi = (api: DoctorApi | undefined): void => void (override = api);

let mock: DoctorApi | undefined;
export function doctorApi(): DoctorApi {
  if (override) return override;
  if (inTauri()) return tauriApi;
  return (mock ??= createMockDoctor(scenario()));
}

function scenario(): string {
  try {
    return new URLSearchParams(location.search).get("doctor") ?? "normal";
  } catch {
    return "normal";
  }
}

const item = (name: string, o: Partial<DoctorItem> = {}): DoctorItem => ({ name, count: null, bytes: null, ageMinutes: null, ...o });
const check = (group: string, level: DoctorCheck["level"], code: string, o: Partial<DoctorCheck> = {}): DoctorCheck => ({ group, level, code, params: {}, items: [], repoId: null, fix: null, ...o });

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** A realistic machine: everything fine except a stale lock, a GUI PATH that lacks Homebrew, a big untracked directory and leftovers. */
export function createMockDoctor(kind = "normal"): DoctorApi {
  const clean = kind === "clean";
  const checks: DoctorCheck[] = [
    check("tools", "ok", "tool.ok", { params: { tool: "git", version: "2.50.1" }, items: [item("/usr/bin/git")] }),
    check("tools", "ok", "tool.ok", { params: { tool: "node", version: "24.1.0" }, items: [item("/opt/homebrew/bin/node")] }),
    check("tools", "ok", "tool.ok", { params: { tool: "gh", version: "2.80.0" }, items: [item("/opt/homebrew/bin/gh")] }),
    check("tools", "ok", "tool.ok", { params: { tool: "claude", version: "2.1.0" }, items: [item("/Users/me/.local/bin/claude")] }),
    check("tools", "info", "tool.missing", { params: { tool: "codex" } }),
    check("credentials", "ok", "cred.ok", { items: [item("osxkeychain"), item("gh")] }),
    clean ? check("path", "ok", "path.guiOk") : check("path", "info", "path.guiMinimal", { params: { count: "1" }, items: [item("/opt/homebrew/bin")], fix: "refreshEnv" }),
    check("disk", "ok", "disk.ok", { params: { free: String(212 * GIB), warnBelow: String(5 * GIB) }, items: [item("backend"), item("admin"), item("IDE state")] }),
    ...["backend", "admin"].map((id) => check("repo", "ok", "hooks.foundAt", { repoId: id, params: { count: "2", hooksPath: ".husky/_" }, items: [item("pre-commit"), item("commit-msg")] })),
    ...(clean
      ? []
      : [
          check("repo", "warn", "lock.stale", { repoId: "admin", params: { minutes: "10" }, items: [item("index.lock", { ageMinutes: 187 })] }),
          check("repo", "warn", "untracked.large", { repoId: "backend", params: { capped: "false" }, items: [item("crm-export/", { count: 1840, bytes: 29 * MIB * 2 }), item("dump_2026-08/", { count: 612, bytes: 96 * MIB })] }),
        ]),
    clean ? check("leftovers", "ok", "orphans.none") : check("leftovers", "warn", "orphans.found", { params: { count: "2" }, items: [item("node index.js (pid 48211)", { ageMinutes: 612 }), item("git (pid 48977)", { ageMinutes: 590 })] }),
    clean ? check("leftovers", "ok", "temp.none") : check("leftovers", "info", "temp.old", { params: { count: "3", bytes: String(64 * MIB) }, items: [item("intely-run-git-501", { bytes: 4096, ageMinutes: 4000 }), item("intely-ledger-1234", { bytes: 60 * MIB, ageMinutes: 2900 })] }),
  ];
  let refreshed = false;
  return {
    run: async () => ({ checks: structuredClone(refreshed ? checks.filter((c) => c.code !== "path.guiMinimal").concat(check("path", "ok", "path.guiOk")) : checks), generatedAt: Date.now() }),
    refreshEnv: async () => void (refreshed = true),
  };
}

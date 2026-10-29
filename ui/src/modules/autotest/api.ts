// Backend of "Auto-test after a run": `autotest_pick` / `autotest_start` in the app, plus the Run panel's own stop, logs and
// state events (the tests run as a Run panel process). A plain browser and the tests get an in-memory runner that prints
// real-looking Vitest output, so the cards can be shown without a process.
import { ipc } from "../../ipc";
import type { LogChunk, ServerInfo } from "../../ipc/run";
import { call } from "../../ipc/rpc";
import { inTauri } from "../l10n/api";
import type { TestPick } from "./types";

type Off = () => void;

export interface AutotestApi {
  /** The repository's unit-test command, or null when it has none the IDE may start by itself. */
  pick(repoId: string): Promise<TestPick | null>;
  /** Starts it (picked again on the backend, with `CI=1`). Rejects with `noTests`, `readOnly`, `alreadyRunning`, ... */
  start(repoId: string): Promise<ServerInfo>;
  stop(serverId: string): Promise<void>;
  logs(serverId: string, fromSeq: number): Promise<LogChunk>;
  list(): Promise<ServerInfo[]>;
  onState(cb: (s: ServerInfo) => void): Off;
}

const tauriApi: AutotestApi = {
  pick: (repoId) => call("autotest_pick", { repoId }),
  start: (repoId) => call("autotest_start", { repoId }),
  stop: (serverId) => ipc.run.stop(serverId),
  logs: (serverId, fromSeq) => ipc.run.logs(serverId, fromSeq),
  list: () => ipc.run.list(),
  onState: (cb) => ipc.run.onState(cb),
};

let override: AutotestApi | undefined;
export const setAutotestApi = (api: AutotestApi | undefined): void => void (override = api);

let mock: AutotestApi | undefined;
export function autotestApi(): AutotestApi {
  if (override) return override;
  if (inTauri()) return tauriApi;
  return (mock ??= createMockAutotest());
}

export interface MockOptions {
  /** Per repository: what the pick returns (default: `npm run test` with Vitest). `null` = no tests. */
  picks?: Record<string, TestPick | null>;
  /** Per repository: the output lines and the exit code. Default: a passing Vitest run. */
  outputs?: Record<string, { lines: string[]; exitCode: number }>;
  /** How long a run takes; `Infinity` = it never ends by itself. */
  durationMs?: number;
}

const PASSING = [" RUN  v2.1.8 /repo", "", " ✓ src/cart.test.ts (6 tests) 12ms", " ✓ src/price.test.ts (4 tests) 4ms", "", " Test Files  2 passed (2)", "      Tests  10 passed (10)", "   Start at  10:02:11", "   Duration  1.31s (transform 90ms, setup 0ms, collect 120ms, tests 16ms)"];

/** An in-memory test runner: every start prints the configured output and exits after `durationMs`. */
export function createMockAutotest(opts: MockOptions = {}): AutotestApi {
  interface Sim {
    info: ServerInfo;
    lines: string[];
    timer?: ReturnType<typeof setTimeout>;
    finish?: (code: number | null, extra: string[]) => void;
  }
  const servers = new Map<string, Sim>();
  const cbs = new Set<(s: ServerInfo) => void>();
  const emit = (info: ServerInfo) => cbs.forEach((cb) => cb(structuredClone(info)));
  const pickOf = (repoId: string): TestPick | null => (opts.picks && repoId in opts.picks ? opts.picks[repoId] : { script: "npm:test", runner: "npm run test", kind: "vitest" });
  return {
    pick: async (repoId) => pickOf(repoId),
    async start(repoId) {
      const p = pickOf(repoId);
      if (!p) throw { code: "noTests", message: `no unit-test command found in ${repoId}` };
      const id = `${repoId}:${p.script}`;
      const prev = servers.get(id);
      if (prev && (prev.info.status === "starting" || prev.info.status === "running")) throw { code: "alreadyRunning", message: `${p.runner} is already running` };
      const out = opts.outputs?.[repoId] ?? { lines: PASSING, exitCode: 0 };
      const s: Sim = { info: { id, repoId, script: p.script, runner: p.runner, status: "running", pid: 50000 + servers.size, startedAt: Math.floor(Date.now() / 1000), ports: [], procs: 1, exitCode: null, url: null, rssMb: null, heavyMb: null } as ServerInfo, lines: [...(prev?.lines ?? []), `─── ${p.runner} ───`] };
      servers.set(id, s);
      s.finish = (code, extra) => {
        s.lines.push(...extra, code === null ? "─── stopped ───" : code ? `─── exited with code ${code} ───` : "─── exited ───");
        s.info = { ...s.info, status: "exited", exitCode: code, pid: null, procs: 0 };
        emit(s.info);
      };
      const ms = opts.durationMs ?? 1200;
      if (Number.isFinite(ms)) s.timer = setTimeout(() => s.finish?.(out.exitCode, out.lines), ms);
      queueMicrotask(() => emit(s.info));
      return structuredClone(s.info);
    },
    async stop(serverId) {
      const s = servers.get(serverId);
      if (!s || s.info.status !== "running") return;
      if (s.timer) clearTimeout(s.timer);
      s.finish?.(null, []);
    },
    async logs(serverId, fromSeq) {
      const s = servers.get(serverId);
      if (!s) throw { code: "io", message: `no server ${serverId}` };
      return { serverId, startSeq: fromSeq, lines: s.lines.slice(fromSeq), reset: false };
    },
    list: async () => [...servers.values()].map((s) => structuredClone(s.info)),
    onState(cb) {
      cbs.add(cb);
      return () => void cbs.delete(cb);
    },
  };
}

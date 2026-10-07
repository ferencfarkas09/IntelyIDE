// Backend of the checks panel and the env/secret awareness: the `checks_*`, `secrets_scan` and `env_report` commands in
// the app, a deterministic fixture in a plain browser (and in tests, which can swap it with `setChecksApi`).
import { call, subscribe } from "../../ipc/rpc";
import type { Unsubscribe } from "../../ipc";
import { inTauri } from "../l10n/api";
import type { CheckInfo, CheckRun, EnvReport, LogChunk, ProcessAccess, SecretScan } from "./types";

export interface ChecksApi {
  access(repoId?: string): Promise<ProcessAccess>;
  discover(repoId: string, changed: string[]): Promise<CheckInfo[]>;
  start(repoId: string, checkId: string, changed: string[]): Promise<CheckRun>;
  stop(runId: string): Promise<void>;
  list(): Promise<CheckRun[]>;
  logs(runId: string, fromSeq: number): Promise<LogChunk>;
  dismiss(runId: string): Promise<void>;
  scan(repoId: string, paths: string[]): Promise<SecretScan>;
  env(): Promise<EnvReport>;
  onState(cb: (run: CheckRun) => void): Unsubscribe;
  onLog(cb: (chunk: LogChunk) => void): Unsubscribe;
}

const tauriApi: ChecksApi = {
  access: (repoId) => call("checks_access", { repoId: repoId ?? null }),
  discover: (repoId, changed) => call("checks_discover", { repoId, changed }),
  start: (repoId, checkId, changed) => call("checks_start", { repoId, checkId, changed }),
  stop: (runId) => call("checks_stop", { runId }),
  list: () => call("checks_list"),
  logs: (runId, fromSeq) => call("checks_logs", { runId, fromSeq }),
  dismiss: (runId) => call("checks_dismiss", { runId }),
  scan: (repoId, paths) => call("secrets_scan", { repoId, paths }),
  env: () => call("env_report"),
  onState: (cb) => subscribe<CheckRun>("checks:state", cb),
  onLog: (cb) => subscribe<LogChunk>("checks:log", cb),
};

let override: ChecksApi | undefined;
export const setChecksApi = (api: ChecksApi | undefined): void => void (override = api);

let mock: ChecksApi | undefined;
export function checksApi(): ChecksApi {
  if (override) return override;
  if (inTauri()) return tauriApi;
  return (mock ??= createMockChecks());
}

const ext = (p: string) => p.slice(p.lastIndexOf(".") + 1);

/** The fixture: lint and the syntax check pass, the related tests fail with a few lines of output. Nothing real runs. */
export function createMockChecks(opts: { startable?: boolean } = {}): ChecksApi {
  const runs = new Map<string, CheckRun>();
  const logs = new Map<string, string[]>();
  const stateCbs = new Set<(r: CheckRun) => void>();
  const logCbs = new Set<(c: LogChunk) => void>();
  const startable = opts.startable ?? true;

  const output: Record<string, { lines: string[]; ok: boolean }> = {
    "npm:lint:changed": { ok: true, lines: ["\u001b[2m$ npm run lint:changed\u001b[0m", "> eslint --cache src/orders/create.js src/orders/total.js", "\u001b[32m✔ 2 files, no problems\u001b[0m"] },
    "tests:related": {
      ok: false,
      lines: ["\u001b[2m$ npx --no-install jest --findRelatedTests ./src/orders/total.js\u001b[0m", "\u001b[31mFAIL\u001b[0m src/orders/total.test.js", "  ● total › adds the delivery fee", "    expect(received).toBe(expected)", "    Expected: 1290", "    Received: 1190", "Tests: 1 failed, 6 passed, 7 total"],
    },
    "node:check": { ok: true, lines: ["\u001b[2m$ node --check ./src/orders/create.js\u001b[0m"] },
    "npm:swagger:validate": { ok: true, lines: ["\u001b[2m$ npm run swagger:validate\u001b[0m", "Swagger spec is valid"] },
    "cargo:check": { ok: true, lines: ["\u001b[2m$ cargo check -j 2\u001b[0m", "    Finished `dev` profile in 4.2s"] },
  };

  const emitState = (r: CheckRun) => stateCbs.forEach((cb) => cb(r));
  const emitLog = (c: LogChunk) => logCbs.forEach((cb) => cb(c));

  return {
    access: async () => ({ allowed: false, jail: "off", startable, reason: startable ? null : "Starting a process is refused in read-only mode. Turn on \"Allow processes\" in Settings > Safety." }),
    discover: async (_repo, changed) => {
      const js = changed.filter((p) => ["js", "jsx", "ts", "tsx", "mjs", "cjs"].includes(ext(p))).length;
      const node = changed.filter((p) => ["js", "mjs", "cjs"].includes(ext(p))).length;
      return [
        { id: "npm:lint:changed", label: "Lint changed files", kind: "lint", runner: "npm run lint:changed", fileCount: js, disabled: null, note: null },
        { id: "tests:related", label: "Tests for the changed files", kind: "test", runner: `jest on ${js} changed file${js === 1 ? "" : "s"}`, fileCount: js, disabled: js ? null : "Tick changed JavaScript or TypeScript files first", note: null },
        { id: "node:check", label: "Syntax check (node --check)", kind: "syntax", runner: `node --check on ${node} file${node === 1 ? "" : "s"}`, fileCount: node, disabled: node ? null : "Tick changed .js, .mjs or .cjs files first", note: null },
        { id: "npm:swagger:validate", label: "Swagger validation", kind: "swagger", runner: "npm run swagger:validate", fileCount: 0, disabled: null, note: "May regenerate spec files" },
      ];
    },
    start: async (repoId, checkId) => {
      if (!startable) throw { code: "readOnly", message: "Starting a process is refused in read-only mode." };
      const id = `${repoId}:${checkId}`;
      const spec = output[checkId] ?? { ok: true, lines: [`$ ${checkId}`] };
      const run: CheckRun = { id, repoId, checkId, label: checkId, runner: checkId, status: "running", exitCode: null, startedAt: Math.floor(Date.now() / 1000), durationMs: 0 };
      runs.set(id, run);
      logs.set(id, []);
      emitState(run);
      emitLog({ runId: id, startSeq: 0, lines: [], reset: true });
      setTimeout(() => {
        logs.set(id, spec.lines);
        emitLog({ runId: id, startSeq: 0, lines: spec.lines, reset: false });
        const done: CheckRun = { ...run, status: spec.ok ? "passed" : "failed", exitCode: spec.ok ? 0 : 1, durationMs: 1400 };
        runs.set(id, done);
        emitState(done);
      }, 30);
      return run;
    },
    stop: async () => {},
    list: async () => [...runs.values()],
    logs: async (runId, fromSeq) => ({ runId, startSeq: fromSeq, lines: (logs.get(runId) ?? []).slice(fromSeq), reset: false }),
    dismiss: async (runId) => void (runs.delete(runId), logs.delete(runId)),
    scan: async (repoId, paths) => ({
      repoId,
      skipped: paths.filter((p) => p.split("/").pop()?.startsWith(".env")),
      findings: paths.filter((p) => /(^|\/)(index\.js|keys\.js)$/.test(p)).slice(0, 1).map((path) => ({ path, line: 12, kind: "GitHub token", preview: 'const token = "[redacted: GitHub token]";' })),
    }),
    env: async () => ({
      repos: [
        { repoId: "backend", files: [{ path: ".env.example", kind: "example", environment: "default", names: ["PORT", "MONGO_URI", "JWT_SECRET"] }, { path: ".env", kind: "real", environment: "default", names: [] }], declared: 3, referenced: 4, missing: [{ name: "SENTRY_DSN", usedIn: ["src/lib/sentry.js"] }], unused: [], hasExample: true, missingTotal: 1, scannedFiles: 212, truncated: false },
        { repoId: "admin", files: [{ path: ".env.example", kind: "example", environment: "default", names: ["VITE_API_URL", "PORT"] }], declared: 2, referenced: 2, missing: [], unused: [], hasExample: true, missingTotal: 0, scannedFiles: 640, truncated: false },
      ],
      names: [
        { name: "SENTRY_DSN", repos: [{ repoId: "backend", declared: false, referenced: true }, { repoId: "admin", declared: false, referenced: false }] },
        { name: "MONGO_URI", repos: [{ repoId: "backend", declared: true, referenced: true }, { repoId: "admin", declared: false, referenced: false }] },
        { name: "JWT_SECRET", repos: [{ repoId: "backend", declared: true, referenced: true }, { repoId: "admin", declared: false, referenced: false }] },
        { name: "VITE_API_URL", repos: [{ repoId: "backend", declared: false, referenced: false }, { repoId: "admin", declared: true, referenced: true }] },
        { name: "PORT", repos: [{ repoId: "backend", declared: true, referenced: true }, { repoId: "admin", declared: true, referenced: true }] },
      ],
    }),
    onState: (cb) => (stateCbs.add(cb), () => void stateCbs.delete(cb)),
    onLog: (cb) => (logCbs.add(cb), () => void logCbs.delete(cb)),
  };
}

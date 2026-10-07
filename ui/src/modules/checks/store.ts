// Run state of the checks panel: runs by id, their output, and the "Run before commit" flow. Loaded with the module's
// first use (the panel), wired once to the backend events.
import { batch, createRoot, createSignal } from "solid-js";
import { t } from "../../i18n";
import { toast } from "../../ui-kit";
import { checksApi } from "./api";
import { applyChunk, BEFORE_COMMIT_TIMEOUT_MS, errorText, failureText, isQuick } from "./logic";
import type { CheckInfo, CheckRun } from "./types";

const state = createRoot(() => {
  const [runs, setRuns] = createSignal<Record<string, CheckRun>>({});
  const [logs, setLogs] = createSignal<Record<string, string[]>>({});
  return { runs, setRuns, logs, setLogs };
});

export const runs = state.runs;
export const logOf = (id: string): readonly string[] => state.logs()[id] ?? [];
export const runOf = (repoId: string, checkId: string): CheckRun | undefined => state.runs()[`${repoId}:${checkId}`];

let off: (() => void)[] = [];
const waiters = new Set<() => void>();

/** Subscribes to the backend once; safe to call again. */
export function wireChecks(): void {
  if (off.length) return;
  const api = checksApi();
  off = [
    api.onState((run) => {
      state.setRuns((r) => ({ ...r, [run.id]: run }));
      waiters.forEach((w) => w());
    }),
    api.onLog((chunk) => state.setLogs((l) => ({ ...l, [chunk.runId]: applyChunk(l[chunk.runId] ?? [], chunk) }))),
  ];
  void api.list().then((all) => state.setRuns(Object.fromEntries(all.map((r) => [r.id, r])))).catch(() => {});
}

export function unwireChecks(): void {
  for (const o of off) o();
  off = [];
}

export async function runCheck(repoId: string, checkId: string, changed: string[]): Promise<CheckRun | undefined> {
  wireChecks();
  try {
    const run = await checksApi().start(repoId, checkId, changed);
    batch(() => {
      state.setRuns((r) => ({ ...r, [run.id]: run }));
      state.setLogs((l) => ({ ...l, [run.id]: [] }));
    });
    return run;
  } catch (e) {
    toast.error(t("checks.toast.startFailed"), errorText(e));
    return undefined;
  }
}

export const stopCheck = (id: string): Promise<void> =>
  checksApi()
    .stop(id)
    .catch((e) => void toast.error(t("checks.toast.stopFailed"), errorText(e)));

const finished = (r: CheckRun | undefined): boolean => !!r && r.status !== "running";

/**
 * "Run before commit": starts the quick checks of every repo about to be committed and waits for them. Failures only
 * warn; this never says no to the commit and gives up waiting after the timeout.
 */
export async function runBeforeCommit(targets: { repoId: string; paths: string[] }[], names: (repoId: string) => string, timeoutMs = BEFORE_COMMIT_TIMEOUT_MS): Promise<void> {
  wireChecks();
  const api = checksApi();
  const access = await api.access().catch(() => undefined);
  if (access && !access.startable) {
    toast.warn(t("checks.toast.skipped"), access.reason ?? t("checks.noProcesses"));
    return;
  }
  const started: string[] = [];
  for (const target of targets) {
    let found: CheckInfo[] = [];
    try {
      found = await api.discover(target.repoId, target.paths);
    } catch {
      continue;
    }
    for (const c of found.filter(isQuick)) {
      const run = await runCheck(target.repoId, c.id, target.paths);
      if (run) started.push(run.id);
    }
  }
  if (!started.length) return;
  const done = () => started.every((id) => finished(state.runs()[id]));
  await new Promise<void>((resolve) => {
    if (done()) return resolve();
    const timer = setTimeout(finish, timeoutMs);
    const waiter = () => done() && finish();
    function finish() {
      clearTimeout(timer);
      waiters.delete(waiter);
      resolve();
    }
    waiters.add(waiter);
  });
  const all = started.map((id) => state.runs()[id]).filter((r): r is CheckRun => !!r);
  const failed = all.filter((r) => r.status === "failed");
  if (failed.length) toast.warn(t("checks.toast.problems"), t("checks.toast.problemsBody", { list: failureText(failed, names) }));
  else if (all.some((r) => r.status === "running")) toast.warn(t("checks.toast.stillRunning"), t("checks.toast.stillRunningBody"));
}

export function resetChecksStore(): void {
  unwireChecks();
  batch(() => {
    state.setRuns({});
    state.setLogs({});
  });
}

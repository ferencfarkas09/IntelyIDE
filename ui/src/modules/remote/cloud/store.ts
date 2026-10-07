// State shared by the Relay group, the wizard and the manage dialogs. Zero cost while idle: nothing subscribes and no command is
// called until the page is open (`relay_cloud_status` only reads settings and files) or a run is started by a click.
import { createSignal } from "solid-js";
import { cloudApi } from "./api";
import { applyLogChunk, emptyLog, type LogState } from "./logic";
import type { CloudRun, CloudView, LogChunk } from "./types";

const [view, setView] = createSignal<CloudView | null>(null);
export const cloudView = view;

const [run, setRun] = createSignal<CloudRun | null>(null);
const [log, setLog] = createSignal<LogState>(emptyLog());
export const currentRun = run;
export const currentLog = log;

export async function refreshCloud(): Promise<CloudView> {
  const v = await cloudApi().status();
  setView(v);
  return v;
}

export interface RunHandle {
  /** Resolves with the final snapshot (ok, failed or cancelled). */
  done: Promise<CloudRun>;
}

/**
 * Starts an operation that returns a `CloudRun` and follows it through `relay-cloud:state` and `relay-cloud:log`. The listeners
 * exist only for the lifetime of the run; events that arrive before the run id is known are replayed.
 */
export function followRun(start: () => Promise<CloudRun>): RunHandle & { started: Promise<CloudRun> } {
  const api = cloudApi();
  let runId: string | null = null;
  const early: { state: CloudRun[]; log: LogChunk[] } = { state: [], log: [] };
  let finish!: (r: CloudRun) => void;
  const done = new Promise<CloudRun>((r) => (finish = r));
  let offState: () => void = () => {};
  let offLog: () => void = () => {};
  const onState = (r: CloudRun) => {
    if (runId === null) return void early.state.push(r);
    if (r.runId !== runId) return;
    setRun(r);
    if (r.status !== "running") {
      offState();
      offLog();
      void api
        .logs(r.runId, 0)
        .then((c) => setLog((s) => applyLogChunk(s, c)))
        .catch(() => {})
        .finally(() => void refreshCloud().catch(() => {}).finally(() => finish(r)));
    }
  };
  const onLog = (c: LogChunk) => {
    if (runId === null) return void early.log.push(c);
    if (c.runId === runId) setLog((s) => applyLogChunk(s, c));
  };
  offState = api.onState(onState);
  offLog = api.onLog(onLog);
  const started = start().then(
    (r) => {
      runId = r.runId;
      setLog(emptyLog());
      setRun(r);
      early.log.filter((c) => c.runId === runId).forEach(onLog);
      early.state.filter((s) => s.runId === runId).forEach(onState);
      if (r.status !== "running") onState(r);
      return r;
    },
    (e) => {
      offState();
      offLog();
      throw e;
    },
  );
  return { started, done: started.then(() => done) };
}

export function clearRun(): void {
  setRun(null);
  setLog(emptyLog());
}

/** Test hook. */
export function resetCloudState(): void {
  setView(null);
  clearRun();
}

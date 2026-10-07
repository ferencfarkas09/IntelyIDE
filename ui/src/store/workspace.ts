import { createSignal } from "solid-js";
import { ipc as defaultIpc, type EnvStatus, type Ipc, type OpEvent, type OpKind, type RepoConfig, type StepStatus, type Workspace } from "../ipc";
import { applySnapshot, errorText, loadSnapshot, refreshSnapshots } from "./snapshots";

/** `empty`: no workspace is open (Welcome). `switching`: a switch is in flight and the page is about to reload. */
export type LoadState = "loading" | "ready" | "empty" | "switching" | "error";

export interface RepoRun {
  status: StepStatus;
  percent?: number;
  /** Last output line, shown as a hint in the status bar. */
  line?: string;
}

export interface RunningOp {
  runId: string;
  kind: OpKind;
  repos: Record<string, RepoRun>;
}

const FINISHED: StepStatus[] = ["done", "skipped", "failed", "cancelled"];
const FOCUS_REFRESH_GAP_MS = 2_000;
let focusRefresh = true;

/** Settings > General: whether regaining window focus refreshes every repo. */
export const setFocusRefresh = (on: boolean): void => void (focusRefresh = on);

const [current, setCurrent] = createSignal<Workspace | undefined>(undefined);
const [state, setState] = createSignal<LoadState>("loading");
const [loadError, setLoadError] = createSignal<string | undefined>(undefined);
const [env, setEnv] = createSignal<EnvStatus | undefined>(undefined);
const [ops, setOps] = createSignal<Record<string, RunningOp>>({});

/** The loaded workspace; `undefined` until the first `workspaceGet` resolves. */
export const workspace = current;
export const workspaceState = state;
export const workspaceError = loadError;
export const envStatus = env;

/** No workspace is open (first run, closed, problem card): Welcome takes the window. Nothing of the old workspace stays. */
export function enterEmptyState(): void {
  setCurrent(undefined);
  setLoadError(undefined);
  setState("empty");
}

/** A switch started: the Splash covers the window until the page reloads (or the switch fails and `leaveSwitching` runs). */
export function enterSwitching(): void {
  setState("switching");
}

/** The switch was refused before anything was stopped: back to what was showing. */
export function leaveSwitching(): void {
  setState(current() ? "ready" : "empty");
}
export const runningOps = (): RunningOp[] => Object.values(ops());

/** Repos in display order. */
export const repos = (): RepoConfig[] => [...(current()?.repos ?? [])].sort((a, b) => a.order - b.order);
export const repoConfig = (repoId: string): RepoConfig | undefined => current()?.repos.find((r) => r.id === repoId);
export const messageMode = (): "shared" | "perRepo" => current()?.settings.messageMode ?? "shared";

/** True while a commit, push, pull or fetch of this repo is running. */
export const repoBusy = (repoId: string): OpKind | undefined => runningOps().find((op) => op.repos[repoId] && !FINISHED.includes(op.repos[repoId].status))?.kind;

export async function saveWorkspace(ws: Workspace, client: Ipc = defaultIpc): Promise<void> {
  setCurrent(await client.workspaceSave(ws));
}

/** The workspace file changed on the Rust side (repositories added through the picker): adopt it and load the new repos. */
export async function adoptWorkspace(ws: Workspace, client: Ipc = defaultIpc): Promise<void> {
  const known = new Set(current()?.repos.map((r) => r.id));
  setCurrent(ws);
  await Promise.all(ws.repos.filter((r) => !known.has(r.id)).map((r) => loadSnapshot(r.id, client)));
}

function trackOp(e: OpEvent): void {
  setOps((all) => {
    const op = all[e.runId] ?? { runId: e.runId, kind: e.kind, repos: {} };
    const prev = op.repos[e.repoId];
    const run: RepoRun = { status: e.status, percent: e.percent ?? prev?.percent, line: e.line?.text ?? prev?.line };
    return { ...all, [e.runId]: { ...op, repos: { ...op.repos, [e.repoId]: run } } };
  });
}

/**
 * Loads the workspace, subscribes to the engine events and refreshes on window focus. Returns the disposer.
 * The subscriptions come first, so a snapshot that arrives while the initial loads are in flight is not lost.
 */
export function startWorkspace(client: Ipc = defaultIpc): () => void {
  const stop = subscribeWorkspace(client);
  void loadWorkspace(client);
  return stop;
}

/** The subscriptions of `startWorkspace` without the initial load (the workspace store loads after its own checks). */
export function subscribeWorkspace(client: Ipc = defaultIpc): () => void {
  const unsubscribe = [
    client.onRepoSnapshot((s) => void applySnapshot(s)),
    client.onEngineEnv(setEnv),
    client.onOpEvent(trackOp),
    client.onOpResult((r) =>
      setOps((all) => {
        const { [r.runId]: _done, ...rest } = all;
        return rest;
      }),
    ),
  ];

  let lastFocusRefresh = Date.now();
  const onFocus = () => {
    if (!focusRefresh || Date.now() - lastFocusRefresh < FOCUS_REFRESH_GAP_MS) return;
    lastFocusRefresh = Date.now();
    void refreshSnapshots(null, client);
  };
  if (typeof window !== "undefined") window.addEventListener("focus", onFocus);

  return () => {
    unsubscribe.forEach((u) => u());
    if (typeof window !== "undefined") window.removeEventListener("focus", onFocus);
  };
}

/** (Re)loads workspace, engine status and every repo snapshot. Also the retry action of the error state. */
export async function loadWorkspace(client: Ipc = defaultIpc): Promise<void> {
  setState("loading");
  setLoadError(undefined);
  try {
    const [ws, status] = await Promise.all([client.workspaceGet(), client.engineStatus()]);
    setCurrent(ws);
    setEnv((cur) => cur ?? status.env);
    setState("ready");
    await Promise.all(ws.repos.map((r) => loadSnapshot(r.id, client)));
  } catch (e) {
    setLoadError(errorText(e));
    setState("error");
  }
}

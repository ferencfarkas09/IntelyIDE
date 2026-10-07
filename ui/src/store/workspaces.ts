import { batch, createMemo, createRoot, createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { t } from "../i18n";
import { ipc as defaultIpc, type Ipc } from "../ipc";
import { setPageEpoch, toEngineError } from "../ipc/rpc";
import type { CreateRequest, RegistryView, RepoProbe, RepoStatus, Survivor, SwitchWarning, WorkspaceProbe, WorkspaceSummary } from "../ipc/workspaces";
import { saveAllUnsaved, unsavedTitles } from "../platform/closeGuard";
import { BEFORE_TEARDOWN, switchWarningText, workspaceErrorText } from "../shell/workspace/errors";
import { announce, toast } from "../ui-kit";
import { readStored, removeStored, writeStored } from "../ui-kit/storage";
import { GUARD_POLL_MS, hasBlocking, isClear, mergeBusy, parseBusyDetail, type GuardModel } from "./workspaceBusy";
import { enterEmptyState, enterSwitching, leaveSwitching, loadWorkspace, subscribeWorkspace } from "./workspace";

/*
 * The workspace registry as the UI sees it, the boot decision (Welcome or the open workspace) and the switch orchestrator
 * ((design notes: workspaces-spec) 3.1, 3.9). A switch always ends in a page reload (decision D1): the webview is the only thing that
 * can drop every module-level store of the old workspace, so nothing here tries to reset them one by one.
 */

export const HANDOFF_KEY = "intely.ws.switched";
const PENDING_REMOVE_KEY = "intely.ws.removeAfterClose";
const PROBE_BATCH = 4;
const PROBE_TOTAL_MS = 3000;

// A store reconciled by id: a refresh keeps the identity of unchanged rows, so a list on screen keeps its DOM nodes and its focus.
const [registryStore, setRegistryStore] = createStore<{ view?: RegistryView }>({});
const registryView = (): RegistryView | undefined => registryStore.view;
const setRegistryView = (v: RegistryView | undefined): void => setRegistryStore("view", v ? reconcile(v, { key: "id" }) : undefined);
const [probes, setProbes] = createSignal<Record<string, WorkspaceProbe>>({});
const [checking, setChecking] = createSignal<ReadonlySet<string>>(new Set());
const [survivorList, setSurvivorList] = createSignal<Survivor[]>([]);
const [closedByUser, setClosedByUser] = createSignal(false);
/** The page was loaded by "Close workspace": Welcome then starts with the focus on the recent list. */
export const arrivedByClose = closedByUser;
const [switchingTo, setSwitchingTo] = createSignal<{ id: string | null; name: string | null } | null>(null);

export const registry = registryView;
export const survivors = survivorList;
/** The workspace the Splash names while a switch runs; `name` is null when the window is being emptied. */
export const switchTarget = switchingTo;

export const isPinned = (): boolean => registryView()?.pinned ?? false;
export const registryProblem = () => registryView()?.problem ?? null;
export const crashLoop = () => registryView()?.crashLoop ?? null;
export const openError = () => registryView()?.openError ?? null;
export const activeId = (): string | null => registryView()?.activeId ?? null;
export const workspaces = (): WorkspaceSummary[] => registryView()?.workspaces ?? [];
export const activeSummary = (): WorkspaceSummary | undefined => workspaces().find((w) => w.id === activeId());

const byRecent = (a: WorkspaceSummary, b: WorkspaceSummary): number => (b.lastOpenedAt ?? -1) - (a.lastOpenedAt ?? -1) || a.name.localeCompare(b.name);

/** Workspaces sorted by `lastOpenedAt` (never opened last), then by name. */
export const recents = createRoot(() => createMemo((): WorkspaceSummary[] => [...workspaces()].sort(byRecent)));

/** The ids the title-bar switcher and the dynamic commands list: the eight most recent, the open one included. */
export const switcherRecents = (max = 8): WorkspaceSummary[] => recents().slice(0, max);

// ---------------------------------------------------------------------------------------------------------------- probe

export type RowStatusKind = "checking" | "ok" | "missing" | "someMissing" | "volumeMissing" | "notRepo" | "noAccess" | "unresponsive" | "fileDamaged";

export interface RowStatus {
  kind: RowStatusKind;
  missing: number;
  total: number;
}

const BAD: ReadonlySet<RepoStatus> = new Set(["missing", "volumeMissing", "notRepo", "noAccess", "unresponsive"]);

/** One status for a Welcome row from its probe (`undefined` = not probed yet). A workspace with zero repos is always `ok`. */
export function rowStatus(ws: WorkspaceSummary, probe: WorkspaceProbe | undefined, isChecking: boolean, damaged = false): RowStatus {
  const total = ws.repos.length;
  if (damaged) return { kind: "fileDamaged", missing: 0, total };
  if (total === 0) return { kind: "ok", missing: 0, total };
  if (!probe) return { kind: isChecking ? "checking" : "ok", missing: 0, total };
  const bad = probe.repos.filter((r) => BAD.has(r.status));
  if (bad.length === 0) return { kind: "ok", missing: 0, total };
  if (bad.length < total) return { kind: "someMissing", missing: bad.length, total };
  const first = bad[0].status;
  const same = bad.every((r) => r.status === first);
  return { kind: same ? (first as RowStatusKind) : "missing", missing: bad.length, total };
}

/** True when every repo of a non-empty workspace is missing (the launch-time `keepActive` decision). */
export const allMissing = (probe: WorkspaceProbe | undefined): boolean => !!probe && probe.repos.length > 0 && probe.repos.every((r) => r.status === "missing" || r.status === "volumeMissing");

export const probeOf = (id: string): WorkspaceProbe | undefined => probes()[id];
export const isChecking = (id: string): boolean => checking().has(id);

/** The first repo of the workspace whose branch is known, for the Welcome row. */
export function firstBranch(ws: WorkspaceSummary): { repo: string; branch: string } | undefined {
  const p = probes()[ws.id];
  if (!p) return undefined;
  for (const r of ws.repos) {
    const pr: RepoProbe | undefined = p.repos.find((x) => x.repoId === r.id);
    if (pr?.status === "ok" && pr.branch) return { repo: r.name, branch: pr.branch };
  }
  return undefined;
}

const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });

/** Probes lazily, four workspaces at a time. A failed batch just leaves its rows unprobed. */
export async function probeWorkspaces(ids: string[] = workspaces().map((w) => w.id), client: Ipc = defaultIpc): Promise<void> {
  const todo = ids.filter((id) => !checking().has(id));
  setChecking((s) => new Set([...s, ...todo]));
  for (let i = 0; i < todo.length; i += PROBE_BATCH) {
    const part = todo.slice(i, i + PROBE_BATCH);
    try {
      const got = await client.workspaces.probe(part);
      setProbes((all) => ({ ...all, ...Object.fromEntries(got.map((p) => [p.id, p])) }));
    } catch {
      /* the rows stay as they were */
    } finally {
      setChecking((s) => {
        const next = new Set(s);
        part.forEach((id) => next.delete(id));
        return next;
      });
    }
  }
}

export async function refreshRegistry(client: Ipc = defaultIpc): Promise<RegistryView | undefined> {
  try {
    const v = await client.workspaces.list();
    setRegistryView(v);
    return v;
  } catch {
    return registryView();
  }
}

// ----------------------------------------------------------------------------------------------------- hand-off record

export interface Handoff {
  from: string | null;
  to: string | null;
  toName: string | null;
  at: number;
  error?: { code: string; message: string };
  warnings?: SwitchWarning[];
  /** The launch-time detach of a workspace whose folders are all gone: nobody closed it, so the toast says what happened. */
  foldersMissing?: string;
}

function writeHandoff(h: Handoff): void {
  try {
    globalThis.sessionStorage?.setItem(HANDOFF_KEY, JSON.stringify(h));
  } catch {
    /* no session storage: the next page just shows no toast */
  }
}

/** Reads and clears the record the previous page left (once). */
export function consumeHandoff(): Handoff | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(HANDOFF_KEY);
    if (!raw) return null;
    globalThis.sessionStorage.removeItem(HANDOFF_KEY);
    const h = JSON.parse(raw) as Handoff;
    return typeof h === "object" && h ? h : null;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------------------------------- hooks

type Reload = () => void;
let reloadHook: Reload = () => globalThis.location?.reload();
/** Tests replace the reload; the app uses `location.reload()`. Returns the previous hook. */
export function setReloadHook(fn: Reload): Reload {
  const prev = reloadHook;
  reloadHook = fn;
  return prev;
}

/** Reloads the page (the "Try again" of the problem card re-reads the registry from a fresh boot). */
export const reloadPage = (): void => reloadHook();

const leaveHooks = new Set<() => void>();
/** Called synchronously right after the guard passed and before the engine switches (U6 saves the per-workspace UI state here). */
export function onLeaveWorkspace(fn: () => void): () => void {
  leaveHooks.add(fn);
  return () => void leaveHooks.delete(fn);
}

// -------------------------------------------------------------------------------------------------------------- guard

export interface GuardState {
  /** `null` = close the workspace. */
  targetId: string | null;
  targetName: string | null;
  closing: boolean;
  model: GuardModel;
  stage: "idle" | "saving" | "stopping";
  /** Set when "Save all" left something unsaved. */
  saveFailed: boolean;
}

const [guardState, setGuardState] = createSignal<GuardState | null>(null);
export const guard = guardState;
let pollTimer: ReturnType<typeof setInterval> | undefined;

function stopPolling(): void {
  if (pollTimer !== undefined) clearInterval(pollTimer);
  pollTimer = undefined;
}

function startPolling(client: Ipc): void {
  stopPolling();
  pollTimer = setInterval(() => {
    void client.workspaces
      .busy()
      .then((report) => {
        const g = guardState();
        if (g) setGuardState({ ...g, model: mergeBusy(report, unsavedTitles()) });
      })
      .catch(() => undefined);
  }, GUARD_POLL_MS);
}

function openGuard(client: Ipc, targetId: string | null, model: GuardModel): void {
  const name = targetId === null ? null : (workspaces().find((w) => w.id === targetId)?.name ?? null);
  setGuardState({ targetId, targetName: name, closing: targetId === null, model, stage: "idle", saveFailed: false });
  startPolling(client);
}

export function closeGuard(): void {
  stopPolling();
  setGuardState(null);
}

export type SwitchOutcome = "switched" | "guard" | "failed" | "cancelled";

const targetNameOf = (id: string | null): string | null => (id === null ? null : (workspaces().find((w) => w.id === id)?.name ?? null));

let inFlight = false;

async function runSwitch(client: Ipc, target: string | null, force: boolean, keepActive = false): Promise<SwitchOutcome> {
  inFlight = true;
  leaveHooks.forEach((fn) => {
    try {
      fn();
    } catch {
      /* saving the UI state must never block a switch */
    }
  });
  const from = activeId();
  const toName = targetNameOf(target);
  batch(() => {
    setSwitchingTo({ id: target, name: toName });
    enterSwitching();
  });
  try {
    const result = await client.workspaces.switch(target, { force, keepActive: keepActive || undefined });
    setSurvivorList(result.survivors);
    const missingName = keepActive ? (workspaces().find((w) => w.id === from)?.name ?? "") : undefined;
    writeHandoff({ from, to: result.activeId, toName, at: Date.now(), warnings: result.warnings, foldersMissing: missingName });
    if (result.survivors.length) writeSurvivors(result.survivors);
    closeGuard();
    reloadHook();
    return "switched";
  } catch (e) {
    const stillHere = BEFORE_TEARDOWN.has(toEngineError(e).code);
    if (stillHere) inFlight = false;
    const err = toEngineError(e);
    if (BEFORE_TEARDOWN.has(err.code)) {
      batch(() => {
        setSwitchingTo(null);
        leaveSwitching();
      });
      if (err.code === "workspaceBusy") {
        const report = parseBusyDetail(err.detail);
        openGuard(client, target, mergeBusy(report ?? (await safeBusy(client)), unsavedTitles()));
      } else {
        closeGuard();
        toast.error(t("switch.failed", { reason: workspaceErrorText(err) }));
      }
      return "failed";
    }
    // Something may already be stopped: the only safe state is a fresh page against whatever the engine is now.
    writeHandoff({ from, to: null, toName, at: Date.now(), error: { code: err.code, message: err.message } });
    closeGuard();
    reloadHook();
    return "failed";
  }
}

async function safeBusy(client: Ipc) {
  try {
    return await client.workspaces.busy();
  } catch {
    return { blocking: [], confirmable: [] };
  }
}

/**
 * Switch to another workspace (or close the open one with `null`). Reads what is busy first; when nothing is, the switch
 * starts at once. Otherwise the guard dialog opens (`guard()`), and its actions below continue or cancel.
 */
export async function requestSwitch(targetId: string | null, client: Ipc = defaultIpc): Promise<SwitchOutcome> {
  if (guardState() || inFlight) return "cancelled";
  if (targetId !== null && targetId === activeId() && !openError() && !crashLoop()) return "cancelled";
  let model: GuardModel;
  try {
    model = mergeBusy(await client.workspaces.busy(), unsavedTitles());
  } catch (e) {
    toast.error(t("switch.failed", { reason: workspaceErrorText(e) }));
    return "failed";
  }
  if (isClear(model)) return runSwitch(client, targetId, false);
  openGuard(client, targetId, model);
  return "guard";
}

async function guarded(client: Ipc, stage: "saving" | "stopping", work: (g: GuardState) => Promise<SwitchOutcome | null>): Promise<SwitchOutcome> {
  const g = guardState();
  if (!g || g.stage !== "idle") return "cancelled";
  setGuardState({ ...g, stage, saveFailed: false });
  const outcome = await work(g);
  if (outcome) return outcome;
  const now = guardState();
  if (now) setGuardState({ ...now, stage: "idle" });
  return "guard";
}

/** "Save all and switch": saves every buffer first, stays in the dialog when something could not be saved. */
export function guardSaveAndSwitch(client: Ipc = defaultIpc): Promise<SwitchOutcome> {
  return guarded(client, "saving", async (g) => {
    if (!(await saveAllUnsaved())) {
      const now = guardState();
      if (now) setGuardState({ ...now, saveFailed: true, model: mergeBusy({ blocking: now.model.blocking, confirmable: now.model.confirmable }, unsavedTitles()) });
      return null;
    }
    return runSwitch(client, g.targetId, true);
  });
}

/** "Don't save and switch" / "Stop them and switch": `force` stops the confirmable items. */
export function guardForceSwitch(client: Ipc = defaultIpc): Promise<SwitchOutcome> {
  return guarded(client, "stopping", async (g) => (hasBlocking(g.model) ? null : runSwitch(client, g.targetId, true)));
}

export function guardCancel(): void {
  closeGuard();
}

/** The blocking git operation is cancelled through its own command (commit_cancel / push_cancel); the dialog then re-reads. */
export async function guardRecheck(client: Ipc = defaultIpc): Promise<void> {
  const g = guardState();
  if (!g) return;
  setGuardState({ ...g, model: mergeBusy(await safeBusy(client), unsavedTitles()) });
}

// -------------------------------------------------------------------------------------------------------- survivors

const SURVIVORS_KEY = "intely.ws.survivors";

function writeSurvivors(list: Survivor[]): void {
  writeStored(SURVIVORS_KEY, JSON.stringify(list), globalThis.sessionStorage ?? null);
}

function restoreSurvivors(): void {
  try {
    const raw = readStored(SURVIVORS_KEY, globalThis.sessionStorage ?? null);
    if (raw) setSurvivorList(JSON.parse(raw) as Survivor[]);
  } catch {
    /* ignore */
  }
}

export async function killSurvivor(pid: number, client: Ipc = defaultIpc): Promise<void> {
  try {
    await client.workspaces.killSurvivor(pid);
  } catch (e) {
    toast.error(workspaceErrorText(e));
    return;
  }
  setSurvivorList((l) => l.filter((s) => s.pid !== pid));
  writeSurvivors(survivorList());
}

// ------------------------------------------------------------------------------------------------------ registry edits

/** A registry edit followed by a re-read, so the lists on screen agree with the registry before the event arrives. */
async function edit<T>(client: Ipc, work: () => Promise<T>): Promise<T> {
  const r = await work();
  await refreshRegistry(client);
  return r;
}

export const renameWorkspace = (id: string, name: string, client: Ipc = defaultIpc) => edit(client, () => client.workspaces.rename(id, name));
export const recolorWorkspace = (id: string, color: string, client: Ipc = defaultIpc) => edit(client, () => client.workspaces.recolor(id, color));
export const duplicateWorkspace = (id: string, name?: string, client: Ipc = defaultIpc) => edit(client, () => client.workspaces.duplicate(id, name));
export const reorderWorkspaces = (ids: string[], client: Ipc = defaultIpc) => edit(client, () => client.workspaces.reorder(ids));
export const restoreRegistryBackup = (name: string, client: Ipc = defaultIpc) => edit(client, async () => void (await client.workspaces.restoreBackup(name)));
export const startFreshRegistry = (client: Ipc = defaultIpc) => edit(client, async () => void (await client.workspaces.startFresh()));

/**
 * Removes an entry from the list (never a file on disk). The open workspace is closed first through the same guard as any
 * switch; when that did not end in a reload (the guard is up, or it failed) the removal does not run.
 */
export async function removeWorkspace(id: string, client: Ipc = defaultIpc): Promise<"removed" | SwitchOutcome> {
  if (activeId() === id && openError()?.id === id) {
    // Detached but still the registry's active entry (every folder was missing at launch): release it, no page reload needed.
    await client.workspaces.switch(null, { force: true });
    await edit(client, () => client.workspaces.remove(id, true));
    return "removed";
  }
  if (activeId() === id) {
    // Two steps: close (guard, switch, reload), then the next page removes the entry (see `afterBoot`).
    writeStored(PENDING_REMOVE_KEY, id, globalThis.sessionStorage ?? null);
    const outcome = await requestSwitch(null, client);
    if (outcome !== "switched") removeStored(PENDING_REMOVE_KEY, globalThis.sessionStorage ?? null);
    return outcome;
  }
  await edit(client, () => client.workspaces.remove(id, true));
  return "removed";
}

/**
 * Creates a workspace from picked folders and opens it. An existing workspace with the same folders is reused (3.3).
 * From Welcome nothing runs, so the guard passes silently.
 */
export async function createWorkspaceAndOpen(req: CreateRequest, client: Ipc = defaultIpc): Promise<SwitchOutcome> {
  const { entry, reused } = await client.workspaces.create(req);
  await refreshRegistry(client);
  if (reused) toast.info(t("ws.toast.reused", { name: entry.name }));
  else toast.success(t("ws.toast.created", { name: entry.name }));
  return requestSwitch(entry.id, client);
}

/** Opens a workspace whose folders were flagged: the crash-loop "Open anyway" and the retry of a vanished entry. */
export async function forceOpen(id: string, client: Ipc = defaultIpc): Promise<SwitchOutcome> {
  return runSwitch(client, id, false);
}

// ------------------------------------------------------------------------------------------------------------- boot

async function afterBoot(view: RegistryView, handoff: Handoff | null, client: Ipc): Promise<void> {
  if (view.epoch !== undefined && !view.problem) void client.workspaces.ready(view.epoch).catch(() => undefined);
  restoreSurvivors();
  if (view.justMigrated) toast.info(t("ws.migrated"));
  await finishPendingRemove(view, client);
  if (!handoff) return;
  if (handoff.error) {
    toast.error(t("switch.failed", { reason: workspaceErrorText(handoff.error) }));
    return;
  }
  const name = handoff.toName;
  if (handoff.foldersMissing !== undefined) {
    toast.warn(t("ws.toast.foldersMissing", { name: handoff.foldersMissing }));
  } else if (name) {
    toast.success(t("ws.toast.switched", { name }));
    announce(t("switch.announced", { name }));
  } else {
    setClosedByUser(true);
    toast.info(t("ws.toast.closed"));
  }
  for (const w of handoff.warnings ?? []) {
    const text = switchWarningText(w.code);
    if (text) toast.warn(text);
  }
  focusMainHeading();
}

/** The second step of removing the open workspace: the page after the close removes the entry. A failure leaves it listed. */
async function finishPendingRemove(view: RegistryView, client: Ipc): Promise<void> {
  const id = readStored(PENDING_REMOVE_KEY, globalThis.sessionStorage ?? null);
  if (!id) return;
  removeStored(PENDING_REMOVE_KEY, globalThis.sessionStorage ?? null);
  const entry = view.workspaces.find((w) => w.id === id);
  if (!entry || view.activeId === id) return;
  try {
    await edit(client, () => client.workspaces.remove(id, true));
    toast.success(t("ws.toast.removed", { name: entry.name }));
  } catch (e) {
    toast.error(workspaceErrorText(e));
  }
}

/** After a reload the focus lands on the main heading of the new page (8.2). */
export function focusMainHeading(): void {
  queueMicrotask(() =>
    setTimeout(() => {
      const el = globalThis.document?.querySelector<HTMLElement>("[data-workspace-heading]");
      if (el) {
        if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
        el.focus({ preventScroll: true });
      }
    }, 0),
  );
}

const bootProbe = async (view: RegistryView, client: Ipc): Promise<WorkspaceProbe | undefined> => {
  if (view.pinned) return undefined;
  const active = view.workspaces.find((w) => w.id === view.activeId);
  if (!active || active.repos.length === 0) return undefined;
  try {
    return (await withTimeout(client.workspaces.probe([active.id]), PROBE_TOTAL_MS))[0];
  } catch {
    return undefined;
  }
};

/**
 * App start: reads the registry, decides between Welcome and the open workspace (3.1) and loads it. The engine subscriptions
 * come first so a snapshot that arrives during the load is not lost. Returns the disposer.
 */
export function startWorkspaces(client: Ipc = defaultIpc): () => void {
  const off = [client.workspaces.onListChanged(() => void refreshRegistry(client))];
  let stopEngine: (() => void) | undefined;
  let disposed = false;
  void (async () => {
    let view: RegistryView;
    try {
      view = await client.workspaces.list();
    } catch (e) {
      // Without a registry there is nothing to decide: fall back to the single legacy flow so the app still opens.
      stopEngine = subscribeWorkspace(client);
      await loadWorkspace(client);
      console.error("workspaces_list failed", e);
      return;
    }
    if (disposed) return;
    setRegistryView(view);
    setPageEpoch(view.epoch);
    const handoff = consumeHandoff();
    if (view.problem || view.crashLoop || view.openError || view.activeId === null) {
      enterEmptyState();
      void afterBoot(view, handoff, client);
      return;
    }
    const probe = await bootProbe(view, client);
    if (probe) setProbes((all) => ({ ...all, [probe.id]: probe }));
    if (allMissing(probe)) {
      // Every folder of the open workspace is gone: detach the engine, keep the entry, and come back as Welcome.
      const done = await runSwitch(client, null, true, true);
      if (done !== "switched") enterEmptyState();
      return;
    }
    stopEngine = subscribeWorkspace(client);
    await loadWorkspace(client);
    void afterBoot(view, handoff, client);
  })();
  return () => {
    disposed = true;
    stopEngine?.();
    off.forEach((o) => o());
    stopPolling();
  };
}

/** Test helper: back to the state of a page that has just loaded. */
export function resetWorkspacesForTest(): void {
  stopPolling();
  batch(() => {
    setRegistryView(undefined);
    setProbes({});
    setChecking(new Set<string>());
    setSurvivorList([]);
    setSwitchingTo(null);
    setGuardState(null);
    setClosedByUser(false);
  });
  inFlight = false;
  leaveHooks.clear();
  removeStored(HANDOFF_KEY, globalThis.sessionStorage ?? null);
  removeStored(PENDING_REMOVE_KEY, globalThis.sessionStorage ?? null);
  removeStored(SURVIVORS_KEY, globalThis.sessionStorage ?? null);
  setPageEpoch(undefined);
}

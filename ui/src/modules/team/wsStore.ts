import { createSignal } from "solid-js";
import { ipc } from "../../ipc";
import type { TeamSnapshot } from "../../ipc/team";
import { messageOf } from "./store";

// A teammate's workspace (T4): the last snapshot per member and project, read-only, in memory. A snapshot is asked for, never pushed.
const [snapshots, setSnapshots] = createSignal<Record<string, TeamSnapshot>>({});
const [waiting, setWaiting] = createSignal<Record<string, boolean>>({});
const [problems, setProblems] = createSignal<Record<string, string>>({});

export { snapshots, waiting, problems };

/** No answer after this long: stop waiting and say so. */
export const WAIT_MS = 20_000;
/** The owner's machine answers a requester once per 30 s and project; asking sooner only earns a `rate` refusal. */
export const ASK_GAP_MS = 30_000;
export const wsKey = (memberId: string, projectKey: string) => `${memberId}:${projectKey}`;

let watching: (() => void) | undefined;
const askedAt = new Map<string, number>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

const put = <T>(set: (f: (o: Record<string, T>) => Record<string, T>) => void, key: string, value: T | undefined) =>
  set((o) => {
    const next = { ...o };
    if (value === undefined) delete next[key];
    else next[key] = value;
    return next;
  });

function done(key: string): void {
  clearTimeout(timers.get(key));
  timers.delete(key);
  put(setWaiting, key, undefined);
}

function watch(): void {
  if (watching) return;
  const offSnap = ipc.team.onWorkspace((e) => {
    const key = wsKey(e.memberId, e.snapshot.projectKey);
    done(key);
    put(setProblems, key, undefined);
    put(setSnapshots, key, e.snapshot);
  });
  const offDenied = ipc.team.onWorkspaceDenied((e) => {
    const key = wsKey(e.memberId, e.projectKey);
    done(key);
    put(setProblems, key, e.reason);
  });
  watching = () => (offSnap(), offDenied());
}

/** What this install already received for the project (the backend keeps it in memory). */
export async function loadWorkspace(memberId: string, projectKey: string): Promise<boolean> {
  watch();
  const key = wsKey(memberId, projectKey);
  if (snapshots()[key]) return true;
  try {
    const s = await ipc.team.workspace(memberId, projectKey);
    if (s) put(setSnapshots, key, s);
    return !!s;
  } catch {
    return false;
  }
}

/** Asks the member for a fresh snapshot. The answer comes as an event; the owner's machine decides whether the project is open to it. */
export async function requestWorkspace(memberId: string, projectKey: string): Promise<void> {
  watch();
  const key = wsKey(memberId, projectKey);
  askedAt.set(key, Date.now());
  put(setProblems, key, undefined);
  put(setWaiting, key, true);
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => (done(key), put(setProblems, key, "noAnswer")), WAIT_MS));
  try {
    await ipc.team.workspaceRequest(memberId, projectKey);
  } catch (e) {
    done(key);
    put(setProblems, key, messageOf(e));
  }
}

/** Like `requestWorkspace`, but not when this install asked less than 30 s ago. Resolves true when a request went out. */
export async function requestWorkspaceThrottled(memberId: string, projectKey: string): Promise<boolean> {
  const key = wsKey(memberId, projectKey);
  if (Date.now() - (askedAt.get(key) ?? 0) < ASK_GAP_MS) return false;
  await requestWorkspace(memberId, projectKey);
  return true;
}

/** Tests: forget everything and the watchers. */
export function resetWorkspace(): void {
  watching?.();
  watching = undefined;
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  askedAt.clear();
  setSnapshots({});
  setWaiting({});
  setProblems({});
}

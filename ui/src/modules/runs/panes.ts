import { createEffect, createMemo, createRoot, createSignal, on } from "solid-js";
import { agentIds, agentsError, agentsLoaded, selectAgent, selectedAgentId } from "../../store/agents";
import { readScoped, writeScoped } from "../../store/scopedStorage";
import { activeId } from "../../store/workspaces";
import * as L from "./paneLogic";

/*
 * The run panes of the Agent workspace, per workspace in the webview's storage (like the closed and reviewed runs). The focused pane's run is
 * the selected run of the store, so everything that follows the selection (Inspector, Stop, the next-request command) acts on the focused pane.
 */

export const PANES_KEY = "intely.runs.panes.v1";

function load(): L.PaneState {
  try {
    return L.parsePaneState(JSON.parse(readScoped(PANES_KEY) ?? "null"));
  } catch {
    return L.initialPaneState();
  }
}

const [state, setState] = createSignal<L.PaneState>(load());
const [windowWidth, setWindowWidth] = createSignal(globalThis.innerWidth || 0);
const [centreWidth, setCentreWidth] = createSignal(0);

export const paneState = state;
export const paneLayout = (): L.PaneLayout => state().layout;
export { setCentreWidth, setWindowWidth };

/** The layout that is shown now: the saved one, or fewer panes when the window or the middle is too narrow. */
export const shownLayout = createRoot(() => createMemo(() => L.effectiveLayout(state().layout, windowWidth(), centreWidth())));
export const shownCount = (): number => L.paneCount(shownLayout());
export const isNarrowFallback = (): boolean => shownLayout() !== state().layout;

function save(next: L.PaneState): void {
  writeScoped(PANES_KEY, JSON.stringify({ layout: next.layout, slots: next.slots, focus: next.focus, ratios: next.ratios }));
}
function commit(next: L.PaneState, persist = true): void {
  if (next === state()) return;
  setState(next);
  if (persist) save(next);
}

/** Tells the rest of the app which run the focused pane shows (an empty pane selects nothing). */
function follow(next: L.PaneState): void {
  const id = next.slots[next.focus] ?? null;
  if (id !== selectedAgentId()) void selectAgent(id);
}

export function chooseLayout(layout: L.PaneLayout): void {
  const prev = state();
  const next = L.setLayout(prev, layout);
  commit(next);
  // The focus only moves when the new layout is too small for it; the shown run is then another one.
  if (next.focus !== prev.focus) follow(next);
}

/** Focus a pane (click, keyboard focus inside it). */
export function focusPaneAt(index: number): void {
  const next = L.focusPane(state(), index, shownCount());
  if (next === state()) return;
  commit(next);
  follow(next);
}

/** The selected run (list click, notification, command) goes to a pane. A pane that shows it is focused; otherwise the focused pane takes it. */
export function showRunInPane(id: string): void {
  commit(L.openRun(state(), id, shownCount()));
}

export function dropRunOnPane(index: number, id: string): void {
  const next = L.dropRun(state(), index, id, shownCount());
  commit(next);
  follow(next);
}
export function swapPaneRuns(a: number, b: number): void {
  const next = L.swapPanes(state(), a, b, shownCount());
  commit(next);
  follow(next);
}
export function movePaneRun(index: number, dir: L.Direction): void {
  const next = L.movePane(state(), shownLayout(), index, dir);
  commit(next);
  follow(next);
}
export function emptyPane(index: number): void {
  const next = L.closePane(state(), index);
  commit(next);
  if (index === next.focus) follow(next);
}

/** Dividers: `persist` is false while the pointer is still dragging. */
export function setTrackRatios(key: L.RatioKey, ratios: number[], persist: boolean): void {
  commit(L.setRatios(state(), key, ratios), persist);
}
export function resetTrackRatios(key: L.RatioKey): void {
  commit(L.resetRatios(state(), key));
}
export function persistPanes(): void {
  save(state());
}

let restored = false;

createRoot(() => {
  // The selected run lands in a pane; nothing selected (a starting run, the empty state) leaves the panes alone.
  createEffect(on(selectedAgentId, (id) => id && showRunInPane(id)));
  // Another workspace has its own panes; the registry answers after this module loaded.
  createEffect(on(activeId, (id) => id && setState(load()), { defer: true }));
  // A run the host no longer knows leaves its pane. A failed list load is not "no runs".
  createEffect(() => {
    if (!agentsLoaded() || agentsError()) return;
    const known = agentIds();
    const next = L.dropMissing(state(), (id) => known.has(id));
    if (next !== state()) commit(next);
    // After a start the focused pane's run is the selected one, before the store picks its own default. The single pane keeps the old behaviour.
    if (!restored) {
      restored = true;
      const id = next.layout === "1" ? null : next.slots[next.focus];
      if (id && selectedAgentId() === null) void selectAgent(id);
    }
  });
});

/** Test helper: back to the default state, without writing it. */
export function resetPanes(): void {
  setState(L.initialPaneState());
  setWindowWidth(globalThis.innerWidth || 0);
  setCentreWidth(0);
  restored = false;
}
/** Test helper: read the saved state again (what a restart does). */
export function reloadPanes(): void {
  setState(load());
}

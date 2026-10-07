// Module state of the night queue and the brief view (the centre area remounts a tab on every activation).
import { batch, createSignal } from "solid-js";
import { nightApi } from "./api";
import type { Brief, NewItem, NightView } from "./types";

export type View = "queue" | "brief";

const [view, setView] = createSignal<View>("queue");
const [night, setNight] = createSignal<NightView | undefined>(undefined);
const [brief, setBrief] = createSignal<Brief | undefined>(undefined);
const [briefBusy, setBriefBusy] = createSignal(false);
const [briefError, setBriefError] = createSignal<string | undefined>(undefined);
const [summary, setSummary] = createSignal<string | undefined>(undefined);
const [summaryBusy, setSummaryBusy] = createSignal(false);
const [loadError, setLoadError] = createSignal<string | undefined>(undefined);

export { brief, briefBusy, briefError, loadError, night, setView, summary, summaryBusy, view };

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String((e as { message?: string }).message ?? e));
export const errorCode = (e: unknown): string | undefined => (typeof e === "object" && e !== null ? (e as { code?: string }).code : undefined);

let unsubscribe: (() => void) | undefined;

/** Loads the plan and follows the backend's pushes. Idempotent. */
export async function startNight(): Promise<void> {
  unsubscribe ??= nightApi().onState((v) => setNight(v));
  try {
    setNight(await nightApi().state());
    setLoadError(undefined);
  } catch (e) {
    setLoadError(errorText(e));
  }
}

export function stopNight(): void {
  unsubscribe?.();
  unsubscribe = undefined;
}

/** Runs one queue command; a refusal comes back as `{ code, message }` for the caller to show. */
export async function act(fn: () => Promise<NightView>): Promise<{ code: string; message: string } | undefined> {
  try {
    setNight(await fn());
    return undefined;
  } catch (e) {
    return { code: errorCode(e) ?? "error", message: errorText(e) };
  }
}

export const addItem = (item: NewItem) => act(() => nightApi().add(item));
export const removeItem = (id: string) => act(() => nightApi().remove(id));
export const moveItem = (id: string, delta: -1 | 1) => act(() => nightApi().move(id, delta));
export const arm = (armed: boolean, cancelRest = false) => act(() => nightApi().arm(armed, cancelRest));
export const stopCurrent = () => act(() => nightApi().stop());
export const clearFinished = () => act(() => nightApi().clear());

export async function loadBrief(): Promise<void> {
  setBriefBusy(true);
  try {
    const b = await nightApi().brief();
    batch(() => {
      setBrief(b);
      setBriefError(undefined);
    });
  } catch (e) {
    setBriefError(errorText(e));
  } finally {
    setBriefBusy(false);
  }
}

/** The one model call: only ever from the button. */
export async function summarise(): Promise<string | undefined> {
  setSummaryBusy(true);
  try {
    const text = await nightApi().summarise(brief()?.runs.map((r) => r.runId));
    setSummary(text);
    return undefined;
  } catch (e) {
    return errorText(e);
  } finally {
    setSummaryBusy(false);
  }
}

export function resetNight(): void {
  stopNight();
  batch(() => {
    setView("queue");
    setNight(undefined);
    setBrief(undefined);
    setBriefError(undefined);
    setSummary(undefined);
    setLoadError(undefined);
  });
}

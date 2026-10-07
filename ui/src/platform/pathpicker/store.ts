import { createSignal } from "solid-js";
import type { Picked } from "../../ipc/picker";
import type { PickOptions } from "./types";

interface Request {
  opts: PickOptions;
  resolve(result: Picked[] | null): void;
}

const [request, setRequest] = createSignal<Request | null>(null);

/** The open request, or `null`. The overlay host renders the dialog for it. */
export const pickerRequest = request;

/** Tokens whose repository config card the user acknowledged ("I trust this repository"). */
const trustedTokens = new Set<string>();

/** Whether the user ticked the trust box for this result; callers pass it as `trust` to `workspaces_create` and friends. */
export const wasTrusted = (p: Picked): boolean => trustedTokens.has(p.token);

export function markTrusted(p: Picked): void {
  trustedTokens.add(p.token);
  if (trustedTokens.size > 256) trustedTokens.delete(trustedTokens.values().next().value as string);
}

/**
 * Opens the folder picker. Resolves with the validated results (each with a single-use token) or `null` when the user
 * cancelled. A second call while one is open rejects with `busy`.
 */
export function openPathPicker(opts: PickOptions): Promise<Picked[] | null> {
  if (request()) return Promise.reject({ code: "busy", message: "A folder dialog is already open." });
  return new Promise((resolve) => setRequest({ opts, resolve }));
}

export function settle(result: Picked[] | null): void {
  const r = request();
  setRequest(null);
  r?.resolve(result);
}

/** Test hook: drops an open request as a cancel. */
export function resetPathPicker(): void {
  settle(null);
  trustedTokens.clear();
}

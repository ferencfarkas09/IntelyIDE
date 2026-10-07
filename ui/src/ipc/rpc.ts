import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { EngineError } from "../bindings";
import type { Unsubscribe } from "./index";

function isEngineError(e: unknown): e is EngineError {
  return typeof e === "object" && e !== null && typeof (e as EngineError).code === "string";
}

/** Normalises whatever `invoke` rejects with (a serialised `EngineError`, or a plain string from Tauri itself). */
export function toEngineError(e: unknown): EngineError {
  if (isEngineError(e)) return e;
  return { code: "io", message: e instanceof Error ? e.message : String(e) };
}

/**
 * Commands that carry the engine epoch the page booted with ((design notes: workspaces-spec) 4.9): a late call from the page of a
 * retired workspace answers `staleEpoch` instead of running against the new one. Every other command is left untouched.
 */
export const EPOCH_COMMANDS: ReadonlySet<string> = new Set([
  "commit_start",
  "push_start",
  "pull",
  "fetch",
  "set_push_target",
  "workspace_save",
  "workspaces_add_repos",
  "workspaces_relocate_repo",
]);

let pageEpoch: number | undefined;

/** Set once per page by the workspace store, from the registry view the page booted against. */
export function setPageEpoch(epoch: number | undefined): void {
  pageEpoch = epoch;
}

export const getPageEpoch = (): number | undefined => pageEpoch;

/** The arguments a command is invoked with: the page epoch is added for the commands of `EPOCH_COMMANDS` only. */
export function withEpoch(command: string, args?: Record<string, unknown>): Record<string, unknown> | undefined {
  return pageEpoch !== undefined && EPOCH_COMMANDS.has(command) ? { ...args, epoch: pageEpoch } : args;
}

export async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, withEpoch(command, args));
  } catch (e) {
    throw toEngineError(e);
  }
}

export function subscribe<T>(event: string, cb: (payload: T) => void): Unsubscribe {
  const pending = listen<T>(event, (e) => cb(e.payload));
  return () => void pending.then((off) => off());
}

/** What an Ipc method that has no backend yet rejects with; the owning track replaces the stub with `call(...)`. */
export function notImplemented(method: string): Promise<never> {
  return Promise.reject<never>({ code: "unimplemented", message: `${method} is not implemented yet` } satisfies EngineError);
}

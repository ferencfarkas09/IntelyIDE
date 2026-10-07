import { readStored, writeStored } from "../ui-kit/storage";
import { activeId } from "./workspaces";

/*
 * Per-workspace browser storage keys ((design notes: workspaces-spec) 4.13): `<base>:<workspaceId>`. Before the registry has answered, and
 * for the value that existed before workspaces, the migrated workspace's id is used, so nothing is lost on the first start.
 */
export const LEGACY_WORKSPACE = "w-migrated";

export const scopeId = (): string => activeId() ?? LEGACY_WORKSPACE;
export const scopedKey = (base: string, id: string = scopeId()): string => `${base}:${id}`;

/** The workspace's own value; the old unscoped value belongs to the migrated workspace (read, never rewritten). */
export function readScoped(base: string, id: string = scopeId()): string | null {
  return readStored(scopedKey(base, id)) ?? (id === LEGACY_WORKSPACE ? readStored(base) : null);
}

export function writeScoped(base: string, value: string, id: string = scopeId()): void {
  writeStored(scopedKey(base, id), value);
}

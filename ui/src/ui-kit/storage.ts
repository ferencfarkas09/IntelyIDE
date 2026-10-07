/** localStorage access that never throws (private windows, blocked storage, previews). */
export type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function defaultStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readStored(key: string, storage: KeyValueStorage | null = defaultStorage()): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string, storage: KeyValueStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(key, value);
  } catch {
    /* quota or blocked storage: the preference simply is not persisted */
  }
}

export function removeStored(key: string, storage: KeyValueStorage | null = defaultStorage()): void {
  try {
    storage?.removeItem(key);
  } catch {
    /* ignore */
  }
}

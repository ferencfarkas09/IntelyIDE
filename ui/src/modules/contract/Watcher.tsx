// Background watcher (an overlay, mounted only while the extra is on): checks once at start and again a moment after a
// repo's change list moved, so the Changes tree badges follow the working tree. Unchanged repos come from the cache.
import { createEffect, on, onCleanup, onMount } from "solid-js";
import { snapshots } from "../../store/snapshots";
import { refresh } from "./store";

const DEBOUNCE_MS = 3000;
const FIRST_MS = 2500;

export default function ContractWatcher() {
  const seen = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const later = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), ms);
  };
  onMount(() => later(FIRST_MS));
  createEffect(
    on(snapshots, (all) => {
      let moved = false;
      for (const [repoId, snap] of Object.entries(all)) {
        if (!snap || seen.get(repoId) === snap.revision) continue;
        if (seen.has(repoId)) moved = true;
        seen.set(repoId, snap.revision);
      }
      if (moved) later(DEBOUNCE_MS);
    }),
  );
  onCleanup(() => clearTimeout(timer));
  return null;
}

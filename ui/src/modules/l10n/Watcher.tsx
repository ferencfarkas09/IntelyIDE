// Background watcher (an overlay, mounted only while the extra is on): re-runs the checker a moment after a repo's
// change list moved, so the Changes tree badges follow the working tree. One repo at a time, never while a run is open.
import { createEffect, on, onCleanup } from "solid-js";
import { snapshots } from "../../store/snapshots";
import { refresh } from "./store";

const DEBOUNCE_MS = 1500;

export default function L10nWatcher() {
  const seen = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  createEffect(
    on(snapshots, (all) => {
      for (const [repoId, snap] of Object.entries(all)) {
        if (!snap || seen.get(repoId) === snap.revision) continue;
        seen.set(repoId, snap.revision);
        clearTimeout(timers.get(repoId));
        timers.set(
          repoId,
          setTimeout(() => void refresh(repoId), DEBOUNCE_MS),
        );
      }
    }),
  );
  onCleanup(() => timers.forEach((t) => clearTimeout(t)));
  return null;
}

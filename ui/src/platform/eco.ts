import { createSignal } from "solid-js";

// Eco mode (wave3 X3, ideas #27): after the window has been unfocused for a while the app stops its background work.
// The Rust side owns the clock (`intely_hud::Eco`) and tells the UI through `hud:eco`; the HUD module mirrors it here. A module
// that polls uses `ecoInterval` instead of `setInterval`, or reads `ecoActive()`; it needs no other knowledge of the HUD.

const [active, setActive] = createSignal(false);
const listeners = new Set<(active: boolean) => void>();

/** True while Eco mode has paused background work. Reactive. */
export const ecoActive = active;

export function setEcoActive(next: boolean): void {
  if (next === active()) return;
  setActive(next);
  listeners.forEach((l) => l(next));
}

/** Calls `cb` when Eco starts (true) or ends (false). Returns the disposer. */
export function onEco(cb: (active: boolean) => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/**
 * `setInterval` that does not tick while Eco is active. When Eco ends it runs once right away (catching up) and carries on.
 * Returns the stop function.
 */
export function ecoInterval(fn: () => void, ms: number): () => void {
  let id: ReturnType<typeof setInterval> | undefined;
  const start = () => {
    if (id === undefined) id = setInterval(fn, ms);
  };
  const stop = () => {
    if (id !== undefined) (clearInterval(id), (id = undefined));
  };
  const off = onEco((a) => {
    if (a) stop();
    else (fn(), start());
  });
  if (!active()) start();
  return () => (stop(), off());
}

export const resetEco = () => {
  listeners.clear();
  setActive(false);
};

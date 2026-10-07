import { createEffect, createSignal, onCleanup } from "solid-js";
import { toast } from "../../ui-kit";

/** Runs a Happy call; a failure becomes a toast (user-initiated actions only, plan 1.7) and resolves to `undefined`. */
export async function attempt<T>(op: () => Promise<T>, title: string): Promise<T | undefined> {
  try {
    return await op();
  } catch (e) {
    const message = typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e);
    toast.show({ title, description: message, tone: "danger" });
    return undefined;
  }
}

/** A clock signal that ticks once a second, and only while `active()` is true. */
export function createTicker(active: () => boolean): () => number {
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (!active()) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(id));
  });
  return now;
}

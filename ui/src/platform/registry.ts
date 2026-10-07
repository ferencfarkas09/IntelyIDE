import { createSignal } from "solid-js";

export type Disposer = () => void;

export interface Registry<T extends { id: string }> {
  /** Adds the item, or replaces the one with the same id (a module upgrading its placeholder). Returns an unregister function. */
  register(item: T): Disposer;
  /** Reactive: components re-render when a module registers late. Sorted by `order`, then registration order. */
  items(): readonly T[];
  get(id: string): T | undefined;
  /** Test helper: drops every item. */
  clear(): void;
}

const tracked: { name: string; replaced: string[] }[] = [];

/** Ids that two registrations claimed in the same registry (`rail:search`), minus placeholders being upgraded. Empty when the modules do not collide. */
export const registryClashes = (): string[] => tracked.flatMap((t) => t.replaced.map((id) => `${t.name}:${id}`));

/** Shared by every platform registry: a reactive, id-keyed list ordered by `order`. `placeholder` marks an item a later registration may replace without being a clash. */
export function createRegistry<T extends { id: string }>(orderOf: (item: T) => number = () => 0, name = "registry", placeholder: (item: T) => boolean = () => false): Registry<T> {
  const [list, setList] = createSignal<readonly T[]>([]);
  const track = { name, replaced: [] as string[] };
  tracked.push(track);
  const sorted = (items: T[]) => items.map((item, i) => ({ item, i })).sort((a, b) => orderOf(a.item) - orderOf(b.item) || a.i - b.i).map((e) => e.item);
  return {
    register(item) {
      setList((prev) => {
        const next = prev.slice();
        const at = next.findIndex((x) => x.id === item.id);
        if (at >= 0) {
          if (!placeholder(next[at])) track.replaced.push(item.id);
          next[at] = item;
        }
        else next.push(item);
        return sorted(next);
      });
      return () => setList((prev) => prev.filter((x) => x !== item));
    },
    items: list,
    get: (id) => list().find((x) => x.id === id),
    clear: () => (track.replaced.length = 0, setList([])),
  };
}

import { For } from "solid-js";
import type { RefDecoration } from "../../ipc/graph";

const RANK: Record<RefDecoration["kind"], number> = { head: 0, branch: 0, remote: 1, tag: 2 };

/** Current branch first, then local branches, remotes, tags. */
export const orderedRefs = (decorations: readonly RefDecoration[]): RefDecoration[] =>
  decorations.slice().sort((a, b) => Number(b.current) - Number(a.current) || RANK[a.kind] - RANK[b.kind] || a.name.localeCompare(b.name));

/** Ref chips of a commit; at most `max` of them, the rest is in the tooltip of the last one. */
export function Refs(props: { decorations: readonly RefDecoration[]; max?: number }) {
  const shown = () => orderedRefs(props.decorations).slice(0, props.max ?? 3);
  return (
    <For each={shown()}>
      {(ref) => (
        <span class="glog__ref" data-kind={ref.kind} data-current={ref.current ? "" : undefined} title={ref.name}>
          {ref.name}
        </span>
      )}
    </For>
  );
}

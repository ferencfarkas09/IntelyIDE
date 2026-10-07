import { createSignal, For } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { Editor } from "./Editor";
import { DiffExample } from "./DiffExample";

const ROW_COUNT = 5000;
const ROW_HEIGHT = 24;

function FileList() {
  let scroller!: HTMLDivElement;
  const [checked, setChecked] = createSignal<Set<number>>(new Set());
  const virtualizer = createVirtualizer({
    count: ROW_COUNT,
    getScrollElement: () => scroller,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });
  const toggle = (i: number) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (!next.delete(i)) next.add(i);
      return next;
    });

  return (
    <div class="list" ref={scroller}>
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
        <For each={virtualizer.getVirtualItems()}>
          {(row) => (
          <label
            class="row"
            style={{ height: `${row.size}px`, transform: `translateY(${row.start}px)` }}
          >
            <input type="checkbox" checked={checked().has(row.index)} onChange={() => toggle(row.index)} />
            <span>src/module_{row.index}/file_{row.index}.ts</span>
          </label>
          )}
        </For>
      </div>
    </div>
  );
}

export function Rich() {
  return (
    <main class="rich">
      <aside class="left">
        <FileList />
      </aside>
      <section class="centre">
        <Editor />
      </section>
      <footer class="bottom">
        <DiffExample />
      </footer>
    </main>
  );
}

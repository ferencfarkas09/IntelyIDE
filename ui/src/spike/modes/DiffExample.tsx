import { onCleanup, onMount } from "solid-js";
import { unifiedMergeView } from "@codemirror/merge";
import { mount } from "./cm";

const ORIGINAL = `function total(items) {
  let sum = 0;
  for (const item of items) sum += item.price;
  return sum;
}
`;

const MODIFIED = `function total(items, taxRate = 0) {
  let sum = 0;
  for (const item of items) sum += item.price * item.qty;
  return sum * (1 + taxRate);
}
`;

export function DiffExample() {
  let host!: HTMLDivElement;
  onMount(() => {
    const view = mount(host, MODIFIED, [unifiedMergeView({ original: ORIGINAL })]);
    onCleanup(() => view.destroy());
  });
  return <div class="diff" ref={host} />;
}

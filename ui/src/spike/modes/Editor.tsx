import { onCleanup, onMount } from "solid-js";
import { mount } from "./cm";

const LINES = 5000;

function generateSource(lines: number): string {
  const out: string[] = [];
  for (let i = 0; out.length < lines; i++) {
    out.push(`export function handler${i}(input, options = {}) {`);
    out.push(`  const value = input?.items?.[${i % 7}] ?? "default-${i}";`);
    out.push(`  if (options.verbose) console.log("handler${i}", value);`);
    out.push(`  return { id: ${i}, value, ok: value !== undefined };`);
    out.push("}");
    out.push("");
  }
  return out.slice(0, lines).join("\n");
}

export function Editor() {
  let host!: HTMLDivElement;
  onMount(() => {
    const view = mount(host, generateSource(LINES));
    onCleanup(() => view.destroy());
  });
  return <div class="editor" ref={host} />;
}

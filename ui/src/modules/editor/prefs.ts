import { createSignal } from "solid-js";
import { readStored, writeStored } from "../../ui-kit/storage";

const WRAP_KEY = "intely.editor.wrap";
const [wrap, setWrap] = createSignal(readStored(WRAP_KEY) === "1");

/** Soft wrap, one preference for all editors. */
export { wrap };

export function toggleWrap(): void {
  setWrap(!wrap());
  writeStored(WRAP_KEY, wrap() ? "1" : "0");
}

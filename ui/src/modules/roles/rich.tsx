import type { JSX } from "solid-js";
import { t, type MessageKey } from "../../i18n";

/** A message with inline elements: each `{name}` placeholder becomes the given node, so word order stays the translator's. */
export function rich(key: MessageKey, parts: Record<string, () => JSX.Element>): JSX.Element[] {
  const names = Object.keys(parts);
  const text = t(key, Object.fromEntries(names.map((n, i) => [n, `\u0001${i}\u0001`])));
  return text.split("\u0001").map((seg, i) => (i % 2 ? parts[names[Number(seg)]]() : seg));
}

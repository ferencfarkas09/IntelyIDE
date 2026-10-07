import type { JSX } from "solid-js";
import { t, type MessageKey } from "../i18n";

const MARK = "\u0001";

/**
 * A translated sentence with JSX in it (a code span, a bold name): `tRich("key", { name: <strong>x</strong> })` where the
 * message holds `{name}`. The slots are filled after translation, so each language can put them where its grammar wants.
 */
export function tRich(key: MessageKey, slots: Record<string, JSX.Element>, params: Record<string, string | number> = {}): JSX.Element {
  const names = Object.keys(slots);
  const marked = t(key, { ...params, ...Object.fromEntries(names.map((n) => [n, `${MARK}${n}${MARK}`])) });
  return marked.split(MARK).map((part, i) => (i % 2 === 1 ? (slots[part] ?? part) : part));
}

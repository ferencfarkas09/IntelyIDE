/** Names up to this long are never split. */
const WHOLE = 14;
const TAIL_MAX = 12;

/**
 * Splits a name into a head that may be ellipsised and a tail that always stays visible, so the end of a long
 * branch such as `feature-light-design` survives (`sandbox-li…-design`). The tail starts at the last separator
 * within its last {@link TAIL_MAX} characters, else it is the last 6 characters.
 */
export function splitMiddle(text: string): [head: string, tail: string] {
  if (text.length <= WHOLE) return [text, ""];
  const window = text.slice(-TAIL_MAX);
  const sep = Math.max(window.lastIndexOf("-"), window.lastIndexOf("/"), window.lastIndexOf("_"), window.lastIndexOf("."));
  const cut = sep > 0 ? text.length - TAIL_MAX + sep : text.length - 6;
  return [text.slice(0, cut), text.slice(cut)];
}

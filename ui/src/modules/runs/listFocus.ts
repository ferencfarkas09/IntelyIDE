/**
 * A row that is closed (or reopened) leaves the list. When the focus was in it, it goes to the next row, else the previous one, else a fallback
 * of the group (its header), so the keyboard does not start over from the top of the page.
 */
export function focusNeighbour(from: Element, rowSelector: string, fallbackSelector: string): void {
  const row = from.closest(rowSelector);
  if (!row || !row.contains(document.activeElement)) return;
  const near = [row.nextElementSibling, row.previousElementSibling].find((el): el is Element => !!el && el.matches(rowSelector));
  const target = near ? (near.matches("[tabindex]") ? near : near.querySelector("button")) : row.closest("section")?.querySelector(fallbackSelector);
  if (target instanceof HTMLElement) queueMicrotask(() => target.focus());
}

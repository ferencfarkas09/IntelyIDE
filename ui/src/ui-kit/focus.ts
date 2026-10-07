const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])';

export function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => el.getClientRects().length > 0 && el.getAttribute("aria-disabled") !== "true");
}

/** Keeps Tab / Shift+Tab inside `root`. Returns true when it handled the event. */
export function trapTab(e: KeyboardEvent, root: HTMLElement): boolean {
  if (e.key !== "Tab") return false;
  const list = tabbables(root);
  if (list.length === 0) {
    e.preventDefault();
    root.focus();
    return true;
  }
  const first = list[0];
  const last = list[list.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === root)) {
    e.preventDefault();
    last.focus();
    return true;
  }
  if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

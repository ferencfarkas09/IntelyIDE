/** A checkbox is on, off, or mixed (some children checked). Mixed is never stored: derive it. */
export type CheckState = boolean | "mixed";

/** Clicking mixed selects everything (the JetBrains behaviour), clicking on clears, clicking off sets. */
export function nextCheckState(state: CheckState): boolean {
  return state === true ? false : true;
}

export function ariaChecked(state: CheckState): "true" | "false" | "mixed" {
  return state === "mixed" ? "mixed" : state ? "true" : "false";
}

/** Tri-state of a parent from how many of its `total` children are checked. */
export function deriveCheckState(checked: number, total: number): CheckState {
  if (total <= 0 || checked <= 0) return false;
  return checked >= total ? true : "mixed";
}

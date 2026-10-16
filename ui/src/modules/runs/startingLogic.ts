/** After this long without an answer from the host, the New run dialog gives way to the run's starting card. A quicker answer changes nothing. */
export const REVEAL_AFTER_MS = 600;
/** The starting card says more about the wait after this long. */
export const SLOW_AFTER_MS = 15_000;

/** "7 s", "1 min 05 s": how long a run has been starting. */
export function elapsedLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total} s`;
  return `${Math.floor(total / 60)} min ${String(total % 60).padStart(2, "0")} s`;
}

/** The first line of the task with something in it, cut to `max` characters: what a starting card is called. */
export function startingTitle(prompt: string, max = 80): string {
  const line = prompt.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const chars = [...line];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : line;
}

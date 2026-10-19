/** Drag and drop between the sessions list and the run panes, and between panes. Plain HTML5 drag data, no library. */
export const RUN_MIME = "application/x-intely-run";
export const PANE_MIME = "application/x-intely-pane";

/** A run is dragged out of the sessions list. */
export function startRunDrag(e: DragEvent, agentId: string): void {
  e.dataTransfer?.setData(RUN_MIME, agentId);
  e.dataTransfer?.setData("text/plain", agentId);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "copyMove";
}

/** A pane is dragged by its header. */
export function startPaneDrag(e: DragEvent, index: number): void {
  e.dataTransfer?.setData(PANE_MIME, String(index));
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
}

/** What is being dragged over a pane (known while dragging; the data itself is readable only on drop). */
export function dragKind(e: DragEvent): "run" | "pane" | null {
  const types = Array.from(e.dataTransfer?.types ?? []);
  return types.includes(PANE_MIME) ? "pane" : types.includes(RUN_MIME) ? "run" : null;
}

export type Dropped = { kind: "run"; agentId: string } | { kind: "pane"; index: number } | null;

export function readDrop(e: DragEvent): Dropped {
  const pane = e.dataTransfer?.getData(PANE_MIME);
  if (pane !== undefined && pane !== "" && Number.isInteger(Number(pane))) return { kind: "pane", index: Number(pane) };
  const run = e.dataTransfer?.getData(RUN_MIME);
  return run ? { kind: "run", agentId: run } : null;
}

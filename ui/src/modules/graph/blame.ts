import { createSignal } from "solid-js";
import { t } from "../../i18n";
import type { BlameLine } from "../../ipc/graph";
import { readStored, writeStored } from "../../ui-kit/storage";
import { ageLabel } from "./format";

const KEY = "intely.graph.blame";
const [enabled, setEnabled] = createSignal(readStored(KEY) === "1");

/** Whether the editor shows the blame gutter and the caret-line annotation. */
export const blameEnabled = enabled;

export function setBlameEnabled(on: boolean): void {
  setEnabled(on);
  writeStored(KEY, on ? "1" : "0");
}
export const toggleBlame = (): void => setBlameEnabled(!enabled());

export interface BlameCell extends BlameLine {
  /** First line of a run from the same commit: only these show a label. */
  first: boolean;
}

export function blameCells(lines: readonly BlameLine[]): BlameCell[] {
  return lines.map((l, i) => ({ ...l, first: i === 0 || lines[i - 1].oid !== l.oid }));
}

export const gutterLabel = (l: BlameLine, now = Date.now()): string => (l.uncommitted ? t("graph.blame.uncommitted") : t("graph.blame.gutter", { author: l.author, age: ageLabel(l.dateMs, now) }));
/** The caret-line annotation: who, when and why. */
export const caretLabel = (l: BlameLine, now = Date.now()): string => (l.uncommitted ? t("graph.blame.you") : t("graph.blame.caret", { author: l.author, age: ageLabel(l.dateMs, now), summary: l.summary }));

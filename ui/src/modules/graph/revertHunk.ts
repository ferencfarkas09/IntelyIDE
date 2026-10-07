import { t } from "../../i18n";
import type { Hunk } from "../../ipc";

/** Thrown when the file no longer looks the way the hunk was shown; same code the file writer uses. */
export const staleError = (): { code: string; message: string } => ({ code: "staleFile", message: t("graph.hunks.stale") });

/**
 * The text with one hunk undone: the working-tree side of the hunk (context and added lines) is replaced by the old side (context and
 * removed lines). The lines are checked first, so a file that moved on is refused instead of being damaged.
 */
export function revertHunkInText(text: string, hunk: Hunk): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const current = hunk.lines.filter((l) => l.kind !== "del").map((l) => l.text.replace(/\r$/, ""));
  const original = hunk.lines.filter((l) => l.kind !== "add").map((l) => l.text.replace(/\r$/, ""));
  // A hunk without lines on the new side (pure deletion) is positioned by the line before it.
  const at = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1;
  if (at < 0 || current.some((line, i) => lines[at + i] !== line)) throw staleError();
  lines.splice(at, current.length, ...original);
  return lines.join(eol);
}

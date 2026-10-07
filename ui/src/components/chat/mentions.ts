import type { AgentAttachment } from "../../store/agent-types";

export interface Mention {
  /** Index of the `@`. */
  start: number;
  query: string;
}

/** The `@token` the caret is in (an `@` at the start or after whitespace, no whitespace up to the caret). */
export function activeMention(text: string, caret: number): Mention | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  return /\s/.test(query) ? null : { start: at, query };
}

export function applyMention(text: string, mention: Mention, caret: number, path: string): { text: string; caret: number } {
  const insert = `@${path} `;
  return { text: text.slice(0, mention.start) + insert + text.slice(caret), caret: mention.start + insert.length };
}

/** Attachments whose `@path` is still in the text (the user may have deleted the mention after picking it). */
export function liveAttachments(text: string, attachments: readonly AgentAttachment[]): AgentAttachment[] {
  return attachments.filter((a) => new RegExp(`(^|\\s)@${a.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(text));
}

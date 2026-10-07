import type { Command } from "../../platform/commands";
import type { Chord, Shortcut } from "../../platform/keymap";
import { parseChord } from "../../platform/keymap";

export interface ShortcutRow {
  id: string;
  title: string;
  keys: string;
  /** Another shortcut uses the same chord. */
  conflict: boolean;
}

const signature = (keys: string): string => {
  const c: Chord = parseChord(keys);
  return [c.cmd, c.ctrl, c.alt, c.shift, c.key].join("|");
};

/** Shortcuts grouped like the palette (the command's group; shortcuts without a command go under "Other"), titles from the command. */
export function groupShortcuts(list: readonly Shortcut[], commands: readonly Command[]): { group: string; rows: ShortcutRow[] }[] {
  const counts = new Map<string, number>();
  list.forEach((s) => counts.set(signature(s.keys), (counts.get(signature(s.keys)) ?? 0) + 1));
  const groups = new Map<string, ShortcutRow[]>();
  for (const s of list) {
    const command = commands.find((c) => c.id === s.command);
    const group = command?.group ?? "Other";
    const row: ShortcutRow = { id: s.id, title: command?.title ?? s.id, keys: s.keys, conflict: (counts.get(signature(s.keys)) ?? 0) > 1 };
    groups.set(group, [...(groups.get(group) ?? []), row]);
  }
  return [...groups].map(([group, rows]) => ({ group, rows })).sort((a, b) => (a.group === "Other" ? 1 : b.group === "Other" ? -1 : a.group.localeCompare(b.group)));
}

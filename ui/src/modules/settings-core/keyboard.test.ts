import { describe, expect, it } from "vitest";
import type { Command } from "../../platform/commands";
import type { Shortcut } from "../../platform/keymap";
import { groupShortcuts } from "./keyboard";

const sc = (id: string, keys: string, command?: string): Shortcut => ({ id, keys, command, run: command ? undefined : () => {} });
const cmd = (id: string, title: string, group: string): Command => ({ id, title, group, run: () => {} });

describe("groupShortcuts", () => {
  it("groups by command group, titles from the command, and flags clashing chords in any spelling", () => {
    const rows = groupShortcuts(
      [sc("a", "Mod+Shift+P", "palette.open"), sc("b", "Cmd+K", "x.y"), sc("c", "Cmd+k", "x.z"), sc("d", "Ctrl+Tab")],
      [cmd("palette.open", "Show all commands", "View"), cmd("x.y", "Why", "Git"), cmd("x.z", "Zed", "Git")],
    );
    expect(rows.map((g) => g.group)).toEqual(["Git", "View", "Other"]);
    expect(rows[0].rows.map((r) => [r.title, r.conflict])).toEqual([["Why", true], ["Zed", true]]);
    expect(rows[1].rows[0]).toMatchObject({ title: "Show all commands", conflict: false });
    expect(rows[2].rows[0]).toMatchObject({ title: "d", keys: "Ctrl+Tab" });
  });
});

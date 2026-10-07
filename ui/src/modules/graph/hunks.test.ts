import { describe, expect, it } from "vitest";
import { hunkStats, resolveChoice, toggled } from "./hunks";

describe("hunk choice", () => {
  it("tells whole, none and some apart", () => {
    expect(resolveChoice(new Set([0, 1, 2]), 3)).toEqual({ kind: "whole" });
    expect(resolveChoice(new Set(), 3)).toEqual({ kind: "none" });
    expect(resolveChoice(new Set([2, 0]), 3)).toEqual({ kind: "some", indexes: [0, 2] });
    expect(resolveChoice(new Set([7]), 3)).toEqual({ kind: "none" });
  });

  it("toggles without mutating", () => {
    const base = new Set([1]);
    expect([...toggled(base, 2)].sort()).toEqual([1, 2]);
    expect([...toggled(base, 1)]).toEqual([]);
    expect([...base]).toEqual([1]);
  });

  it("counts added and removed lines", () => {
    expect(hunkStats([{ kind: "context" }, { kind: "add" }, { kind: "add" }, { kind: "del" }])).toEqual({ added: 2, removed: 1 });
  });
});

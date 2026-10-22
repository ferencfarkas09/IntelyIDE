import { describe, expect, it } from "vitest";
import type { TranscriptItem, TranscriptRow } from "../../store/agent-reducer";
import { estimateRow } from "./rowSize";

const row = (item: object, children: object[] = []): TranscriptRow => ({ key: "k", item: { key: "k", ts: 0, ...item } as TranscriptItem, children: children as never, notes: [] });

describe("estimateRow", () => {
  it("grows with the text of an answer, by its lines and paragraphs", () => {
    const one = estimateRow(row({ type: "text", text: "short", done: true }));
    const long = estimateRow(row({ type: "text", text: "x".repeat(118 * 3), done: true }));
    const paragraphs = estimateRow(row({ type: "text", text: Array.from({ length: 10 }, () => "para").join("\n\n"), done: true }));
    expect(long).toBeGreaterThan(one);
    expect(paragraphs).toBeGreaterThan(long);
  });

  it("counts a blank-line-free block as lines of its own", () => {
    const joined = estimateRow(row({ type: "text", text: "a\nb\nc", done: true }));
    const single = estimateRow(row({ type: "text", text: "a", done: true }));
    expect(joined).toBeGreaterThan(single);
  });

  it("gives a message of yours more chrome than the same text as an answer", () => {
    expect(estimateRow(row({ type: "user", text: "hi" }))).toBeGreaterThan(estimateRow(row({ type: "text", text: "hi", done: true })));
  });

  it("makes a tool card taller for each child call, and never returns nothing for an unknown row", () => {
    expect(estimateRow(row({ type: "tool" }, [{}, {}]))).toBeGreaterThan(estimateRow(row({ type: "tool" })));
    expect(estimateRow(undefined)).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from "vitest";
import { activeMention, applyMention, liveAttachments } from "./mentions";

describe("activeMention", () => {
  it("finds the @token under the caret", () => {
    expect(activeMention("look at @src/ut", 15)).toEqual({ start: 8, query: "src/ut" });
    expect(activeMention("@a", 2)).toEqual({ start: 0, query: "a" });
  });
  it("ignores e-mail addresses, closed tokens and a caret after whitespace", () => {
    expect(activeMention("mail me@host", 12)).toBeNull();
    expect(activeMention("see @a.ts now", 13)).toBeNull();
    expect(activeMention("no mention", 5)).toBeNull();
  });
});

describe("applyMention", () => {
  it("replaces the token with the path and a trailing space", () => {
    const m = activeMention("look at @or tomorrow", 11)!;
    expect(applyMention("look at @or tomorrow", m, 11, "src/Order.tsx")).toEqual({ text: "look at @src/Order.tsx  tomorrow", caret: 23 });
  });
});

describe("liveAttachments", () => {
  it("keeps only attachments whose mention is still in the text", () => {
    const a = [{ repoId: "admin", path: "src/a.ts" }, { repoId: "admin", path: "src/b.ts" }];
    expect(liveAttachments("check @src/a.ts please", a)).toEqual([a[0]]);
    expect(liveAttachments("check @src/a.tsx", a)).toEqual([]);
  });
});

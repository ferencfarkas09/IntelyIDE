import { describe, expect, it } from "vitest";
import { highlight, palette256, parseAnsi, stripAnsi } from "./ansi";

describe("parseAnsi", () => {
  it("turns colour codes into styled runs and resets cleanly", () => {
    const segs = parseAnsi("\x1b[32mOK\x1b[0m plain \x1b[1;31mbad\x1b[0m");
    expect(segs.map((s) => s.text)).toEqual(["OK", " plain ", "bad"]);
    expect(segs[0].fg).toBe("var(--ansi-2)");
    expect(segs[1].fg).toBeUndefined();
    expect(segs[2]).toMatchObject({ fg: "var(--ansi-1)", bold: true });
  });

  it("reads 256-colour and truecolour, and drops cursor and title sequences", () => {
    expect(parseAnsi("\x1b[38;5;196mx")[0].fg).toBe("rgb(255 0 0)");
    expect(parseAnsi("\x1b[38;2;10;20;30mx")[0].fg).toBe("rgb(10 20 30)");
    expect(parseAnsi("\x1b[2K\x1b[1Gdone\x1b]0;title\x07!").map((s) => s.text).join("")).toBe("done!");
    expect(palette256(244)).toBe("rgb(128 128 128)");
  });

  it("keeps an empty line renderable and strips for search", () => {
    expect(parseAnsi("")).toEqual([{ text: "" }]);
    expect(stripAnsi("\x1b[33mwarn\x1b[0m: x")).toBe("warn: x");
  });
});

describe("highlight", () => {
  it("marks case-insensitive matches without losing the colour", () => {
    const out = highlight(parseAnsi("\x1b[31mError: ERROR twice\x1b[0m"), "error");
    expect(out.map((s) => [s.text, !!s.hit])).toEqual([["Error", true], [": ", false], ["ERROR", true], [" twice", false]]);
    expect(out.every((s) => s.fg === "var(--ansi-1)")).toBe(true);
    expect(highlight([{ text: "abc" }], "")).toEqual([{ text: "abc" }]);
  });
});

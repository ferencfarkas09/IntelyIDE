import { describe, expect, it } from "vitest";
import { CHANNEL, MAX_NAME, MAX_PATH, modeMessage, parseInspectMessage } from "./protocol";

const good = { intely: CHANNEL, file: "/Users/x/admin/src/Login.js", line: 34, col: 7, componentName: "LoginForm" };

describe("parseInspectMessage: the page channel carries a source hint and nothing else", () => {
  it("accepts exactly the five-key message", () => {
    expect(parseInspectMessage(good)).toEqual({ file: good.file, line: 34, col: 7, componentName: "LoginForm" });
    expect(parseInspectMessage({ ...good, col: 0 })?.col).toBe(1);
  });

  it("accepts a name-only hint", () => {
    expect(parseInspectMessage({ ...good, file: "", line: 0, col: 0 })).toEqual({ file: "", line: 0, col: 0, componentName: "LoginForm" });
    expect(parseInspectMessage({ ...good, file: "", line: 0, col: 0, componentName: "" })).toBeUndefined();
    expect(parseInspectMessage({ ...good, file: "", line: 3, col: 0 })).toBeUndefined();
  });

  it("rejects any extra field, so page data cannot ride along", () => {
    expect(parseInspectMessage({ ...good, html: "<p>secret</p>" })).toBeUndefined();
    expect(parseInspectMessage({ ...good, props: { token: "x" } })).toBeUndefined();
    const { col: _col, ...missing } = good;
    expect(parseInspectMessage(missing)).toBeUndefined();
  });

  it("rejects the wrong channel, version and shape", () => {
    expect(parseInspectMessage({ ...good, intely: "inspect/2" })).toBeUndefined();
    expect(parseInspectMessage({ ...good, intely: undefined })).toBeUndefined();
    for (const v of [null, undefined, 1, "x", true, [], [good], () => good, new Date(), new Map()]) expect(parseInspectMessage(v)).toBeUndefined();
    class Evil { intely = CHANNEL; file = "/a/b.js"; line = 1; col = 1; componentName = "X"; }
    expect(parseInspectMessage(new Evil())).toBeUndefined();
  });

  it("rejects getters, symbols and inherited keys", () => {
    const withGetter = Object.defineProperty({ ...good }, "file", { get: () => "/a/b.js", enumerable: true });
    expect(parseInspectMessage(withGetter)).toBeUndefined();
    expect(parseInspectMessage({ ...good, [Symbol("x")]: 1 })).toBeUndefined();
    const inherited = Object.create(good);
    expect(parseInspectMessage(inherited)).toBeUndefined();
    expect(parseInspectMessage(Object.assign(Object.create(null), good))).toBeDefined();
  });

  it("rejects bad positions", () => {
    for (const line of [0, -1, 1.5, NaN, Infinity, 10_000_001, "3" as unknown as number]) expect(parseInspectMessage({ ...good, line }), String(line)).toBeUndefined();
    for (const col of [-1, 0.5, NaN, 10_000_001, null as unknown as number]) expect(parseInspectMessage({ ...good, col }), String(col)).toBeUndefined();
  });

  it("rejects hostile paths and names", () => {
    const bad = ["a\0b.js", "a\nb.js", "a\rb.js", "a\u2028b.js", "a\u202eb.js", "src\\x.js", "x".repeat(MAX_PATH + 1)];
    for (const file of bad) expect(parseInspectMessage({ ...good, file }), JSON.stringify(file)).toBeUndefined();
    const names = ["<script>alert(1)</script>/", "a;b", 'x"y', "a\nb", "x".repeat(MAX_NAME + 1), "a\u202eb", "`x`", "a{b}", "a/b"];
    for (const componentName of names) expect(parseInspectMessage({ ...good, componentName }), JSON.stringify(componentName)).toBeUndefined();
    for (const ok of ["Login", "Foo.Bar", "memo(Foo)", "Árvíztűrő", "$Comp", "_x1", "ForwardRef(Button)"]) expect(parseInspectMessage({ ...good, componentName: ok }), ok).toBeDefined();
  });

  it("builds the mode message the IDE sends to the page", () => {
    expect(modeMessage(true)).toEqual({ intely: "inspect.mode/1", on: true });
  });
});

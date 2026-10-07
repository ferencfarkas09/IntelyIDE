import { describe, expect, it } from "vitest";
import { dataUrlToBytes, defaultPrefs, parseFrameMessage, parseJsonObject, parsePrefs, prefsKey, PROTOCOL, pushEvent, EVENT_LIMIT, viewportById, withPreset, MAX_PRESETS } from "./componentLogic";

describe("parseJsonObject", () => {
  it("accepts an object and treats empty text as {}", () => {
    expect(parseJsonObject('{"a":1,"fn":{"$fn":"x"}}')).toEqual({ ok: true, value: { a: 1, fn: { $fn: "x" } } });
    expect(parseJsonObject("  ")).toEqual({ ok: true, value: {} });
  });
  it("reports syntax errors with a line and column", () => {
    const r = parseJsonObject('{\n  "a": 1,\n  "b": }');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("syntax");
      expect(r.line).toBe(3);
      expect(r.col).toBeGreaterThan(1);
    }
  });
  it("finds the position even when V8 only quotes a snippet of a long text", () => {
    const text = `{\n  "name": "Ada",\n  "padding": "${"x".repeat(60)}",\n  "onClick": \n}`;
    const r = parseJsonObject(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.line).toBe(5);
  });
  it("refuses arrays, scalars, null, oversize text and prototype-poisoning keys at any depth", () => {
    for (const bad of ["[1]", "3", '"x"', "null"]) expect(parseJsonObject(bad)).toMatchObject({ ok: false, reason: "notObject" });
    expect(parseJsonObject(`"${"x".repeat(200_001)}"`)).toMatchObject({ ok: false, reason: "tooLarge" });
    expect(parseJsonObject('{"a":{"b":[{"__proto__":{"x":1}}]}}')).toMatchObject({ ok: false, reason: "forbiddenKey", detail: "__proto__" });
    expect(parseJsonObject('{"constructor":1}')).toMatchObject({ ok: false, reason: "forbiddenKey" });
  });
});

describe("parsePrefs", () => {
  it("falls back field by field and never throws", () => {
    expect(parsePrefs(undefined)).toEqual(defaultPrefs());
    expect(parsePrefs("x")).toEqual(defaultPrefs());
    const p = parsePrefs({ props: 5, scheme: "purple", viewport: "tv", layout: "full", route: "no-slash", wrappers: { redux: true, theme: "yes" }, presets: [{ name: "a", props: "{}" }, { name: "a", props: "{}" }, { props: "{}" }, { name: "x", props: 3 }, null] });
    expect(p.props).toBeUndefined();
    expect(p).toMatchObject({ scheme: "dark", viewport: "fit", layout: "full", route: "/", wrappers: { theme: false, redux: true, router: false } });
    expect(p.presets).toEqual([{ name: "a", props: "{}", store: "" }]);
  });
  it("keeps valid saved values", () => {
    const p = parsePrefs({ props: '{"a":1}', store: "{}", scheme: "light", viewport: "phone", route: "/orders/1", presets: [{ name: "Empty", props: "{}", store: "{}" }] });
    expect(p).toMatchObject({ props: '{"a":1}', scheme: "light", viewport: "phone", route: "/orders/1" });
    expect(p.presets).toHaveLength(1);
  });
});

describe("presets and keys", () => {
  it("replaces by name, trims, ignores empty names and caps the list", () => {
    let list = withPreset([], { name: " A ", props: "1", store: "" });
    list = withPreset(list, { name: "A", props: "2", store: "" });
    expect(list).toEqual([{ name: "A", props: "2", store: "" }]);
    expect(withPreset(list, { name: "  ", props: "", store: "" })).toEqual(list);
    let many = list;
    for (let i = 0; i < MAX_PRESETS + 5; i++) many = withPreset(many, { name: `p${i}`, props: "", store: "" });
    expect(many).toHaveLength(MAX_PRESETS);
    expect(many.at(-1)?.name).toBe(`p${MAX_PRESETS + 4}`);
  });
  it("builds a stable key per component and export", () => {
    expect(prefsKey("r", "src/A.jsx", "default")).toBe("component:r:src/A.jsx#default");
    expect(viewportById("phone").width).toBe(393);
    expect(viewportById("nope").id).toBe("fit");
  });
  it("keeps the last EVENT_LIMIT events", () => {
    let l: number[] = [];
    for (let i = 0; i < EVENT_LIMIT + 10; i++) l = pushEvent(l, i);
    expect(l).toHaveLength(EVENT_LIMIT);
    expect(l[0]).toBe(10);
  });
});

describe("parseFrameMessage (the page is untrusted)", () => {
  it("accepts the four message kinds and clips and cleans them", () => {
    expect(parseFrameMessage({ intely: PROTOCOL.ready, name: "A", file: "src/A.jsx", exports: ["default", "B", "ev;il()", 5], available: { redux: true } })).toEqual({ kind: "ready", name: "A", file: "src/A.jsx", exports: ["default", "B"], available: { redux: true, mui: false, styled: false, router: false } });
    const st = parseFrameMessage({ intely: PROTOCOL.status, state: "buildError", message: "bad‮text", errors: [{ file: "a.jsx", line: 3, col: 7, text: "oops" }, null] });
    expect(st).toMatchObject({ kind: "status", state: "buildError", message: "badtext" });
    expect(st && st.kind === "status" && st.errors[0]).toEqual({ file: "a.jsx", line: 3, col: 7, text: "oops" });
    expect(parseFrameMessage({ intely: PROTOCOL.event, kind: "fn", name: "onClick()", detail: undefined })).toEqual({ kind: "event", event: "fn", name: "onClick()", detail: "" });
    expect(parseFrameMessage({ intely: PROTOCOL.shot, id: "s1", ok: false, error: "tainted" })).toMatchObject({ kind: "shot", ok: false, error: "tainted" });
  });
  it("ignores anything else", () => {
    for (const bad of [null, "x", [], {}, { intely: "inspect/1" }, { intely: PROTOCOL.status, state: "weird" }, { intely: PROTOCOL.event, kind: "eval" }, { intely: PROTOCOL.shot, id: "", ok: true }, { intely: PROTOCOL.shot, id: "a", ok: true, dataUrl: "data:text/html;base64,AAAA" }]) expect(parseFrameMessage(bad)).toBeUndefined();
  });
  it("bounds lengths", () => {
    const m = parseFrameMessage({ intely: PROTOCOL.event, kind: "console", name: "x".repeat(5000) });
    expect(m && m.kind === "event" && m.name.length).toBe(300);
  });
});

describe("dataUrlToBytes", () => {
  it("decodes a png data url and refuses others", () => {
    expect([...(dataUrlToBytes("data:image/png;base64,iVBORw==") ?? [])]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(dataUrlToBytes("data:image/svg+xml;base64,AAAA")).toBeUndefined();
    expect(dataUrlToBytes("data:image/png;base64,@@@")).toBeUndefined();
  });
});

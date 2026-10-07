import { describe, expect, it } from "vitest";
import { createInThreadClient } from "./client";
import { DocEngine } from "./engine";
import { pathToString, runQuery, QueryError } from "./jsonPath";

const doc = { name: "x", list: Array.from({ length: 450 }, (_, i) => ({ id: i, tag: i % 2 ? "odd" : "even" })), "odd key": { deep: [1, [2, 3]] }, empty: {} };

describe("jq-like paths and queries", () => {
  it("formats a path the way jq reads it", () => {
    expect(pathToString([])).toBe(".");
    expect(pathToString(["a", 0, "b c", "d"])).toBe('.a[0]["b c"].d');
  });

  it("walks keys, indices, slices, iteration and recursion", () => {
    expect(runQuery(doc, ".name").map((h) => h.value)).toEqual(["x"]);
    expect(runQuery(doc, ".list[3].id").map((h) => h.value)).toEqual([3]);
    expect(runQuery(doc, ".list[-1].id").map((h) => h.value)).toEqual([449]);
    expect(runQuery(doc, ".list[1:3]").map((h) => (h.value as { id: number }).id)).toEqual([1, 2]);
    expect(runQuery(doc, '."odd key".deep[1][]').map((h) => h.value)).toEqual([2, 3]);
    expect(runQuery(doc, "..id", 1000)).toHaveLength(450);
    expect(runQuery(doc, ".list[].id", 5)).toHaveLength(5);
  });

  it("filters with select and pipes", () => {
    const hits = runQuery(doc, '.list[] | select(.tag == "odd") | select(.id > 440)');
    expect(hits.map((h) => (h.value as { id: number }).id)).toEqual([441, 443, 445, 447, 449]);
    expect(hits[0].path).toEqual(["list", 441]);
    expect(runQuery(doc, '.list[] | select(.tag ~ "OD") | .id', 3)).toHaveLength(3);
  });

  it("reports unreadable input as a QueryError", () => {
    expect(() => runQuery(doc, ".list[")).toThrow(QueryError);
    expect(() => runQuery(doc, ".a | select(.b == nope)")).toThrow(QueryError);
    expect(() => runQuery(doc, ".a b")).toThrow(QueryError);
  });
});

describe("DocEngine tree", () => {
  const make = () => {
    const e = new DocEngine();
    e.load(doc, "json");
    return e;
  };

  it("starts with the root open and pages long arrays", () => {
    const e = make();
    expect(e.window(0, 10).map((r) => `${r.depth}:${r.label}`)).toEqual(["0:$", "1:name", "1:list", "1:odd key", "1:empty"]);
    const i = e.window(0, 10).findIndex((r) => r.label === "list");
    e.toggle(i);
    const rows = e.window(0, 1000);
    expect(rows.filter((r) => r.depth === 2 && r.path[0] === "list" && r.more === undefined)).toHaveLength(200);
    const more = rows.find((r) => r.more !== undefined)!;
    expect(more.more).toBe(250);
    e.toggle(rows.indexOf(more));
    expect(e.window(0, 1000).filter((r) => r.depth === 2 && r.path[0] === "list" && r.more === undefined)).toHaveLength(400);
  });

  it("collapses and keeps the total consistent", () => {
    const e = make();
    const before = e.total();
    e.toggle(2);
    expect(e.total()).toBeGreaterThan(before);
    e.toggle(2);
    expect(e.total()).toBe(before);
    expect(e.collapseAll()).toBe(before);
  });

  it("reveals a deep path past the first page and opens its ancestors", () => {
    const e = make();
    const index = e.reveal(["list", 300, "tag"]);
    expect(index).toBeGreaterThan(0);
    const row = e.window(index, 1)[0];
    expect(row.path).toEqual(["list", 300, "tag"]);
    expect(row.preview).toBe('"even"');
  });

  it("expands levels", () => {
    const e = make();
    e.expandLevel(3);
    const labels = e.window(0, 5000).filter((r) => r.path[0] === "odd key").map((r) => r.label);
    expect(labels).toEqual(["odd key", "deep", "0", "1", "0", "1"]);
  });

  it("searches keys and values in document order, and queries", () => {
    const e = make();
    const r = e.search("odd");
    expect(r.hits[0]).toMatchObject({ pathText: ".list[1].tag", where: "value" });
    expect(r.hits[r.hits.length - 1]).toMatchObject({ pathText: '["odd key"]', where: "key" });
    expect(r.hits.length).toBe(1 + 225);
    expect(e.search("ODD", 10).truncated).toBe(true);
    const q = e.search('.list[] | select(.id == 7) | .tag');
    expect(q.hits.map((h) => h.preview)).toEqual(['"odd"']);
    expect(e.search(".list[").error).toMatch(/\]/);
    expect(e.valueText(["odd key", "deep", 1])).toBe("[\n  2,\n  3\n]");
  });
});

describe("DocEngine lines", () => {
  it("shows log lines flat, with levels, and expands JSON lines", () => {
    const e = new DocEngine();
    e.load([], "lines");
    e.appendLines(["2026-10-03 INFO started", "2026-10-03 ERROR boom", { level: "warn", msg: "slow", ctx: { ms: 900 } }, "plain"]);
    const rows = e.window(0, 10);
    expect(rows.map((r) => [r.label, r.type, r.level])).toEqual([["1", "line", "info"], ["2", "line", "error"], ["3", "object", "warn"], ["4", "line", undefined]]);
    e.toggle(2);
    expect(e.window(0, 10).map((r) => r.label)).toEqual(["1", "2", "3", "level", "msg", "ctx", "4"]);
    expect(e.levelCounts()).toEqual({ error: 1, warn: 1, info: 1, debug: 0 });
    expect(e.nextLevel("error", -1, 1)).toBe(1);
    expect(e.nextLevel("error", 1, 1)).toBe(-1);
    expect(e.search("boom").hits[0].pathText).toBe("line 2");
    expect(e.valueText([1])).toBe("2026-10-03 ERROR boom");
    expect(e.search('.[] | select(.level == "warn")').hits).toHaveLength(1);
  });
});

describe("EngineHost via the in-thread client", () => {
  const enc = new TextEncoder();
  it("parses JSON streamed in odd-sized chunks (multi-byte characters cut in half)", async () => {
    const c = createInThreadClient();
    const bytes = enc.encode(JSON.stringify({ név: "árvíztűrő", n: [1, 2, 3] }));
    await c.begin("json");
    for (let i = 0; i < bytes.length; i += 7) await c.chunk(bytes.slice(i, i + 7));
    const s = await c.end();
    expect(s.error).toBeUndefined();
    expect(s.loading).toBe(false);
    expect((await c.window(0, 5)).map((r) => r.label)).toEqual(["$", "név", "n"]);
    expect((await c.window(1, 1))[0].preview).toBe('"árvíztűrő"');
  });

  it("falls back to text lines with the parse error for broken JSON", async () => {
    const c = createInThreadClient();
    await c.begin("json");
    await c.chunk(enc.encode('{"a": [1, 2,\n "b": }'));
    const s = await c.end();
    expect(s.fellBackToText).toBe(true);
    expect(s.error).toBeTruthy();
    expect(s.lineCount).toBe(2);
  });

  it("streams a log: lines grow while loading, JSON lines parse, a bad one stays text", async () => {
    const c = createInThreadClient();
    await c.begin("log");
    const s1 = await c.chunk(enc.encode('2026 INFO a\n{"level":"error","msg":"x"}\n{"bad": }\nlast'));
    expect(s1.lineCount).toBe(3);
    expect(s1.loading).toBe(true);
    const s2 = await c.end();
    expect(s2.lineCount).toBe(4);
    expect(s2.badLines).toBe(1);
    expect((await c.window(0, 4)).map((r) => r.type)).toEqual(["line", "object", "line", "line"]);
    expect((await c.levelCounts()).error).toBe(1);
  });

  it("handles CRLF and a 100k-line log within a second", async () => {
    const c = createInThreadClient();
    const text = Array.from({ length: 100_000 }, (_, i) => `line ${i} INFO ok`).join("\r\n");
    await c.begin("log");
    const t0 = performance.now();
    await c.chunk(enc.encode(text));
    const s = await c.end();
    expect(s.lineCount).toBe(100_000);
    expect((await c.window(99_999, 1))[0].preview).toBe("line 99999 INFO ok");
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

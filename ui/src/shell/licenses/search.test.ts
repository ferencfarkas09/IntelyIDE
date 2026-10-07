import { describe, expect, it } from "vitest";
import { filterComponents, groupByLicense } from "./search";
import type { Component } from "./types";

const c = (name: string, over: Partial<Component> = {}): Component => ({
  id: `npm:${name}@1.0.0`, kind: "npm", name, version: "1.0.0", expression: "MIT", chosen: ["MIT"], copyright: [`Copyright (c) ${name} authors`],
  textIds: [], shippedIn: ["app"], distributed: true, verdict: "ok", ...over,
});
const list = [
  c("solid-js"),
  c("serde", { kind: "cargo", version: "1.0.228", expression: "MIT OR Apache-2.0", chosen: ["Apache-2.0"] }),
  c("inter", { kind: "font", expression: "OFL-1.1", chosen: ["OFL-1.1"] }),
];

describe("filterComponents", () => {
  it("matches name, version, license and copyright case-insensitively", () => {
    expect(filterComponents(list, { query: "SERDE" }).map((x) => x.name)).toEqual(["serde"]);
    expect(filterComponents(list, { query: "1.0.228" }).map((x) => x.name)).toEqual(["serde"]);
    expect(filterComponents(list, { query: "apache" }).map((x) => x.name)).toEqual(["serde"]);
    expect(filterComponents(list, { query: "inter authors" }).map((x) => x.name)).toEqual(["inter"]);
  });
  it("ANDs whitespace-separated tokens", () => {
    expect(filterComponents(list, { query: "serde apache" })).toHaveLength(1);
    expect(filterComponents(list, { query: "serde solid" })).toHaveLength(0);
  });
  it("never builds a regex from the input", () => {
    expect(filterComponents(list, { query: "((" })).toEqual([]);
    expect(filterComponents(list, { query: ".*" })).toEqual([]);
    expect(filterComponents(list, { query: "[a-z]+" })).toEqual([]);
  });
  it("filters by license and kind", () => {
    expect(filterComponents(list, { license: "OFL-1.1" }).map((x) => x.name)).toEqual(["inter"]);
    expect(filterComponents(list, { kind: "rust" }).map((x) => x.name)).toEqual(["serde"]);
    expect(filterComponents(list, { kind: "fonts" }).map((x) => x.name)).toEqual(["inter"]);
    expect(filterComponents(list, { kind: "npm" }).map((x) => x.name)).toEqual(["solid-js"]);
    expect(filterComponents(list, { kind: "all", query: "  " })).toHaveLength(3);
  });
});

describe("groupByLicense", () => {
  it("counts per chosen id, count desc then id", () => {
    expect(groupByLicense([...list, c("a"), c("b", { chosen: ["MIT", "Apache-2.0"] })])).toEqual([
      { id: "MIT", count: 3 },
      { id: "Apache-2.0", count: 2 },
      { id: "OFL-1.1", count: 1 },
    ]);
  });
});

import { describe, expect, it } from "vitest";
import type { LicenseIndex, LicenseTexts } from "./types";

// Runs only once the generator (L2b/L11) has produced the bundle.
const raw = import.meta.glob<string>("./data/*.json", { eager: true, query: "?raw", import: "default" });
const rawIndex = raw["./data/index.json"];
const rawTexts = raw["./data/texts.json"];
const present = typeof rawIndex === "string" && typeof rawTexts === "string";

describe.skipIf(!present)("generated license bundle", () => {
  const index = (): LicenseIndex => JSON.parse(rawIndex!);
  const texts = (): LicenseTexts => JSON.parse(rawTexts!);
  it("has schema 1 and the project entry", () => {
    const i = index();
    expect(i.schema).toBe(1);
    expect(texts().schema).toBe(1);
    expect(i.project.license).toBe("GPL-3.0-or-later");
    expect(i.project.textIds.length).toBeGreaterThan(0);
  });
  it("every textId resolves", () => {
    const t = texts().texts;
    const i = index();
    for (const id of i.project.textIds) expect(t[id], id).toBeDefined();
    for (const c of i.components) for (const id of c.textIds) expect(t[id], `${c.id} ${id}`).toBeDefined();
  });
  it("every chosen id is a known group", () => {
    const i = index();
    const groups = new Set(i.groups.map((g) => g.id));
    for (const c of i.components) for (const id of c.chosen) expect(groups.has(id), `${c.id} ${id}`).toBe(true);
  });
  it("stays under the size cap and leaks no machine paths", () => {
    expect(rawIndex!.length + rawTexts!.length).toBeLessThanOrEqual(1_500_000);
    for (const bad of ["/Users/", ".cargo", ".pnpm"]) expect(rawIndex!.includes(bad), bad).toBe(false);
  });
  it("only manual Anthropic entries are not distributed, and the SDK is one of them", () => {
    const nd = index().components.filter((c) => !c.distributed);
    expect(nd.map((c) => c.id)).toContain("manual:claude-agent-sdk");
    expect(nd.every((c) => c.kind === "manual")).toBe(true);
  });
});

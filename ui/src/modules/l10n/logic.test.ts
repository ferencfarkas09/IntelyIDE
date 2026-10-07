import { describe, expect, it } from "vitest";
import { createMockL10n } from "./api";
import { badgeFor, draftItems, edits, placeholders, proposals, samePlaceholders, summarize, targets } from "./logic";

const report = () => createMockL10n().analyze("r");

describe("l10n logic", () => {
  it("lists a draft target for every gap and none for ok cells", async () => {
    const r = await report();
    const ts = targets(r);
    // welcome: 9 languages miss it plus hu placeholders; items: 9 plural gaps (cn is ok, en is the reference).
    expect(ts.filter((t) => t.key === "welcome")).toHaveLength(10);
    expect(ts.filter((t) => t.key === "items_other")).toHaveLength(9);
    expect(ts.every((t) => t.rel.endsWith(`/${t.lang}.json`))).toBe(true);
    expect(targets(r, ["de"]).map((t) => t.key)).toEqual(["welcome", "items_other"]);
    expect(new Set(ts.map((t) => t.id)).size).toBe(ts.length);
  });

  it("turns drafts into review lines that start undecided, and only accepted ones into edits", async () => {
    const ts = targets(await report(), ["de", "hu"]);
    const ps = proposals(ts, [
      { id: ts[0].id, text: "Willkommen zurück, {{name}}", valid: true },
      { id: ts[1].id, text: "no placeholder", valid: false, note: "placeholders differ" },
      { id: "unknown", text: "x", valid: true },
    ]);
    expect(ps).toHaveLength(2);
    expect(ps.every((p) => p.decision === "pending")).toBe(true);
    expect(edits(ps)).toEqual([]);
    ps[0].decision = "accepted";
    ps[1].decision = "rejected";
    expect(edits(ps)).toEqual([{ rel: ts[0].rel, path: ts[0].path, value: "Willkommen zurück, {{name}}" }]);
    expect(draftItems(ts)[0]).toMatchObject({ id: ts[0].id, lang: ts[0].lang, refLang: "en" });
  });

  it("compares placeholders the way the backend does", () => {
    expect(placeholders("{{ count , number }} of {{total}} %s %1$d")).toEqual(["%1$d", "%s", "{{count}}", "{{total}}"]);
    expect(samePlaceholders("Hi {{name}}", "Szia {{name}}!")).toBe(true);
    expect(samePlaceholders("Hi {{name}}", "Szia")).toBe(false);
    expect(samePlaceholders("100%", "100 %")).toBe(true);
  });

  it("summarizes totals and finds the badge of a file", async () => {
    const r = await report();
    const s = summarize(r);
    expect(s.keys).toBe(2);
    expect(s.missing).toBe(9);
    expect(s.problems).toBe(10);
    expect(badgeFor(r, "src/pages/Dashboard.jsx")?.missing).toBe(9);
    expect(badgeFor(r, "nope")).toBeUndefined();
  });

  it("the mock drops a gap once its key is written", async () => {
    const api = createMockL10n();
    const before = targets(await api.analyze("r"), ["de"]);
    await api.apply("r", [{ rel: before[0].rel, path: before[0].path, value: "x" }]);
    expect(targets(await api.analyze("r"), ["de"])).toHaveLength(before.length - 1);
  });
});

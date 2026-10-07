import { describe, expect, it } from "vitest";
import en from "../../i18n/locales/en/mcp.json";
import hu from "../../i18n/locales/hu/mcp.json";

const sources = import.meta.glob(["./*.ts", "./*.tsx", "!./*.test.*"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const enAll = en as Record<string, string>;
const huAll = hu as Record<string, string>;

/** Every `t("mcp.x")` literal and every `"mcp.x"` entry of a key table (`MessageKey` maps) in the module. */
function used(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [file, text] of Object.entries(sources)) {
    for (const m of text.matchAll(/\bt\(\s*"(mcp\.[a-zA-Z0-9_.]+)"/g)) out.set(m[1], file);
    for (const m of text.matchAll(/[:[,(?]\s*"(mcp\.[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)"/g)) out.set(m[1], file);
  }
  return out;
}

/** The keys that are built from a code or a state (`mcp.err.${code}`...): the tests of logic.ts check that each code has its text. */
const BY_CODE = /^mcp\.(err|test\.code|runerr|state|policy|picker\.unavailable|import\.issue)\./;

describe("mcp catalogs", () => {
  it("every key the module uses exists in English and in Hungarian", () => {
    const missing: string[] = [];
    for (const [key, file] of used()) {
      if (!(key in enAll)) missing.push(`en ${key} (${file})`);
      if (!(key in huAll)) missing.push(`hu ${key} (${file})`);
    }
    expect(missing).toEqual([]);
  });

  it("scans something real", () => {
    expect(used().size).toBeGreaterThan(80);
  });

  it("en and hu have exactly the same keys, placeholders and plural shapes", () => {
    expect(Object.keys(huAll).sort()).toEqual(Object.keys(enAll).sort());
    const names = (s: string) => [...new Set([...s.matchAll(/\{(\w+)(?=[,}])/g)].map((m) => m[1]))].sort().join();
    const plurals = (s: string) => [...s.matchAll(/\{\w+, plural, one \{[^}]*\} other \{[^}]*\}\}/g)].length;
    for (const key of Object.keys(enAll)) {
      expect(names(huAll[key]), key).toBe(names(enAll[key]));
      expect(plurals(huAll[key]), key).toBe(plurals(enAll[key]));
    }
  });

  it("has no key that nothing uses, apart from the families built from a code or a state and the consent lines owned by the run header", () => {
    const keys = new Set(used().keys());
    // `mcp.exposure.*` are the consent lines of the mode menu and the Bypass dialog (ui-modes, fed by AgentSummary.mcp); `mcp.import.rename` is spec copy the dialog does not need
    const allowed = new Set(["mcp.exposure.line", "mcp.exposure.secretEnv", "mcp.import.rename"]);
    expect(Object.keys(enAll).filter((k) => !keys.has(k) && !BY_CODE.test(k) && !allowed.has(k))).toEqual([]);
  });

  it("keeps the Hungarian text hand-written: every value is filled and none is a copy of the English one for a sentence", () => {
    for (const [key, value] of Object.entries(huAll)) {
      expect(value.trim(), key).not.toBe("");
      if (enAll[key].split(" ").length > 4) expect(value, key).not.toBe(enAll[key]);
    }
  });
});

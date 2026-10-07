import { describe, expect, it } from "vitest";
import enNew from "../../i18n/locales/en/workspaceNew.json";
import enPicker from "../../i18n/locales/en/workspacePicker.json";
import en from "../../i18n/locales/en/workspace.json";
import huNew from "../../i18n/locales/hu/workspaceNew.json";
import huPicker from "../../i18n/locales/hu/workspacePicker.json";
import hu from "../../i18n/locales/hu/workspace.json";

const sources = import.meta.glob(["./*.ts", "./*.tsx", "../../store/workspace*.ts", "../../platform/pathpicker/*.ts", "../../platform/pathpicker/*.tsx", "!./*.test.*", "!../../**/*.test.*"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const enAll: Record<string, string> = { ...en, ...enNew, ...enPicker };
const huAll: Record<string, string> = { ...hu, ...huNew, ...huPicker };

/** Every literal `t("key")` and `"area.key" as const` table entry in the workspace screens. */
const used = (): Map<string, string> => {
  const out = new Map<string, string>();
  for (const [file, text] of Object.entries(sources)) {
    for (const m of text.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g)) out.set(m[1], file);
    for (const m of text.matchAll(/:\s*"((?:welcome|ws|switch|guard|manage|new|scan|picker)\.[a-zA-Z0-9_.]+)"/g)) out.set(m[1], file);
  }
  return out;
};

describe("workspace catalogs", () => {
  it("every key the workspace screens use exists in English and in Hungarian", () => {
    const missingEn: string[] = [];
    const missingHu: string[] = [];
    for (const [key, file] of used()) {
      // keys of other namespaces (shell.close.*, comp.*, general.*, repos.*) live in their own catalogs
      if (!/^(welcome|ws|switch|guard|manage|new|scan|picker)\./.test(key)) continue;
      if (!(key in enAll)) missingEn.push(`${key} (${file})`);
      if (!(key in huAll)) missingHu.push(`${key} (${file})`);
    }
    expect(missingEn).toEqual([]);
    expect(missingHu).toEqual([]);
  });

  it("scans something real", () => {
    expect(used().size).toBeGreaterThan(60);
  });

  it("en and hu have exactly the same keys and placeholders", () => {
    expect(Object.keys(huAll).sort()).toEqual(Object.keys(enAll).sort());
    const names = (s: string) => [...new Set([...s.matchAll(/\{(\w+)(?=[,}])/g)].map((m) => m[1]))].sort().join();
    for (const key of Object.keys(enAll)) expect(names(huAll[key]), key).toBe(names(enAll[key]));
  });
});

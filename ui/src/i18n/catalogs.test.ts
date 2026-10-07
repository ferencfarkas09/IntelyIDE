import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script shared with `pnpm i18n:check`
import { PENDING_NAMESPACES, checkCatalogs, loadCatalog } from "../../../scripts/i18n-check.mjs";
// @ts-expect-error plain .mjs test helper (the ui package has no node typings)
import { makeCatalogFixture } from "../../../scripts/lib/i18n-fixture.mjs";
import { LANGUAGES } from "./languages";
import { NAMESPACES } from "./index";

/** Every source file's text (tests, catalogs, bindings and the spike are left out). */
const SOURCES = import.meta.glob<string>(["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}", "!../i18n/**", "!../bindings/**", "!../spike/**"], { query: "?raw", import: "default", eager: true });

describe("catalogs", () => {
  const result = checkCatalogs();

  // English and Hungarian are hand-written and must be exact. The 51 machine-translated catalogs are filled in by `pnpm i18n:translate`; until that
  // run they are red in `pnpm i18n:check` (decision RD6: informational, the CI job `i18n-full` reports them and may fail).
  it("English and Hungarian have exactly the keys of English, the same placeholders, no empty values and valid plurals (pnpm i18n:check --lang=en,hu)", () => {
    expect(checkCatalogs({ langs: ["en", "hu"] }).errors).toEqual([]);
  });

  it("ships a catalog for every language in languages.ts", () => {
    expect(result.missingLanguages).toEqual([]);
  });

  it("English files are exactly the registered namespaces", () => {
    expect(Object.keys(loadCatalog("en")).map((f: string) => f.replace(".json", "")).sort()).toEqual([...NAMESPACES].sort());
  });

  it("covers at least 50 languages besides English and the pseudo-locale", () => {
    expect(LANGUAGES.filter((l) => !l.pseudo && l.code !== "en").length).toBeGreaterThanOrEqual(50);
  });

  it("every literal t(\"key\") in the source exists in the English catalog", () => {
    const en = loadCatalog("en");
    const keys = new Set(Object.values(en).flatMap((c) => Object.keys(c as object)));
    const missing: string[] = [];
    for (const [file, text] of Object.entries(SOURCES)) {
      for (const m of text.matchAll(/(?<![\w.$])t\(\s*"([a-zA-Z][\w.]*\.[\w.]+)"/g)) if (!keys.has(m[1])) missing.push(`${file}: ${m[1]}`);
    }
    expect(missing).toEqual([]);
  });

  it("only hu is a reviewed non-English catalog", () => {
    expect(LANGUAGES.filter((l) => l.reviewed && l.code !== "en").map((l) => l.code)).toEqual(["hu"]);
  });
});

describe("pending namespaces", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });
  /** A throwaway catalog tree: `files[lang][namespace]` is the JSON content. */
  function fixture(files: Record<string, Record<string, Record<string, string>>>): string {
    const f = makeCatalogFixture(files) as { dir: string; cleanup: () => void };
    cleanups.push(f.cleanup);
    return f.dir;
  }
  const en = { mongo: { "mongo.a": "Hello {name}", "mongo.b": "Bye" }, platform: { "platform.a": "Open the file list" } };

  it("lists the six MongoDB Studio namespaces, licenses, the workspace namespaces and workflow and panels (Wave 9, until translated), all registered", () => {
    expect([...PENDING_NAMESPACES].sort()).toEqual(["happy", "licenses", "mcp", "memory", "modes", "mongo", "mongoDiag", "mongoForm", "mongoLoud", "mongoManage", "mongoStudio", "panels", "preview", "providers", "slash", "updates", "workflow", "workspace", "workspaceNew", "workspacePicker"]);
    for (const ns of PENDING_NAMESPACES) expect(NAMESPACES).toContain(ns);
  });

  it("a key missing in de is one warning, the same gap in hu is an error", () => {
    const dir = fixture({
      en,
      de: { mongo: { "mongo.a": "Hallo {name}" }, platform: { "platform.a": "Dateiliste öffnen" } },
      hu: { mongo: { "mongo.a": "Szia {name}" }, platform: { "platform.a": "Fájllista megnyitása" } },
    });
    const r = checkCatalogs({ dir, langs: ["de", "hu"], pending: ["mongo"] });
    expect(r.errors).toEqual(["hu: mongo.json: missing key mongo.b"]);
    expect(r.warnings).toEqual(["de: mongo.json: pending namespace, 1 of 2 keys not translated yet (English fallback)"]);
  });

  it("a missing file is a warning for de and an error for hu", () => {
    const dir = fixture({ en, de: { platform: { "platform.a": "Dateiliste öffnen" } }, hu: { platform: { "platform.a": "Fájllista megnyitása" } } });
    const r = checkCatalogs({ dir, langs: ["de", "hu"], pending: ["mongo"] });
    expect(r.errors).toEqual(["hu: missing file mongo.json"]);
    expect(r.warnings).toEqual(["de: mongo.json: pending namespace, file missing (2 keys fall back to English)"]);
  });

  it("present keys of a pending namespace are still checked (placeholders, extra keys)", () => {
    const dir = fixture({
      en,
      de: { mongo: { "mongo.a": "Hallo {wer}", "mongo.zzz": "extra" }, platform: { "platform.a": "Dateiliste öffnen" } },
    });
    const r = checkCatalogs({ dir, langs: ["de"], pending: ["mongo"] });
    expect(r.errors).toContain("de: mongo.json:mongo.a: placeholders {wer} differ from English {name}");
    expect(r.errors).toContain("de: mongo.json: extra key mongo.zzz");
  });

  it("a namespace that is not pending stays strict", () => {
    const dir = fixture({ en, de: { mongo: {}, platform: {} } });
    const r = checkCatalogs({ dir, langs: ["de"], pending: ["mongo"] });
    expect(r.errors).toEqual(["de: platform.json: missing key platform.a"]);
  });

  it("a pending name without an English file is an error", () => {
    const dir = fixture({ en: { platform: en.platform } });
    expect(checkCatalogs({ dir, langs: [], pending: ["mongo"] }).errors).toEqual(["en: pending namespace mongo has no English file"]);
  });
});

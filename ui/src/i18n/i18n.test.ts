import { afterEach, describe, expect, it } from "vitest";
import { compile, formatNodes, formatRelative, MessageSyntaxError, pseudoLocalize } from "./message";
import { detectLanguage, fallbackChain, isRtl, isReviewed, languageName, LANGUAGES, matchLanguage, PSEUDO_LOCALE } from "./languages";
import { fmt, isMachineTranslated, locale, lookup, parseLocale, setLocale, t, translate } from "./index";

const fmtMsg = (src: string, params: Record<string, unknown>, lang = "en") => formatNodes(compile(src), params, lang);

afterEach(async () => {
  await setLocale("en");
  localStorage.clear();
});

describe("messages (ICU-lite)", () => {
  it("fills plain arguments and leaves unknown ones visible", () => {
    expect(fmtMsg("Hello {name}", { name: "Ada" })).toBe("Hello Ada");
    expect(fmtMsg("Hello {name}", {})).toBe("Hello {name}");
  });

  it("quotes: apostrophes stay literal, '' and '{' work", () => {
    expect(fmtMsg("L'état d'un {x}", { x: "repo" }, "fr")).toBe("L'état d'un repo");
    expect(fmtMsg("it''s '{'raw'}'", {})).toBe("it's {raw}");
  });

  it("English plurals", () => {
    const m = "{n, plural, =0 {No files} one {# file} other {# files}}";
    expect([0, 1, 2, 1000].map((n) => fmtMsg(m, { n }))).toEqual(["No files", "1 file", "2 files", "1,000 files"]);
  });

  it("Hungarian plurals (one, other)", () => {
    const m = "{n, plural, one {# fájl} other {# fájl}}";
    expect(fmtMsg(m, { n: 1 }, "hu")).toBe("1 fájl");
    expect(new Intl.PluralRules("hu").select(2)).toBe("other");
  });

  it("Russian plurals (one, few, many, other)", () => {
    const m = "{n, plural, one {# файл} few {# файла} many {# файлов} other {# файла}}";
    expect([1, 2, 5, 11, 21, 22, 25].map((n) => fmtMsg(m, { n }, "ru").replace(/\s/g, " "))).toEqual(["1 файл", "2 файла", "5 файлов", "11 файлов", "21 файл", "22 файла", "25 файлов"]);
  });

  it("Polish plurals (one, few, many, other)", () => {
    const m = "{n, plural, one {# plik} few {# pliki} many {# plików} other {# pliku}}";
    expect([1, 2, 4, 5, 12, 22, 1.5].map((n) => fmtMsg(m, { n }, "pl"))).toEqual(["1 plik", "2 pliki", "4 pliki", "5 plików", "12 plików", "22 pliki", "1,5 pliku"]);
  });

  it("Arabic plurals (zero, one, two, few, many, other)", () => {
    const rules = new Intl.PluralRules("ar");
    expect([0, 1, 2, 5, 11, 100].map((n) => rules.select(n))).toEqual(["zero", "one", "two", "few", "many", "other"]);
    const m = "{n, plural, zero {z} one {o} two {t} few {f} many {m} other {x}}";
    expect([0, 1, 2, 3, 11, 100].map((n) => fmtMsg(m, { n }, "ar"))).toEqual(["z", "o", "t", "f", "m", "x"]);
  });

  it("offset and select", () => {
    expect(fmtMsg("{n, plural, offset:1 =0 {nobody} =1 {just you} one {you and # other} other {you and # others}}", { n: 3 })).toBe("you and 2 others");
    expect(fmtMsg("{k, select, a {Alpha} b {Beta} other {?}}", { k: "b" })).toBe("Beta");
    expect(fmtMsg("{k, select, a {Alpha} other {?}}", { k: "zz" })).toBe("?");
  });

  it("number, date, relative and list formatting go through Intl", () => {
    expect(fmtMsg("{n, number}", { n: 1234567.5 }, "en")).toBe("1,234,567.5");
    expect(fmtMsg("{n, number}", { n: 1234567.5 }, "de")).toBe("1.234.567,5");
    expect(fmtMsg("{n, number, percent}", { n: 0.25 })).toBe("25%");
    expect(fmtMsg("{d, date, short}", { d: new Date(Date.UTC(2026, 9, 3, 12)) }, "en")).toMatch(/10\/3\/26|3\/10\/26/);
    expect(fmtMsg("{n, relative, day}", { n: -1 })).toBe("yesterday");
    expect(fmtMsg("{items, list}", { items: ["a", "b", "c"] })).toBe("a, b, and c");
    expect(fmtMsg("{items, list, or}", { items: ["a", "b"] }, "de")).toBe("a oder b");
    expect(formatRelative(new Date(1_000_000_000_000 - 3 * 3600_000), "en", undefined, 1_000_000_000_000)).toBe("3 hours ago");
  });

  it("rejects broken syntax", () => {
    for (const bad of ["{", "{n, plural, one {x}}", "{n, bogus}", "}", "{n, plural, other {x}"]) expect(() => compile(bad), bad).toThrow(MessageSyntaxError);
  });
});

describe("languages", () => {
  it("the fallback chain goes lang-region, lang, en", () => {
    expect(fallbackChain("pt-BR")).toEqual(["pt-BR", "pt", "en"]);
    expect(fallbackChain("zh-Hans-CN")).toEqual(["zh-Hans-CN", "zh-Hans", "zh", "en"]);
    expect(fallbackChain("en")).toEqual(["en"]);
  });

  it("maps browser tags onto shipped languages", () => {
    expect(matchLanguage("de-AT")).toBe("de");
    expect(matchLanguage("pt")).toBe("pt-BR");
    expect(matchLanguage("pt-PT")).toBe("pt-PT");
    expect(matchLanguage("zh-TW")).toBe("zh-Hant");
    expect(matchLanguage("zh-CN")).toBe("zh-Hans");
    expect(matchLanguage("no")).toBe("nb");
    expect(matchLanguage("iw")).toBe("he");
    expect(matchLanguage("tlh")).toBeNull();
    expect(detectLanguage(["xx-YY", "hu-HU", "en"])).toBe("hu");
    expect(detectLanguage([])).toBe("en");
  });

  it("flags RTL languages and only hu and en as reviewed", () => {
    expect(LANGUAGES.filter((l) => l.rtl).map((l) => l.code).sort()).toEqual(["ar", "fa", "he", "ur"]);
    expect(LANGUAGES.filter((l) => l.reviewed).map((l) => l.code).sort()).toEqual(["en", "hu"]);
    expect(isRtl("ar")).toBe(true);
    expect(isRtl("de")).toBe(false);
    expect(isReviewed("hu")).toBe(true);
  });

  it("names a language in its own language", () => {
    expect(languageName("hu")).toBe("magyar".replace(/^m/, "M"));
    expect(languageName("de")).toBe("Deutsch");
    expect(languageName("ja")).toBe("日本語");
    expect(languageName("zh-Hans")).toBe("简体中文");
    expect(languageName("hu", "en")).toBe("Hungarian");
  });
});

describe("runtime", () => {
  it("translates, fills placeholders and falls back to English for a missing key", async () => {
    expect(t("settings.loadFailed", { section: "Git" })).toBe("Git could not load");
    await setLocale("hu");
    expect(t("settings.title")).toBe("Beállítások");
    expect(t("settings.loadFailed", { section: "Git" })).toBe("A(z) Git nem tölthető be");
    expect(t("rail.soon", { title: "X" })).toBe("X (hamarosan)");
    // a key that exists in English only (simulated by an unknown language entry in the chain)
    expect(lookup("settings.title", "hu-XX")).toBe("Beállítások");
    expect(lookup("no.such.key")).toBeUndefined();
  });

  it("an unknown key renders as the key itself", () => {
    expect(translate("en", "totally.unknown")).toBe("totally.unknown");
  });

  it("plurals inside real catalog strings follow the language", async () => {
    expect(t("keyboard.conflicts", { count: 1 })).toBe("1 conflicting shortcut: the first one registered wins.");
    expect(t("keyboard.conflicts", { count: 3 })).toBe("3 conflicting shortcuts: the first one registered wins.");
    await setLocale("hu");
    expect(t("keyboard.conflicts", { count: 2 })).toContain("2 ütköző billentyűkombináció");
  });

  it("remembers the language, sets lang and dir, ignores junk", async () => {
    await setLocale("hu");
    expect(localStorage.getItem("intely.locale")).toBe("hu");
    expect(document.documentElement.lang).toBe("hu");
    expect(document.documentElement.dir).toBe("ltr");
    expect(locale()).toBe("hu");
    expect(parseLocale("klingon")).toBe("en");
    await setLocale("klingon");
    expect(locale()).toBe("en");
  });

  it("sets dir=rtl for the right-to-left languages and back to ltr", async () => {
    for (const code of ["ar", "he", "fa", "ur"]) {
      await setLocale(code);
      expect(document.documentElement.dir, code).toBe("rtl");
      expect(document.documentElement.lang).toBe(code);
    }
    await setLocale("de");
    expect(document.documentElement.dir).toBe("ltr");
  });

  it("only loads the active language (plus English)", async () => {
    const loaded: string[] = [];
    const mod = await import("./index");
    await mod.setLocale("fr");
    loaded.push(mod.locale());
    expect(loaded).toEqual(["fr"]);
    expect(mod.lookup("settings.title", "fr")).toBeTruthy();
    // a language never selected has no catalog in memory: the lookup falls back to English
    expect(mod.lookup("settings.title", "ko")).toBe("Settings");
  });

  it("machine-translated notice: everything except hu and en", async () => {
    expect(isMachineTranslated()).toBe(false);
    await setLocale("hu");
    expect(isMachineTranslated()).toBe(false);
    await setLocale("de");
    expect(isMachineTranslated()).toBe(true);
  });

  it("formats numbers for the current language", async () => {
    expect(fmt.number(1234.5)).toBe("1,234.5");
    await setLocale("de");
    expect(fmt.number(1234.5)).toBe("1.234,5");
  });

  it("the pseudo-locale accents, pads by about 40 percent and keeps placeholders filled", async () => {
    await setLocale(PSEUDO_LOCALE);
    const out = t("tabs.close", { title: "main.rs" });
    expect(out.startsWith("[") && out.endsWith("]")).toBe(true);
    expect(out).toContain("Çļöšé");
    expect(out).toContain("~");
    expect(out.length).toBeGreaterThanOrEqual("Close main.rs".length * 1.4);
    expect(document.documentElement.dir).toBe("ltr");
    expect(pseudoLocalize("abc")).toBe("[áƀç ~~~]");
    expect(pseudoLocalize("a".repeat(30)).includes(" ~~~ ~~~")).toBe(true);
  });
});

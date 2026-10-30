// @ts-expect-error node built-in (the ui package has no node typings)
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AA_TEXT, SURFACES, STANDARD_SURFACES, contrast, glassComposites } from "./accents";
import { GLASS, rgbaOf, type GlassTheme } from "./glassTokens";

const THEMES: GlassTheme[] = ["dark", "light"];
// Read from disk: under vitest a `?raw` import of a .css file comes back empty (the CSS pipeline takes it).
const read = (file: string): string => readFileSync(new URL(file, import.meta.url), "utf8");
const tokensCss = read("./tokens.css");
const glassCss = read("./glass.css");
const indexCss = read("./index.css");

/** The declarations of the first block whose selector list contains `selector` (tokens.css keeps one block per theme). */
function block(css: string, selector: string): Record<string, string> {
  const at = css.indexOf(selector);
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const standardTokens = { dark: block(tokensCss, '[data-theme="dark"] {'), light: block(tokensCss, '[data-theme="light"] {') };
const glassTokens = (theme: GlassTheme) => block(glassCss, `:root[data-skin="glass"]:not([data-transparency="reduced"])[data-theme="${theme}"],`);

describe("glass.css", () => {
  it("is imported after tokens.css (its overrides win at equal specificity)", () => {
    expect(indexCss.indexOf('"./glass.css"')).toBeGreaterThan(indexCss.indexOf('"./tokens.css"'));
  });

  it("does not touch tokens.css: the first [data-theme] block of each theme is still the standard one", () => {
    expect(standardTokens.light["--surface-1"]).toBe("#f8f9fa");
    expect(standardTokens.dark["--surface-1"]).toBe("#131417");
    expect(tokensCss).not.toContain("data-skin");
  });

  for (const theme of THEMES) {
    it(`${theme}: uses exactly the tints and gradient stops of glassTokens.ts`, () => {
      const g = glassTokens(theme);
      const s = GLASS[theme].surfaces;
      expect(g["--surface-0"]).toBe(rgbaOf(s[0]));
      expect(g["--glass-panel"]).toBe(rgbaOf(s[1]));
      expect(g["--surface-1"]).toBe("transparent");
      expect(g["--surface-2"]).toBe(rgbaOf(s[2]));
      expect(g["--surface-3"]).toBe(rgbaOf(s[3]));
      expect(g["--surface-4"]).toBe(rgbaOf(s[4]));
      expect(g["--glass-base"]).toBe(GLASS[theme].stops[0]);
      for (const stop of GLASS[theme].stops.slice(1)) expect(g["--bg-gradient"]).toContain(stop);
    });

    it(`${theme}: editors keep opaque pane colours`, () => {
      for (const k of ["--pane-1", "--pane-2", "--pane-3", "--pane-4"]) expect(glassTokens(theme)[k]).toMatch(/^#[0-9a-f]{6}$/);
    });
  }

  it("falls back to opaque surfaces: translucency needs backdrop-filter and is off with reduced transparency", () => {
    const supports = glassCss.indexOf("@supports (backdrop-filter");
    expect(supports).toBeGreaterThan(-1);
    // every rule that makes something translucent sits inside the @supports block and excludes data-transparency="reduced"
    const translucent = [...glassCss.matchAll(/^\s*(:root\[data-skin="glass"\][^{]*)\{[^}]*(--surface-1: transparent|backdrop-filter)/gm)];
    expect(translucent.length).toBeGreaterThan(0);
    for (const m of translucent) {
      expect(m.index!).toBeGreaterThan(supports);
      expect(m[1]).toContain(':not([data-transparency="reduced"])');
    }
  });
});

describe("frosted overlays", () => {
  // Floating elements that paint --surface-3/4 (86-90% alpha on Glass) need the frost too, or text behind shows through.
  const FLOATING = [".composer__pop", ".hc-mention-list", ".results-sheet", ".msg__copy", ".run-log__follow", ".pi__style", ".att-overlay__pill", ".att-lightbox__bar"];
  const rules = (prop: RegExp) => [...glassCss.matchAll(/^\s*(:root\[data-skin="glass"\]:not\(\[data-transparency="reduced"\]\) :is\([^)]*\))\s*\{([^}]*)\}/gm)].filter((m) => prop.test(m[2])).map((m) => m[1]);

  it.each(FLOATING)("%s gets the backdrop blur and the glass tint", (sel) => {
    expect(rules(/backdrop-filter/).some((r) => r.includes(sel))).toBe(true);
    expect(rules(/background:\s*var\(--glass-bg\)/).some((r) => r.includes(sel))).toBe(true);
  });
});

describe("text tokens on glass (WCAG AA)", () => {
  for (const theme of THEMES) {
    const text = standardTokens[theme];
    const composites = glassComposites(theme);

    it(`${theme}: text-1, text-2 and text-3 read at >= 4.5:1 on every glass surface over every gradient stop`, () => {
      for (const bg of composites) for (const k of ["--text-1", "--text-2", "--text-3"]) expect(contrast(text[k], bg), `${k} on ${bg}`).toBeGreaterThanOrEqual(AA_TEXT);
    });

    it(`${theme}: text-4 (disabled, decorative) is never weaker on glass than on the standard surfaces`, () => {
      const floor = Math.min(...STANDARD_SURFACES[theme].map((s) => contrast(text["--text-4"], s)));
      for (const bg of composites) expect(contrast(text["--text-4"], bg), `on ${bg}`).toBeGreaterThanOrEqual(floor - 0.15);
    });

    it(`${theme}: the semantic colours keep AA on glass`, () => {
      for (const bg of composites) for (const k of ["--ok", "--warn", "--danger", "--info"]) expect(contrast(text[k], bg), `${k} on ${bg}`).toBeGreaterThanOrEqual(AA_TEXT);
    });

    it(`${theme}: the accent surface list includes the glass composites`, () => {
      expect(SURFACES[theme]).toEqual(expect.arrayContaining(composites));
      expect(SURFACES[theme].slice(0, 5)).toEqual(STANDARD_SURFACES[theme]);
    });
  }
});

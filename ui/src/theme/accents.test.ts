import { afterEach, describe, expect, it } from "vitest";
import {
  AA_TEXT, AA_UI, ACCENTS, ACCENT_STYLE_ID, SURFACES, accentCss, accentTokens, applyAccent, applyStoredAccent, contrast, customFamily, hexToOklch, normalizeHex, oklchHex, over,
  tokensFor, type ResolvedThemeName,
} from "./accents";

const hexOf = (c: string) => {
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (!m) return c;
  const [r, g, b] = m[1].split(",").map((v) => Number(v.trim()));
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
};
const alphaOf = (c: string) => Number(c.match(/rgba\([^)]*,\s*([\d.]+)\)/)?.[1] ?? 1);

const THEMES: ResolvedThemeName[] = ["dark", "light"];

/** The brand violet is hand-tuned in tokens.css; its numbers are copied here so it is held to the same bar. */
const VIOLET = {
  dark: { "--accent": "#7447f5", "--accent-hover": "#7c4dff", "--accent-active": "#6a3ee6", "--accent-text": "#a68aff", "--text-on-accent": "#ffffff", "--focus-color": "#a68aff" },
  light: { "--accent": "#6a3bf0", "--accent-hover": "#5d2fe0", "--accent-active": "#5226cc", "--accent-text": "#6330e0", "--text-on-accent": "#ffffff", "--focus-color": "#6a3bf0" },
} as const;

function table(): { id: string; theme: ResolvedThemeName; tokens: Record<string, string> }[] {
  return ACCENTS.flatMap((a) =>
    THEMES.map((theme) => ({ id: a.id, theme, tokens: a.id === "violet" ? { ...VIOLET[theme] } : accentTokens(a, theme) })),
  );
}

describe("accent contrast table (WCAG AA)", () => {
  it("has at least ten selectable families plus the brand default", () => {
    expect(ACCENTS.length).toBeGreaterThanOrEqual(10);
    expect(ACCENTS[0].id).toBe("violet");
  });

  for (const { id, theme, tokens } of table()) {
    it(`${id} / ${theme}`, () => {
      const ink = tokens["--text-on-accent"];
      for (const k of ["--accent", "--accent-hover", "--accent-active"]) expect(contrast(ink, tokens[k]), `${k} ink`).toBeGreaterThanOrEqual(AA_TEXT);
      for (const s of SURFACES[theme]) {
        expect(contrast(tokens["--accent-text"], s), `text on ${s}`).toBeGreaterThanOrEqual(AA_TEXT);
        expect(contrast(tokens["--focus-color"], s), `focus on ${s}`).toBeGreaterThanOrEqual(AA_UI);
      }
      // The fill is a UI component: it has to stand out from the panel it sits on.
      expect(contrast(tokens["--accent"], SURFACES[theme][2]), "fill vs raised surface").toBeGreaterThanOrEqual(AA_UI);
    });
  }

  it("accent text on its own tinted background still reads (subtle chips, selected rows)", () => {
    for (const { id, theme, tokens } of table().filter((t) => t.id !== "violet")) {
      for (const s of SURFACES[theme]) {
        const bg = over(hexOf(tokens["--accent-subtle-hover"]), alphaOf(tokens["--accent-subtle-hover"]), s);
        expect(contrast(tokens["--accent-text"], bg), `${id}/${theme} on ${s}`).toBeGreaterThanOrEqual(AA_TEXT);
      }
      const sel = over(hexOf(tokens["--surface-selected"]), alphaOf(tokens["--surface-selected"]), SURFACES[theme][1]);
      expect(contrast(theme === "dark" ? "#ececee" : "#15181d", sel), `${id}/${theme} text-1 on selection`).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });
});

describe("custom colour", () => {
  it("auto-adjusts the lightness for AA, whatever the picked colour", () => {
    for (const hex of ["#ffff00", "#000000", "#ffffff", "#336699", "#ff00ff", "#00ff00", "#808080", "#123456"]) {
      const fam = customFamily(hex)!;
      expect(fam, hex).not.toBeNull();
      for (const theme of THEMES) {
        const t = accentTokens(fam, theme);
        expect(contrast(t["--text-on-accent"], t["--accent"]), `${hex}/${theme} fill`).toBeGreaterThanOrEqual(AA_TEXT);
        for (const s of SURFACES[theme]) expect(contrast(t["--accent-text"], s), `${hex}/${theme} text`).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }
  });
  it("rejects malformed hex and normalizes valid hex", () => {
    expect(customFamily("#12345")).toBeNull();
    expect(customFamily("blue")).toBeNull();
    expect(normalizeHex(" ABCDEF ")).toBe("#abcdef");
    expect(normalizeHex("#abc")).toBeNull();
  });
  it("round-trips through OKLCH", () => {
    const { L, C, h } = hexToOklch("#3b82f6");
    expect(oklchHex(L, C, h)).toBe("#3b82f6");
  });
});

describe("applying", () => {
  afterEach(() => {
    document.getElementById(ACCENT_STYLE_ID)?.remove();
    document.documentElement.removeAttribute("data-accent");
    localStorage.clear();
  });
  it("the brand violet adds no override", () => {
    expect(accentCss("violet")).toBe("");
    expect(tokensFor("violet", undefined, "dark")).toEqual({});
  });
  it("writes one style element with both themes and replaces it in place", () => {
    applyAccent("teal");
    expect(document.documentElement.dataset.accent).toBe("teal");
    const css = document.getElementById(ACCENT_STYLE_ID)!.textContent!;
    expect(css).toContain('[data-theme="dark"]');
    expect(css).toContain('[data-theme="light"]');
    applyAccent("amber");
    expect(document.querySelectorAll(`#${ACCENT_STYLE_ID}`)).toHaveLength(1);
    applyAccent("violet");
    expect(document.getElementById(ACCENT_STYLE_ID)).toBeNull();
  });
  it("a custom accent without a valid colour falls back to the brand", () => {
    applyAccent("custom", "nope");
    expect(document.documentElement.dataset.accent).toBe("violet");
  });
  it("applies from the localStorage mirror before first paint", () => {
    localStorage.setItem("intely.appearance", JSON.stringify({ accent: "custom", customAccent: "#2a9d8f" }));
    applyStoredAccent();
    expect(document.documentElement.dataset.accent).toBe("custom");
    expect(document.getElementById(ACCENT_STYLE_ID)!.textContent).toContain("--accent:");
  });
  it("junk in the mirror keeps the brand accent", () => {
    localStorage.setItem("intely.appearance", "{not json");
    applyStoredAccent();
    expect(document.getElementById(ACCENT_STYLE_ID)).toBeNull();
  });
});

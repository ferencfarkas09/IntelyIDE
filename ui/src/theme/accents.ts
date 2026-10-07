/**
 * Accent families. Every family is generated in OKLCH (hue + chroma, lightness solved) as a full token set for both themes
 * so that, by construction and by test (`accents.test.ts`):
 *  - the on-accent ink reads >= 4.5:1 on the base, hover and active fills,
 *  - the accent text / focus ring read >= 4.5:1 on every surface,
 *  - the fill itself is >= 3:1 against the panel surfaces (non-text UI contrast).
 * The brand violet (from the B2 logo) is the hand-tuned default and is NOT overridden: it lives in tokens.css.
 */
import { defaultStorage, readStored } from "../ui-kit/storage";

export type ResolvedThemeName = "dark" | "light";
export type Ink = "light" | "dark";

export interface AccentFamily {
  id: string;
  hue: number;
  chroma: number;
  /** Which ink sits on the fill. Light ink needs a dark-ish fill; yellow-ish families use dark ink on a light fill. */
  ink?: Ink;
  /** Repaint `--status-modified` with the info blue: the accent would collide with the ok / warn / danger status colours. */
  modifiedInfo?: boolean;
}

export const BRAND_ACCENT = "violet";
export const CUSTOM_ACCENT = "custom";

/** Order = order of the swatch grid. `violet` is the brand default and has no generated overrides. */
export const ACCENTS: readonly AccentFamily[] = [
  { id: "violet", hue: 292, chroma: 0.2 },
  { id: "indigo", hue: 270, chroma: 0.19 },
  { id: "blue", hue: 250, chroma: 0.18 },
  { id: "cyan", hue: 215, chroma: 0.13 },
  { id: "teal", hue: 188, chroma: 0.12, modifiedInfo: true },
  { id: "green", hue: 150, chroma: 0.15, modifiedInfo: true },
  { id: "amber", hue: 82, chroma: 0.16, ink: "dark", modifiedInfo: true },
  { id: "orange", hue: 50, chroma: 0.17, modifiedInfo: true },
  { id: "rose", hue: 8, chroma: 0.19, modifiedInfo: true },
  { id: "pink", hue: 345, chroma: 0.19, modifiedInfo: true },
  { id: "graphite", hue: 265, chroma: 0.012 },
];

export const ACCENT_IDS: readonly string[] = ACCENTS.map((a) => a.id);

/** The surfaces the accent text has to read on (tokens.css, worst case = the lightest dark surface / the darkest light one). */
export const SURFACES: Record<ResolvedThemeName, readonly string[]> = {
  dark: ["#0d0e10", "#131417", "#1a1b1f", "#202226", "#282a2f"],
  light: ["#e6e8ec", "#f8f9fa", "#ffffff", "#ffffff", "#f0f1f4"],
};

export const INK = { light: "#ffffff", dark: "#0d0e10" } as const;

/** AA thresholds used by the generator and asserted by the tests. */
export const AA_TEXT = 4.5;
export const AA_UI = 3;
const TARGET = 4.65;

// ---- colour maths --------------------------------------------------------------------------------------------------

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const toByte = (n: number) => Math.round(clamp01(n) * 255);
const encode = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const decode = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

const byteHex = (n: number) => toByte(n / 255).toString(16).padStart(2, "0");
export const rgbToHex = (r: number, g: number, b: number) => `#${byteHex(r)}${byteHex(g)}${byteHex(b)}`;

/** OKLCH to linear sRGB (unclamped). */
function oklchToLinear(L: number, C: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

const inGamut = (rgb: number[]) => rgb.every((c) => c >= -0.0005 && c <= 1.0005);

/** sRGB hex for an OKLCH colour; out-of-gamut chroma is reduced (lightness and hue are kept). */
export function oklchHex(L: number, C: number, hue: number): string {
  let c = C;
  let lin = oklchToLinear(L, c, hue);
  for (let i = 0; i < 40 && !inGamut(lin); i++) lin = oklchToLinear(L, (c *= 0.93), hue);
  return rgbToHex(...(lin.map((v) => encode(clamp01(v)) * 255) as [number, number, number]));
}

export function hexToOklch(hex: string): { L: number; C: number; h: number } {
  const [r, g, b] = hexToRgb(hex).map((v) => decode(v / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(a, bb), h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 };
}

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => decode(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Alpha-composites `fg` (with alpha) over an opaque `bg`. */
export function over(fg: string, alpha: number, bg: string): string {
  const f = hexToRgb(fg);
  const k = hexToRgb(bg);
  return rgbToHex(...(f.map((v, i) => v * alpha + k[i] * (1 - alpha)) as [number, number, number]));
}

const rgba = (hex: string, a: number) => `rgba(${hexToRgb(hex).join(", ")}, ${a})`;

// ---- token generation ----------------------------------------------------------------------------------------------

export type AccentTokens = Record<string, string>;

/** Walks the lightness from `from` in `step` until `ok` holds (or the range ends); returns the last tried value. */
function solve(from: number, step: number, limit: number, ok: (L: number) => boolean): number {
  let L = from;
  while (!ok(L)) {
    const next = L + step;
    if ((step > 0 && next > limit) || (step < 0 && next < limit)) return L;
    L = next;
  }
  return L;
}

export function accentTokens(f: AccentFamily, theme: ResolvedThemeName): AccentTokens {
  const dark = theme === "dark";
  const ink = f.ink ?? "light";
  const inkHex = INK[ink];
  const surfaces = SURFACES[theme];
  const fillAt = (L: number) => oklchHex(L, f.chroma, f.hue);
  // hover is lighter in the dark theme and darker in the light one; active is always the pressed (darker) step.
  const dHover = dark ? 0.025 : -0.03;
  const dActive = dark ? -0.035 : -0.06;
  const trio = (L: number) => [fillAt(L), fillAt(L + dHover), fillAt(L + dActive)];

  let L: number;
  if (ink === "light") {
    // The brightest fill that still carries white ink on base, hover and active.
    L = solve(dark ? 0.6 : 0.56, -0.005, 0.3, (x) => trio(x).every((c) => contrast(inkHex, c) >= TARGET));
  } else {
    L = solve(dark ? 0.8 : 0.78, 0.005, 0.95, (x) => trio(x).every((c) => contrast(inkHex, c) >= TARGET));
    // On the light theme a yellow fill melts into the white panel: take the lightest step that still has 3:1 against it.
    if (!dark) L = solve(L, -0.005, 0.5, (x) => contrast(fillAt(x), surfaces[2]) >= AA_UI + 0.05 || trio(x).some((c) => contrast(inkHex, c) < TARGET + 0.4));
  }
  const [fill, hover, active] = trio(L);

  // Text / icon / focus colour: it has to read on every surface of the theme.
  const textAt = (x: number) => oklchHex(x, f.chroma * 0.9, f.hue);
  const tintOf = (c: string) => (dark ? c : fill);
  const readsOnTint = (c: string, surface: string) => contrast(c, over(tintOf(c), dark ? 0.24 : 0.17, surface)) >= TARGET - 0.1;
  const T = dark
    ? solve(0.72, 0.005, 0.95, (x) => surfaces.every((s) => contrast(textAt(x), s) >= TARGET && readsOnTint(textAt(x), s)))
    : solve(0.54, -0.005, 0.25, (x) => surfaces.every((s) => contrast(textAt(x), s) >= TARGET && readsOnTint(textAt(x), s)));
  const text = textAt(T);
  const tint = dark ? text : fill;

  const tokens: AccentTokens = {
    "--accent": fill,
    "--accent-hover": hover,
    "--accent-active": active,
    "--accent-text": text,
    "--accent-subtle": rgba(tint, dark ? 0.15 : 0.1),
    "--accent-subtle-hover": rgba(tint, dark ? 0.24 : 0.17),
    "--accent-border": rgba(tint, dark ? 0.45 : 0.4),
    "--focus-color": text,
    "--text-on-accent": inkHex,
    "--surface-selected": rgba(tint, dark ? 0.18 : 0.11),
    "--selection-bg": rgba(tint, dark ? 0.36 : 0.22),
  };
  if (f.modifiedInfo) tokens["--status-modified"] = "var(--info)";
  return tokens;
}

/** Spec for a user-chosen colour: hue and chroma are kept, the lightness is solved for AA. Null for a malformed value. */
export function customFamily(hex: string): AccentFamily | null {
  if (!/^#?[0-9a-f]{6}$/i.test(hex.trim())) return null;
  const { L, C, h } = hexToOklch(hex.startsWith("#") ? hex : `#${hex.trim()}`);
  return { id: CUSTOM_ACCENT, hue: C < 0.02 ? 265 : h, chroma: Math.min(0.24, Math.max(C, 0.01)), ink: L > 0.72 ? "dark" : "light" };
}

export function normalizeHex(raw: string): string | null {
  const t = raw.trim();
  return /^#?[0-9a-f]{6}$/i.test(t) ? `#${t.replace("#", "").toLowerCase()}` : null;
}

export function resolveFamily(id: string, customHex?: string): AccentFamily | null {
  if (id === CUSTOM_ACCENT) return customHex ? customFamily(customHex) : null;
  return ACCENTS.find((a) => a.id === id) ?? null;
}

/** The generated override set (the brand violet returns {}: tokens.css already is that set). */
export function tokensFor(id: string, customHex: string | undefined, theme: ResolvedThemeName): AccentTokens {
  if (id === BRAND_ACCENT) return {};
  const fam = resolveFamily(id, customHex);
  return fam ? accentTokens(fam, theme) : {};
}

/** The colour of a swatch: the fill for `theme` (the brand violet reads its own token value). */
export function swatchColor(id: string, customHex: string | undefined, theme: ResolvedThemeName): string {
  if (id === BRAND_ACCENT) return theme === "dark" ? "#7447f5" : "#6a3bf0";
  return tokensFor(id, customHex, theme)["--accent"] ?? "#7447f5";
}

const block = (selector: string, tokens: AccentTokens) => `${selector}{${Object.entries(tokens).map(([k, v]) => `${k}:${v}`).join(";")}}`;

/** CSS for the chosen accent in both themes. The selectors are more specific than tokens.css, so source order never matters. */
export function accentCss(id: string, customHex?: string): string {
  if (id === BRAND_ACCENT) return "";
  const dark = tokensFor(id, customHex, "dark");
  const light = tokensFor(id, customHex, "light");
  if (!Object.keys(dark).length) return "";
  return [block(':root[data-accent][data-theme="dark"]', dark), block(':root[data-accent][data-theme="light"]', light)].join("\n");
}

export const ACCENT_STYLE_ID = "intely-accent";
export const APPEARANCE_MIRROR_KEY = "intely.appearance";

/** Sets `data-accent` and the override style element. Idempotent and cheap (one style element, replaced in place). */
export function applyAccent(id: string, customHex?: string, doc: Document | null = typeof document === "undefined" ? null : document): void {
  if (!doc) return;
  const root = doc.documentElement;
  const css = accentCss(id, customHex);
  root.dataset.accent = css ? id : BRAND_ACCENT;
  let el = doc.getElementById(ACCENT_STYLE_ID) as HTMLStyleElement | null;
  if (!css) return void el?.remove();
  if (!el) {
    el = doc.createElement("style");
    el.id = ACCENT_STYLE_ID;
    doc.head.appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;
}

/** First-paint path: reads the localStorage mirror of the appearance settings, no async work. */
export function applyStoredAccent(): void {
  try {
    const raw = JSON.parse(readStored(APPEARANCE_MIRROR_KEY, defaultStorage()) ?? "{}") as { accent?: unknown; customAccent?: unknown };
    const id = typeof raw.accent === "string" ? raw.accent : BRAND_ACCENT;
    const custom = typeof raw.customAccent === "string" ? raw.customAccent : undefined;
    applyAccent(resolveFamily(id, custom) ? id : BRAND_ACCENT, custom);
  } catch {
    /* junk in the mirror: keep the brand accent */
  }
}

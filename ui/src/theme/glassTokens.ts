/**
 * The numbers behind glass.css, as data: the gradient stops of the window backdrop and the tint (colour + alpha) of each
 * glass surface. accents.ts composites them into the worst-case backgrounds that every accent and text token has to read on;
 * glass.test.ts checks that glass.css still uses exactly these values.
 */
export type GlassTheme = "dark" | "light";

export interface Tint {
  color: string;
  alpha: number;
}

export interface GlassSpec {
  /** Base colour first, then the four corner glows of the backdrop gradient. */
  stops: readonly string[];
  /**
   * The tints of glass.css: --surface-0 (chrome), --glass-panel (the one panel layer; --surface-1 itself is transparent so
   * nested panels never stack), --surface-2 (raised, on a panel), --surface-3 (overlay) and --surface-4 (control, on a panel).
   */
  surfaces: readonly [Tint, Tint, Tint, Tint, Tint];
}

export const GLASS: Record<GlassTheme, GlassSpec> = {
  light: {
    stops: ["#eef0fb", "#dde7ff", "#e9e2ff", "#ffe1d2", "#dfe9ff"],
    surfaces: [
      { color: "#ffffff", alpha: 0.3 },
      { color: "#ffffff", alpha: 0.62 },
      { color: "#ffffff", alpha: 0.74 },
      { color: "#ffffff", alpha: 0.86 },
      { color: "#f3f4fa", alpha: 0.86 },
    ],
  },
  dark: {
    stops: ["#0d1022", "#1a245e", "#2b1a5a", "#0a2c3a", "#142050"],
    surfaces: [
      { color: "#0a0c1a", alpha: 0.4 },
      { color: "#141628", alpha: 0.62 },
      { color: "#24273f", alpha: 0.6 },
      { color: "#1f2237", alpha: 0.9 },
      { color: "#262941", alpha: 0.88 },
    ],
  },
};

/** Surfaces 2 and 4 are drawn on a panel (surface 1); the others sit straight on the backdrop. */
export const ON_PANEL: readonly number[] = [2, 4];

export const rgbaOf = ({ color, alpha }: Tint): string => {
  const h = color.replace("#", "");
  return `rgba(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}, ${alpha})`;
};

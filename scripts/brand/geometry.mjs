// B2 logo geometry, shared by build-brand.mjs. Numbers come from assets/brand/source/B2*.dc.html.

export const PALETTE = {
  dark: { ink: "#FFFFFF", sub: "#B7A6E8", ideA: "#9B7BFF", ideB: "#E36BF5", shadow: 0.5 },
  light: { ink: "#1A0A2E", sub: "#5B4B7A", ideA: "#6A3BF0", ideB: "#B82FD0", shadow: 0.18 },
};

export const TILE = { from: "#3D1458", to: "#160823" };

/** The three code lines. x1..x2 is the gradient run; d is the stroked centre line. */
export const BARS = [
  { d: "M64 92 H171", x1: 45, x2: 190, y: 92, from: "#2EE6C5", to: "#2B6CF6" },
  { d: "M104 150 H209", x1: 85, x2: 228, y: 150, from: "#7C4DFF", to: "#D946EF" },
  { d: "M64 208 H141", x1: 45, x2: 160, y: 208, from: "#E5306F", to: "#FF9A1F" },
];
export const BAR_WIDTH = 38;
export const CURSOR = { d: "M250 131 V169", width: 14 };
export const SPARK = {
  d: "M0 -1 C0.18 -0.18 0.18 -0.18 1 0 C0.18 0.18 0.18 0.18 0 1 C-0.18 0.18 -0.18 0.18 -1 0 C-0.18 -0.18 -0.18 -0.18 0 -1 Z",
  transform: "translate(250 100) scale(17)",
};
export const MARK_VIEWBOX = [6, 0, 300, 300];

/** Simplified mark for 16 and 32 px: heavier bars, a taller cursor, no spark. */
export const SMALL_BARS = [
  { d: "M66 84 H170", x1: 44, x2: 192, y: 84, from: "#2EE6C5", to: "#2B6CF6" },
  { d: "M108 150 H206", x1: 86, x2: 228, y: 150, from: "#7C4DFF", to: "#D946EF" },
  { d: "M66 216 H146", x1: 44, x2: 168, y: 216, from: "#E5306F", to: "#FF9A1F" },
];
export const SMALL_BAR_WIDTH = 44;
export const SMALL_CURSOR = { d: "M252 126 V174", width: 20 };
export const SMALL_VIEWBOX = [3, 0, 300, 300];

/** Visible extent of the full mark in its own units (bars, cursor and spark; no shadow). */
export const MARK_BOUNDS = { x1: 45, x2: 267, y1: 73, y2: 227 };

export const SHADOW = { dy: 5, blur: 5, color: "#0E0419" };

/** Wordmark and subtitle settings, from the lockup sources. */
export const TEXT = {
  titleLetterSpacing: 0.08,
  subLetterSpacing: 0.6,
  ascent: 0.97,
  descent: 0.29,
  horizontal: { title: 76, sub: 17, gap: 18, markScale: 0.7, markGap: 64 },
  stacked: { title: 56, sub: 14, gap: 16, markScale: 1, markGap: 44 },
  padding: 24,
};

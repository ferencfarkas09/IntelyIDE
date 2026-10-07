import type { ITheme } from "@xterm/xterm";

/** Moves `from` towards `to` by `t` (0..1). Only `#rgb`/`#rrggbb` values can be mixed; anything else comes back unchanged. */
export function mixColor(from: string, to: string, t: number): string {
  const rgb = (c: string) => {
    const h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim())?.[1];
    if (!h) return undefined;
    const full = h.length === 3 ? [...h].map((x) => x + x).join("") : h;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  };
  const a = rgb(from);
  const b = rgb(to);
  if (!a || !b) return from;
  return `#${a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, "0")).join("")}`;
}

/** The terminal palette from the design tokens; `read("--ok")` returns the resolved value of a token in the current theme. */
export function xtermTheme(read: (token: string) => string): ITheme {
  const ink = read("--text-1");
  const bright = (token: string) => mixColor(read(token), ink, 0.28);
  return {
    background: read("--surface-1"),
    foreground: ink,
    cursor: read("--accent-text"),
    cursorAccent: read("--surface-1"),
    selectionBackground: read("--selection-bg"),
    selectionInactiveBackground: read("--surface-selected-inactive"),
    black: read("--surface-4"),
    red: read("--danger"),
    green: read("--ok"),
    yellow: read("--warn"),
    blue: read("--info"),
    magenta: read("--syn-keyword"),
    cyan: read("--syn-type"),
    white: read("--text-2"),
    brightBlack: read("--text-4"),
    brightRed: bright("--danger"),
    brightGreen: bright("--ok"),
    brightYellow: bright("--warn"),
    brightBlue: bright("--info"),
    brightMagenta: bright("--syn-keyword"),
    brightCyan: bright("--syn-type"),
    brightWhite: ink,
  };
}

export const readToken = (token: string): string => getComputedStyle(document.documentElement).getPropertyValue(token).trim();

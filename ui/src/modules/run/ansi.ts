/** SGR colours and styles for the Run panel's log view. Other escape sequences (cursor moves, OSC titles) are dropped. */

export interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface Segment extends Style {
  text: string;
  /** Set by `highlight` for a search match. */
  hit?: boolean;
}

const BASE = ["var(--ansi-0)", "var(--ansi-1)", "var(--ansi-2)", "var(--ansi-3)", "var(--ansi-4)", "var(--ansi-5)", "var(--ansi-6)", "var(--ansi-7)"];
const BRIGHT = ["var(--ansi-8)", "var(--ansi-9)", "var(--ansi-10)", "var(--ansi-11)", "var(--ansi-12)", "var(--ansi-13)", "var(--ansi-14)", "var(--ansi-15)"];
const CSI = /\x1b\[([0-9;:?]*)([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g;

/** xterm's 256-colour palette entry `n`. */
export function palette256(n: number): string {
  if (n < 8) return BASE[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v} ${v} ${v})`;
  }
  const i = n - 16;
  const level = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${level(Math.floor(i / 36))} ${level(Math.floor(i / 6) % 6)} ${level(i % 6)})`;
}

function applySgr(style: Style, params: number[]): Style {
  let next: Style = { ...style };
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) next = {};
    else if (p === 1) next.bold = true;
    else if (p === 2) next.dim = true;
    else if (p === 3) next.italic = true;
    else if (p === 4) next.underline = true;
    else if (p === 22) (next.bold = false), (next.dim = false);
    else if (p === 23) next.italic = false;
    else if (p === 24) next.underline = false;
    else if (p >= 30 && p <= 37) next.fg = BASE[p - 30];
    else if (p >= 90 && p <= 97) next.fg = BRIGHT[p - 90];
    else if (p >= 40 && p <= 47) next.bg = BASE[p - 40];
    else if (p >= 100 && p <= 107) next.bg = BRIGHT[p - 100];
    else if (p === 39) delete next.fg;
    else if (p === 49) delete next.bg;
    else if (p === 38 || p === 48) {
      const key = p === 38 ? "fg" : "bg";
      if (params[i + 1] === 5 && params[i + 2] !== undefined) {
        next[key] = palette256(Math.max(0, Math.min(255, params[i + 2])));
        i += 2;
      } else if (params[i + 1] === 2 && params.length >= i + 5) {
        const [r, g, b] = params.slice(i + 2, i + 5).map((v) => Math.max(0, Math.min(255, v)));
        next[key] = `rgb(${r} ${g} ${b})`;
        i += 4;
      }
    }
  }
  return next;
}

/** One log line as styled runs. The style starts clean on every line. */
export function parseAnsi(line: string): Segment[] {
  const out: Segment[] = [];
  let style: Style = {};
  let at = 0;
  const push = (text: string) => text && out.push({ ...style, text });
  for (const m of line.matchAll(CSI)) {
    push(line.slice(at, m.index));
    at = (m.index ?? 0) + m[0].length;
    if (m[2] === "m") style = applySgr(style, (m[1] === "" ? "0" : m[1]).split(/[;:]/).map((v) => Number(v) || 0));
  }
  push(line.slice(at));
  return out.length ? out : [{ text: "" }];
}

/** The line without any escape sequence (what search and copy see). */
export const stripAnsi = (line: string): string => line.replace(CSI, "");

/** Splits the runs at every case-insensitive occurrence of `query` inside a run and marks them as hits. */
export function highlight(segments: Segment[], query: string): Segment[] {
  const q = query.toLowerCase();
  if (!q) return segments;
  const out: Segment[] = [];
  for (const seg of segments) {
    const lower = seg.text.toLowerCase();
    let at = 0;
    for (let hit = lower.indexOf(q); hit !== -1; hit = lower.indexOf(q, at)) {
      if (hit > at) out.push({ ...seg, text: seg.text.slice(at, hit) });
      out.push({ ...seg, text: seg.text.slice(hit, hit + q.length), hit: true });
      at = hit + q.length;
    }
    if (at < seg.text.length || at === 0) out.push({ ...seg, text: seg.text.slice(at) });
  }
  return out;
}

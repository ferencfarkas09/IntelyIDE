// @ts-expect-error node built-in (the ui package has no node typings)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * WebKit (the Mac web view) can stop painting the text of a scrolling list when a compositing trigger sits on the scroller, on
 * one of its ancestors, or on something inside its rows (1.14.1: the copy button of every message had a backdrop-filter, in rows
 * that move with `transform`). The transcript and the run log must stay plain surfaces; Glass frosts the chrome around them.
 */
// vitest runs from ui/ (the same working directory as `pnpm --dir ui test`).
declare const process: { cwd(): string };
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name: string) => {
    const p = `${dir}/${name}`;
    return statSync(p).isDirectory() ? files(p) : name.endsWith(".css") ? [p] : [];
  });

// Classes of the transcript, the run log, their rows and cards, and every pane that holds them.
const GUARDED = [
  "transcript", "transcript__scroll", "transcript__inner", "transcript__row", "transcript__col",
  "msg", "msg-row", "msg-row__main", "msg__bubble", "msg__text", "msg__copy", "msg__meta", "md", "tool-card",
  "chat", "chat__top", "agent-centre", "agent-centre__run", "agent", "centre", "shell", "shell__mode",
  "run-log", "run-log__body", "run-log__follow", "ui-scroll", "ui-scroll__viewport",
];
const TRIGGERS = /(^|[;\s])(-webkit-)?backdrop-filter\s*:|(^|[;\s])will-change\s*:|(^|[;\s])content-visibility\s*:|(^|[;\s])contain\s*:\s*[^;]*\b(paint|strict|content)\b|(^|[;\s])(-webkit-)?filter\s*:\s*(?!none)/;
const hits = (sel: string) => GUARDED.filter((c) => new RegExp(`\\.${c}(?![\\w-])`).test(sel));

function offenders(css: string): string[] {
  const out: string[] = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!TRIGGERS.test(m[2])) continue;
    for (const sel of m[1].split(",")) if (hits(sel).length) out.push(sel.trim().replace(/\s+/g, " "));
  }
  return out;
}

describe("transcript and run log stay free of compositing triggers", () => {
  const sheets = files(`${process.cwd()}/src`).map((p) => ({ name: p.split("/src/")[1], css: readFileSync(p, "utf8") }));

  it("finds the style sheets", () => {
    expect(sheets.length).toBeGreaterThan(10);
    expect(sheets.some((s) => s.name === "theme/glass.css")).toBe(true);
    expect(sheets.some((s) => s.name === "components/chat/chat.css")).toBe(true);
  });

  it("no rule puts backdrop-filter, will-change, content-visibility, contain: paint or a filter on the transcript, the run log, their rows or their ancestors", () => {
    for (const s of sheets) expect({ file: s.name, selectors: offenders(s.css) }).toEqual({ file: s.name, selectors: [] });
  });

  it("the guard itself catches the 1.14.1 regression", () => {
    const bad = `:root[data-skin="glass"] :is(.ui-popover, .msg__copy) { -webkit-backdrop-filter: blur(28px); backdrop-filter: blur(28px); }
    .transcript__row { will-change: transform; } .agent-centre { contain: paint; } .ui-popover { backdrop-filter: blur(4px); }`;
    const found = offenders(bad).join(" | ");
    expect(found).toContain(".msg__copy");
    expect(found).toContain(".transcript__row");
    expect(found).toContain(".agent-centre");
    expect(found).not.toContain(".ui-popover");
    expect(offenders(".ui-popover { backdrop-filter: blur(4px); }")).toEqual([]);
  });
});

// The document engine behind the JSON/JSONL/log viewer. Pure and synchronous (it runs in a worker, or in-thread in tests):
// it owns the parsed value and answers "which rows are visible" so the page only ever holds a window of rows.

import { childEntries, getAt, looksLikeQuery, pathToString, QueryError, runQuery, type Key, type Value } from "./jsonPath";

export type RowType = "object" | "array" | "string" | "number" | "boolean" | "null" | "line";
export type Level = "error" | "warn" | "info" | "debug";

export interface Row {
  /** Unique and stable while the document is unchanged. */
  id: string;
  depth: number;
  /** Object key, array index (as text) or the 1-based line number for a log line. */
  label: string;
  type: RowType;
  preview: string;
  expandable: boolean;
  open: boolean;
  /** The row's own path from the root; for a "show more" row, the path of the container it continues. */
  path: Key[];
  /** A "show more" row: `more` children are still hidden below `path`. */
  more?: number;
  level?: Level;
}

export type DocKind = "json" | "lines";

const PAGE = 200;
const PREVIEW_MAX = 160;
const LEVEL_RE = /\b(ERROR|ERR|FATAL|CRITICAL|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/i;

export function levelOf(text: string): Level | undefined {
  const m = LEVEL_RE.exec(text.length > 400 ? text.slice(0, 400) : text);
  if (!m) return undefined;
  const w = m[1].toUpperCase();
  if (w === "ERROR" || w === "ERR" || w === "FATAL" || w === "CRITICAL") return "error";
  if (w.startsWith("WARN")) return "warn";
  return w === "INFO" ? "info" : "debug";
}

const cut = (s: string, n = PREVIEW_MAX) => (s.length > n ? `${s.slice(0, n)}…` : s);

function typeOf(v: Value): RowType {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  switch (typeof v) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "object";
  }
}

function previewOf(v: Value, type: RowType): string {
  switch (type) {
    case "object": {
      const n = Object.keys(v as object).length;
      return n === 0 ? "{}" : `{ ${n} ${n === 1 ? "key" : "keys"} }`;
    }
    case "array": {
      const n = (v as unknown[]).length;
      return n === 0 ? "[]" : `[ ${n} ${n === 1 ? "item" : "items"} ]`;
    }
    case "string":
      return cut(JSON.stringify(v));
    case "null":
      return "null";
    default:
      return String(v);
  }
}

const idOf = (path: readonly Key[]): string => path.map(seg).join("");
const seg = (k: Key): string => (typeof k === "number" ? `[${k}]` : `.${k.replace(/\\/g, "\\\\").replace(/\./g, "\\.")}`);

export interface SearchHit {
  path: Key[];
  pathText: string;
  preview: string;
  type: RowType;
  where: "key" | "value" | "line";
}

export interface QueryResult {
  hits: SearchHit[];
  /** True when more than `hits.length` results exist. */
  truncated: boolean;
  error?: string;
}

export class DocEngine {
  private root: Value = null;
  private kind: DocKind = "json";
  private rows: Row[] = [];
  /** Open containers: row id -> how many children are shown. */
  private shown = new Map<string, number>();
  private dirty = true;

  load(root: Value, kind: DocKind): void {
    this.root = root;
    this.kind = kind;
    this.shown.clear();
    this.dirty = true;
    if (kind === "json") this.shown.set("", PAGE);
  }

  /** Lines mode while streaming: more lines arrived. */
  appendLines(values: Value[]): void {
    if (!Array.isArray(this.root)) this.root = [];
    const arr = this.root as Value[];
    for (const v of values) arr.push(v);
    this.dirty = true;
  }

  get lineCount(): number {
    return Array.isArray(this.root) ? this.root.length : 0;
  }

  total(): number {
    this.ensure();
    return this.rows.length;
  }

  window(start: number, count: number): Row[] {
    this.ensure();
    return this.rows.slice(Math.max(0, start), Math.max(0, start) + count);
  }

  toggle(index: number): number {
    this.ensure();
    const row = this.rows[index];
    if (!row) return this.rows.length;
    const id = idOf(row.path);
    if (row.more !== undefined) this.shown.set(id, (this.shown.get(id) ?? PAGE) + PAGE);
    else if (row.expandable) {
      if (this.shown.has(id)) this.shown.delete(id);
      else this.shown.set(id, PAGE);
    }
    this.dirty = true;
    return this.total();
  }

  /** Opens every container down to `depth` (0 = only the root), at most ~20k rows. */
  expandLevel(depth: number): number {
    this.shown.clear();
    let budget = 20_000;
    const walk = (v: Value, path: Key[], d: number) => {
      if (d > depth || budget <= 0) return;
      const kids = childEntries(v);
      if (!kids.length) return;
      this.shown.set(idOf(path), PAGE);
      budget -= Math.min(kids.length, PAGE);
      for (const [k, c] of kids.slice(0, PAGE)) walk(c, [...path, k], d + 1);
    };
    if (this.kind === "json") walk(this.root, [], 0);
    else (Array.isArray(this.root) ? (this.root as Value[]) : []).forEach((v, i) => typeof v !== "string" && walk(v, [i], 1));
    this.dirty = true;
    return this.total();
  }

  collapseAll(): number {
    this.shown.clear();
    if (this.kind === "json") this.shown.set("", PAGE);
    this.dirty = true;
    return this.total();
  }

  /** Opens every ancestor of `path` (and widens the pages) and returns the row index of `path`, or -1. */
  reveal(path: readonly Key[]): number {
    for (let i = this.kind === "json" ? 0 : 1; i < path.length; i++) {
      const container = path.slice(0, i);
      const need = childEntries(getAt(this.root, container)).findIndex(([k]) => k === path[i]) + 1;
      const cid = idOf(container);
      this.shown.set(cid, Math.max(this.shown.get(cid) ?? PAGE, Math.ceil(need / PAGE) * PAGE));
    }
    this.dirty = true;
    this.ensure();
    const id = idOf(path);
    return this.rows.findIndex((r) => r.id === id && r.more === undefined);
  }

  pathText(path: readonly Key[]): string {
    if (this.kind !== "lines" || !path.length) return pathToString(path);
    return `line ${Number(path[0]) + 1}${path.length > 1 ? pathToString(path.slice(1)) : ""}`;
  }

  /** The text copied by "Copy value": strings raw for a line, JSON (pretty, capped) for the rest. */
  valueText(path: readonly Key[], max = 2_000_000): string {
    const v = getAt(this.root, path);
    if (typeof v === "string" && this.kind === "lines") return v;
    const s = JSON.stringify(v, null, 2) ?? "";
    return s.length > max ? `${s.slice(0, max)}\n… (cut at ${max} characters)` : s;
  }

  /** Text search over keys and scalar values (or lines), or a jq-like query when the text starts with `.`, `[` or `select(`. */
  search(q: string, limit = 500): QueryResult {
    const text = q.trim();
    if (!text) return { hits: [], truncated: false };
    if (looksLikeQuery(text)) return this.query(text, limit);
    const needle = text.toLowerCase();
    const hits: SearchHit[] = [];
    let truncated = false;
    const stack: { v: Value; path: Key[] }[] = [{ v: this.root, path: [] }];
    // iterative depth-first, in document order
    while (stack.length) {
      const { v, path } = stack.pop()!;
      const kids = childEntries(v);
      const isLine = this.kind === "lines" && path.length === 1;
      if (path.length) {
        const key = path[path.length - 1];
        const keyHit = typeof key === "string" && key.toLowerCase().includes(needle);
        const scalar = kids.length === 0 && v !== undefined;
        const valueHit = scalar && String(v).toLowerCase().includes(needle);
        const lineHit = isLine && typeof v === "string" && v.toLowerCase().includes(needle);
        if (keyHit || valueHit || lineHit) {
          if (hits.length >= limit) {
            truncated = true;
            break;
          }
          const type = isLine && typeof v === "string" ? "line" : typeOf(v);
          hits.push({ path, pathText: this.pathText(path), preview: previewOf(v, type === "line" ? "string" : type), type, where: lineHit ? "line" : keyHit ? "key" : "value" });
        }
      }
      for (let i = kids.length - 1; i >= 0; i--) stack.push({ v: kids[i][1], path: [...path, kids[i][0]] });
    }
    return { hits, truncated };
  }

  query(expr: string, limit = 500): QueryResult {
    try {
      const res = runQuery(this.root, expr, limit + 1);
      const truncated = res.length > limit;
      return {
        truncated,
        hits: res.slice(0, limit).map((h) => {
          const type = typeOf(h.value);
          return { path: h.path, pathText: this.pathText(h.path), preview: previewOf(h.value, type), type, where: "value" as const };
        }),
      };
    } catch (e) {
      if (e instanceof QueryError) return { hits: [], truncated: false, error: e.message };
      throw e;
    }
  }

  /** Number of lines per level (lines mode), for the log toolbar. */
  levelCounts(): Record<Level, number> {
    const out: Record<Level, number> = { error: 0, warn: 0, info: 0, debug: 0 };
    if (this.kind !== "lines" || !Array.isArray(this.root)) return out;
    for (const v of this.root as Value[]) {
      const lv = levelOf(typeof v === "string" ? v : lineLevel(v));
      if (lv) out[lv]++;
    }
    return out;
  }

  /** Index (line number - 1) of the next line at or above `severity`, searching from `from` in `dir`; -1 when none. */
  nextLevel(level: Level, from: number, dir: 1 | -1): number {
    if (!Array.isArray(this.root)) return -1;
    const arr = this.root as Value[];
    for (let i = from + dir; i >= 0 && i < arr.length; i += dir) {
      const v = arr[i];
      if (levelOf(typeof v === "string" ? v : lineLevel(v)) === level) return i;
    }
    return -1;
  }

  private ensure(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const out: Row[] = [];
    if (this.kind === "json") {
      const t = typeOf(this.root);
      const open = this.shown.has("");
      out.push({ id: "", depth: 0, label: "$", type: t, preview: previewOf(this.root, t), expandable: childEntries(this.root).length > 0, open, path: [] });
      if (open) this.emitChildren(out, this.root, [], 1);
    } else {
      const arr = (Array.isArray(this.root) ? this.root : []) as Value[];
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        const path = [i];
        const id = `[${i}]`;
        if (typeof v === "string") {
          out.push({ id, depth: 0, label: String(i + 1), type: "line", preview: v, expandable: false, open: false, path, level: levelOf(v) });
          continue;
        }
        const open = this.shown.has(id);
        out.push({ id, depth: 0, label: String(i + 1), type: typeOf(v), preview: cut(JSON.stringify(v), 400), expandable: childEntries(v).length > 0, open, path, level: levelOf(lineLevel(v)) });
        if (open) this.emitChildren(out, v, path, 1);
      }
    }
    this.rows = out;
  }

  private emitChildren(out: Row[], value: Value, path: Key[], depth: number): void {
    const kids = childEntries(value);
    const shown = this.shown.get(idOf(path)) ?? PAGE;
    const upto = Math.min(kids.length, shown);
    for (let i = 0; i < upto; i++) {
      const [k, v] = kids[i];
      const t = typeOf(v);
      const childPath = [...path, k];
      const id = idOf(childPath);
      const expandable = (t === "object" || t === "array") && childEntries(v).length > 0;
      const open = expandable && this.shown.has(id);
      out.push({ id, depth, label: String(k), type: t, preview: previewOf(v, t), expandable, open, path: childPath });
      if (open) this.emitChildren(out, v, childPath, depth + 1);
    }
    if (kids.length > upto) {
      const hidden = kids.length - upto;
      out.push({ id: `${idOf(path)}…more`, depth, label: "", type: "string", preview: `Show ${Math.min(PAGE, hidden)} more (${hidden} hidden)`, expandable: false, open: false, path, more: hidden });
    }
  }
}

/** What the level of a JSON log line is read from: its `level`/`severity` field, else the raw text. */
function lineLevel(v: Value): string {
  if (v && typeof v === "object") {
    const o = v as Record<string, Value>;
    const l = o.level ?? o.severity ?? o.lvl;
    if (typeof l === "string") return l;
  }
  return "";
}

// jq-like paths and queries over a parsed value. Supported: `.`, `.key`, `."odd key"`, `[3]`, `[-1]`, `[]`, `[2:5]`, `..`, `..key`,
// pipes (`|`) and `select(<path> [==|!=|>|<|>=|<=|~ literal])`. Anything else is a readable error, never a crash.

export type Key = string | number;
export type Value = unknown;

export interface Hit {
  path: Key[];
  value: Value;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `.a.b[0]` / `."odd key"` form of a path, for copying. */
export function pathToString(path: readonly Key[]): string {
  if (!path.length) return ".";
  return path.map((k) => (typeof k === "number" ? `[${k}]` : IDENT.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`)).join("");
}

export function getAt(root: Value, path: readonly Key[]): Value {
  let v = root;
  for (const k of path) {
    if (v === null || typeof v !== "object") return undefined;
    v = (v as Record<Key, Value>)[k];
  }
  return v;
}

export function childEntries(v: Value): [Key, Value][] {
  if (Array.isArray(v)) return v.map((x, i) => [i, x]);
  if (v !== null && typeof v === "object") return Object.entries(v as Record<string, Value>);
  return [];
}

export class QueryError extends Error {}

type Step =
  | { t: "key"; key: string }
  | { t: "index"; i: number }
  | { t: "slice"; a: number | null; b: number | null }
  | { t: "iterate" }
  | { t: "recurse"; key?: string }
  | { t: "select"; path: Step[]; op?: string; lit?: Value };

function parsePathSteps(src: string, at: { i: number }): Step[] {
  const steps: Step[] = [];
  const s = src;
  const skip = () => {
    while (at.i < s.length && s[at.i] === " ") at.i++;
  };
  while (at.i < s.length) {
    const c = s[at.i];
    if (c === "." && s[at.i + 1] === ".") {
      at.i += 2;
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(at.i));
      if (m) (steps.push({ t: "recurse", key: m[0] }), (at.i += m[0].length));
      else steps.push({ t: "recurse" });
    } else if (c === ".") {
      at.i++;
      if (s[at.i] === '"') {
        const end = findQuoteEnd(s, at.i);
        steps.push({ t: "key", key: JSON.parse(s.slice(at.i, end + 1)) as string });
        at.i = end + 1;
      } else {
        const m = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(s.slice(at.i));
        if (m) (steps.push({ t: "key", key: m[0] }), (at.i += m[0].length));
      }
    } else if (c === "[") {
      const close = s.indexOf("]", at.i);
      if (close < 0) throw new QueryError("missing ]");
      const inner = s.slice(at.i + 1, close).trim();
      at.i = close + 1;
      if (inner === "") steps.push({ t: "iterate" });
      else if (/^-?\d+$/.test(inner)) steps.push({ t: "index", i: Number(inner) });
      else if (/^-?\d*:-?\d*$/.test(inner)) {
        const [a, b] = inner.split(":");
        steps.push({ t: "slice", a: a === "" ? null : Number(a), b: b === "" ? null : Number(b) });
      } else if (inner.startsWith('"')) steps.push({ t: "key", key: JSON.parse(inner) as string });
      else throw new QueryError(`bad index [${inner}]`);
    } else {
      skip();
      break;
    }
  }
  return steps;
}

function findQuoteEnd(s: string, start: number): number {
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === '"') return i;
  }
  throw new QueryError("unterminated string");
}

function parseStage(raw: string): Step[] {
  const src = raw.trim();
  if (src === "" || src === ".") return [];
  const sel = /^select\((.*)\)$/s.exec(src);
  if (sel) {
    const inner = sel[1].trim();
    const m = /^(.*?)\s*(==|!=|>=|<=|>|<|~)\s*(.+)$/s.exec(inner);
    const pathSrc = m ? m[1] : inner;
    const at = { i: 0 };
    const path = parsePathSteps(pathSrc.trim(), at);
    if (at.i < pathSrc.trim().length) throw new QueryError(`cannot read "${pathSrc.trim().slice(at.i)}"`);
    if (!m) return [{ t: "select", path }];
    let lit: Value;
    try {
      lit = JSON.parse(m[3].trim());
    } catch {
      throw new QueryError(`"${m[3].trim()}" is not a JSON literal (use "text", 12, true, null)`);
    }
    return [{ t: "select", path, op: m[2], lit }];
  }
  const at = { i: 0 };
  const steps = parsePathSteps(src, at);
  if (at.i < src.length || (!steps.length && src !== ".")) throw new QueryError(`cannot read "${src.slice(at.i)}"`);
  return steps;
}

/** Splits on `|` outside quotes and parentheses. */
function splitPipes(expr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let q = false;
  let cur = "";
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (q) {
      cur += c;
      if (c === "\\") cur += expr[++i] ?? "";
      else if (c === '"') q = false;
      continue;
    }
    if (c === '"') q = true;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "|" && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function apply(hits: Hit[], step: Step, limit: number): Hit[] {
  const out: Hit[] = [];
  const push = (h: Hit) => out.length < limit && out.push(h);
  for (const h of hits) {
    switch (step.t) {
      case "key": {
        if (h.value !== null && typeof h.value === "object" && !Array.isArray(h.value) && step.key in (h.value as object)) push({ path: [...h.path, step.key], value: (h.value as Record<string, Value>)[step.key] });
        break;
      }
      case "index": {
        if (Array.isArray(h.value)) {
          const i = step.i < 0 ? h.value.length + step.i : step.i;
          if (i >= 0 && i < h.value.length) push({ path: [...h.path, i], value: h.value[i] });
        }
        break;
      }
      case "slice": {
        if (Array.isArray(h.value)) {
          const n = h.value.length;
          const norm = (x: number | null, d: number) => (x === null ? d : x < 0 ? Math.max(0, n + x) : Math.min(n, x));
          for (let i = norm(step.a, 0); i < norm(step.b, n); i++) push({ path: [...h.path, i], value: h.value[i] });
        }
        break;
      }
      case "iterate":
        for (const [k, v] of childEntries(h.value)) push({ path: [...h.path, k], value: v });
        break;
      case "recurse": {
        const stack: Hit[] = [h];
        while (stack.length && out.length < limit) {
          const cur = stack.pop()!;
          const kids = childEntries(cur.value).map(([k, v]): Hit => ({ path: [...cur.path, k], value: v }));
          for (const kid of kids.slice().reverse()) stack.push(kid);
          if (cur !== h && (step.key === undefined || cur.path[cur.path.length - 1] === step.key)) push(cur);
        }
        break;
      }
      case "select": {
        let r: Hit[] = [{ path: [], value: h.value }];
        for (const s of step.path) r = apply(r, s, 100);
        const ok = r.some((x) => test(x.value, step.op, step.lit));
        if (ok) push(h);
        break;
      }
    }
    if (out.length >= limit) break;
  }
  return out;
}

function test(v: Value, op: string | undefined, lit: Value): boolean {
  if (!op) return v !== null && v !== undefined && v !== false;
  switch (op) {
    case "==":
      return JSON.stringify(v) === JSON.stringify(lit);
    case "!=":
      return JSON.stringify(v) !== JSON.stringify(lit);
    case "~":
      return typeof v === "string" && typeof lit === "string" && v.toLowerCase().includes(lit.toLowerCase());
    default: {
      if (typeof v !== typeof lit || (typeof v !== "number" && typeof v !== "string")) return false;
      const a = v as number | string;
      const b = lit as number | string;
      return op === ">" ? a > b : op === "<" ? a < b : op === ">=" ? a >= b : a <= b;
    }
  }
}

/** Runs `expr` over `root`. Throws `QueryError` for text it cannot read. At most `limit` results. */
export function runQuery(root: Value, expr: string, limit = 1000): Hit[] {
  const stages = splitPipes(expr).map(parseStage);
  let hits: Hit[] = [{ path: [], value: root }];
  // the cap applies to the answer, not to what a later `select` still has to look at
  const inner = Math.max(limit, 200_000);
  for (const stage of stages) for (const step of stage) hits = apply(hits, step, inner);
  return hits.slice(0, limit);
}

/** A query starts with `.`, `[`, `select(` or `..`; anything else is plain text search. */
export const looksLikeQuery = (q: string): boolean => /^\s*(\.|\[|select\()/.test(q);

// A client-side reader for the mongosh literal subset (unquoted keys, single quotes, trailing commas, comments,
// ObjectId()/ISODate()/new Date()/NumberLong()/..., regex literals). It exists for the live lint of the query bar and for
// the mock backend; the authoritative parser is `crates/mongo/src/shell.rs`, which parses again on every run.
// The result uses Extended JSON wrappers for typed values and plain JS numbers for number literals.

import type { Json } from "./ejson";

export class LiteralError extends Error {
  constructor(message: string, readonly line: number, readonly column: number, readonly offset: number) {
    super(message);
  }
}

const MAX_DEPTH = 32;

class Reader {
  i = 0;
  constructor(readonly s: string, readonly now: number) {}

  fail(msg: string, at = this.i): never {
    let line = 1;
    let col = 1;
    for (let k = 0; k < at && k < this.s.length; k++) (this.s[k] === "\n" ? (line++, (col = 1)) : col++);
    throw new LiteralError(msg, line, col, at);
  }

  ws(): void {
    for (;;) {
      const c = this.s[this.i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") this.i++;
      else if (c === "/" && this.s[this.i + 1] === "/") while (this.i < this.s.length && this.s[this.i] !== "\n") this.i++;
      else if (c === "/" && this.s[this.i + 1] === "*") {
        const end = this.s.indexOf("*/", this.i + 2);
        if (end < 0) this.fail("Unterminated comment");
        this.i = end + 2;
      } else return;
    }
  }

  peek(): string | undefined {
    this.ws();
    return this.s[this.i];
  }

  eat(ch: string): boolean {
    if (this.peek() === ch) return (this.i++, true);
    return false;
  }

  expect(ch: string): void {
    if (!this.eat(ch)) this.fail(this.i >= this.s.length ? `Expected "${ch}" but the text ended` : `Expected "${ch}" but found "${this.s[this.i]}"`);
  }

  value(depth: number): Json {
    if (depth > MAX_DEPTH) this.fail("Nested too deeply");
    const c = this.peek();
    if (c === undefined) this.fail("Expected a value but the text ended");
    if (c === "{") return this.object(depth);
    if (c === "[") return this.array(depth);
    if (c === '"' || c === "'") return this.string();
    if (c === "/") return this.regex();
    if (c === "-" || c === "+" || (c >= "0" && c <= "9") || c === ".") return this.number();
    if (/[A-Za-z_$]/.test(c)) return this.word(depth);
    return this.fail(`Unexpected "${c}"`);
  }

  object(depth: number): Json {
    this.i++;
    const out: { [k: string]: Json } = {};
    for (;;) {
      const c = this.peek();
      if (c === "}") return (this.i++, out);
      if (c === undefined) this.fail("Expected a key or } but the text ended");
      const key = c === '"' || c === "'" ? this.string() : this.ident();
      this.expect(":");
      out[key] = this.value(depth + 1);
      if (!this.eat(",")) {
        this.expect("}");
        return out;
      }
    }
  }

  array(depth: number): Json {
    this.i++;
    const out: Json[] = [];
    for (;;) {
      if (this.peek() === "]") return (this.i++, out);
      out.push(this.value(depth + 1));
      if (!this.eat(",")) {
        this.expect("]");
        return out;
      }
    }
  }

  ident(): string {
    this.ws();
    const m = /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.i));
    if (!m) this.fail(this.i >= this.s.length ? "Expected a key but the text ended" : `Expected a key but found "${this.s[this.i]}"`);
    this.i += m[0].length;
    return m[0];
  }

  string(): string {
    const q = this.s[this.i++];
    let out = "";
    for (;;) {
      const c = this.s[this.i++];
      if (c === undefined) this.fail("Unterminated string");
      if (c === q) return out;
      if (c === "\\") {
        const e = this.s[this.i++];
        const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "0": "\0", "/": "/", "\\": "\\", '"': '"', "'": "'" };
        if (e === "u") {
          const hex = this.s.slice(this.i, this.i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("Bad \\u escape");
          out += String.fromCharCode(parseInt(hex, 16));
          this.i += 4;
        } else if (e !== undefined && e in map) out += map[e];
        else this.fail("Unknown escape");
      } else out += c;
    }
  }

  number(): Json {
    const m = /^[+-]?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(this.s.slice(this.i));
    if (!m) this.fail("Bad number");
    this.i += m[0].length;
    return Number(m[0]);
  }

  regex(): Json {
    const start = this.i++;
    let pattern = "";
    for (;;) {
      const c = this.s[this.i++];
      if (c === undefined || c === "\n") this.fail("Unterminated regular expression", start);
      if (c === "\\") pattern += c + (this.s[this.i++] ?? "");
      else if (c === "/") break;
      else pattern += c;
    }
    const m = /^[a-z]*/.exec(this.s.slice(this.i))!;
    this.i += m[0].length;
    return { $regularExpression: { pattern, options: m[0] } };
  }

  word(depth: number): Json {
    const at = this.i;
    let name = this.ident();
    if (name === "true") return true;
    if (name === "false") return false;
    if (name === "null") return null;
    if (name === "NaN") return { $numberDouble: "NaN" };
    if (name === "Infinity") return { $numberDouble: "Infinity" };
    let isNew = false;
    if (name === "new") {
      isNew = true;
      name = this.ident();
    }
    if (!this.eat("(")) this.fail(`"${name}" is not a value; only literals and the BSON helpers are allowed`, at);
    const args: Json[] = [];
    while (this.peek() !== ")") {
      if (this.peek() === undefined) this.fail("Expected ) but the text ended");
      args.push(this.value(depth + 1));
      if (!this.eat(",")) break;
    }
    this.expect(")");
    return this.helper(name, args, isNew, at);
  }

  helper(name: string, args: Json[], isNew: boolean, at: number): Json {
    const str = (k = 0): string => (typeof args[k] === "string" ? (args[k] as string) : this.fail(`${name}() needs a string`, at));
    switch (name) {
      case "ObjectId":
        if (!/^[0-9a-fA-F]{24}$/.test(str())) this.fail("ObjectId() needs 24 hex characters", at);
        return { $oid: str().toLowerCase() };
      case "ISODate":
      case "Date": {
        if (!isNew && name === "Date") this.fail("Use new Date(...) or ISODate(...)", at);
        const a = args[0];
        const ms = a === undefined ? this.now : typeof a === "number" ? a : typeof a === "string" ? Date.parse(/(?:Z|[+-]\d\d:?\d\d)$/.test(a) || !/T/.test(a) ? a : `${a}Z`) : NaN;
        if (Number.isNaN(ms)) this.fail(`${name}() could not read the date`, at);
        return { $date: { $numberLong: String(Math.trunc(ms)) } };
      }
      case "NumberLong": return { $numberLong: String(typeof args[0] === "number" ? Math.trunc(args[0]) : str()) };
      case "NumberInt": case "Int32": return { $numberInt: String(typeof args[0] === "number" ? Math.trunc(args[0]) : str()) };
      case "NumberDecimal": case "Decimal128": return { $numberDecimal: String(typeof args[0] === "number" ? args[0] : str()) };
      case "Double": return { $numberDouble: String(typeof args[0] === "number" ? args[0] : str()) };
      case "UUID": return { $uuid: str().toLowerCase() };
      case "Timestamp": return { $timestamp: { t: Number(args[0] ?? 0), i: Number(args[1] ?? 0) } };
      case "MinKey": return { $minKey: 1 };
      case "MaxKey": return { $maxKey: 1 };
      default: return this.fail(`"${name}" is not allowed here; only literals and the BSON helpers (ObjectId, ISODate, new Date, NumberLong, NumberInt, NumberDecimal, UUID, Timestamp, MinKey, MaxKey)`, at);
    }
  }
}

/** Parses one literal. `now` is what `ISODate()` and `new Date()` without an argument mean. */
export function parseLiteral(text: string, now: number = Date.now()): Json {
  const r = new Reader(text, now);
  const v = r.value(0);
  if (r.peek() !== undefined) r.fail(`Unexpected "${r.s[r.i]}" after the value`);
  return v;
}

export type LintResult = { ok: true; empty: boolean } | { ok: false; message: string; line: number; column: number };

/** One-line lint of a query-bar field: empty is fine, otherwise the text must be a literal (an object, or an array for a pipeline). */
export function lint(text: string, kind: "object" | "any" = "object"): LintResult {
  if (!text.trim()) return { ok: true, empty: true };
  try {
    const v = parseLiteral(text);
    if (kind === "object" && (typeof v !== "object" || v === null || Array.isArray(v))) return { ok: false, message: "Expected an object like { field: value }", line: 1, column: 1 };
    return { ok: true, empty: false };
  } catch (e) {
    if (e instanceof LiteralError) return { ok: false, message: e.message, line: e.line, column: e.column };
    return { ok: false, message: e instanceof Error ? e.message : String(e), line: 1, column: 1 };
  }
}

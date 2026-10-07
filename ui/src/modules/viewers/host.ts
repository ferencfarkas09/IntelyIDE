// The message handler of the document engine: feeds bytes in, answers window/search requests. Runs inside the worker
// (`engine.worker.ts`) or in-thread (tests, and webviews without module workers) through the same `dispatch`.

import { DocEngine, type Level, type QueryResult, type Row } from "./engine";
import type { DataKind } from "./logic";
import type { Key } from "./jsonPath";

export interface DocState {
  total: number;
  lineCount: number;
  loading: boolean;
  /** A JSON parse error; the text is then shown as lines. */
  error?: string;
  fellBackToText: boolean;
  /** JSONL / log: lines that looked like JSON but did not parse (kept as text). */
  badLines: number;
}

const looksJson = (t: string): boolean => {
  const a = t.charCodeAt(0);
  return (a === 123 && t.endsWith("}")) || (a === 91 && t.endsWith("]"));
};

export class EngineHost {
  private engine = new DocEngine();
  private kind: DataKind = "json";
  private decoder = new TextDecoder("utf-8");
  private parts: string[] = [];
  private tail = "";
  private loading = false;
  private error: string | undefined;
  private fell = false;
  private bad = 0;

  begin(kind: DataKind): void {
    this.kind = kind;
    this.decoder = new TextDecoder("utf-8");
    this.parts = [];
    this.tail = "";
    this.error = undefined;
    this.fell = false;
    this.bad = 0;
    this.loading = true;
    this.engine = new DocEngine();
    this.engine.load(kind === "json" ? null : [], kind === "json" ? "json" : "lines");
  }

  chunk(bytes: Uint8Array): DocState {
    const text = this.decoder.decode(bytes, { stream: true });
    if (this.kind === "json") this.parts.push(text);
    else this.feedLines(text);
    return this.state();
  }

  end(): DocState {
    const rest = this.decoder.decode();
    if (this.kind === "json") {
      this.parts.push(rest);
      this.finishJson(this.parts.join(""));
      this.parts = [];
    } else {
      this.feedLines(rest);
      if (this.tail) (this.pushLine(this.tail), (this.tail = ""));
    }
    this.loading = false;
    return this.state();
  }

  private finishJson(text: string): void {
    try {
      this.engine.load(JSON.parse(text) as unknown, "json");
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.fell = true;
      this.engine.load(text.split(/\r?\n/), "lines");
    }
  }

  private feedLines(text: string): void {
    const pieces = (this.tail + text).split("\n");
    this.tail = pieces.pop() ?? "";
    if (pieces.length) this.engine.appendLines(pieces.map((l) => this.parseLine(l.endsWith("\r") ? l.slice(0, -1) : l)));
  }

  private pushLine(l: string): void {
    this.engine.appendLines([this.parseLine(l.endsWith("\r") ? l.slice(0, -1) : l)]);
  }

  private parseLine(l: string): unknown {
    const t = l.trim();
    if (!looksJson(t)) return l;
    try {
      return JSON.parse(t) as unknown;
    } catch {
      this.bad++;
      return l;
    }
  }

  state(): DocState {
    return { total: this.engine.total(), lineCount: this.engine.lineCount, loading: this.loading, error: this.error, fellBackToText: this.fell, badLines: this.bad };
  }

  dispatch(op: string, args: unknown[]): unknown {
    const e = this.engine;
    switch (op) {
      case "begin":
        return this.begin(args[0] as DataKind);
      case "chunk":
        return this.chunk(args[0] as Uint8Array);
      case "end":
        return this.end();
      case "state":
        return this.state();
      case "window":
        return e.window(args[0] as number, args[1] as number) satisfies Row[];
      case "toggle":
        return e.toggle(args[0] as number);
      case "expandLevel":
        return e.expandLevel(args[0] as number);
      case "collapseAll":
        return e.collapseAll();
      case "reveal":
        return e.reveal(args[0] as Key[]);
      case "search":
        return e.search(args[0] as string) satisfies QueryResult;
      case "levelCounts":
        return e.levelCounts();
      case "nextLevel":
        return e.nextLevel(args[0] as Level, args[1] as number, args[2] as 1 | -1);
      case "valueText":
        return e.valueText(args[0] as Key[]);
      case "pathText":
        return e.pathText(args[0] as Key[]);
      default:
        throw new Error(`unknown op ${op}`);
    }
  }
}

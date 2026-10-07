// The only message the page may send to the IDE, and the only one the IDE sends back. The page is untrusted: this
// parser is strict (exact key set, plain data, bounded sizes, no control or bidi characters) and everything it returns is
// still just a hint (see paths.ts and open.ts).

export const CHANNEL = "inspect/1";
export const MODE_MESSAGE = "inspect.mode/1";

export interface SourceHint {
  /** Absolute, or relative to the preview tab's repo; "" for a name-only hint. */
  file: string;
  /** 1-based; 0 with an empty file. */
  line: number;
  col: number;
  componentName: string;
}

export const MAX_PATH = 1024;
export const MAX_NAME = 128;
export const MAX_LINE = 10_000_000;

const KEYS = ["col", "componentName", "file", "intely", "line"];
// Control characters, line/paragraph separators, bidi overrides/isolates and the BOM: nothing the toast or picker should render.
function hasUnsafeChar(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff) return true;
  }
  return false;
}
const NAME_OK = /^[\p{L}\p{N}_$.\- <>()]*$/u;

export function isCleanPathText(p: string): boolean {
  return p.length > 0 && p.length <= MAX_PATH && !hasUnsafeChar(p) && !p.includes("\\");
}

export function isCleanName(n: string): boolean {
  return n.length <= MAX_NAME && NAME_OK.test(n);
}

function ownData(o: object): Record<string, unknown> | undefined {
  const proto = Object.getPrototypeOf(o);
  if (proto !== Object.prototype && proto !== null) return undefined;
  if (Object.getOwnPropertySymbols(o).length > 0) return undefined;
  const names = Object.getOwnPropertyNames(o).sort();
  if (names.length !== KEYS.length || names.some((n, i) => n !== KEYS[i])) return undefined;
  const out: Record<string, unknown> = {};
  for (const n of names) {
    const d = Object.getOwnPropertyDescriptor(o, n)!;
    if (!("value" in d)) return undefined; // accessors can run page code or change between reads
    out[n] = d.value;
  }
  return out;
}

/** The hint inside a `message` event's data, or undefined for anything that is not exactly the inspector's message. */
export function parseInspectMessage(data: unknown): SourceHint | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const d = ownData(data);
  if (!d || d.intely !== CHANNEL) return undefined;
  const { file, line, col, componentName } = d;
  if (typeof file !== "string" || typeof componentName !== "string" || typeof line !== "number" || typeof col !== "number") return undefined;
  if (!Number.isInteger(line) || !Number.isInteger(col) || !isCleanName(componentName)) return undefined;
  if (file === "") {
    // name-only: no position, and there must be a name to look up
    return line === 0 && col === 0 && componentName !== "" ? { file, line, col, componentName } : undefined;
  }
  if (!isCleanPathText(file) || line < 1 || line > MAX_LINE || col < 0 || col > MAX_LINE) return undefined;
  return { file, line, col: Math.max(1, col), componentName };
}

export const modeMessage = (on: boolean) => ({ intely: MODE_MESSAGE, on });

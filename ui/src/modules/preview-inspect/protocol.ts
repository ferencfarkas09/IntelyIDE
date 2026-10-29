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

// ---- the second message: the clicked element's tag, classes and a few computed styles ------------------------------------------------

export const STYLE_CHANNEL = "inspect.style/1";
/** The only computed styles the panel shows; anything else the page sends is refused. */
export const STYLE_KEYS = ["display", "position", "width", "height", "margin", "padding", "color", "background-color", "font-family", "font-size", "font-weight", "line-height", "border-radius", "gap"] as const;
export type StyleKey = (typeof STYLE_KEYS)[number];

export interface StyleHint {
  tag: string;
  id: string;
  classes: string[];
  styles: Partial<Record<StyleKey, string>>;
  width: number;
  height: number;
}

const STYLE_MSG_KEYS = ["classes", "height", "id", "intely", "styles", "tag", "width"];
const TAG_OK = /^[a-z][a-z0-9-]{0,31}$/;
const CLASS_OK = /^[A-Za-z0-9_-]{1,64}$/;
const ID_OK = /^[A-Za-z0-9_:.-]{0,64}$/;
export const MAX_STYLE_VALUE = 100;
export const MAX_CLASSES = 12;

function plainData(o: object, keys: readonly string[]): Record<string, unknown> | undefined {
  const proto = Object.getPrototypeOf(o);
  if (proto !== Object.prototype && proto !== null) return undefined;
  if (Object.getOwnPropertySymbols(o).length > 0) return undefined;
  const names = Object.getOwnPropertyNames(o).sort();
  if (keys.length && (names.length !== keys.length || names.some((n, i) => n !== keys[i]))) return undefined;
  const out: Record<string, unknown> = {};
  for (const n of names) {
    const d = Object.getOwnPropertyDescriptor(o, n)!;
    if (!("value" in d)) return undefined; // accessors can run page code or change between reads
    out[n] = d.value;
  }
  return out;
}

/** The style hint inside a `message` event's data, or undefined for anything that is not exactly the inspector's second message. */
export function parseStyleMessage(data: unknown): StyleHint | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const d = plainData(data, STYLE_MSG_KEYS);
  if (!d || d.intely !== STYLE_CHANNEL) return undefined;
  const { tag, id, classes, styles, width, height } = d;
  if (typeof tag !== "string" || !TAG_OK.test(tag) || typeof id !== "string" || !ID_OK.test(id)) return undefined;
  if (typeof width !== "number" || typeof height !== "number" || !Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0 || width > 1e6 || height > 1e6) return undefined;
  if (!Array.isArray(classes) || classes.length > MAX_CLASSES || typeof styles !== "object" || styles === null || Array.isArray(styles)) return undefined;
  const cls: string[] = [];
  for (let i = 0; i < classes.length; i++) {
    const c = Object.getOwnPropertyDescriptor(classes, String(i));
    if (!c || !("value" in c) || typeof c.value !== "string") return undefined;
    if (CLASS_OK.test(c.value)) cls.push(c.value); // a class with odd characters is dropped, not trusted
  }
  const raw = plainData(styles, []);
  if (!raw) return undefined;
  const out: Partial<Record<StyleKey, string>> = {};
  for (const key of STYLE_KEYS) {
    if (!(key in raw)) continue;
    const v = raw[key];
    if (typeof v !== "string" || v.length > MAX_STYLE_VALUE || hasUnsafeChar(v)) return undefined;
    if (v) out[key] = v;
  }
  if (Object.keys(raw).some((k) => !(STYLE_KEYS as readonly string[]).includes(k))) return undefined;
  return { tag, id, classes: cls, styles: out, width: Math.round(width), height: Math.round(height) };
}

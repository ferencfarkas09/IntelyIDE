// Finds the React components a source file exports, and which props they seem to take. A light text scan (no code runs, no
// parser dependency): good enough to fill the picker and to seed the props editor; the harness itself reports the real exports.
// Pure: nothing here touches the DOM, the Ipc or a timer.

export type PropType = "string" | "number" | "boolean" | "function" | "array" | "object" | "node" | "unknown";

export interface PropHint {
  name: string;
  type: PropType;
  required: boolean;
  /** A default seen in the source (destructuring default), already a JSON value. */
  default?: unknown;
}

export interface FoundComponent {
  /** The name to show: the declared name, or the file name for an anonymous default export. */
  name: string;
  /** `default` or the named export. */
  exportName: string;
  /** 1-based line of the declaration. */
  line: number;
  kind: "function" | "class" | "arrow" | "wrapped";
  props: PropHint[];
}

const SOURCE_EXT = /\.(jsx?|tsx?|mjs)$/i;
export const isComponentFile = (path: string): boolean => SOURCE_EXT.test(path) && !/(^|\/)node_modules\//.test(path) && !/\.(test|spec|stories)\.[jt]sx?$/i.test(path) && !/\.d\.ts$/.test(path);

const stem = (path: string) => (path.split("/").pop() ?? path).replace(/\.[^.]+$/, "").replace(/^index$/i, "Component").replace(/[^A-Za-z0-9_$]/g, "");
const pascal = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : "Component");

/** Blanks comments (keeping line breaks and offsets) so a commented-out `export` is not found. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
}

const lineOf = (src: string, index: number) => src.slice(0, index).split("\n").length;
const hasJsx = (src: string) => /<[A-Za-z][\w.]*[\s/>]|<>|createElement\(|\bjsxs?\(/.test(src);
const isConstantName = (n: string) => /^[A-Z0-9_]+$/.test(n) && n.length > 1;
const WRAPPERS = /(?:React\.)?(?:memo|forwardRef|lazy|observer|connect|withRouter|withStyles|withTranslation|injectIntl)/;

/** Text of the balanced `(...)`, `{...}` or `[...]` starting at `open` (exclusive of the brackets), or undefined. */
function balanced(src: string, open: number): string | undefined {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const stack: string[] = [];
  for (let i = open; i < src.length && i < open + 4000; i++) {
    const c = src[i];
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) return src.slice(open + 1, i);
    }
  }
  return undefined;
}

function splitTop(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let quote = "";
  for (const c of text) {
    if (quote) {
      cur += c;
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    if ("([{".includes(c)) depth++;
    if (")]}".includes(c)) depth--;
    if (c === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function literal(text: string): { ok: boolean; value?: unknown } {
  const t = text.trim();
  if (/^(['"])(?:(?!\1).)*\1$/s.test(t)) return { ok: true, value: t.slice(1, -1) };
  if (/^-?\d+(\.\d+)?$/.test(t)) return { ok: true, value: Number(t) };
  if (t === "true" || t === "false") return { ok: true, value: t === "true" };
  if (t === "null") return { ok: true, value: null };
  if (t === "[]") return { ok: true, value: [] };
  if (t === "{}") return { ok: true, value: {} };
  return { ok: false };
}

const FN_NAME = /^(on|handle|set|render|get|did|will)[A-Z]|(Fn|Callback|Handler|Cb)$/;
const BOOL_NAME = /^(is|has|show|can|should|enable|disable|with)[A-Z]|^(disabled|loading|open|visible|checked|active|selected|readOnly|readonly|required|hidden|multiple|compact|dense|error|expanded|collapsed|busy|fluid|inline)$/;
const ARRAY_NAME = /^(items|rows|list|options|columns|tabs|values|ids|data|children|entries|records|results|orders|users|products|tags|steps|links)$|(Items|List|Rows|Options|Ids|Columns)$/;
const STRING_NAME = /^(title|label|name|text|description|placeholder|value|id|className|variant|size|color|type|message|subtitle|heading|caption|href|src|alt|url|path|mode|kind|status)$|(Title|Label|Name|Text|Id|Url)$/;

function guessType(name: string, def?: unknown): PropType {
  if (def !== undefined) {
    if (typeof def === "string") return "string";
    if (typeof def === "number") return "number";
    if (typeof def === "boolean") return "boolean";
    if (Array.isArray(def)) return "array";
    if (def && typeof def === "object") return "object";
  }
  if (FN_NAME.test(name)) return "function";
  if (BOOL_NAME.test(name)) return "boolean";
  if (ARRAY_NAME.test(name)) return name === "children" ? "node" : "array";
  if (STRING_NAME.test(name)) return "string";
  return "unknown";
}

const PT: Record<string, PropType> = { string: "string", number: "number", bool: "boolean", func: "function", array: "array", object: "object", node: "node", element: "node", any: "unknown", shape: "object", arrayOf: "array", objectOf: "object", oneOf: "string", oneOfType: "unknown", instanceOf: "object", symbol: "unknown" };
const TS: Array<[RegExp, PropType]> = [[/^string\b|^['"`]/, "string"], [/^number\b|^\d/, "number"], [/^boolean\b|^true|^false/, "boolean"], [/=>|^Function\b|^\(/, "function"], [/\[\]|^Array<|^ReadonlyArray</, "array"], [/^(React\.)?(ReactNode|ReactElement)|^JSX\.Element/, "node"], [/^\{|^Record<|^object\b/, "object"]];

/** Props from `Name.propTypes = {...}` and from `interface NameProps` / `type NameProps = {...}`. */
function declaredProps(src: string, name: string): PropHint[] {
  const out: PropHint[] = [];
  const pt = new RegExp(`\\b${name}\\.propTypes\\s*=\\s*\\{`).exec(src) ?? /static\s+propTypes\s*=\s*\{/.exec(src);
  if (pt) {
    const body = balanced(src, pt.index + pt[0].length - 1) ?? "";
    for (const entry of splitTop(body)) {
      const m = /^['"]?([\w$]+)['"]?\s*:\s*(?:PropTypes\.)?([\w]+)(.*)$/s.exec(entry);
      if (m) out.push({ name: m[1], type: PT[m[2]] ?? "unknown", required: /isRequired/.test(m[3]) });
    }
  }
  const ts = new RegExp(`(?:interface\\s+${name}Props\\s*(?:extends[^{]*)?|interface\\s+Props\\s*(?:extends[^{]*)?|type\\s+${name}Props\\s*=|type\\s+Props\\s*=)\\s*\\{`).exec(src);
  if (ts) {
    const body = balanced(src, ts.index + ts[0].length - 1) ?? "";
    for (const entry of splitTop(body.replace(/;/g, ","))) {
      const m = /^(?:readonly\s+)?([\w$]+)(\?)?\s*:\s*([\s\S]+)$/.exec(entry);
      if (m) out.push({ name: m[1], type: TS.find(([re]) => re.test(m[3].trim()))?.[1] ?? "unknown", required: !m[2] });
    }
  }
  return out;
}

/** Destructured parameter `({ a, b = 1, onX })` of the declaration whose `(` is at `open`. */
function paramProps(src: string, open: number): { props: PropHint[]; bare?: string } {
  const params = balanced(src, open) ?? "";
  const first = splitTop(params)[0]?.replace(/:\s*[\w.<>\[\]| ]+$/s, "").trim();
  if (!first) return { props: [] };
  if (first.startsWith("{")) {
    const body = balanced(first, 0) ?? "";
    const props: PropHint[] = [];
    for (const part of splitTop(body)) {
      if (part.startsWith("...")) continue;
      const m = /^([\w$]+)\s*(?::\s*[\w$]+)?\s*(?:=\s*([\s\S]+))?$/.exec(part.replace(/:\s*(?:[A-Za-z][\w.<>\[\]| ]*)$/, ""));
      if (!m) continue;
      const lit = m[2] === undefined ? { ok: false } : literal(m[2]);
      props.push({ name: m[1], type: guessType(m[1], lit.ok ? lit.value : undefined), required: m[2] === undefined, ...(lit.ok ? { default: lit.value } : {}) });
    }
    return { props };
  }
  const id = /^([\w$]+)/.exec(first)?.[1];
  return { props: [], bare: id };
}

function usedProps(src: string, bare: string | undefined, isClass: boolean): PropHint[] {
  const names = new Set<string>();
  const re = isClass ? /this\.props\.([\w$]+)/g : bare ? new RegExp(`\\b${bare}\\.([\\w$]+)`, "g") : undefined;
  if (re) for (const m of src.matchAll(re)) names.add(m[1]);
  if (isClass) for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*this\.props/g)) splitTop(m[1]).forEach((p) => names.add(p.split(/[:=]/)[0].trim()));
  return [...names].filter((n) => /^[\w$]+$/.test(n)).map((name) => ({ name, type: guessType(name), required: false }));
}

function merge(...lists: PropHint[][]): PropHint[] {
  const by = new Map<string, PropHint>();
  for (const list of lists) {
    for (const p of list) {
      const have = by.get(p.name);
      if (!have) by.set(p.name, p);
      else by.set(p.name, { ...have, type: have.type === "unknown" ? p.type : have.type, required: have.required || p.required, ...(have.default === undefined && p.default !== undefined ? { default: p.default } : {}) });
    }
  }
  return [...by.values()];
}

export function findComponents(path: string, source: string): FoundComponent[] {
  if (!isComponentFile(path) || source.length > 400_000) return [];
  const src = stripComments(source);
  if (!hasJsx(src)) return [];
  const found: FoundComponent[] = [];
  const add = (c: FoundComponent) => {
    if (!found.some((f) => f.exportName === c.exportName)) found.push(c);
  };
  const fileName = pascal(stem(path));

  const declProps = (name: string, decl: { fn?: number; cls?: boolean }): PropHint[] => {
    const own = decl.fn !== undefined ? paramProps(src, decl.fn) : { props: [] as PropHint[], bare: undefined };
    // declared types (PropTypes, TypeScript) beat the ones guessed from names
    return merge(declaredProps(src, name), own.props, usedProps(src, own.bare, !!decl.cls));
  };

  // export default function Name( / export default async function / export default function (
  for (const m of src.matchAll(/export\s+default\s+(?:async\s+)?function\s*\*?\s*([\w$]*)\s*(?:<[^>]*>)?\s*\(/g)) {
    const name = m[1] || fileName;
    add({ name, exportName: "default", line: lineOf(src, m.index), kind: "function", props: declProps(name, { fn: m.index + m[0].length - 1 }) });
  }
  for (const m of src.matchAll(/export\s+default\s+class\s+([\w$]*)\s*(?:extends\s+[\w.$]+)?/g)) {
    const name = m[1] || fileName;
    add({ name, exportName: "default", line: lineOf(src, m.index), kind: "class", props: declProps(name, { cls: true }) });
  }
  for (const m of src.matchAll(/export\s+default\s+(\(|async\s*\(|[\w$]+\s*=>)/g)) {
    const open = m[1].endsWith("(") ? m.index + m[0].length - 1 : undefined;
    add({ name: fileName, exportName: "default", line: lineOf(src, m.index), kind: "arrow", props: declProps(fileName, open === undefined ? {} : { fn: open }) });
  }
  // export default memo(Name) / connect(a)(Name) / withRouter(Name)
  for (const m of src.matchAll(/export\s+default\s+((?:[\w$.]*\s*\([^;]*?\)\s*)+);?/g)) {
    if (!WRAPPERS.test(m[1])) continue;
    const inner = [...m[1].matchAll(/\(\s*([A-Z][\w$]*)\s*\)/g)].at(-1)?.[1];
    const name = inner ?? fileName;
    add({ name, exportName: "default", line: lineOf(src, m.index), kind: "wrapped", props: declProps(name, innerDecl(src, name)) });
  }
  // export default Name;
  for (const m of src.matchAll(/export\s+default\s+([A-Z][\w$]*)\s*;?\s*$/gm)) {
    add({ name: m[1], exportName: "default", line: lineOf(src, m.index), kind: "function", props: declProps(m[1], innerDecl(src, m[1])) });
  }
  // export function Name( / export class Name
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s*\*?\s*([A-Z][\w$]*)\s*(?:<[^>]*>)?\s*\(/g)) {
    if (!isConstantName(m[1])) add({ name: m[1], exportName: m[1], line: lineOf(src, m.index), kind: "function", props: declProps(m[1], { fn: m.index + m[0].length - 1 }) });
  }
  for (const m of src.matchAll(/export\s+class\s+([A-Z][\w$]*)\s+extends\s+(?:React\.)?(?:Pure)?Component/g)) {
    add({ name: m[1], exportName: m[1], line: lineOf(src, m.index), kind: "class", props: declProps(m[1], { cls: true }) });
  }
  // export const Name = (props) => / = function / = memo( / = forwardRef(
  for (const m of src.matchAll(/export\s+const\s+([A-Z][\w$]*)\s*(?::[^=]+)?=\s*((?:async\s*)?\(|(?:async\s+)?[\w$]+\s*=>|function\b|(?:React\.)?(?:memo|forwardRef|lazy)\s*\()/g)) {
    if (isConstantName(m[1])) continue;
    const arrowParen = m[2].endsWith("(") && !WRAPPERS.test(m[2]) ? m.index + m[0].length - 1 : undefined;
    add({ name: m[1], exportName: m[1], line: lineOf(src, m.index), kind: WRAPPERS.test(m[2]) ? "wrapped" : "arrow", props: declProps(m[1], arrowParen === undefined ? innerDecl(src, m[1]) : { fn: arrowParen }) });
  }
  // export { A, B as default }
  for (const m of src.matchAll(/export\s*\{([^}]*)\}(?!\s*from)/g)) {
    for (const part of splitTop(m[1])) {
      const [local, exported = local] = part.split(/\s+as\s+/).map((s) => s.trim());
      if (!/^[A-Z][\w$]*$/.test(local) || isConstantName(local)) continue;
      if (!new RegExp(`(?:function|class|const|let|var)\\s+${local}\\b`).test(src)) continue;
      add({ name: local, exportName: exported, line: lineOf(src, m.index), kind: "function", props: declProps(local, innerDecl(src, local)) });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

/** Finds the local declaration of `name` (function, arrow or class) so its parameters can be read. */
function innerDecl(src: string, name: string): { fn?: number; cls?: boolean } {
  const fnDecl = new RegExp(`function\\s*\\*?\\s*${name}\\s*(?:<[^>]*>)?\\s*\\(`).exec(src);
  if (fnDecl) return { fn: fnDecl.index + fnDecl[0].length - 1 };
  const arrow = new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=\\s*(?:async\\s*)?\\(`).exec(src);
  if (arrow) return { fn: arrow.index + arrow[0].length - 1 };
  if (new RegExp(`class\\s+${name}\\b`).test(src)) return { cls: true };
  return {};
}

const PLACEHOLDER: Record<PropType, unknown> = { string: "", number: 0, boolean: false, function: undefined, array: [], object: {}, node: "Content", unknown: undefined };

/** A starting props object: defaults and typed placeholders; callbacks become `{"$fn": name}` stubs. Unknown-typed props are left out. */
export function suggestProps(c: Pick<FoundComponent, "props">): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of c.props) {
    if (p.default !== undefined) out[p.name] = p.default;
    else if (p.type === "function") out[p.name] = { $fn: p.name };
    else if (p.type === "string" && /^(title|label|name|text|heading|caption|message)$/i.test(p.name)) out[p.name] = p.name[0].toUpperCase() + p.name.slice(1);
    else if (p.type !== "unknown" && PLACEHOLDER[p.type] !== undefined) out[p.name] = PLACEHOLDER[p.type];
  }
  return out;
}

/** Props the source mentions that `suggestProps` could not give a value (shown as "add" chips). */
export function unsuggested(c: Pick<FoundComponent, "props">): string[] {
  const set = suggestProps(c);
  return c.props.map((p) => p.name).filter((n) => !(n in set) && n !== "children" && n !== "key" && n !== "ref");
}

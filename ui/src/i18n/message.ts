/**
 * ICU-lite messages. Supported:
 *   {name}                         plain argument (numbers are formatted for the language)
 *   {n, plural, one {# file} other {# files}}      =N exact matches, offset:N, # = the number
 *   {n, selectordinal, one {#st} other {#th}}
 *   {kind, select, a {...} other {...}}
 *   {n, number}  {n, number, percent|compact|integer}
 *   {d, date, short|medium|long|full}  {d, time, short|medium}
 *   {n, relative, day|hour|minute|...}  (a Date value picks the unit itself)
 *   {items, list, and|or|unit}
 * Quoting: `''` is an apostrophe; an apostrophe right before `{` or `}` starts a quoted run (`'{'`). Any other `'` is literal,
 * so French or Italian text needs no escaping.
 */
export type Params = Record<string, unknown>;

export type Node =
  | string
  | { t: "hash" }
  | { t: "arg"; name: string }
  | { t: "fmt"; name: string; kind: "number" | "date" | "time" | "relative" | "list"; style?: string }
  | { t: "choice"; name: string; kind: "plural" | "selectordinal" | "select"; offset: number; options: Record<string, Node[]> };

export class MessageSyntaxError extends Error {}

export function parseMessage(src: string): Node[] {
  let i = 0;
  const fail = (why: string): never => {
    throw new MessageSyntaxError(`${why} at ${i} in "${src}"`);
  };

  const readUntil = (stops: string): string => {
    const from = i;
    while (i < src.length && !stops.includes(src[i])) i++;
    return src.slice(from, i).trim();
  };

  function nodes(inChoice: boolean): Node[] {
    const out: Node[] = [];
    let text = "";
    const flush = () => text && (out.push(text), (text = ""));
    while (i < src.length) {
      const c = src[i];
      if (c === "}") {
        if (inChoice || depth > 0) break;
        fail("Unmatched }");
      }
      if (c === "'") {
        if (src[i + 1] === "'") ((text += "'"), (i += 2));
        else if (src[i + 1] === "{" || src[i + 1] === "}") {
          i++;
          while (i < src.length && src[i] !== "'") text += src[i++];
          i++;
        } else (text += c, i++);
      } else if (c === "{") {
        flush();
        out.push(argument());
      } else if (c === "#" && inChoice) {
        flush();
        out.push({ t: "hash" });
        i++;
      } else (text += c, i++);
    }
    flush();
    return out;
  }

  let depth = 0;

  function argument(): Node {
    i++; // {
    depth++;
    const name = readUntil(",}");
    if (!name) fail("Empty argument name");
    let node: Node;
    if (src[i] === "}") node = { t: "arg", name };
    else {
      i++; // ,
      const kind = readUntil(",}");
      if (kind === "plural" || kind === "selectordinal" || kind === "select") {
        if (src[i] !== ",") fail(`${kind} needs options`);
        i++;
        let offset = 0;
        const options: Record<string, Node[]> = {};
        for (;;) {
          while (/\s/.test(src[i] ?? "")) i++;
          if (src[i] === "}") break;
          if (i >= src.length) fail("Unclosed choice");
          const key = readUntil("{} \t\n");
          if (key.startsWith("offset:")) {
            offset = Number(key.slice(7)) || 0;
            continue;
          }
          while (/\s/.test(src[i] ?? "")) i++;
          if (src[i] !== "{" || !key) fail("Expected option body");
          i++;
          depth++;
          options[key] = nodes(true);
          depth--;
          if (src[i] !== "}") fail("Unclosed option");
          i++;
        }
        if (!("other" in options)) fail(`${kind} needs an "other" option`);
        node = { t: "choice", name, kind, offset, options };
      } else if (kind === "number" || kind === "date" || kind === "time" || kind === "relative" || kind === "list") {
        let style: string | undefined;
        if (src[i] === ",") {
          i++;
          style = readUntil("}");
        }
        node = { t: "fmt", name, kind, style };
      } else return fail(`Unknown argument type "${kind}"`);
    }
    if (src[i] !== "}") fail("Unclosed argument");
    i++;
    depth--;
    return node;
  }

  const result = nodes(false);
  if (i < src.length) fail("Trailing text");
  return result;
}

const cache = new Map<string, Node[]>();
export function compile(src: string): Node[] {
  let ast = cache.get(src);
  if (!ast) {
    ast = parseMessage(src);
    if (cache.size > 4000) cache.clear();
    cache.set(src, ast);
  }
  return ast;
}

// ---- Intl helpers, memoised per language ----------------------------------------------------------------------------

const memo = new Map<string, unknown>();
function intl<T>(kind: string, locale: string, opts: object | undefined, make: (l: string) => T): T {
  const key = `${kind}|${locale}|${JSON.stringify(opts ?? {})}`;
  let v = memo.get(key) as T | undefined;
  if (!v) {
    try {
      v = make(locale);
    } catch {
      v = make("en");
    }
    memo.set(key, v);
  }
  return v;
}
const numberFormat = (locale: string, opts?: Intl.NumberFormatOptions) => intl("n", locale, opts, (l) => new Intl.NumberFormat(l, opts));
export const pluralRules = (locale: string, type: Intl.PluralRuleType = "cardinal") => intl("p" + type, locale, undefined, (l) => new Intl.PluralRules(l, { type }));

export const formatNumber = (n: number, locale: string, style?: string): string =>
  numberFormat(locale, style === "percent" ? { style: "percent" } : style === "compact" ? { notation: "compact" } : style === "integer" ? { maximumFractionDigits: 0 } : undefined).format(n);

const toDate = (v: unknown): Date => (v instanceof Date ? v : new Date(v as string | number));

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31536e6], ["month", 2592e6], ["day", 864e5], ["hour", 36e5], ["minute", 6e4], ["second", 1e3]];

export function formatRelative(v: unknown, locale: string, unit?: string, now = Date.now()): string {
  const rtf = intl("r", locale, undefined, (l) => new Intl.RelativeTimeFormat(l, { numeric: "auto" }));
  if (typeof v === "number" && unit) return rtf.format(v, unit as Intl.RelativeTimeFormatUnit);
  const ms = toDate(v).getTime() - now;
  const [u, size] = UNITS.find(([, s]) => Math.abs(ms) >= s) ?? UNITS[UNITS.length - 1];
  return rtf.format(Math.round(ms / size), u);
}

function formatValue(node: Extract<Node, { t: "fmt" }>, value: unknown, locale: string): string {
  switch (node.kind) {
    case "number":
      return formatNumber(Number(value), locale, node.style);
    case "date":
    case "time": {
      const style = (node.style || "medium") as "short" | "medium" | "long" | "full";
      const opts: Intl.DateTimeFormatOptions = node.kind === "date" ? { dateStyle: style } : { timeStyle: style === "full" || style === "long" ? "medium" : style };
      return intl("d", locale, opts, (l) => new Intl.DateTimeFormat(l, opts)).format(toDate(value));
    }
    case "relative":
      return formatRelative(value, locale, node.style);
    case "list": {
      const type = node.style === "or" ? "disjunction" : node.style === "unit" ? "unit" : "conjunction";
      const opts = { type } as Intl.ListFormatOptions;
      return intl("l", locale, opts, (l) => new Intl.ListFormat(l, opts)).format(Array.isArray(value) ? value.map(String) : [String(value)]);
    }
  }
}

export function formatNodes(nodes: Node[], params: Params, locale: string, hash?: number): string {
  let out = "";
  for (const node of nodes) {
    if (typeof node === "string") out += node;
    else if (node.t === "hash") out += hash === undefined ? "#" : formatNumber(hash, locale);
    else if (node.t === "arg") {
      const v = params[node.name];
      out += v === undefined ? `{${node.name}}` : typeof v === "number" ? formatNumber(v, locale) : String(v);
    } else if (node.t === "fmt") {
      const v = params[node.name];
      out += v === undefined ? `{${node.name}}` : formatValue(node, v, locale);
    } else {
      const raw = params[node.name];
      if (raw === undefined) {
        out += `{${node.name}}`;
        continue;
      }
      if (node.kind === "select") {
        out += formatNodes(node.options[String(raw)] ?? node.options.other, params, locale);
        continue;
      }
      const n = Number(raw) - node.offset;
      const exact = node.options[`=${Number(raw)}`];
      const category = pluralRules(locale, node.kind === "plural" ? "cardinal" : "ordinal").select(n);
      out += formatNodes(exact ?? node.options[category] ?? node.options.other, params, locale, n);
    }
  }
  return out;
}

/** Plural categories used by `choice` nodes of a message (for the catalog checker). */
export function choiceKinds(nodes: Node[]): { kind: string; keys: string[] }[] {
  const found: { kind: string; keys: string[] }[] = [];
  const walk = (list: Node[]) =>
    list.forEach((n) => {
      if (typeof n !== "string" && n.t === "choice") {
        found.push({ kind: n.kind, keys: Object.keys(n.options) });
        Object.values(n.options).forEach(walk);
      }
    });
  walk(nodes);
  return found;
}

/** Argument names a message needs, for placeholder parity. */
export function argNames(nodes: Node[]): string[] {
  const names = new Set<string>();
  const walk = (list: Node[]) =>
    list.forEach((n) => {
      if (typeof n === "string" || n.t === "hash") return;
      names.add(n.name);
      if (n.t === "choice") Object.values(n.options).forEach(walk);
    });
  walk(nodes);
  return [...names].sort();
}

// ---- pseudo-locale (en-XA): accented + about 40 percent longer ----------------------------------------------------

const ACCENTED: Record<string, string> = { a: "á", b: "ƀ", c: "ç", d: "ð", e: "é", f: "ƒ", g: "ĝ", h: "ĥ", i: "í", j: "ĵ", k: "ķ", l: "ļ", m: "ɱ", n: "ñ", o: "ö", p: "þ", q: "ɋ", r: "ŕ", s: "š", t: "ţ", u: "û", v: "ṽ", w: "ŵ", x: "ẋ", y: "ý", z: "ž", A: "Á", B: "ß", C: "Ç", D: "Ð", E: "É", F: "Ƒ", G: "Ĝ", H: "Ĥ", I: "Í", J: "Ĵ", K: "Ķ", L: "Ļ", M: "Ṁ", N: "Ñ", O: "Ö", P: "Þ", Q: "Ǫ", R: "Ŕ", S: "Š", T: "Ţ", U: "Û", V: "Ṽ", W: "Ŵ", X: "Ẋ", Y: "Ý", Z: "Ž" };

/** Applies to the formatted text, so placeholders were already filled and plural logic ran in English. */
export function pseudoLocalize(text: string): string {
  const accented = [...text].map((c) => ACCENTED[c] ?? c).join("");
  const pad = Math.max(2, Math.ceil(text.length * 0.4));
  // Padding in short wrappable groups: a solid run of tildes would never wrap and fake an overflow.
  return `[${accented} ${Array.from({ length: Math.max(1, Math.round(pad / 4)) }, () => "~~~").join(" ")}]`;
}

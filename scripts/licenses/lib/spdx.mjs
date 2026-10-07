// Minimal SPDX license-expression parser and policy helpers (no dependencies, offline).
// Grammar: expr := and ("OR" and)* ; and := with ("AND" with)* ; with := atom ("WITH" id)? ; atom := id | "(" expr ")".
// Legacy "A/B" (crates.io style) is read as "A OR B".

export class SpdxError extends Error {
  /** @param {string} message @param {"empty"|"unknown"|"see-license"|"syntax"} code @param {string} expression */
  constructor(message, code, expression) {
    super(message);
    this.name = "SpdxError";
    this.code = code;
    this.expression = expression;
  }
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9.+-]*$|^(?:DocumentRef-[A-Za-z0-9.-]+:)?LicenseRef-[A-Za-z0-9.-]+$/;

function tokenize(expression) {
  const tokens = [];
  const re = /\s*(\(|\)|\/|[^\s()/]+)/gy;
  let m;
  let last = 0;
  while ((m = re.exec(expression)) !== null) {
    tokens.push(m[1]);
    last = re.lastIndex;
  }
  if (expression.slice(last).trim() !== "") throw new SpdxError("unexpected trailing input", "syntax", expression);
  return tokens;
}

/** @returns {object} AST: {type:"id",id} | {type:"with",id,exception} | {type:"and"|"or",left,right} */
export function parse(expression) {
  if (typeof expression !== "string" || expression.trim() === "") {
    throw new SpdxError("empty license expression", "empty", String(expression ?? ""));
  }
  const text = expression.trim();
  if (/^SEE\s+LICEN[CS]E\s+IN\b/i.test(text)) throw new SpdxError("license is given by a file, not an SPDX expression", "see-license", text);
  if (/^(UNKNOWN|UNLICENSED|NONE|NOASSERTION)$/i.test(text)) throw new SpdxError("license is unknown", "unknown", text);
  const tokens = tokenize(text);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function atom() {
    const tok = next();
    if (tok === undefined) throw new SpdxError("unexpected end of expression", "syntax", text);
    if (tok === "(") {
      const inner = orExpr();
      if (next() !== ")") throw new SpdxError("missing closing parenthesis", "syntax", text);
      return inner;
    }
    if (tok === ")" || tok === "/" || tok === "AND" || tok === "OR" || tok === "WITH" || !ID_RE.test(tok)) {
      throw new SpdxError(`unexpected token "${tok}"`, "syntax", text);
    }
    return { type: "id", id: tok };
  }
  function withExpr() {
    const left = atom();
    if (peek() === "WITH") {
      next();
      const exc = next();
      if (left.type !== "id" || exc === undefined || !ID_RE.test(exc) || ["AND", "OR", "WITH"].includes(exc)) {
        throw new SpdxError("invalid WITH exception", "syntax", text);
      }
      return { type: "with", id: left.id, exception: exc };
    }
    return left;
  }
  function andExpr() {
    let left = withExpr();
    while (peek() === "AND") {
      next();
      left = { type: "and", left, right: withExpr() };
    }
    return left;
  }
  function orExpr() {
    let left = andExpr();
    while (peek() === "OR" || peek() === "/") {
      next();
      left = { type: "or", left, right: andExpr() };
    }
    return left;
  }
  const ast = orExpr();
  if (pos !== tokens.length) throw new SpdxError(`unexpected token "${tokens[pos]}"`, "syntax", text);
  return ast;
}

const leafString = (n) => (n.type === "with" ? `${n.id} WITH ${n.exception}` : n.id);

/** Canonical text: uppercase operators, "/" turned into OR, parentheses only where needed. */
export function toString(ast, parentType = null) {
  if (ast.type === "id" || ast.type === "with") return leafString(ast);
  const s = `${toString(ast.left, ast.type)} ${ast.type.toUpperCase()} ${toString(ast.right, ast.type)}`;
  return parentType === "and" && ast.type === "or" ? `(${s})` : s;
}

export function normalize(expression) {
  return toString(parse(expression));
}

/** All base license ids mentioned (WITH exceptions excluded), sorted and unique. */
export function ids(ast) {
  const out = new Set();
  (function walk(n) {
    if (n.type === "id" || n.type === "with") out.add(n.id);
    else {
      walk(n.left);
      walk(n.right);
    }
  })(ast);
  return [...out].sort();
}

/** Base id of a chosen entry ("Apache-2.0 WITH LLVM-exception" -> "Apache-2.0"). */
export const baseId = (entry) => entry.split(/\s+WITH\s+/)[0];

function rank(entry, prefer) {
  const i = prefer.indexOf(baseId(entry));
  return i === -1 ? Number.POSITIVE_INFINITY : i;
}

/**
 * Licenses relied on: OR -> the alternative best placed in `prefer` (compound alternatives score by their
 * worst id; ties go to the leftmost), AND -> all parts, WITH kept. Returns sorted unique strings.
 */
export function choose(ast, prefer = []) {
  function pick(n) {
    if (n.type === "id" || n.type === "with") return [leafString(n)];
    if (n.type === "and") return [...new Set([...pick(n.left), ...pick(n.right)])];
    const alts = [];
    (function flat(x) {
      if (x.type === "or") {
        flat(x.left);
        flat(x.right);
      } else alts.push(x);
    })(n);
    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const alt of alts) {
      const chosen = pick(alt);
      const score = Math.max(...chosen.map((c) => rank(c, prefer)));
      if (best === null || score < bestScore) {
        best = chosen;
        bestScore = score;
      }
    }
    return best;
  }
  return [...new Set(pick(ast))].sort();
}

const globToRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);

/** @returns {{id:string, rule:string}[]} one entry per chosen license that the policy refuses. */
export function checkPolicy(chosen, policy) {
  const allow = new Set(policy.allow ?? []);
  const exceptions = new Set(policy.allowExceptions ?? []);
  const deny = (policy.deny ?? []).map((g) => [g, globToRe(g)]);
  const out = [];
  for (const entry of chosen) {
    const id = baseId(entry);
    const hit = deny.find(([, re]) => re.test(id));
    if (hit) {
      out.push({ id: entry, rule: `deny:${hit[0]}` });
      continue;
    }
    if (!allow.has(id)) {
      out.push({ id: entry, rule: "not-allowed" });
      continue;
    }
    const exc = entry.split(/\s+WITH\s+/)[1];
    if (exc && !exceptions.has(exc)) out.push({ id: entry, rule: "exception-not-allowed" });
  }
  return out;
}

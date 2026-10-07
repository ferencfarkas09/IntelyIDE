// Mini YAML parser for the subset the GitHub workflows use ((design notes: release-ci-spec) 5.7).
//
// Supported: block mappings and sequences, plain / single-quoted / double-quoted scalars (also across
// lines), `|` and `>` block scalars (clip, strip, keep, explicit indent), `#` comments, single-line flow
// sequences ([main]) and flow maps ({ contents: read }), nested at will. Scalars follow the YAML 1.2 core
// schema (null, true/false, integers, floats); `on`, `yes` and `off` are plain strings.
//
// Rejected with a YamlError carrying the 1-based line: anchors, aliases, tags, directives, merge keys,
// tabs, multi-document files, duplicate keys, multi-line flow collections, complex keys, "a: b: c".
// The linter must never silently misread a file it does not understand.
//
// parseDocument(text) -> { root, comments }   AST with line numbers (the linter uses this)
// parse(text)         -> plain JS value        (the Psych cross-check uses this)
//
// AST: { t: "map", line, entries: [{ key, keyLine, value }] }
//      { t: "seq", line, items: [] }
//      { t: "scalar", line, style, value, text, comment, bodyLine?, srcLines? }
// `comments` maps a line number to the text of a full-line comment on that line.

export class YamlError extends Error {
  constructor(message, line) {
    super(message);
    this.name = "YamlError";
    this.line = line;
  }
}

const DOC_MARKER = /^(---|\.\.\.)(\s|$)/;
const BLANK_OR_COMMENT = /^[ \t]*(#.*)?$/;

function err(line, message) {
  return new YamlError(message, line);
}

function resolvePlain(text) {
  if (text === "" || text === "~" || /^(null|Null|NULL)$/.test(text)) return null;
  if (/^(true|True|TRUE)$/.test(text)) return true;
  if (/^(false|False|FALSE)$/.test(text)) return false;
  if (/^[-+]?(0|[1-9][0-9]*)$/.test(text)) return Number(text);
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(text)) return Number(text);
  return text;
}

function scalar(line, style, text, comment = null) {
  return { t: "scalar", line, style, value: style === "plain" ? resolvePlain(text) : text, text, comment };
}

function makeLine(raw, no) {
  let indent = 0;
  while (raw[indent] === " ") indent++;
  return { no, raw, indent, text: raw.slice(indent).replace(/[ \t]+$/, "") };
}

// Cut a plain scalar at the first " #" (a comment); returns [value, comment|null].
function cutComment(s) {
  if (s.startsWith("#")) return ["", s.slice(1).trim()];
  const i = s.indexOf(" #");
  if (i < 0) return [s.replace(/[ \t]+$/, ""), null];
  return [s.slice(0, i).replace(/[ \t]+$/, ""), s.slice(i + 2).trim()];
}

function rejectIndicator(ch, line) {
  if (ch === "&") throw err(line, "anchors are not supported");
  if (ch === "*") throw err(line, "aliases are not supported");
  if (ch === "!") throw err(line, "tags are not supported");
  if (ch === "@" || ch === "`") throw err(line, `reserved indicator "${ch}"`);
}

function isSeqStart(t) {
  return t === "-" || t.startsWith("- ");
}

const ESCAPES = { 0: "\0", a: "\x07", b: "\b", t: "\t", "\t": "\t", n: "\n", v: "\v", f: "\f", r: "\r", e: "\x1b", " ": " ", '"': '"', "/": "/", "\\": "\\", N: "\x85", _: "\xa0", L: " ", P: " " };

function fold(lines) {
  let out = "";
  let blanks = 0;
  let prev = null;
  for (const line of lines) {
    if (line === "") {
      blanks++;
      continue;
    }
    const special = line.startsWith(" ") || line.startsWith("\t");
    if (prev === null) out = "\n".repeat(blanks) + line;
    else if (blanks === 0) out += (special || prev.special ? "\n" : " ") + line;
    else out += "\n".repeat(blanks + (special || prev.special ? 1 : 0)) + line;
    prev = { special };
    blanks = 0;
  }
  return out;
}

class Parser {
  constructor(text) {
    this.lines = text.split(/\r?\n/).map((raw, i) => makeLine(raw, i + 1));
    this.pos = 0;
    this.comments = new Map();
    this.seenContent = false;
  }

  // Next significant (non blank, non comment) line, or null. Does not consume it.
  peek() {
    for (;;) {
      const ln = this.lines[this.pos];
      if (!ln) return null;
      if (BLANK_OR_COMMENT.test(ln.raw)) {
        const m = /^[ \t]*#(.*)$/.exec(ln.raw);
        if (m) this.comments.set(ln.no, m[1].trim());
        this.pos++;
        continue;
      }
      if (ln.raw.startsWith("%") && !this.seenContent) throw err(ln.no, "directives are not supported");
      if (DOC_MARKER.test(ln.raw)) {
        if (ln.raw.startsWith("---") && !this.seenContent) {
          if (ln.raw.slice(3).trim() !== "" && !ln.raw.slice(3).trim().startsWith("#")) {
            throw err(ln.no, "content after the document start marker is not supported");
          }
          this.pos++;
          this.seenContent = "marker";
          continue;
        }
        throw err(ln.no, "multi-document files are not supported");
      }
      if (/\t/.test(ln.raw)) throw err(ln.no, "tabs are not allowed");
      this.seenContent = true;
      return ln;
    }
  }

  document() {
    const first = this.peek();
    if (!first) return { root: scalar(1, "plain", ""), comments: this.comments };
    const root = this.nodeHere(-1);
    const rest = this.peek();
    if (rest) throw err(rest.no, "unexpected content (bad indentation?)");
    return { root, comments: this.comments };
  }

  // Parse the collection or scalar that starts at the current (peeked) line.
  nodeHere(parentIndent) {
    const ln = this.lines[this.pos];
    if (isSeqStart(ln.text)) return this.seq(ln.indent);
    if (this.splitKey(ln)) return this.map(ln.indent);
    return this.inline(ln.text, ln, parentIndent);
  }

  seq(indent) {
    const first = this.lines[this.pos];
    const node = { t: "seq", line: first.no, items: [] };
    for (;;) {
      const ln = this.peek();
      if (!ln || ln.indent < indent) break;
      if (ln.indent > indent) throw err(ln.no, "bad indentation of a sequence entry");
      if (!isSeqStart(ln.text)) break;
      const after = ln.text.slice(1);
      const rest = after.trimStart();
      const restIndent = ln.indent + 1 + (after.length - rest.length);
      if (rest === "" || rest.startsWith("#")) {
        if (rest) this.comments.set(ln.no, rest.slice(1).trim());
        this.pos++;
        const nx = this.peek();
        node.items.push(nx && nx.indent > indent ? this.nodeHere(indent) : scalar(ln.no, "plain", ""));
      } else {
        ln.indent = restIndent;
        ln.text = rest;
        node.items.push(this.nodeHere(indent));
      }
    }
    return node;
  }

  // Returns { key, rest } when the line is "key: ..." (rest = text after the colon), else null.
  splitKey(ln) {
    const t = ln.text;
    const c = t[0];
    if (c === '"' || c === "'") {
      let q;
      try {
        q = this.scanQuoted(t, 1, c, ln.no, null);
      } catch (e) {
        return null;
      }
      const after = q.s.slice(q.i);
      const m = /^[ ]*:(?: |$)/.exec(after);
      if (!m) return null;
      return { key: q.value, rest: after.slice(m[0].length) };
    }
    if (c === "[" || c === "{") return null;
    if (c === "?" && (t.length === 1 || t[1] === " ")) throw err(ln.no, "complex keys are not supported");
    for (let i = 1; i < t.length; i++) {
      if (t[i] === "#" && t[i - 1] === " ") return null;
      if (t[i] === ":" && (i + 1 === t.length || t[i + 1] === " ")) {
        return { key: t.slice(0, i).replace(/[ \t]+$/, ""), rest: t.slice(i + 1) };
      }
    }
    return null;
  }

  map(indent) {
    const first = this.lines[this.pos];
    const node = { t: "map", line: first.no, entries: [] };
    const seen = new Set();
    for (;;) {
      const ln = this.peek();
      if (!ln || ln.indent < indent) break;
      if (ln.indent > indent) throw err(ln.no, "bad indentation of a mapping entry");
      if (isSeqStart(ln.text)) break;
      const kv = this.splitKey(ln);
      if (!kv) throw err(ln.no, 'expected "key: value"');
      rejectIndicator(ln.text[0], ln.no);
      if (kv.key === "<<") throw err(ln.no, "merge keys are not supported");
      if (seen.has(kv.key)) throw err(ln.no, `duplicate key "${kv.key}"`);
      seen.add(kv.key);
      const r = kv.rest.trimStart();
      let value;
      if (r === "" || r.startsWith("#")) {
        if (r) this.comments.set(ln.no, r.slice(1).trim());
        this.pos++;
        const nx = this.peek();
        if (nx && nx.indent > indent) value = this.nodeHere(indent);
        else if (nx && nx.indent === indent && isSeqStart(nx.text)) value = this.seq(indent);
        else value = scalar(ln.no, "plain", "");
      } else {
        value = this.inline(r, ln, indent);
      }
      node.entries.push({ key: kv.key, keyLine: ln.no, value });
    }
    return node;
  }

  // Parse a value that starts on line `ln` with text `r`; consumes the line(s) it uses.
  inline(r, ln, parentIndent) {
    rejectIndicator(r[0], ln.no);
    if (r[0] === "|" || r[0] === ">") return this.blockScalar(r, ln, parentIndent);
    if (r[0] === '"' || r[0] === "'") return this.quotedValue(r, ln);
    if (r[0] === "[" || r[0] === "{") return this.flowValue(r, ln);
    return this.plain(r, ln, parentIndent);
  }

  plain(r, ln, parentIndent) {
    const [value, comment] = cutComment(r);
    this.checkPlain(value, ln.no);
    this.pos++;
    const parts = [value];
    let last = comment;
    while (last === null) {
      const nx = this.lines[this.pos];
      if (!nx || BLANK_OR_COMMENT.test(nx.raw) || DOC_MARKER.test(nx.raw) || nx.indent <= parentIndent) break;
      if (/\t/.test(nx.raw)) throw err(nx.no, "tabs are not allowed");
      const [v, c] = cutComment(nx.text);
      this.checkPlain(v, nx.no);
      parts.push(v);
      last = c;
      this.pos++;
    }
    return scalar(ln.no, "plain", parts.join(" "), last);
  }

  checkPlain(v, line) {
    if (/: |:$/.test(v)) throw err(line, "mapping values are not allowed in this context");
  }

  quotedValue(r, ln) {
    const quote = r[0];
    const fetch = () => {
      this.pos++;
      const nx = this.lines[this.pos];
      if (!nx) return null;
      if (/\t/.test(nx.raw)) throw err(nx.no, "tabs are not allowed");
      return nx.raw;
    };
    const q = this.scanQuoted(r, 1, quote, ln.no, fetch);
    this.pos++;
    const [rest, comment] = cutComment(q.s.slice(q.i).trimStart());
    if (rest !== "") throw err(q.line, "unexpected text after a quoted scalar");
    return scalar(ln.no, quote === '"' ? "double" : "single", q.value, comment);
  }

  // Scan a quoted scalar in `s` starting after the opening quote at index i. When fetch is given the scalar
  // may continue on following lines (folded). Returns { value, s, i, line } with i just past the closing quote.
  scanQuoted(s, i, quote, line, fetch) {
    let out = "";
    let cur = line;
    for (;;) {
      if (i >= s.length) {
        // end of line inside the scalar: fold into the next line(s)
        if (!fetch) throw err(cur, "unterminated quoted scalar");
        out = out.replace(/[ ]+$/, "");
        let blanks = 0;
        let nxt;
        for (;;) {
          nxt = fetch();
          cur++;
          if (nxt === null) throw err(line, "unterminated quoted scalar");
          if (nxt.trim() === "") blanks++;
          else break;
        }
        out += blanks ? "\n".repeat(blanks) : " ";
        s = nxt.replace(/^[ ]+/, "");
        i = 0;
        continue;
      }
      const ch = s[i];
      if (quote === "'") {
        if (ch === "'") {
          if (s[i + 1] === "'") {
            out += "'";
            i += 2;
            continue;
          }
          return { value: out, s, i: i + 1, line: cur };
        }
        out += ch;
        i++;
        continue;
      }
      if (ch === '"') return { value: out, s, i: i + 1, line: cur };
      if (ch !== "\\") {
        out += ch;
        i++;
        continue;
      }
      const n = s[i + 1];
      if (n === undefined) {
        // backslash at end of line: the line break is removed
        if (!fetch) throw err(cur, "unterminated quoted scalar");
        const nxt = fetch();
        cur++;
        if (nxt === null) throw err(line, "unterminated quoted scalar");
        s = nxt.replace(/^[ ]+/, "");
        i = 0;
        continue;
      }
      if (n === "x" || n === "u" || n === "U") {
        const len = n === "x" ? 2 : n === "u" ? 4 : 8;
        const hex = s.slice(i + 2, i + 2 + len);
        if (hex.length !== len || !/^[0-9a-fA-F]+$/.test(hex)) throw err(cur, "invalid escape sequence");
        out += String.fromCodePoint(parseInt(hex, 16));
        i += 2 + len;
        continue;
      }
      if (!(n in ESCAPES)) throw err(cur, `invalid escape sequence "\\${n}"`);
      out += ESCAPES[n];
      i += 2;
    }
  }

  flowValue(r, ln) {
    const st = { s: r, i: 0, line: ln.no };
    const node = this.flowNode(st);
    const [rest] = cutComment(st.s.slice(st.i).trimStart());
    if (rest !== "") throw err(ln.no, "unexpected text after a flow collection");
    const m = /(?:^| )#(.*)$/.exec(st.s.slice(st.i));
    if (m) node.comment = m[1].trim();
    this.pos++;
    return node;
  }

  flowSkip(st) {
    while (st.i < st.s.length && st.s[st.i] === " ") st.i++;
  }

  flowNode(st) {
    this.flowSkip(st);
    const ch = st.s[st.i];
    if (ch === undefined) throw err(st.line, "multi-line flow collections are not supported");
    if (ch === "[") {
      st.i++;
      const node = { t: "seq", line: st.line, flow: true, items: [] };
      for (;;) {
        this.flowSkip(st);
        if (st.s[st.i] === undefined) throw err(st.line, "multi-line flow collections are not supported");
        if (st.s[st.i] === "]") {
          st.i++;
          return node;
        }
        node.items.push(this.flowNode(st));
        this.flowSkip(st);
        if (st.s[st.i] === ",") st.i++;
        else if (st.s[st.i] !== "]") throw err(st.line, 'expected "," or "]" in a flow sequence');
      }
    }
    if (ch === "{") {
      st.i++;
      const node = { t: "map", line: st.line, flow: true, entries: [] };
      const seen = new Set();
      for (;;) {
        this.flowSkip(st);
        if (st.s[st.i] === undefined) throw err(st.line, "multi-line flow collections are not supported");
        if (st.s[st.i] === "}") {
          st.i++;
          return node;
        }
        const k = this.flowScalar(st, true);
        if (k.t !== "scalar") throw err(st.line, "flow collections as keys are not supported");
        const key = String(k.text);
        if (key === "<<") throw err(st.line, "merge keys are not supported");
        if (seen.has(key)) throw err(st.line, `duplicate key "${key}"`);
        seen.add(key);
        this.flowSkip(st);
        let value;
        if (st.s[st.i] === ":") {
          st.i++;
          this.flowSkip(st);
          value = st.s[st.i] === "," || st.s[st.i] === "}" ? scalar(st.line, "plain", "") : this.flowNode(st);
        } else {
          value = scalar(st.line, "plain", "");
        }
        node.entries.push({ key, keyLine: st.line, value });
        this.flowSkip(st);
        if (st.s[st.i] === ",") st.i++;
        else if (st.s[st.i] !== "}") throw err(st.line, 'expected "," or "}" in a flow map');
      }
    }
    return this.flowScalar(st, false);
  }

  flowScalar(st, isKey) {
    this.flowSkip(st);
    const ch = st.s[st.i];
    if (ch === "[" || ch === "{") return this.flowNode(st);
    if (ch === '"' || ch === "'") {
      const q = this.scanQuoted(st.s, st.i + 1, ch, st.line, null);
      st.i = q.i;
      return scalar(st.line, ch === '"' ? "double" : "single", q.value);
    }
    rejectIndicator(ch, st.line);
    let j = st.i;
    while (j < st.s.length) {
      const c = st.s[j];
      if (c === "," || c === "]" || c === "}") break;
      if (c === ":" && (j + 1 === st.s.length || st.s[j + 1] === " " || st.s[j + 1] === "," || st.s[j + 1] === "}")) {
        if (isKey) break;
        throw err(st.line, "mapping values are not allowed in this context");
      }
      if (c === "#" && st.s[j - 1] === " ") break;
      j++;
    }
    const text = st.s.slice(st.i, j).replace(/[ ]+$/, "");
    st.i = j;
    return scalar(st.line, "plain", text);
  }

  blockScalar(header, ln, parentIndent) {
    const m = /^([|>])(?:([1-9])([+-]?)|([+-]?)([1-9]?))[ ]*(#.*)?$/.exec(header);
    if (!m) throw err(ln.no, "invalid block scalar header");
    const style = m[1] === "|" ? "literal" : "folded";
    const digit = Number(m[2] || m[5] || 0);
    const chomp = m[3] || m[4] || "";
    this.pos++;
    const startIdx = this.pos;
    let contentIndent = digit ? Math.max(parentIndent, 0) + digit : null;
    const body = [];
    for (;;) {
      const l = this.lines[this.pos];
      if (!l) break;
      if (l.raw.trim() === "") {
        body.push(contentIndent !== null ? l.raw.slice(contentIndent).replace(/^[ ]*$/, "") : "");
        this.pos++;
        continue;
      }
      if (DOC_MARKER.test(l.raw)) break;
      if (contentIndent === null) {
        if (l.indent <= parentIndent) break;
        contentIndent = l.indent;
      } else if (l.indent < contentIndent) {
        break;
      }
      body.push(l.raw.slice(contentIndent));
      this.pos++;
    }
    // trailing blank lines are chomping material, not content
    let trailing = 0;
    while (body.length && body[body.length - 1] === "") {
      body.pop();
      trailing++;
    }
    // keep line mapping for the lines we popped (they stay in srcLines)
    const srcLines = body.concat(Array(trailing).fill(""));
    // blank lines the loop consumed after the last content line must not be re-read as structure
    let value = style === "literal" ? body.join("\n") : fold(body);
    if (body.length === 0) value = chomp === "+" ? "\n".repeat(trailing) : "";
    else if (chomp === "") value += "\n";
    else if (chomp === "+") value += "\n" + "\n".repeat(trailing);
    const node = scalar(ln.no, style, value, m[6] ? m[6].slice(1).trim() : null);
    node.bodyLine = this.lines[startIdx] ? this.lines[startIdx].no : ln.no + 1;
    node.srcLines = srcLines;
    return node;
  }
}

export function parseDocument(text) {
  if (typeof text !== "string") throw new TypeError("parseDocument expects a string");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return new Parser(text).document();
}

export function toJS(node) {
  if (node.t === "scalar") return node.value;
  if (node.t === "seq") return node.items.map(toJS);
  const o = {};
  for (const e of node.entries) {
    Object.defineProperty(o, e.key, { value: toJS(e.value), enumerable: true, writable: true, configurable: true });
  }
  return o;
}

export function parse(text) {
  return toJS(parseDocument(text).root);
}

// Convenience accessors for AST consumers.
export function entry(map, key) {
  return map && map.t === "map" ? map.entries.find((e) => e.key === key) : undefined;
}

export function get(map, key) {
  const e = entry(map, key);
  return e ? e.value : undefined;
}

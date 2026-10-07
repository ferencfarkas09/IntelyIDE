// A small, safe Markdown reader: text in, an AST out. Nothing here produces HTML: raw `<tags>` stay literal text, and the
// view builds elements itself, so there is no injection surface. Links and images are classified, never fetched.

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong" | "em" | "del"; c: Inline[] }
  | { t: "link"; href: string | null; c: Inline[] }
  | { t: "image"; src: string; alt: string }
  | { t: "br" };

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { t: "heading"; level: number; c: Inline[] }
  | { t: "p"; c: Inline[] }
  | { t: "code"; lang: string; v: string }
  | { t: "quote"; c: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: { task: boolean | null; c: Block[] }[] }
  | { t: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { t: "hr" };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** http(s) and mailto links, in-page anchors and relative paths pass; `javascript:`, `data:`, `file:` and friends do not. */
export function safeHref(href: string): string | null {
  const h = href.trim();
  if (!h) return null;
  if (/^(https?:|mailto:)/i.test(h)) return h;
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith("//")) return null;
  return h;
}

export type ImageSource = { kind: "remote"; url: string } | { kind: "local"; path: string } | { kind: "blocked" };

/** Remote images are never fetched; a relative path is resolved against the document's folder inside the repo. */
export function imageSource(src: string, dir: string): ImageSource {
  const s = src.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith("//")) return /^https?:/i.test(s) || s.startsWith("//") ? { kind: "remote", url: s } : { kind: "blocked" };
  const parts = (s.startsWith("/") ? s.slice(1) : `${dir ? `${dir}/` : ""}${s}`).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (!out.length) return { kind: "blocked" };
      out.pop();
    } else out.push(decodeURIComponent(p));
  }
  return out.length ? { kind: "local", path: out.join("/") } : { kind: "blocked" };
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) (out.push({ t: "text", v: text }), (text = ""));
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!|~<>]/.test(src[i + 1])) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      const m = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(src.slice(i));
      if (m) {
        flush();
        out.push({ t: "code", v: m[2].replace(/^ (.*) $/, "$1") });
        i += m[0].length;
        continue;
      }
    }
    if (c === "!" && src[i + 1] === "[") {
      const m = /^!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(src.slice(i));
      if (m) {
        flush();
        out.push({ t: "image", alt: m[1], src: m[2] });
        i += m[0].length;
        continue;
      }
    }
    if (c === "[") {
      const m = /^\[((?:[^\]\\]|\\.)*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/.exec(src.slice(i));
      if (m) {
        flush();
        out.push({ t: "link", href: safeHref(m[2]), c: parseInline(m[1]) });
        i += m[0].length;
        continue;
      }
    }
    const emph = /^(\*\*|__|~~|\*|_)(?=\S)/.exec(src.slice(i));
    if (emph) {
      const mark = emph[1];
      const close = findClose(src, i + mark.length, mark);
      if (close > 0 && (mark[0] !== "_" || isWordBoundary(src, i, close + mark.length))) {
        flush();
        const t = mark === "**" || mark === "__" ? "strong" : mark === "~~" ? "del" : "em";
        out.push({ t, c: parseInline(src.slice(i + mark.length, close)) });
        i = close + mark.length;
        continue;
      }
    }
    if (c === " " && src.startsWith("  \n", i)) {
      flush();
      out.push({ t: "br" });
      i += 3;
      continue;
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

function findClose(s: string, from: number, mark: string): number {
  for (let j = from; j < s.length; j++) {
    if (s[j] === "\\") j++;
    else if (s[j] === "`") {
      const end = s.indexOf("`", j + 1);
      if (end > 0) j = end;
    } else if (s.startsWith(mark, j) && j > from && !/\s/.test(s[j - 1]) && (mark.length > 1 || s[j + 1] !== mark)) return j;
  }
  return -1;
}

function isWordBoundary(s: string, open: number, closeEnd: number): boolean {
  return !/\w/.test(s[open - 1] ?? " ") && !/\w/.test(s[closeEnd] ?? " ");
}

function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

const indentOf = (l: string): number => l.length - l.trimStart().length;

function startsBlock(l: string, next: string | undefined): boolean {
  return FENCE.test(l) || HEADING.test(l) || HR.test(l) || /^ {0,3}>/.test(l) || LIST.test(l) || (l.includes("|") && next !== undefined && TABLE_SEP.test(next));
}

export function parseBlocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(l);
    if (fence) {
      const [, marker, lang] = fence;
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i].trim().startsWith(marker[0].repeat(marker.length)) && /^\s*[`~]+\s*$/.test(lines[i]))) body.push(lines[i++]);
      i++;
      out.push({ t: "code", lang, v: body.join("\n") });
      continue;
    }
    const h = HEADING.exec(l);
    if (h) {
      out.push({ t: "heading", level: h[1].length, c: parseInline(h[2]) });
      i++;
      continue;
    }
    if (HR.test(l)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }
    if (/^ {0,3}>/.test(l)) {
      const body: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) body.push(lines[i++].replace(/^ {0,3}> ?/, ""));
      out.push({ t: "quote", c: parseBlocks(body) });
      continue;
    }
    if (l.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = splitRow(l);
      const align = splitRow(lines[i + 1]).map((c): Align => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null));
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(splitRow(lines[i++]).map(parseInline).slice(0, head.length));
      out.push({ t: "table", align, head: head.map(parseInline), rows });
      continue;
    }
    const li = LIST.exec(l);
    if (li) {
      const base = li[1].length;
      const ordered = /\d/.test(li[2]);
      const items: { task: boolean | null; c: Block[] }[] = [];
      const start = ordered ? parseInt(li[2], 10) : 1;
      while (i < lines.length) {
        const m = LIST.exec(lines[i]);
        if (!m || m[1].length !== base || /\d/.test(m[2]) !== ordered) break;
        const body = [m[3]];
        i++;
        while (i < lines.length && (lines[i].trim() === "" ? i + 1 < lines.length && indentOf(lines[i + 1]) > base : indentOf(lines[i]) > base)) body.push(lines[i++].slice(Math.min(indentOf(lines[i - 1] ?? ""), base + 2)));
        const task = /^\[( |x|X)\]\s/.exec(body[0]);
        if (task) body[0] = body[0].slice(4);
        items.push({ task: task ? task[1] !== " " : null, c: parseBlocks(body) });
      }
      out.push({ t: "list", ordered, start, items });
      continue;
    }
    const para: string[] = [l.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) para.push(lines[i++].trim());
    out.push({ t: "p", c: parseInline(para.join("\n").replace(/\n/g, " ")) });
  }
  return out;
}

export function parseMarkdown(src: string): Block[] {
  return parseBlocks(src.replace(/\r\n?/g, "\n").split("\n"));
}

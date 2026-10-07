import DOMPurify from "dompurify";
import { Marked } from "marked";
import { escapeHtml, highlight } from "./highlight";

/**
 * Markdown for agent output. Links and images are never live: a link becomes a plain labelled span (the target stays in the
 * tooltip) and an image becomes its alt text, so model output cannot navigate the webview or fetch remote content.
 */
const marked = new Marked({
  gfm: true,
  breaks: false,
  async: false,
  renderer: {
    link(token) {
      return `<span class="md-link" title="${escapeHtml(token.href)}">${this.parser.parseInline(token.tokens)}</span>`;
    },
    image(token) {
      return escapeHtml(token.text || "image");
    },
    html(token) {
      return escapeHtml(token.text);
    },
    code(token) {
      const lang = (token.lang ?? "").split(/\s/)[0];
      return `<pre class="md-code"${lang ? ` data-lang="${escapeHtml(lang)}"` : ""}><code>${highlight(token.text, lang)}</code></pre>`;
    },
  },
});

const ALLOWED_TAGS = ["p", "br", "strong", "em", "del", "code", "pre", "span", "ul", "ol", "li", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "table", "thead", "tbody", "tr", "th", "td"];
const ALLOWED_ATTR = ["class", "title", "data-lang", "start"];

export function renderMarkdown(source: string): string {
  const html = marked.parse(source) as string;
  return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOW_DATA_ATTR: false });
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const UNSAFE_START = /^(\s|[-*+]\s|\d+[.)]\s|>|\[[^\]]+\]:)/;

/**
 * Splits streamed markdown at blank lines that cannot change how the text on either side renders (outside fences, and not
 * before an indented line, list item, quote or reference definition). Finished chunks keep their text while the tail grows,
 * so only the tail has to be parsed and sanitised again on each delta. The chunks always join back to `source`.
 */
export function splitBlocks(source: string): string[] {
  const lines = source.split("\n");
  const chunks: string[] = [];
  let start = 0;
  let fence: { char: string; len: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = FENCE.exec(line);
    if (m) {
      const char = m[1][0];
      if (!fence) fence = { char, len: m[1].length };
      else if (char === fence.char && m[1].length >= fence.len && line.trim() === m[1]) fence = undefined;
    }
    if (fence || line.trim() !== "" || i + 1 >= lines.length) continue;
    // `line` is blank: the boundary goes before the next non-blank line.
    let next = i + 1;
    while (next < lines.length && lines[next].trim() === "") next++;
    if (next >= lines.length || UNSAFE_START.test(lines[next])) continue;
    const cut = lines.slice(0, next).reduce((n, l) => n + l.length + 1, 0);
    if (cut > start && cut <= source.length) {
      chunks.push(source.slice(start, cut));
      start = cut;
    }
    i = next - 1;
  }
  if (start < source.length) chunks.push(source.slice(start));
  return chunks;
}

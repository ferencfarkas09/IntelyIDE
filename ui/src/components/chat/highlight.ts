/** Light syntax colouring for code blocks: comments, strings, numbers and keywords. Output is escaped HTML. */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const KEYWORDS = new Set(
  (
    "as async await break case catch class const continue default delete do else enum export extends false finally for from function if impl import in instanceof interface let loop match mod mut new null of package private public pub return self static struct super switch this throw trait true try type typeof undefined use var void while with yield " +
    "def elif lambda pass None True False fn echo fi then done"
  ).split(" "),
);

const SHELL = new Set(["sh", "bash", "zsh", "shell", "console"]);
const HASH_COMMENT = new Set([...SHELL, "py", "python", "yaml", "yml", "toml", "rb", "ruby"]);

const TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)/g;

export function highlight(code: string, lang: string | undefined): string {
  const l = (lang ?? "").toLowerCase();
  if (l === "diff") return highlightDiff(code);
  const hash = HASH_COMMENT.has(l);
  let out = "";
  let last = 0;
  for (const m of code.matchAll(TOKEN)) {
    const [text, comment, str, num, word] = m;
    let cls: string | undefined;
    if (comment) cls = comment.startsWith("#") ? (hash ? "c" : undefined) : "c";
    else if (str) cls = "s";
    else if (num) cls = "n";
    else if (word && KEYWORDS.has(word)) cls = "k";
    out += escapeHtml(code.slice(last, m.index));
    out += cls ? `<span class="tok-${cls}">${escapeHtml(text)}</span>` : escapeHtml(text);
    last = m.index + text.length;
  }
  return out + escapeHtml(code.slice(last));
}

function highlightDiff(code: string): string {
  return code
    .split("\n")
    .map((line) => {
      const cls = line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : line.startsWith("@@") ? "hunk" : "";
      return cls ? `<span class="tok-${cls}">${escapeHtml(line)}</span>` : escapeHtml(line);
    })
    .join("\n");
}

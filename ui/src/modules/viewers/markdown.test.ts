import { describe, expect, it } from "vitest";
import { imageSource, parseInline, parseMarkdown, safeHref, type Block, type Inline } from "./markdown";

const text = (c: Inline[]): string => c.map((i) => (i.t === "text" || i.t === "code" ? i.v : i.t === "image" ? i.alt : i.t === "br" ? " " : text(i.c))).join("");

describe("markdown blocks", () => {
  const doc = `# Title

Para with **bold**, *em*, ~~gone~~ and \`code\`.
Second line.

- [x] done
- [ ] todo
  - nested

1. one
2. two

> quote <b>raw</b>

| A | B |
|:--|--:|
| 1 | 2 |

\`\`\`ts
const x = 1;
\`\`\`

---`;
  const blocks = parseMarkdown(doc);

  it("recognises the common blocks in order", () => {
    expect(blocks.map((b) => b.t)).toEqual(["heading", "p", "list", "list", "quote", "table", "code", "hr"]);
  });

  it("reads inline marks, task items, nesting and tables", () => {
    const p = blocks[1] as Extract<Block, { t: "p" }>;
    expect(p.c.map((i) => i.t)).toEqual(["text", "strong", "text", "em", "text", "del", "text", "code", "text"]);
    expect(text(p.c)).toBe("Para with bold, em, gone and code. Second line.");
    const list = blocks[2] as Extract<Block, { t: "list" }>;
    expect(list.items.map((i) => i.task)).toEqual([true, false]);
    expect((list.items[1].c[1] as Extract<Block, { t: "list" }>).items).toHaveLength(1);
    expect((blocks[3] as Extract<Block, { t: "list" }>).ordered).toBe(true);
    const table = blocks[5] as Extract<Block, { t: "table" }>;
    expect(table.align).toEqual(["left", "right"]);
    expect(table.rows.map((r) => r.map(text))).toEqual([["1", "2"]]);
    expect((blocks[6] as Extract<Block, { t: "code" }>).v).toBe("const x = 1;");
  });

  it("keeps raw HTML as literal text, never as an element", () => {
    const q = blocks[4] as Extract<Block, { t: "quote" }>;
    expect(text((q.c[0] as Extract<Block, { t: "p" }>).c)).toBe("quote <b>raw</b>");
    const evil = parseMarkdown("<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>");
    expect(evil.every((b) => b.t === "p")).toBe(true);
    expect(JSON.stringify(evil)).not.toMatch(/"t":"(html|script)"/);
  });
});

describe("links and images are classified, never fetched", () => {
  it("passes only web, mail and relative links", () => {
    expect(safeHref("https://example.com/a")).toBe("https://example.com/a");
    expect(safeHref("mailto:a@b.hu")).toBe("mailto:a@b.hu");
    expect(safeHref("#section")).toBe("#section");
    expect(safeHref("docs/x.md")).toBe("docs/x.md");
    for (const bad of ["javascript:alert(1)", " JavaScript:alert(1)", "data:text/html,<script>", "file:///etc/passwd", "vbscript:x", "//evil.example/x"]) expect(safeHref(bad), bad).toBeNull();
    const l = parseInline("[x](javascript:alert(1))")[0];
    expect(l).toMatchObject({ t: "link", href: null });
  });

  it("blocks remote images and resolves local ones inside the repo only", () => {
    expect(imageSource("https://example.com/x.png", "docs")).toEqual({ kind: "remote", url: "https://example.com/x.png" });
    expect(imageSource("//cdn.example/x.png", "docs").kind).toBe("remote");
    expect(imageSource("data:image/png;base64,AAAA", "docs")).toEqual({ kind: "blocked" });
    expect(imageSource("img/a%20b.png", "docs")).toEqual({ kind: "local", path: "docs/img/a b.png" });
    expect(imageSource("../assets/logo.svg", "docs/deep")).toEqual({ kind: "local", path: "docs/assets/logo.svg" });
    expect(imageSource("../../../etc/passwd", "docs")).toEqual({ kind: "blocked" });
    expect(imageSource("/assets/logo.svg", "docs")).toEqual({ kind: "local", path: "assets/logo.svg" });
  });
});

import { describe, expect, it } from "vitest";
import { renderMarkdown, splitBlocks } from "./mdRender";

describe("renderMarkdown", () => {
  it("renders basic markdown", () => {
    const html = renderMarkdown("**bold** and `code`\n\n- one\n- two");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<li>one</li>");
  });

  it("never produces live links or images", () => {
    const html = renderMarkdown("[click](https://evil.example/x) ![pic](https://evil.example/p.png) <a href=\"https://evil.example\">raw</a> <img src=x onerror=alert(1)>");
    expect(html).not.toMatch(/<a[\s>]/);
    expect(html).not.toMatch(/<img/);
    expect(html).toContain("&lt;img");
    expect(html).toContain('class="md-link"');
    expect(html).toContain("click");
  });

  it("strips scripts and event handlers, escapes raw html", () => {
    const html = renderMarkdown("<script>alert(1)</script><b onclick=\"x()\">b</b>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b");
  });

  it("highlights code blocks and keeps an unclosed fence streaming-safe", () => {
    const html = renderMarkdown("```ts\nconst a = 'x'; // note\n```");
    expect(html).toContain('data-lang="ts"');
    expect(html).toContain("tok-k");
    expect(html).toContain("tok-s");
    expect(html).toContain("tok-c");
    expect(renderMarkdown("```ts\nconst a = 1")).toContain("<pre");
  });
});

describe("splitBlocks", () => {
  it("splits at blank lines and always joins back to the source", () => {
    const text = "para one\n\npara two\n\n\n# Title\n\ntail";
    const parts = splitBlocks(text);
    expect(parts).toEqual(["para one\n\n", "para two\n\n\n", "# Title\n\n", "tail"]);
    expect(parts.join("")).toBe(text);
  });

  it("keeps a growing tail separate from the finished blocks", () => {
    const [first, ...rest] = splitBlocks("done\n\nstream");
    expect(splitBlocks("done\n\nstreaming on")[0]).toBe(first);
    expect(rest).toEqual(["stream"]);
  });

  it("never splits inside a fence, even at blank lines", () => {
    const text = "intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nafter";
    expect(splitBlocks(text)).toEqual(["intro\n\n", "```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n", "after"]);
    expect(splitBlocks("```\nopen\n\nstill open")).toEqual(["```\nopen\n\nstill open"]);
  });

  it("does not split a loose list, an indented continuation or a quote", () => {
    for (const text of ["1. a\n\n2. b", "- a\n\n  more of a", "> quote\n\n> more", "- a\n\n- b"]) expect(splitBlocks(text)).toEqual([text]);
  });

  it("renders the same text whether split or not", () => {
    const text = "# T\n\nsome **bold**\n\n- x\n- y\n\n```js\nlet a;\n```\n";
    expect(splitBlocks(text).map(renderMarkdown).join("")).toContain("<strong>bold</strong>");
    expect(splitBlocks(text).join("")).toBe(text);
  });

  it("copes with empty and blank-only input", () => {
    expect(splitBlocks("")).toEqual([]);
    expect(splitBlocks("\n\n\n").join("")).toBe("\n\n\n");
  });
});

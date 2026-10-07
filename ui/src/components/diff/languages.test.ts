import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, language } from "@codemirror/language";
import { describe, expect, it } from "vitest";
import { loadLanguage } from "./languages";
import type { LanguageKey } from "./logic";

const SAMPLES: Record<LanguageKey, string> = {
  javascript: "const a = 1;",
  typescript: "const a: number = 1;",
  jsx: "const a = <b />;",
  tsx: "const a: number = <b />;",
  json: '{"a": 1}',
  css: "a { color: red; }",
  html: "<p class='x'>hi</p>",
  markdown: "# Title\n\ntext",
  rust: "fn main() {}",
  yaml: "a: 1\nb: [x, y]",
  shell: 'echo "$HOME" | grep x',
  sql: "SELECT a FROM b WHERE c = 1;",
};

describe("loadLanguage", () => {
  it.each(Object.keys(SAMPLES) as LanguageKey[])("loads %s and parses a sample into a syntax tree", async (key) => {
    const state = EditorState.create({ doc: SAMPLES[key], extensions: [await loadLanguage(key)] });
    expect(state.facet(language)).toBeTruthy();
    const tree = ensureSyntaxTree(state, state.doc.length, 2000);
    expect(tree?.length).toBe(state.doc.length);
  });
});

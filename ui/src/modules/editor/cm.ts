import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit } from "@codemirror/language";
import { Compartment, EditorState, type Extension, type Text } from "@codemirror/state";
import { drawSelection, EditorView, type ViewUpdate, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { highlight } from "../../components/diff/highlight";
import { loadLanguage } from "../../components/diff/languages";
import { languageKey } from "../../components/diff/logic";
import { extensionsFor } from "../../platform/editor-ext";
import type { Indent } from "./logic";

// One instance serves every editor state: a compartment is addressed per state.
const indentSlot = new Compartment();
const wrapSlot = new Compartment();
const themeSlot = new Compartment();
const listenerSlot = new Compartment();
const readOnlySlot = new Compartment();

const mono = "var(--font-mono)";

function theme(dark: boolean): Extension {
  return EditorView.theme(
    {
      "&": { height: "100%", color: "var(--text-1)", backgroundColor: "var(--surface-1)", fontSize: "var(--text-sm)" },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": { fontFamily: mono, lineHeight: "1.65", overflow: "auto" },
      ".cm-content": { padding: "var(--space-2) 0", caretColor: "var(--text-1)" },
      ".cm-line": { padding: "0 var(--space-4) 0 var(--space-2)" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text-1)", borderLeftWidth: "1.5px" },
      ".cm-gutters": { backgroundColor: "var(--surface-1)", color: "var(--text-3)", border: "none", fontFamily: mono },
      ".cm-lineNumbers .cm-gutterElement": { padding: "0 var(--space-2) 0 var(--space-3)", minWidth: "44px", fontVariantNumeric: "tabular-nums" },
      ".cm-activeLine": { backgroundColor: "var(--surface-hover)" },
      ".cm-activeLineGutter": { backgroundColor: "var(--surface-hover)", color: "var(--text-1)" },
      ".cm-foldGutter .cm-gutterElement": { cursor: "pointer", color: "var(--text-3)", padding: "0 var(--space-1)" },
      ".cm-foldGutter .cm-gutterElement:hover": { color: "var(--text-1)" },
      ".cm-foldPlaceholder": { backgroundColor: "var(--surface-3)", border: "none", color: "var(--text-2)", borderRadius: "var(--radius-1)", padding: "0 var(--space-1)" },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "var(--selection-bg)" },
      ".cm-selectionMatch": { backgroundColor: "var(--accent-subtle)" },
      "&.cm-focused .cm-matchingBracket": { backgroundColor: "var(--accent-subtle-hover)", outline: "1px solid var(--accent-border)" },
      ".cm-searchMatch": { backgroundColor: "var(--warn-subtle)", outline: "1px solid var(--warn-border)" },
      ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--accent-subtle-hover)", outline: "1px solid var(--accent-border)" },
      ".cm-panels": { backgroundColor: "var(--surface-2)", color: "var(--text-1)", fontFamily: "var(--font-ui)", fontSize: "var(--text-sm)" },
      ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border-subtle)" },
      ".cm-panels input, .cm-panels button, .cm-panels label": { fontFamily: "var(--font-ui)", fontSize: "var(--text-sm)" },
      ".cm-panel.cm-search": { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--space-1) var(--space-2)", padding: "var(--space-2) var(--space-8) var(--space-2) var(--space-3)" },
      ".cm-panel.cm-search br": { display: "none" },
      ".cm-panel.cm-search input.cm-textfield": { height: "24px", padding: "0 var(--space-2)", border: "1px solid var(--border)", borderRadius: "var(--radius-2)", backgroundColor: "var(--surface-1)", color: "var(--text-1)", outline: "none" },
      ".cm-panel.cm-search input.cm-textfield:focus": { borderColor: "var(--accent)" },
      ".cm-panel.cm-search button": { height: "24px", padding: "0 var(--space-2)", border: "1px solid var(--border)", borderRadius: "var(--radius-2)", backgroundImage: "none", backgroundColor: "var(--surface-3)", color: "var(--text-1)", cursor: "pointer" },
      ".cm-panel.cm-search button:hover": { backgroundColor: "var(--surface-active)" },
      ".cm-panel.cm-search button[name=close]": { position: "absolute", top: "var(--space-1)", right: "var(--space-2)", border: "none", backgroundColor: "transparent", color: "var(--text-3)", fontSize: "var(--text-md)" },
      ".cm-panel.cm-search label": { display: "inline-flex", alignItems: "center", gap: "var(--space-1)", color: "var(--text-2)" },
      ".cm-panel.cm-gotoLine": { display: "flex", alignItems: "center", gap: "var(--space-2)", padding: "var(--space-2) var(--space-3)" },
      ".cm-panel.cm-gotoLine input": { height: "24px", padding: "0 var(--space-2)", border: "1px solid var(--border)", borderRadius: "var(--radius-2)", backgroundColor: "var(--surface-1)", color: "var(--text-1)", outline: "none" },
      ".cm-panel.cm-gotoLine button": { height: "24px", padding: "0 var(--space-2)", border: "1px solid var(--border)", borderRadius: "var(--radius-2)", backgroundImage: "none", backgroundColor: "var(--surface-3)", color: "var(--text-1)", cursor: "pointer" },
    },
    { dark },
  );
}

export interface EditorSetup {
  repoId: string;
  path: string;
  language?: string;
  doc: Text;
  indent: Indent;
  dark: boolean;
  wrap: boolean;
  /** A partial read (file over 5 MiB): no typing, never saved. */
  readOnly?: boolean;
}

/** Builds the editor state. The language pack is shared with the diff view; `registerEditorExtension` contributions are added for matching files. */
export async function createEditorState(s: EditorSetup): Promise<EditorState> {
  const key = languageKey(s.path, s.language);
  const [language, extra] = await Promise.all([key ? loadLanguage(key).catch((): Extension => []) : [], extensionsFor({ repoId: s.repoId, path: s.path, language: s.language })]);
  return EditorState.create({
    doc: s.doc,
    extensions: [
      EditorState.lineSeparator.of("\n"),
      lineNumbers(),
      highlightActiveLineGutter(),
      foldGutter(),
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, ...searchKeymap, indentWithTab]),
      highlight,
      indentSlot.of(indentExtension(s.indent)),
      wrapSlot.of(s.wrap ? EditorView.lineWrapping : []),
      themeSlot.of(theme(s.dark)),
      language,
      ...extra,
      listenerSlot.of([]),
      readOnlySlot.of(readOnlyExtension(!!s.readOnly)),
    ],
  });
}

const readOnlyExtension = (on: boolean): Extension => [EditorState.readOnly.of(on), EditorView.editable.of(!on)];

const indentExtension = (indent: Indent): Extension => [indentUnit.of(indent.unit), EditorState.tabSize.of(indent.tabSize)];

export const setIndentEffect = (indent: Indent) => indentSlot.reconfigure(indentExtension(indent));
export const setWrapEffect = (wrap: boolean) => wrapSlot.reconfigure(wrap ? EditorView.lineWrapping : []);
export const setListenerEffect = (onUpdate: (u: ViewUpdate) => void) => listenerSlot.reconfigure(EditorView.updateListener.of(onUpdate));
export const setReadOnlyEffect = (on: boolean) => readOnlySlot.reconfigure(readOnlyExtension(on));
export const setThemeEffect = (dark: boolean) => themeSlot.reconfigure(theme(dark));

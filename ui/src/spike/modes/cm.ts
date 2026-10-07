import { EditorView, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { keymap } from "@codemirror/view";

export const baseExtensions: Extension[] = [
  lineNumbers(),
  highlightActiveLine(),
  history(),
  bracketMatching(),
  syntaxHighlighting(defaultHighlightStyle),
  javascript(),
  keymap.of([...defaultKeymap, ...historyKeymap]),
  EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { overflow: "auto" } }),
];

export function mount(parent: HTMLElement, doc: string, extra: Extension[] = []): EditorView {
  return new EditorView({ parent, state: EditorState.create({ doc, extensions: [...baseExtensions, ...extra] }) });
}

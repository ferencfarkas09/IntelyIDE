import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, completionStatus, type CompletionSource } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { bracketMatching } from "@codemirror/language";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExt } from "@codemirror/view";
import { createEffect, on, onCleanup, onMount } from "solid-js";
import { highlight } from "../components/diff/highlight";
import "./data.css";

// Imported by path (`ui-kit/CodeEditor`), never through the barrel: CodeMirror stays out of the main chunk.

export interface CodeEditorHandle {
  focus(): void;
  view(): EditorView | undefined;
}

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  /** Accessible name; the editor has no visible <label>. */
  label: string;
  placeholder?: string;
  /** Called for Enter (when `submitOnEnter`) and for Mod+Shift+Enter. Shift+Enter inserts a line break. */
  onSubmit?: () => void;
  submitOnEnter?: boolean;
  completions?: CompletionSource;
  invalid?: boolean;
  readOnly?: boolean;
  /** Extra extensions (language support, linting). Default: JavaScript expressions, which fits mongosh literals. */
  extensions?: Extension;
  /** Soft wrap long lines instead of scrolling sideways. Default on. */
  wrap?: boolean;
  /** Maximum height in px before the editor scrolls (default 120). */
  maxHeight?: number;
  class?: string;
  ref?: (h: CodeEditorHandle) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

const theme = EditorView.theme({
  "&": { color: "var(--text-1)", backgroundColor: "transparent", fontSize: "var(--text-sm)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "20px", overflow: "auto" },
  ".cm-content": { padding: "3px 0", caretColor: "var(--text-1)", minHeight: "20px" },
  ".cm-line": { padding: "0 var(--space-2)" },
  ".cm-placeholder": { color: "var(--text-3)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text-1)", borderLeftWidth: "1.5px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "var(--selection-bg)" },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "var(--accent-subtle-hover)", outline: "1px solid var(--accent-border)" },
  ".cm-tooltip": { border: "none", backgroundColor: "var(--surface-3)", color: "var(--text-1)", borderRadius: "var(--radius-3)", boxShadow: "var(--shadow-popover)", overflow: "hidden", fontFamily: "var(--font-ui)" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", maxHeight: "240px", minWidth: "220px", padding: "var(--space-1)" },
  ".cm-tooltip-autocomplete ul li": { display: "flex", alignItems: "center", gap: "var(--space-2)", height: "24px", padding: "0 var(--space-2)", borderRadius: "var(--radius-2)", lineHeight: "24px" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--surface-selected)", color: "var(--text-1)" },
  ".cm-completionLabel": { flex: "1", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis" },
  ".cm-completionMatchedText": { textDecoration: "none", color: "var(--accent-text)", fontWeight: "600" },
  ".cm-completionDetail": { marginLeft: "auto", color: "var(--text-3)", fontStyle: "normal", fontFamily: "var(--font-ui)", fontSize: "var(--text-xs)" },
  ".cm-completionIcon": { display: "none" },
  ".cm-tooltip.cm-completionInfo": { padding: "var(--space-2) var(--space-3)", fontSize: "var(--text-sm)", color: "var(--text-2)", maxWidth: "280px" },
});

const slot = new Compartment();
const roSlot = new Compartment();

/** A compact CodeMirror 6 editor on the design tokens: one or a few lines, completion, submit chords. */
export function CodeEditor(props: CodeEditorProps) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  let own = false;

  const dynamic = (): Extension => [
    props.completions ? autocompletion({ override: [props.completions], icons: false, activateOnTyping: true, tooltipClass: () => "ui-code-tip" }) : [],
    EditorView.contentAttributes.of({ "aria-label": props.label, "aria-invalid": props.invalid ? "true" : "false", spellcheck: "false", autocapitalize: "off", autocorrect: "off" }),
    props.extensions ?? javascript(),
  ];

  onMount(() => {
    const submit = () => (props.onSubmit?.(), true);
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          Prec.highest(
            keymap.of([
              { key: "Mod-Shift-Enter", run: submit },
              ...(props.submitOnEnter ? [{ key: "Enter", run: (v: EditorView) => completionStatus(v.state) !== "active" && submit() }] : []),
            ]),
          ),
          history(),
          closeBrackets(),
          bracketMatching(),
          keymap.of([...closeBracketsKeymap, ...completionKeymap, ...defaultKeymap, ...historyKeymap]),
          highlight,
          theme,
          props.wrap === false ? [] : EditorView.lineWrapping,
          props.placeholder ? placeholderExt(props.placeholder) : [],
          slot.of(dynamic()),
          roSlot.of([EditorState.readOnly.of(!!props.readOnly), EditorView.editable.of(!props.readOnly)]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              own = true;
              props.onChange?.(u.state.doc.toString());
            }
          }),
          EditorView.domEventHandlers({ focus: () => void props.onFocus?.(), blur: () => void props.onBlur?.() }),
        ],
      }),
    });
    view.scrollDOM.style.maxHeight = `${props.maxHeight ?? 120}px`;
    props.ref?.({ focus: () => view?.focus(), view: () => view });
  });

  createEffect(
    on(
      () => props.value,
      (v) => {
        if (!view) return;
        if (own) {
          own = false;
          return;
        }
        if (v !== view.state.doc.toString()) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
      },
      { defer: true },
    ),
  );
  createEffect(() => view?.dispatch({ effects: slot.reconfigure(dynamic()) }));
  createEffect(() => view?.dispatch({ effects: roSlot.reconfigure([EditorState.readOnly.of(!!props.readOnly), EditorView.editable.of(!props.readOnly)]) }));
  onCleanup(() => view?.destroy());

  return <div ref={host} class={props.class ? `ui-code ${props.class}` : "ui-code"} data-invalid={props.invalid ? "" : undefined} />;
}

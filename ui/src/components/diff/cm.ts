import { Compartment, EditorState, Prec, type Extension, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, lineNumbers, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { getChunks, getOriginalDoc, MergeView, unifiedMergeView } from "@codemirror/merge";
import { highlight } from "./highlight";
import { loadLanguage } from "./languages";
import type { DiffViewMode, LanguageKey } from "./logic";

export interface DiffInput {
  original: string;
  modified: string;
  language: LanguageKey | null;
  dark: boolean;
}

export interface DiffHandle {
  destroy(): void;
  setDark(dark: boolean): void;
  /** Changed lines on each side, for the header. */
  stats: { added: number; removed: number };
}

const mono = "var(--font-mono)";

/**
 * Marks each line's leading indentation. The merge view highlights an indentation change as a changed word, which
 * shows as a detached block at the start of the line. This mark has the highest precedence, so it ends up innermost
 * and paints the line colour over that block again (see `.cm-indent` in the theme).
 */
const indentMark = Decoration.mark({ class: "cm-indent" });
const indentation = Prec.highest(
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
      }
      build(view: EditorView): DecorationSet {
        const marks: Range<Decoration>[] = [];
        for (const { from, to } of view.visibleRanges) {
          for (let pos = from; pos <= to; ) {
            const line = view.state.doc.lineAt(pos);
            const ws = /^[ \t]+/.exec(line.text);
            if (ws) marks.push(indentMark.range(line.from, line.from + ws[0].length));
            pos = line.to + 1;
          }
        }
        return Decoration.set(marks);
      }
    },
    { decorations: (v) => v.decorations },
  ),
);

/** Colours come from the design tokens, so one theme definition serves dark and light. */
function theme(dark: boolean): Extension {
  return EditorView.theme(
    {
      "&": { height: "100%", color: "var(--text-1)", backgroundColor: "var(--surface-1)", fontSize: "var(--code-font-size, var(--text-sm))" },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": { fontFamily: mono, lineHeight: "1.65", overflow: "auto" },
      ".cm-content": { padding: "var(--space-2) 0", caretColor: "transparent" },
      ".cm-line": { padding: "0 var(--space-4) 0 var(--space-2)" },
      ".cm-gutters": { backgroundColor: "var(--surface-1)", color: "var(--text-3)", border: "none", fontFamily: mono },
      ".cm-lineNumbers .cm-gutterElement": { padding: "0 var(--space-2) 0 var(--space-3)", minWidth: "44px", fontVariantNumeric: "tabular-nums" },
      ".cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "var(--selection, var(--accent-subtle-hover))" },
      // Changed lines and words (unified view and both split sides).
      ".cm-changedLine, .cm-inlineChangedLine": { backgroundColor: "var(--diff-add-bg) !important" },
      ".cm-changedText": { background: "var(--diff-add-strong) !important", backgroundImage: "none !important", borderRadius: "2px" },
      ".cm-changedLine .cm-indent, .cm-inlineChangedLine .cm-indent": { background: "linear-gradient(var(--diff-add-bg), var(--diff-add-bg)), var(--surface-1) !important" },
      "&.cm-merge-a .cm-changedLine .cm-indent": { background: "linear-gradient(var(--diff-del-bg), var(--diff-del-bg)), var(--surface-1) !important" },
      ".cm-deletedChunk": { backgroundColor: "var(--diff-del-bg) !important", padding: "0" },
      ".cm-deletedChunk .cm-deletedLine": { padding: "0 var(--space-4) 0 var(--space-2)" },
      ".cm-deletedChunk .cm-deletedText, .cm-deletedText": { background: "var(--diff-del-strong) !important", backgroundImage: "none !important", borderRadius: "2px" },
      "&.cm-merge-a .cm-changedLine": { backgroundColor: "var(--diff-del-bg) !important" },
      "&.cm-merge-a .cm-changedText": { background: "var(--diff-del-strong) !important", backgroundImage: "none !important" },
      ".cm-changeGutter": { width: "3px", paddingLeft: "0" },
      ".cm-changedLineGutter": { background: "var(--ok) !important" },
      ".cm-deletedLineGutter, &.cm-merge-a .cm-changedLineGutter": { background: "var(--danger) !important" },
      ".cm-collapsedLines": {
        margin: "var(--space-1) var(--space-3)",
        padding: "var(--space-half) var(--space-3)",
        borderRadius: "var(--radius-2)",
        backgroundColor: "var(--surface-2) !important",
        backgroundImage: "none !important",
        color: "var(--text-3) !important",
        fontFamily: "var(--font-ui)",
        fontSize: "var(--text-xs)",
        cursor: "pointer",
        transition: "background-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease)",
      },
      ".cm-collapsedLines:hover": { backgroundColor: "var(--surface-active) !important", color: "var(--text-1) !important" },
      ".cm-collapsedLines::before, .cm-collapsedLines::after": { content: "none" },
      // Rows opposite an insertion or deletion in split view.
      ".cm-mergeSpacer": { backgroundImage: "repeating-linear-gradient(135deg, transparent 0 4px, var(--border-subtle) 4px 5px) !important", backgroundColor: "transparent !important" },
    },
    { dark },
  );
}

function baseExtensions(language: Extension, themeSlot: Compartment, dark: boolean): Extension[] {
  return [
    lineNumbers(),
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    highlight,
    indentation,
    themeSlot.of(theme(dark)),
    language,
  ];
}

const collapse = { margin: 3, minSize: 6 };

function countLines(doc: { lineAt(pos: number): { number: number }; length: number }, from: number, to: number): number {
  return to > from ? doc.lineAt(to - 1).number - doc.lineAt(from).number + 1 : 0;
}

/** Mounts a read-only diff into `parent`. The returned handle destroys the view(s) so a file switch leaves nothing behind. */
export async function mountDiff(parent: HTMLElement, mode: DiffViewMode, input: DiffInput): Promise<DiffHandle> {
  // The grammar is loaded before the editor exists, so deleted lines (rendered once) are highlighted too.
  const language = input.language ? await loadLanguage(input.language).catch((): Extension => []) : [];
  const themeSlot = new Compartment();
  const base = baseExtensions(language, themeSlot, input.dark);
  const views: EditorView[] = [];
  let destroy: () => void;
  const stats = { added: 0, removed: 0 };

  if (mode === "unified") {
    const state = EditorState.create({
      doc: input.modified,
      extensions: [...base, unifiedMergeView({ original: input.original, mergeControls: false, gutter: true, highlightChanges: true, syntaxHighlightDeletions: true, collapseUnchanged: collapse })],
    });
    const view = new EditorView({ state, parent });
    views.push(view);
    destroy = () => view.destroy();
    const chunks = getChunks(state)?.chunks ?? [];
    const original = getOriginalDoc(state);
    for (const c of chunks) {
      stats.added += countLines(state.doc, c.fromB, c.toB);
      stats.removed += countLines(original, c.fromA, c.toA);
    }
  } else {
    const view = new MergeView({
      a: { doc: input.original, extensions: base },
      b: { doc: input.modified, extensions: baseExtensions(language, themeSlot, input.dark) },
      parent,
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: collapse,
    });
    views.push(view.a, view.b);
    destroy = () => view.destroy();
    for (const c of view.chunks) {
      stats.added += countLines(view.b.state.doc, c.fromB, c.toB);
      stats.removed += countLines(view.a.state.doc, c.fromA, c.toA);
    }
  }

  return {
    stats,
    setDark: (dark) => views.forEach((v) => v.dispatch({ effects: themeSlot.reconfigure(theme(dark)) })),
    destroy,
  };
}

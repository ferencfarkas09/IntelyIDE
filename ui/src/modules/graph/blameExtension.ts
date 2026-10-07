import { Compartment, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, gutter, type DecorationSet } from "@codemirror/view";
import { createEffect, createRoot, on } from "solid-js";
import { ipc } from "../../ipc";
import type { EditorFile } from "../../platform/editor-ext";
import { blameCells, blameEnabled, caretLabel, gutterLabel, type BlameCell } from "./blame";
import "./blame.css";

const setBlame = StateEffect.define<BlameCell[] | null>();

/** The blame of the committed file, or null while off, loading or stale. */
const blameField = StateField.define<BlameCell[] | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setBlame)) return e.value;
    // The blame describes the committed text: an edit makes its line numbers unreliable, so it steps aside.
    return tr.docChanged ? null : value;
  },
});

class BlameMarker extends GutterMarker {
  constructor(
    private readonly label: string,
    private readonly title: string,
    private readonly shade: number,
  ) {
    super();
  }
  eq(other: BlameMarker): boolean {
    return other.label === this.label && other.title === this.title && other.shade === this.shade;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-blame-cell";
    el.dataset.shade = String(this.shade);
    el.textContent = this.label;
    el.title = this.title;
    return el;
  }
}

class Annotation extends WidgetType {
  constructor(private readonly text: string) {
    super();
  }
  eq(other: Annotation): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-blame-note";
    el.textContent = this.text;
    return el;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

const shadeOf = (oid: string): number => (parseInt(oid.slice(0, 2), 16) || 0) % 4;

const gutterExtension = gutter({
  class: "cm-blame-gutter",
  lineMarker(view, block) {
    const cells = view.state.field(blameField);
    if (!cells) return null;
    const cell = cells[view.state.doc.lineAt(block.from).number - 1];
    return cell ? new BlameMarker(cell.first ? gutterLabel(cell) : "", `${cell.oid.slice(0, 8)} ${cell.summary}`, shadeOf(cell.oid)) : null;
  },
  lineMarkerChange: (update) => update.selectionSet || update.transactions.some((t) => t.effects.some((e) => e.is(setBlame))) || update.docChanged,
  initialSpacer: () => new BlameMarker("Mmmmmmmmmmmm · 99mo ago", "", 0),
});

function annotate(view: EditorView): DecorationSet {
  const cells = view.state.field(blameField);
  if (!cells) return Decoration.none;
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const cell = cells[line.number - 1];
  return cell ? Decoration.set([Decoration.widget({ widget: new Annotation(caretLabel(cell)), side: 1 }).range(line.to)]) : Decoration.none;
}

/** Fetches the blame when the toggle is on and clears it when it goes off. Lives as long as the editor view. */
function blamePlugin(file: EditorFile, slot: Compartment) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      private dispose: () => void;
      private alive = true;
      constructor(private readonly view: EditorView) {
        this.dispose = createRoot((dispose) => {
          createEffect(on(blameEnabled, (enabled) => void this.sync(enabled)));
          return dispose;
        });
      }
      private async sync(enabled: boolean): Promise<void> {
        if (!enabled) return this.push(null);
        try {
          const lines = await ipc.graph.blame(file.repoId, file.path);
          if (this.alive && blameEnabled()) this.push(blameCells(lines));
        } catch (err) {
          console.error("blame failed", err);
        }
      }
      private push(cells: BlameCell[] | null): void {
        // Never dispatch while CodeMirror is mid-update (the first run happens in the constructor).
        queueMicrotask(() => this.alive && this.view.dispatch({ effects: [setBlame.of(cells), slot.reconfigure(cells ? gutterExtension : [])] }));
      }
      update(): void {
        this.decorations = annotate(this.view);
      }
      destroy(): void {
        this.alive = false;
        this.dispose();
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

export function blameExtension(file: EditorFile): Extension {
  // The gutter takes width, so it only exists while there is blame to show.
  const slot = new Compartment();
  return [blameField, slot.of([]), blamePlugin(file, slot)];
}

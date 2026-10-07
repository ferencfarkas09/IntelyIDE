import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import type { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { findFileRefs, type FileRef } from "./links";
import { readToken, xtermTheme } from "./theme";

export const SCROLLBACK = 5000;

export interface ViewHandlers {
  /** Typed or pasted input, for the shell. */
  onInput(data: string): void;
  onResize(cols: number, rows: number): void;
  /** The shell announced its directory (OSC 7). */
  onCwd(path: string): void;
  /** Whether a `path:line` in the output points into a repo; only those become links. */
  isLink(ref: FileRef): boolean;
  openLink(ref: FileRef): void;
}

/** One xterm instance with its own host element; it outlives the panel so a hidden terminal keeps its scrollback. */
export interface TermView {
  readonly term: Terminal;
  readonly host: HTMLElement;
  write(data: string): void;
  /** Puts the host into `parent` and opens xterm on first use. */
  attach(parent: HTMLElement): void;
  detach(): void;
  fit(): void;
  focus(): void;
  /** Only the focused terminal gets the GPU renderer; the others stay on the DOM renderer. */
  setWebgl(on: boolean): Promise<void>;
  setTheme(): void;
  dispose(): void;
}

const copyKey = (e: KeyboardEvent) => (e.metaKey && !e.ctrlKey && e.key === "c") || (e.ctrlKey && e.shiftKey && e.key === "C");

export async function createView(handlers: ViewHandlers): Promise<TermView> {
  const fontFamily = readToken("--font-mono") || "monospace";
  try {
    // Cell metrics are measured on first open; a font that is not loaded yet would size the grid wrongly.
    await document.fonts.load(`13px ${fontFamily.split(",")[0]}`);
  } catch {
    /* the fallback font is measured instead */
  }
  const term = new Terminal({
    scrollback: SCROLLBACK,
    fontFamily,
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    cursorStyle: "bar",
    cursorInactiveStyle: "outline",
    minimumContrastRatio: 4.5,
    // Option types characters on the Hungarian layout; it must never turn into Meta.
    macOptionIsMeta: false,
    scrollOnUserInput: true,
    theme: xtermTheme(readToken),
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  const host = document.createElement("div");
  host.className = "term-host";
  let opened = false;
  let disposed = false;
  let wantWebgl = false;
  let webgl: WebglAddon | undefined;

  term.onData(handlers.onInput);
  term.onResize(({ cols, rows }) => handlers.onResize(cols, rows));
  term.parser.registerOscHandler(7, (payload) => {
    try {
      handlers.onCwd(decodeURIComponent(new URL(payload).pathname));
    } catch {
      /* not a file URL */
    }
    return true;
  });
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === "keydown" && copyKey(e) && term.hasSelection()) {
      void navigator.clipboard?.writeText(term.getSelection());
      return false;
    }
    return true;
  });
  term.registerLinkProvider({
    provideLinks(y, done) {
      const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
      const links = findFileRefs(text)
        .filter(handlers.isLink)
        .map((ref) => ({
          range: { start: { x: ref.start + 1, y }, end: { x: ref.end, y } },
          text: text.slice(ref.start, ref.end),
          // A plain click would also fire at the end of a text selection.
          activate: (e: MouseEvent) => (e.metaKey || e.ctrlKey) && handlers.openLink(ref),
        }));
      done(links.length ? links : undefined);
    },
  });

  const view: TermView = {
    term,
    host,
    write: (data) => term.write(data),
    attach(parent) {
      if (disposed) return;
      parent.appendChild(host);
      if (!opened) {
        term.open(host);
        opened = true;
      } else {
        // A re-attached viewport starts at the top; put it back where the buffer says it is.
        term.scrollToLine(term.buffer.active.viewportY);
      }
    },
    detach() {
      void view.setWebgl(false);
      host.remove();
    },
    fit() {
      if (!opened || host.clientWidth === 0 || host.clientHeight === 0) return;
      const dims = fitAddon.proposeDimensions();
      if (dims && Number.isFinite(dims.cols) && Number.isFinite(dims.rows) && (dims.cols !== term.cols || dims.rows !== term.rows)) term.resize(dims.cols, dims.rows);
    },
    focus: () => term.focus(),
    async setWebgl(on) {
      wantWebgl = on;
      if (!on) {
        webgl?.dispose();
        webgl = undefined;
        return;
      }
      if (!opened || webgl) return;
      try {
        const { WebglAddon } = await import("@xterm/addon-webgl");
        if (!wantWebgl || disposed || webgl) return;
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          addon.dispose();
          if (webgl === addon) webgl = undefined;
        });
        term.loadAddon(addon);
        webgl = addon;
      } catch (e) {
        console.warn("terminal: WebGL renderer unavailable, staying on the DOM renderer", e);
      }
    },
    setTheme() {
      term.options.theme = xtermTheme(readToken);
    },
    dispose() {
      disposed = true;
      webgl?.dispose();
      webgl = undefined;
      host.remove();
      term.dispose();
    },
  };
  return view;
}

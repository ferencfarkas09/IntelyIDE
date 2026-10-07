// Non-composer drop targets that need a little logic of their own.
import { ipc } from "../../ipc";
import type { DropTarget } from "../../platform/dropzone";
import { activeTerminalId } from "../terminal/store";
import { t } from "../../i18n";

/** Shell-escapes a path the way Terminal.app does for a dropped file: backslash before every shell-special character. */
export function shellEscapePath(path: string): string {
  return path.replace(/[^A-Za-z0-9_\-.,:/@%+=~]/g, (c) => (c === "\n" ? "'\n'" : `\\${c}`));
}

export function terminalTarget(): DropTarget {
  const el = () => document.querySelector<HTMLElement>(".term");
  return {
    id: "terminal",
    priority: 30,
    get label() {
      return t("attach.terminalLabel");
    },
    get title() {
      return t("attach.terminalDrop");
    },
    accepts: (items) => items.some((i) => i.path),
    refusal: () => t("attach.terminalRefusal"),
    isActive: () => !!el() && !!activeTerminalId(),
    element: el,
    onDrop: async (items) => {
      const id = activeTerminalId();
      const text = items.filter((i) => i.path).map((i) => shellEscapePath(i.path!)).join(" ");
      if (id && text) await ipc.term.write(id, `${text} `);
    },
  };
}

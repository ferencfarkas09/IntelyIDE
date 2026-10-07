/**
 * Tracks whether the last input was the pointer or the keyboard, as `data-input` on <html>. A tree shows its hover tint
 * for the pointer and the cursor ring for the keyboard, never both at once (CSS in display.css).
 */
let installed = false;

export function installInputModality(doc: Document | undefined = typeof document === "undefined" ? undefined : document): void {
  if (installed || !doc) return;
  installed = true;
  const set = (value: "pointer" | "keyboard") => {
    if (doc.documentElement.dataset.input !== value) doc.documentElement.dataset.input = value;
  };
  // Capture phase, so a handler that stops propagation cannot hide the input from here.
  doc.addEventListener("pointermove", () => set("pointer"), true);
  doc.addEventListener("pointerdown", () => set("pointer"), true);
  doc.addEventListener("keydown", (e) => !["Shift", "Meta", "Control", "Alt"].includes(e.key) && set("keyboard"), true);
}

installInputModality();

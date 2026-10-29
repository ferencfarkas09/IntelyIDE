// The prompt of "Ask agent to restyle this" and the helpers of the small style panel. Pure. The values come from a page that is
// untrusted (the protocol parser already bounded them); they are flattened to plain single-line text again before they reach a prompt.
import { plain } from "../webtools/logic";
import type { StyleHint, StyleKey } from "./protocol";

export const SHOWN: { key: StyleKey; label: string }[] = [
  { key: "display", label: "display" },
  { key: "position", label: "position" },
  { key: "width", label: "width" },
  { key: "height", label: "height" },
  { key: "margin", label: "margin" },
  { key: "padding", label: "padding" },
  { key: "color", label: "color" },
  { key: "background-color", label: "background" },
  { key: "font-family", label: "font" },
  { key: "font-size", label: "size" },
  { key: "font-weight", label: "weight" },
  { key: "line-height", label: "line" },
  { key: "border-radius", label: "radius" },
  { key: "gap", label: "gap" },
];

/** `button#save.btn.primary` */
export function describe(h: StyleHint): string {
  return `${h.tag}${h.id ? `#${h.id}` : ""}${h.classes.map((c) => `.${c}`).join("")}`;
}

export function restylePrompt(h: StyleHint): string {
  const styles = SHOWN.filter((s) => h.styles[s.key]).map((s) => `${s.key}: ${plain(h.styles[s.key]!, 100)}`);
  return [
    `In the running preview I Alt-clicked this element: <${plain(h.tag, 32)}> ${plain(describe(h), 200)}, ${h.width}x${h.height}px.`,
    `Its computed styles (only a few of them): ${styles.join("; ") || "none"}.`,
    "Find where it is styled: the CSS/SCSS rule for these classes or id (or CSS-module, styled-component or inline style) and the component that renders it. Tell me the files you found before you change anything.",
    "Then restyle it like this: <describe the change you want here>.",
    "Make the smallest change that does the job, keep the code style of the project, prefer existing design tokens (CSS variables) over new hard-coded values, and show me the diff. Do not run git commit or git push.",
    "(No screenshot is attached: the preview cannot be captured from here. Ask me if you need one.)",
  ].join("\n");
}

import { createEffect, createMemo, Index, onCleanup } from "solid-js";
import { t } from "../../i18n";
import { renderMarkdown, splitBlocks } from "./mdRender";

/** Lucide "copy" and "check" (the sanitised HTML cannot hold components, so the button is made here with the DOM API). */
const COPY_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const CHECK_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

/** Gives every fenced code block of a rendered part a copy button (once; a part whose HTML changed gets new ones). */
function addCopyButtons(part: HTMLElement): void {
  for (const pre of part.querySelectorAll<HTMLElement>("pre.md-code")) {
    if (pre.querySelector(":scope > .md-copy")) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "md-copy";
    button.setAttribute("aria-label", t("activity.copyCode"));
    button.innerHTML = COPY_SVG;
    pre.appendChild(button);
  }
}

/**
 * Streaming-safe: an unclosed fence or list simply renders as far as it goes. The text is split into blocks and each block is
 * parsed once, so a delta only re-renders the open tail instead of the whole message. Code blocks get a copy button.
 */
export function Markdown(props: { text: string; class?: string }) {
  const blocks = createMemo(() => splitBlocks(props.text));
  const timers = new Set<ReturnType<typeof setTimeout>>();
  onCleanup(() => timers.forEach(clearTimeout));
  // One listener for every copy button of the message (the buttons come and go with the HTML of their part).
  const onClick = async (e: MouseEvent) => {
    const button = (e.target as Element | null)?.closest?.<HTMLButtonElement>("button.md-copy");
    const code = button?.parentElement?.querySelector("code");
    if (!button || !code) return;
    try {
      await navigator.clipboard.writeText(code.textContent ?? "");
    } catch {
      return; // no clipboard (a locked-down webview): nothing to confirm
    }
    button.dataset.copied = "";
    button.setAttribute("aria-label", t("chat.copied"));
    button.innerHTML = CHECK_SVG;
    const timer = setTimeout(() => {
      timers.delete(timer);
      delete button.dataset.copied;
      button.setAttribute("aria-label", t("activity.copyCode"));
      button.innerHTML = COPY_SVG;
    }, 1600);
    timers.add(timer);
  };
  // Each string is sanitized by DOMPurify with a tag/attribute allow-list (mdRender.ts).
  return (
    <div class={props.class ? `md ui-selectable ${props.class}` : "md ui-selectable"} onClick={(e) => void onClick(e)}>
      <Index each={blocks()}>
        {(block) => {
          const html = createMemo(() => renderMarkdown(block()));
          let part!: HTMLDivElement;
          createEffect(() => {
            if (html().includes("md-code")) addCopyButtons(part);
          });
          return <div ref={part} class="md-part" innerHTML={html()} />;
        }}
      </Index>
    </div>
  );
}

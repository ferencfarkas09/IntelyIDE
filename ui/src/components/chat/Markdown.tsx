import { createMemo, Index } from "solid-js";
import { renderMarkdown, splitBlocks } from "./mdRender";

/**
 * Streaming-safe: an unclosed fence or list simply renders as far as it goes. The text is split into blocks and each block is
 * parsed once, so a delta only re-renders the open tail instead of the whole message.
 */
export function Markdown(props: { text: string; class?: string }) {
  const blocks = createMemo(() => splitBlocks(props.text));
  // Each string is sanitized by DOMPurify with a tag/attribute allow-list (mdRender.ts).
  return (
    <div class={props.class ? `md ui-selectable ${props.class}` : "md ui-selectable"}>
      <Index each={blocks()}>
        {(block) => {
          const html = createMemo(() => renderMarkdown(block()));
          return <div class="md-part" innerHTML={html()} />;
        }}
      </Index>
    </div>
  );
}

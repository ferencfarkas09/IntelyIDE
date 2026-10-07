// The DOM contract with the preview module (which this module never imports): its frame carries
//   <iframe data-intely-preview data-repo-id="<repo id>" src="http://127.0.0.1:<proxy port>/...">
// The overlay finds frames by that attribute, so a message is accepted only from a window that is currently a preview frame.

import { modeMessage } from "./protocol";

export const FRAME_SELECTOR = "iframe[data-intely-preview]";

export const previewFrames = (): HTMLIFrameElement[] => Array.from(document.querySelectorAll<HTMLIFrameElement>(FRAME_SELECTOR));

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]");
  } catch {
    return false;
  }
}

/** The frame a message came from, if it is a preview frame and the message's origin is the frame's own loopback origin. */
export function frameOf(event: Pick<MessageEvent, "source" | "origin">): HTMLIFrameElement | undefined {
  if (!event.source || !isLoopbackOrigin(event.origin)) return undefined;
  const frame = previewFrames().find((f) => f.contentWindow === event.source);
  if (!frame) return undefined;
  try {
    return new URL(frame.src).origin === event.origin ? frame : undefined;
  } catch {
    return undefined;
  }
}

/** Tells one frame's inspector to switch modes. Addressed to the frame's own origin only. */
export function postMode(frame: HTMLIFrameElement, on: boolean): void {
  try {
    frame.contentWindow?.postMessage(modeMessage(on), new URL(frame.src).origin);
  } catch {
    /* a frame that is not on a URL yet has no inspector */
  }
}

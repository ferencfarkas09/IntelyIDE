/** Which way a list moved between two reads of its scrollTop (half a pixel of rounding is no movement). */
export type ScrollMove = "up" | "down" | "none";

export const scrollMove = (before: number, after: number): ScrollMove => (after < before - 0.5 ? "up" : after > before + 0.5 ? "down" : "none");

/**
 * Whether a list that follows its newest end (a transcript, a chat) goes on following after the person scrolled.
 * At the bottom it does. A little above it (`near` px) it does too, unless the person is moving up: scrolling up is the ask to stop,
 * however short the way so far. Counting "close to the bottom" as the bottom for a scroll up made every slow scroll start inside
 * the margin snap back to the end with the next streamed chunk, again and again, until one scroll got past the margin in a single step.
 */
export const keepsFollowing = (gap: number, move: ScrollMove, near: number): boolean => gap <= 1 || (gap < near && move !== "up");

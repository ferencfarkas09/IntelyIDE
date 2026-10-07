// Pure helpers of the channel-management dialogs (names, mute times, error placement) and a tiny debounce.
import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js";

export const MAX_CHANNEL_NAME = 80;
export const MAX_DESCRIPTION = 250;
export const MAX_GROUP_PEOPLE = 7;
export const SEARCH_MIN = 2;
/** "Mute forever" is a far-away time (the server only knows "until"). */
export const MUTE_FOREVER_MS = 4_102_444_800_000;

/** The name as it is sent: no leading `#`, trimmed, inner whitespace collapsed, at most `MAX_CHANNEL_NAME` characters. */
export const cleanChannelName = (raw: string): string => raw.replace(/^[\s#]+/, "").replace(/\s+/g, " ").trim().slice(0, MAX_CHANNEL_NAME);

export type MuteChoice = "hour" | "tomorrow" | "forever";

/** The epoch ms a mute choice lasts until (`tomorrow` = 08:00 local of the next day). */
export function muteUntil(choice: MuteChoice, nowMs: number): number {
  if (choice === "hour") return nowMs + 3_600_000;
  if (choice === "forever") return MUTE_FOREVER_MS;
  const d = new Date(nowMs);
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d.getTime();
}

/** Which field of the create/edit form an error code belongs to (everything else is a form-level message). */
export const nameFieldError = (code: string): boolean => code === "CHANNEL_NAME_TAKEN" || code === "NAME_REQUIRED";

/** `source()` after it stayed unchanged for `ms` (immediately when `ms` is 0). */
export function createDebounced<T>(source: Accessor<T>, ms: number): Accessor<T> {
  const [value, setValue] = createSignal<T>(source());
  createEffect(
    on(source, (v) => {
      if (ms <= 0) return setValue(() => v);
      const id = setTimeout(() => setValue(() => v), ms);
      onCleanup(() => clearTimeout(id));
    }, { defer: true }),
  );
  return value;
}

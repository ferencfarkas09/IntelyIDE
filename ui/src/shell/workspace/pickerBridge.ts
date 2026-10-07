import type { Picked } from "../../ipc/picker";
import { openPathPicker, wasTrusted, type PickOptions } from "../../platform/pathpicker";

export type { PickOptions };

/** A picked item and whether the user already ticked the trust box for it in the picker's result card. */
export type PickedItem = Picked & { trusted?: boolean };

/**
 * The one place the workspace screens open the path picker ((design notes: workspaces-spec) 5.9). Resolves with the validated
 * items (`trusted` set from the picker's trust card) or `null` when the user cancelled.
 */
export async function openPicker(opts: PickOptions): Promise<PickedItem[] | null> {
  const picked = await openPathPicker(opts);
  return picked?.map((p) => ({ ...p, ...(wasTrusted(p) ? { trusted: true } : {}) })) ?? null;
}

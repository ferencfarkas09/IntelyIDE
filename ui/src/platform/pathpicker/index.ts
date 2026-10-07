import { registerOverlay } from "../overlay";
import { PathPickerHost } from "./PickerDialog";

export { openPathPicker, wasTrusted, resetPathPicker } from "./store";
export type { PickOptions, PickKind, PickPurpose } from "./types";
export { BrowseButton, PathField, type PathFieldProps } from "./PathField";
export { PathPickerHost, PickerDialog } from "./PickerDialog";

/** Registers the overlay host once (from `registerBuiltins`). Idempotent: the id replaces. */
export function registerPathPicker(): void {
  registerOverlay({ id: "pathpicker", component: PathPickerHost });
}

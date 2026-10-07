import type { LucideIcon } from "lucide-solid";
import { t, type MessageKey } from "../../i18n";
import type { PermissionMode } from "../../store/agent-types";
import { CircleQuestionMark, ListChecks, Pencil, TriangleAlert, Zap, type Tone } from "../../ui-kit";

// The pure ladder helpers live in the store (the mock IPC reads them too); the components import them from here.
export { AFTER_PLAN, effectiveMode, exposureOf, isUnattended, MODE_ORDER, strictness } from "../../store/permissionModes";

/** One table for the picker, the header menu, the cards and the inspector: label, one-line explanation, icon and tone of a mode. */
export const MODE_META: Record<PermissionMode, { label: MessageKey; hint: MessageKey; icon: LucideIcon; tone: Tone }> = {
  readOnly: { label: "modes.readOnly.label", hint: "modes.readOnly.hint", icon: ListChecks, tone: "neutral" },
  ask: { label: "modes.ask.label", hint: "modes.ask.hint", icon: CircleQuestionMark, tone: "neutral" },
  edit: { label: "modes.edit.label", hint: "modes.edit.hint", icon: Pencil, tone: "accent" },
  automatic: { label: "modes.automatic.label", hint: "modes.automatic.hint", icon: Zap, tone: "accent" },
  bypass: { label: "modes.bypass.label", hint: "modes.bypass.hint", icon: TriangleAlert, tone: "danger" },
};

const ERROR_KEY: Record<string, MessageKey> = {
  modeNotSupported: "modes.err.modeNotSupported",
  modeDisabled: "modes.err.modeDisabled",
  bypassNotConfirmed: "modes.err.bypassNotConfirmed",
  writeLease: "modes.err.writeLease",
  noSlot: "modes.err.noSlot",
  modeBusy: "modes.err.modeBusy",
  modeNotApplied: "modes.err.modeNotApplied",
  invalidMode: "modes.err.invalidMode",
  modeChanged: "modes.err.modeChanged",
  optionNotOffered: "modes.err.optionNotOffered",
};

/** What a refused mode change or answer says: the host's error code in the user's words, else the host's own message. */
export function modeErrorText(code: string | undefined, message?: string): string {
  const key = code ? ERROR_KEY[code] : undefined;
  return key ? t(key) : message || t("modes.err.generic");
}

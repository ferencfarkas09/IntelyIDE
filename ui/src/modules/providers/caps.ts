import type { CapKey, ProviderCaps } from "@intely/protocol";
import { t, type MessageKey } from "../../i18n";

const KEYS: CapKey[] = ["streaming", "toolEvents", "permissions", "resume", "fork", "modelList", "effort", "subagents", "usage", "hooks", "modelSwitch", "cancel", "sandbox"];

/** Rows of the capability matrix; label and hint are getters so they follow the language. */
export const CAP_ROWS: { key: CapKey; label: string; hint: string }[] = KEYS.map((key) => ({
  key,
  get label() {
    return t(`providers.caps.row.${key}` as MessageKey);
  },
  get hint() {
    return t(`providers.caps.hint.${key}` as MessageKey);
  },
}));

/** One sentence under the table: what the UI will hide or flag for this provider. */
export function capSummary(caps: ProviderCaps): string {
  const parts: string[] = [];
  if (caps.effort.cap === "no") parts.push(t("providers.caps.sum.effortNo"));
  else if (caps.effort.cap === "partial") parts.push(t("providers.caps.sum.effortPartial"));
  if (caps.usage.cap !== "yes") parts.push(t("providers.caps.sum.usage"));
  if (caps.permissions.cap !== "yes") parts.push(t("providers.caps.sum.permissions"));
  if (caps.subagents.cap === "no") parts.push(t("providers.caps.sum.subagents"));
  const att = caps.attachments ?? "none";
  parts.push(t(att === "none" ? "providers.caps.sum.attNone" : att === "files" ? "providers.caps.sum.attFiles" : att === "imagesPdf" ? "providers.caps.sum.attImagesPdf" : "providers.caps.sum.attImages"));
  return parts.join(" ");
}

// The notification categories (orders, delivery, invoices ...) as the settings list them. Shared by Settings > Integrations > Happy and
// the inbox, which never import each other: the state and the words live here, next to store/happyNt.ts.
import { t } from "../i18n";
import type { NotificationItem, NotifyMode } from "../ipc/happy";

/** The categories the settings list from the start, in this order (Rust folds `orders`, `shipping`, `billing` ... into the first three). */
export const KNOWN_CATEGORIES = ["order", "delivery", "invoice", "chat", "task", "mention", "deploy", "error", "warning", "other"] as const;

/** `Orders` for a known category, the type itself (first letter up) for one the server invented. */
export function categoryLabel(key: string): string {
  return (KNOWN_CATEGORIES as readonly string[]).includes(key) ? t(`hn.cat.${key}` as "hn.cat.order") : key.charAt(0).toUpperCase() + key.slice(1);
}

/** The rows of the category settings: the known ones, then the others that have arrived or that are set, by name. */
export function categoryRows(items: readonly Pick<NotificationItem, "category">[], configured: Readonly<Record<string, NotifyMode>> | undefined): string[] {
  const extra = new Set<string>();
  for (const i of items) if (i.category) extra.add(i.category);
  for (const key of Object.keys(configured ?? {})) extra.add(key);
  for (const key of KNOWN_CATEGORIES) extra.delete(key);
  return [...KNOWN_CATEGORIES, ...[...extra].sort()];
}

export const modeOf = (configured: Readonly<Record<string, NotifyMode>> | undefined, key: string): NotifyMode => configured?.[key] ?? "alert";

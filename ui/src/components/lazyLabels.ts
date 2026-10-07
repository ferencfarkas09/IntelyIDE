import { t, type MessageKey } from "../i18n";

/**
 * A label table whose values follow the language: `TABLE[key]` calls `t()` when it is read, so a module-level constant
 * stays usable as a plain `Record<K, string>` (also by other modules) while it is reactive when read inside JSX.
 */
export function lazyLabels<K extends string>(keys: Record<K, MessageKey>): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const k of Object.keys(keys) as K[]) Object.defineProperty(out, k, { enumerable: true, get: () => t(keys[k]) });
  return out;
}

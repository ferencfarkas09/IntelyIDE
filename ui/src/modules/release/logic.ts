// Pure helpers of the release assistant.
import { t } from "../../i18n";
import type { DraftItem, Drafted } from "../l10n/types";
import type { Entry, Kind, Localized } from "./types";

const KINDS: readonly string[] = ["feature", "improvement", "fix", "performance", "security", "internal"];
/** The localized name of a change kind; an unknown kind (from a repo's own changelog) is shown as it is. */
export const kindLabel = (kind: string): string => (KINDS.includes(kind) ? t(`release.kind.${kind as Kind}`) : kind);

/** Every English text of an entry as a translation job per other language. Ids say where the text goes back. */
export function translationJobs(entry: Entry, langs: readonly string[]): DraftItem[] {
  const out: DraftItem[] = [];
  const add = (id: string, text: Localized | undefined) => {
    const en = text?.en;
    if (!en) return;
    for (const lang of langs) if (lang !== "en" && !text?.[lang]) out.push({ id: `${id}\u0001${lang}`, lang, reference: en, refLang: "en" });
  };
  add("h", entry.highlight);
  entry.groups.forEach((g, gi) =>
    g.items.forEach((it, ii) => {
      add(`t\u0001${gi}\u0001${ii}`, it.title);
      add(`d\u0001${gi}\u0001${ii}`, it.description);
    }),
  );
  return out;
}

/** Puts valid drafts into a copy of the entry; drafts whose placeholders differ are skipped and counted. */
export function mergeTranslations(entry: Entry, drafted: readonly Drafted[]): { entry: Entry; applied: number; skipped: number } {
  const next: Entry = structuredClone(entry);
  let applied = 0;
  let skipped = 0;
  for (const d of drafted) {
    if (!d.valid || !d.text.trim()) {
      skipped++;
      continue;
    }
    const parts = d.id.split("\u0001");
    const lang = parts[parts.length - 1];
    const kind = parts[0];
    if (kind === "h") next.highlight[lang] = d.text;
    else {
      const item = next.groups[Number(parts[1])]?.items[Number(parts[2])];
      if (!item) continue;
      if (kind === "t") item.title[lang] = d.text;
      else (item.description ??= {})[lang] = d.text;
    }
    applied++;
  }
  return { entry: next, applied, skipped };
}

export const entryCount = (e: Entry): number => e.groups.reduce((n, g) => n + g.items.length, 0);

export function setEnglish(entry: Entry, path: { gi: number; ii: number; field: "title" | "description" } | "highlight", text: string): Entry {
  const next = structuredClone(entry);
  if (path === "highlight") next.highlight.en = text;
  else {
    const it = next.groups[path.gi]?.items[path.ii];
    if (!it) return entry;
    if (path.field === "title") it.title.en = text;
    else if (text) (it.description ??= {}).en = text;
    else delete it.description;
  }
  return next;
}

export function dropItem(entry: Entry, gi: number, ii: number): Entry {
  const next = structuredClone(entry);
  next.groups[gi]?.items.splice(ii, 1);
  next.groups = next.groups.filter((g) => g.items.length);
  return next;
}

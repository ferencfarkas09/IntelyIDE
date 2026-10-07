// Pure helpers of the localization checker: what to draft, how drafts become review lines, which lines become edits.
import { t } from "../../i18n";
import type { Cell, CellState, DraftItem, Drafted, Edit, Proposal, Report } from "./types";

export const WORKING: readonly CellState[] = ["missing", "placeholder", "plural"];

export const isGap = (c: Cell): boolean => WORKING.includes(c.state) && c.todo.length > 0;

export interface Target {
  id: string;
  group: string;
  rel: string;
  lang: string;
  key: string;
  path: string[];
  reference: string;
  refLang: string;
}

/** Every key the report says can be drafted, optionally limited to some languages. */
export function targets(report: Report, only?: readonly string[]): Target[] {
  const out: Target[] = [];
  for (const g of report.groups) {
    for (const row of g.rows) {
      for (const [lang, cell] of Object.entries(row.cells)) {
        if (only && !only.includes(lang)) continue;
        const rel = g.files[lang];
        if (!rel || !isGap(cell)) continue;
        for (const todo of cell.todo) out.push({ id: `${g.group}\u0001${lang}\u0001${todo.path.join(".")}`, group: g.group, rel, lang, key: todo.path.join("."), path: todo.path, reference: todo.reference, refLang: row.refLang });
      }
    }
  }
  return out;
}

export const draftItems = (ts: readonly Target[]): DraftItem[] => ts.map((x) => ({ id: x.id, lang: x.lang, reference: x.reference, refLang: x.refLang }));

/** Joins the model's answers with their targets. Invalid drafts (placeholders differ) stay visible but need an explicit edit. */
export function proposals(ts: readonly Target[], drafted: readonly Drafted[]): Proposal[] {
  const byId = new Map(drafted.map((d) => [d.id, d]));
  const out: Proposal[] = [];
  for (const x of ts) {
    const d = byId.get(x.id);
    if (!d) continue;
    out.push({ ...x, text: d.text, valid: d.valid, note: d.note ?? undefined, decision: "pending" });
  }
  return out;
}

export const edits = (ps: readonly Proposal[]): Edit[] => ps.filter((p) => p.decision === "accepted" && p.text.trim()).map((p) => ({ rel: p.rel, path: p.path, value: p.text }));

/** Placeholder names of a text, as the Rust side sees them (`{{name}}`, printf). Used to re-validate an edited draft. */
export function placeholders(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*-?\s*([^},\s]+)[^}]*\}\}/g)) out.add(`{{${m[1]}}}`);
  for (const m of text.matchAll(/%(?:\d+\$)?[\d.]*[sdif@]/g)) out.add(m[0]);
  return [...out].sort();
}

export const samePlaceholders = (a: string, b: string): boolean => {
  const [x, y] = [placeholders(a), placeholders(b)];
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

export interface Summary {
  keys: number;
  missing: number;
  problems: number;
  /** Languages with nothing left to do, of all languages. */
  clean: number;
}

export function summarize(report: Report): Summary {
  const keys = report.groups.reduce((n, g) => n + g.rows.length, 0);
  const missing = report.totals.reduce((n, x) => n + x.missing, 0);
  const problems = report.totals.reduce((n, x) => n + x.problems, 0);
  return { keys, missing, problems, clean: report.totals.filter((x) => x.missing + x.problems === 0).length };
}

export const badgeFor = (report: Report | undefined, path: string) => report?.badges.find((b) => b.path === path);

export const CELL_LABEL: Record<CellState, string> = {
  get ok() {
    return t("l10n.cell.ok");
  },
  get missing() {
    return t("l10n.cell.missing");
  },
  get placeholder() {
    return t("l10n.cell.placeholder");
  },
  get plural() {
    return t("l10n.cell.plural");
  },
  get noFile() {
    return t("l10n.cell.noFile");
  },
};

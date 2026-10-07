// Backend of the localization checker. In the Tauri app every call goes to the `l10n_*` commands; in a plain browser
// (mock UI, Playwright, vitest) a deterministic in-memory fixture with the same shapes stands in.
import { call } from "../../ipc/rpc";
import type { Applied, DraftItem, Drafted, Edit, Report } from "./types";

export interface L10nApi {
  analyze(repoId: string): Promise<Report>;
  draft(items: DraftItem[]): Promise<Drafted[]>;
  apply(repoId: string, edits: Edit[]): Promise<Applied>;
}

export const inTauri = (): boolean => typeof window !== "undefined" && !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

const tauriApi: L10nApi = {
  analyze: (repoId) => call("l10n_analyze", { repoId }),
  draft: (items) => call("l10n_draft", { items }),
  apply: (repoId, edits) => call("l10n_apply", { repoId, edits }),
};

let override: L10nApi | undefined;
/** Tests inject their own backend. */
export const setL10nApi = (api: L10nApi | undefined): void => void (override = api);

let mock: L10nApi | undefined;
export function l10nApi(): L10nApi {
  if (override) return override;
  if (inTauri()) return tauriApi;
  return (mock ??= createMockL10n());
}

const REPO_LANGS: Record<string, string[]> = { admin: ["en", "cn", "cz", "de", "es", "fr", "hu", "it", "pl", "ro", "sk"], mobile: ["en", "cn", "de", "hu", "ro", "svn"], pos: ["en", "de", "hu", "zh"] };

/** Fixture: an admin-shaped repo with one added key, one plural and one placeholder mistake. Writes make the gaps disappear. */
export function createMockL10n(): L10nApi {
  const written = new Set<string>();
  const langs = REPO_LANGS.admin;
  const file = (lang: string) => `src/localization/modules/crm/${lang}.json`;
  const build = (): Report => {
    const cell = (lang: string, path: string[], done: boolean, pre: Partial<Report["groups"][0]["rows"][0]["cells"][string]> = {}) =>
      done || written.has(`${lang}\u0001${path.join(".")}`) ? { state: "ok" as const, todo: [] } : { state: "missing" as const, todo: [{ path, reference: "Welcome back, {{name}}" }], ...pre };
    const welcome = Object.fromEntries(
      langs.map((l) => [
        l,
        l === "en" || l === "hu" ? (l === "hu" && !written.has("hu\u0001welcome") ? { state: "placeholder" as const, note: "lacks {{name}}", todo: [{ path: ["welcome"], reference: "Welcome back, {{name}}" }] } : { state: "ok" as const, todo: [] }) : cell(l, ["welcome"], false),
      ]),
    );
    const items = Object.fromEntries(
      langs.map((l) => [
        l,
        l === "en" ? { state: "ok" as const, todo: [] } : l === "cn" ? { state: "ok" as const, todo: [] } : written.has(`${l}\u0001items_other`) ? { state: "ok" as const, todo: [] } : { state: "plural" as const, note: "Needs plural form: other", todo: [{ path: ["items_other"], reference: "{{count}} items" }] },
      ]),
    );
    const rows = [
      { key: "welcome", reason: "added" as const, plural: false, refLang: "en", reference: "Welcome back, {{name}}", files: [file("en"), "src/pages/Dashboard.jsx"], cells: welcome },
      { key: "items", reason: "added" as const, plural: true, refLang: "en", reference: "{{count}} items", files: [file("en")], cells: items },
    ];
    const gaps = (langName: string) => rows.reduce((n, r) => n + (["missing", "noFile"].includes(r.cells[langName].state) ? 1 : 0), 0);
    const probs = (langName: string) => rows.reduce((n, r) => n + (["placeholder", "plural"].includes(r.cells[langName].state) ? 1 : 0), 0);
    const missingTotal = langs.reduce((n, l) => n + gaps(l), 0);
    const problemTotal = langs.reduce((n, l) => n + probs(l), 0);
    return {
      layout: "admin",
      langs,
      reference: "en",
      catalogs: 33,
      changed: 3,
      groups: [{ group: "crm", langs, files: Object.fromEntries(langs.map((l) => [l, file(l)])), rows, truncated: false }],
      undefined: [{ key: "dashboard_subtitle", files: ["src/pages/Dashboard.jsx"] }],
      badges: [file("en"), "src/pages/Dashboard.jsx"].map((path) => ({ path, missing: missingTotal, problems: problemTotal })).filter((b) => b.missing + b.problems > 0),
      totals: langs.map((lang) => ({ lang, missing: gaps(lang), problems: probs(lang) })),
      skipped: 0,
    };
  };
  return {
    analyze: async () => build(),
    draft: async (items) => items.map((i) => ({ id: i.id, text: `[${i.lang}] ${i.reference}`, valid: true, note: null })),
    apply: async (_repo, edits) => {
      for (const e of edits) written.add(`${e.rel.split("/").pop()!.replace(".json", "")}\u0001${e.path.join(".")}`);
      return { written: edits.length, files: [...new Set(edits.map((e) => e.rel))] };
    },
  };
}

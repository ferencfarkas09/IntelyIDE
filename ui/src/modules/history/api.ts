// Backend of the session search: `agentux_search` in the app, a deterministic fixture in a plain browser (and in tests,
// which can swap it with `setHistoryApi`).
import { call } from "../../ipc/rpc";
import { inTauri } from "../l10n/api";
import type { Counted, Facets, SearchHit, SearchOut, SearchQuery, Snippet } from "./types";

export interface HistoryApi {
  search(query: SearchQuery, reindex?: boolean): Promise<SearchOut>;
}

const tauriApi: HistoryApi = {
  search: (query, reindex) => call("agentux_search", { query, reindex: reindex ?? false }),
};

let override: HistoryApi | undefined;
export const setHistoryApi = (api: HistoryApi | undefined): void => void (override = api);

let mock: HistoryApi | undefined;
export function historyApi(): HistoryApi {
  if (override) return override;
  if (inTauri()) return tauriApi;
  return (mock ??= createMockHistory());
}

export interface MockDoc {
  id: string;
  title: string;
  role: string;
  model: string;
  repoIds: string[];
  status: string;
  startedMs: number;
  endedMs: number;
  costUsd?: number;
  prompts: string[];
  replies: string[];
  tools: string[];
  files: string[];
}

const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 4, 8, 0, 0);

export const MOCK_DOCS: MockDoc[] = [
  { id: "run-dev", title: "Fix the delivery fee rounding in checkout", role: "developer", model: "claude-sonnet-5-5", repoIds: ["backend"], status: "done", startedMs: NOW - 9 * H, endedMs: NOW - 9 * H + 840_000, costUsd: 0.41, prompts: ["Fix the delivery fee rounding in checkout. The total is off by 1 forint on large orders."], replies: ["The fee was rounded per line item instead of once per order. I changed total.js to round the sum and added a regression test."], tools: ["Read", "Grep", "Edit", "Bash"], files: ["src/orders/total.js", "src/orders/total.test.js"] },
  { id: "run-rev", title: "Review the admin login form for accessibility", role: "reviewer", model: "claude-opus-5-5", repoIds: ["admin"], status: "done", startedMs: NOW - 7 * H, endedMs: NOW - 7 * H + 420_000, costUsd: 0.87, prompts: ["Review the admin login form for accessibility problems and list findings."], replies: ["Two inputs have no accessible name and the error text is not announced. Findings are attached as JSON."], tools: ["Read", "Grep"], files: ["src/components/pages/login/Login.jsx"] },
  { id: "run-fail", title: "Migrate the mobile app to the new auth flow", role: "developer", model: "claude-sonnet-5-5", repoIds: ["services"], status: "failed", startedMs: NOW - 6 * H, endedMs: NOW - 6 * H + 1_900_000, costUsd: 1.62, prompts: ["Migrate the mobile app to the new auth flow using the refresh token endpoint."], replies: ["The Google sign-in callback still expects the old token shape. Tests fail in auth.spec.ts, I stopped after three attempts."], tools: ["Read", "Edit", "Bash", "Grep"], files: ["app/auth/session.ts", "app/auth/google.ts", "app/auth/auth.spec.ts"] },
  { id: "run-904", title: "Add Hungarian strings for the receipt screen", role: "docs-writer", model: "claude-haiku-4-5-20251001", repoIds: ["pos"], status: "done", startedMs: NOW - 5 * H, endedMs: NOW - 5 * H + 150_000, costUsd: 0.03, prompts: ["Add Hungarian and English strings for the receipt screen, keep keys sorted."], replies: ["Added 14 keys to hu.json and en.json."], tools: ["Read", "Edit"], files: ["src/localization/hu.json", "src/localization/en.json"] },
  { id: "run-res", title: "Why does the swagger validate script regenerate files?", role: "researcher", model: "claude-haiku-4-5-20251001", repoIds: ["backend"], status: "done", startedMs: NOW - 30 * H, endedMs: NOW - 30 * H + 90_000, costUsd: 0.02, prompts: ["Why does the swagger validate script regenerate spec files?"], replies: ["swagger:validate runs the generator first, then validates the output. Use swagger:check for a read-only validation."], tools: ["Read", "Grep"], files: ["package.json", "scripts/swagger.js"] },
  { id: "run-906", title: "Cancelled: refactor the order service", role: "developer", model: "claude-sonnet-5-5", repoIds: ["backend", "admin"], status: "cancelled", startedMs: NOW - 52 * H, endedMs: NOW - 52 * H + 60_000, prompts: ["Refactor the order service into smaller modules."], replies: [], tools: ["Read"], files: ["src/orders/service.js"] },
  { id: "run-907", title: "Night run: update the dependency audit notes", role: "developer", model: "claude-sonnet-5-5", repoIds: ["backend"], status: "running", startedMs: NOW - H, endedMs: NOW - H + 300_000, prompts: ["Update the dependency audit notes in docs and list the packages with known advisories."], replies: ["Reading package-lock.json to collect the advisories."], tools: ["Read", "Bash"], files: ["docs/audit.md"] },
];

const words = (s: string) => s.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2).map((w) => w.toLowerCase());

function snippetOf(field: Snippet["field"], text: string, needles: string[]): Snippet | undefined {
  const lower = text.toLowerCase();
  const found: [number, number][] = [];
  for (const n of needles) for (let i = lower.indexOf(n); i >= 0; i = lower.indexOf(n, i + n.length)) found.push([i, i + n.length]);
  if (!found.length) return undefined;
  found.sort((a, b) => a[0] - b[0]);
  const at = found[0][0];
  const start = Math.max(0, at - 50);
  const end = Math.min(text.length, at + 110);
  const lead = start > 0 ? 1 : 0;
  const body = `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
  const marks = found.filter(([a, b]) => a >= start && b <= end).map(([a, b]) => [a - start + lead, b - start + lead] as [number, number]);
  return { field, text: body, marks };
}

/** The fixture: the same semantics as the Rust index (all words must match, prefixes count, filters AND together). */
export function createMockHistory(docs: MockDoc[] = MOCK_DOCS): HistoryApi {
  return {
    async search(query) {
      const terms = words(query.text);
      const count = (values: string[]): Counted[] => {
        const m = new Map<string, number>();
        for (const v of values.filter(Boolean)) m.set(v, (m.get(v) ?? 0) + 1);
        return [...m].map(([value, n]) => ({ value, count: n })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
      };
      const facets: Facets = { repos: count(docs.flatMap((d) => d.repoIds)), roles: count(docs.map((d) => d.role)), models: count(docs.map((d) => d.model)), statuses: count(docs.map((d) => d.status)) };
      const fields = (d: MockDoc): [Snippet["field"], string][] => [["title", d.title], ...d.prompts.map((p): [Snippet["field"], string] => ["prompt", p]), ...d.files.map((p): [Snippet["field"], string] => ["file", p]), ...d.tools.map((p): [Snippet["field"], string] => ["tool", p]), ...d.replies.map((p): [Snippet["field"], string] => ["reply", p])];
      const hits: SearchHit[] = [];
      for (const d of docs) {
        if (query.repo && !d.repoIds.includes(query.repo)) continue;
        if (query.role && d.role.toLowerCase() !== query.role.toLowerCase()) continue;
        if (query.model && !d.model.toLowerCase().includes(query.model.toLowerCase())) continue;
        if (query.status && d.status !== query.status) continue;
        if (query.fromMs && d.startedMs < query.fromMs) continue;
        if (query.toMs && d.startedMs > query.toMs) continue;
        const all = words([d.title, d.role, d.model, d.status, ...d.repoIds, ...d.prompts, ...d.replies, ...d.tools, ...d.files].join(" "));
        if (!terms.every((t) => all.some((w) => w.startsWith(t)))) continue;
        const snippets: Snippet[] = [];
        for (const field of ["title", "prompt", "file", "tool", "reply"] as const) {
          for (const [f, text] of fields(d)) {
            if (f !== field) continue;
            const s = terms.length ? snippetOf(f, text, terms) : undefined;
            if (s) {
              snippets.push(s);
              break;
            }
          }
        }
        if (!terms.length && d.prompts[0]) snippets.push({ field: "prompt", text: d.prompts[0].slice(0, 160), marks: [] });
        hits.push({ runId: d.id, title: d.title, role: d.role, model: d.model, repoIds: d.repoIds, status: d.status, startedMs: d.startedMs, endedMs: d.endedMs, ...(d.costUsd !== undefined ? { costUsd: d.costUsd } : {}), score: terms.length, snippets: snippets.slice(0, 3) });
      }
      hits.sort((a, b) => b.startedMs - a.startedMs);
      return { hits: hits.slice(0, query.limit ?? 50), total: hits.length, facets, indexed: docs.length, tookMs: 2 };
    },
  };
}

import { buildDigest, type SchemaDigest } from "../../modules/mongo/digest";
import { lint } from "../../modules/mongo/shellLiteral";
import type { AiAsk, AiDraft, AiIpc, AiPayload, AiResult } from "../mongoAi";
import type { ProfileView } from "../mongo";
import { presetOf } from "../../modules/mongo/presets";
import { collectionsFor, NOW_MS } from "./mongoData";

// The "model" of the mock: for the Happy preset it reads a few Hungarian and English phrasings; for the Generic preset English only,
// with dates worded in the caller's own time zone (D24). It reads a few phrasings so the whole review flow can be shown without a
// provider. The payload preview applies the same rules as the Rust filter (emails, phone numbers and long numbers become
// typed placeholders; sensitive names become <pii-field-N> on production-level connections; no values at all).

export interface MockAiHost {
  latency: number;
  enabled: () => boolean;
  connected: (id: string) => boolean;
  profile: (id: string) => ProfileView | undefined;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const fail = (code: string, message: string): never => {
  throw { code, message };
};

export function maskQuestion(text: string): { text: string; replaced: number } {
  let replaced = 0;
  const swap = (re: RegExp, token: string, s: string) => s.replace(re, () => (replaced++, token));
  let out = swap(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>", text);
  out = swap(/\b[0-9a-f]{24}\b/gi, "<id>", out);
  out = swap(/\+?\d[\d\s-]{8,}\d/g, "<number>", out);
  return { text: out, replaced };
}

const isHu = (text: string) => /[áéíóöőúüű]|\b(rendel|nyitott|lezárt|elmúlt|felett|nap|melyik|mutasd|duplik|törölt|vendég)/i.test(text);

const offsetText = (min: number) => `${min < 0 ? "-" : "+"}${String(Math.floor(Math.abs(min) / 60)).padStart(2, "0")}:${String(Math.abs(min) % 60).padStart(2, "0")}`;

function draftFor(question: string, collection: string, domain: "generic" | "happy", zone: { name: string; offsetMin: number }) {
  const hu = domain === "happy" && isHu(question);
  const off = domain === "happy" ? "+02:00" : offsetText(zone.offsetMin);
  const tzName = domain === "happy" ? "Europe/Budapest" : zone.name;
  const ql = question.toLowerCase();
  const filter: string[] = [];
  const assumptions: string[] = [];
  const why: string[] = [];
  const days = /(?:elmúlt|last|past)\s+(\d+)\s*(?:nap|days?)/.exec(ql);
  if (collection === "orders" || collection === "invoices") {
    if (days) {
      const from = `${new Date(NOW_MS - Number(days[1]) * 86_400_000).toISOString().slice(0, 10)}T00:00:00${off}`;
      filter.push(`${collection === "orders" ? "createdAt" : "issuedAt"}: { $gte: ISODate("${from}") }`);
      assumptions.push(hu ? `Az "elmúlt ${days[1]} nap" a mai nap éjfélétől (${tzName}) visszaszámolva.` : `"Last ${days[1]} days" counts back from midnight today (${tzName}).`);
      why.push(hu ? `${days[1]} napnál újabb rendelések` : `created within the last ${days[1]} days`);
    }
    if (collection === "orders") {
      if (/lezárt|closed|paid|fizetett/.test(ql)) {
        filter.push(domain === "happy" ? `status: { $in: ["paid", "closed"] }` : `status: { $in: ["paid", "shipped"] }`);
        assumptions.push(hu ? "A \"lezárt\" itt a paid és closed státuszt jelenti; az értékeket a séma nem mutatja, ellenőrizd." : domain === "happy" ? `"Closed" is read as status paid or closed; P1 hides enum values, please check.` : `"Closed" is read as status paid or shipped; P1 hides enum values, please check.`);
        why.push(hu ? "státusz: paid vagy closed" : domain === "happy" ? "status is paid or closed" : "status is paid or shipped");
      } else if (/nyitott|open/.test(ql)) {
        filter.push(`status: "open"`);
        why.push(hu ? "státusz: open" : "status is open");
      } else if (/sztornó|cancel/.test(ql)) {
        filter.push(`status: "cancelled"`);
        why.push(hu ? "státusz: cancelled" : "status is cancelled");
      }
      const over = /(\d[\d\s.]*)\s*(?:ft|huf)?\s*(?:felett|above|over|több mint)|(?:over|above)\s+(\d[\d\s.]*)/.exec(ql);
      const amount = over ? Number((over[1] ?? over[2]).replace(/[\s.]/g, "")) : 0;
      if (amount) {
        filter.push(`total: { $gt: ${amount} }`);
        assumptions.push(hu ? "A total mező egy része szövegként van tárolva (TRAP 4%), ezek kimaradnak." : "Part of total is stored as text (TRAP 4%); those documents are left out.");
        why.push(hu ? `végösszeg > ${amount}` : `total above ${amount}`);
      }
    }
  }
  if (/duplik|duplicate/.test(ql) && collection === "customers") {
    assumptions.push(hu ? "Egy find nem tud duplikátumot keresni; csoportosítás (aggregáció) kell, az M2-ben érkezik." : "A find cannot detect duplicates; that needs an aggregation, which arrives in M2.");
  }
  const sort = /legújabb|newest|latest|utolsó|legutóbbi/.test(ql) ? "{ createdAt: -1 }" : /legdrágább|highest/.test(ql) ? "{ total: -1 }" : "";
  const limit = Number(/(?:legutóbbi|utolsó|last|latest|top)\s+(\d+)\b/.exec(ql)?.[1] ?? 50);
  return { filter: filter.length ? `{ ${filter.join(", ")} }` : "{}", sort, limit, assumptions, hu, why };
}

export function createMockMongoAi(host: MockAiHost): AiIpc {
  const digests = new Map<string, SchemaDigest>();
  const defs = (p: ProfileView) => collectionsFor(p.domain);
  const running = new Map<string, () => void>();
  const digestOf = (p: ProfileView, name: string): SchemaDigest => {
    const key = `${p.domain}:${name}`;
    const hit = digests.get(key);
    if (hit) return hit;
    const def = defs(p)[name] ?? fail("mongoRejected", `unknown collection "${name}"`);
    const n = Math.min(def.count, 300);
    const d = buildDigest(Array.from({ length: n }, (_, i) => def.gen(Math.floor((i * def.count) / n))), def.indexes, presetOf(p.domain).tenantCandidates);
    digests.set(key, d);
    return d;
  };
  const guard = (req: AiAsk): ProfileView => {
    if (!host.enabled()) fail("mongoDisabled", "MongoDB Studio is switched off");
    if (!host.connected(req.connection)) fail("mongoNotConnected", "connect first");
    const p = host.profile(req.connection) ?? fail("mongoNotFound", "Unknown connection");
    if (p.aiMode === "off") fail("mongoAiOff", "AI is off for this connection");
    if (/provider-missing/.test(req.question)) fail("mongoNoProvider", "Set up an AI provider in Settings to use plain-language queries");
    return p;
  };

  const payload = (p: ProfileView, req: AiAsk): AiPayload => {
    const dg = digestOf(p, req.collection);
    const keep: string[] = [];
    let masked = 0;
    const lines = dg.fields
      .filter((f) => !f.path.includes(".") || f.presence > 0.05)
      .slice(0, 40)
      .map((f) => {
        const types = f.types.map((t) => t.type).join(" | ");
        if (f.sensitive && p.effectiveLevel === "productionLevel") return `  <pii-field-${++masked}>: ${types} /* ${Math.round(f.presence * 100)}% */`;
        keep.push(f.path);
        return `  ${f.path}: ${types}${f.array ? "[]" : ""} /* ${Math.round(f.presence * 100)}%${f.enumValues ? `, ${f.enumValues} values` : ""}${f.trap ? `, ${f.trap}` : ""} */`;
      });
    const q = maskQuestion(req.question);
    const text = [
      "system: read-only query generator. Reply as JSON {mode, collection, filter, projection, sort, limit, assumptions, explanation}",
      p.domain === "happy" ? "now: 2026-10-03T11:30:00+02:00 Europe/Budapest" : `now: 2026-10-03T09:30:00Z, caller zone ${req.tzName ?? "UTC"} (UTC${offsetText(req.utcOffsetMin ?? 0)})`,
      `collection: intely_test_shop.${req.collection} (~${defs(p)[req.collection]?.count.toLocaleString("en-US")} documents)`,
      `interface ${req.collection} {`,
      ...lines,
      "}",
      `indexes: ${dg.indexes.map((ix) => ix.name).join(", ")}`,
      `other collections: ${Object.keys(defs(p)).filter((c) => c !== req.collection).join(", ")}`,
      `<question>${q.text}</question>`,
    ].join("\n");
    const bytes = new TextEncoder().encode(text).length;
    return { mode: p.aiMode === "schemaEnums" ? "schemaEnums" : "schemaOnly", text, bytes, tokensEstimate: Math.ceil(bytes / 4), keptNames: keep, replacedNames: masked, excludedFields: 0, maskedLiterals: q.replaced, notes: /törl|delete|drop|update|insert|módosít/.test(req.question.toLowerCase()) && !/törölt/.test(req.question.toLowerCase()) ? ["I only generate read queries."] : [] };
  };

  return {
    async payload(req) {
      const p = guard(req);
      await sleep(Math.min(host.latency, 40));
      return payload(p, req);
    },
    async generate(req): Promise<AiResult> {
      const p = guard(req);
      const started = Date.now();
      const cancelled = new Promise<never>((_, rej) => running.set(req.tab, () => rej(Object.assign(new Error("Cancelled."), { code: "mongoCancelled" }))));
      try {
        await Promise.race([sleep(host.latency * 6 + (/slow-model/.test(req.question) ? 20_000 : 0)), cancelled]);
      } finally {
        running.delete(req.tab);
      }
      if (/busy-model/.test(req.question)) fail("mongoModelBusy", "The model did not finish. Try again.");
      const pl = payload(p, req);
      const d = draftFor(maskQuestion(req.question).text, req.collection, p.domain, { name: req.tzName ?? "UTC", offsetMin: req.utcOffsetMin ?? 0 });
      const def = defs(p)[req.collection] ?? fail("mongoRejected", `unknown collection "${req.collection}"`);
      const l = lint(d.filter);
      const warnings: string[] = [];
      if (/total/.test(d.filter) || /total/.test(d.sort)) warnings.push(d.hu ? "A total mező 4%-a szöveg: a rendezés és a szűrés kihagyhat dokumentumokat." : "4% of total is stored as text: sorting and filtering may skip documents.");
      const keyed = def.indexes.some((ix) => Object.keys(ix.key).some((k) => d.filter.includes(k) && k !== "_id"));
      const collscan = !keyed && !d.sort;
      const big = collscan && def.count > 50_000;
      if (big) warnings.push(d.hu ? `COLLSCAN ~${def.count.toLocaleString("hu-HU")} dokumentumon.` : `COLLSCAN on ~${def.count.toLocaleString("en-US")} documents.`);
      const q = req.question.toLowerCase();
      const writeAsk = /törl|delete|drop|update|insert|módosít/.test(q) && !/törölt/.test(q);
      const editor = req.editor;
      const draft: AiDraft = {
        collection: req.collection,
        filter: d.filter,
        projection: "",
        sort: d.sort,
        limit: d.limit,
        explanation: writeAsk
          ? d.hu ? "Csak olvasási lekérdezéseket tudok készíteni. Az alábbi szűrő a kérdésed olvasható részét adja vissza." : "I only generate read queries. The filter below covers the readable part of your question."
          : d.hu ? `${req.collection}: ${d.why.length ? d.why.join("; ") : "minden dokumentum"}. Legfeljebb ${d.limit} találat.` : `${req.collection}: ${d.why.length ? d.why.join("; ") : "all documents"}. At most ${d.limit} results.`,
        modelNote: "",
        assumptions: d.assumptions,
        warnings: l.ok ? warnings : [...warnings, l.message],
        plan: { collscan, indexNames: keyed ? def.indexes.filter((ix) => Object.keys(ix.key).some((k) => d.filter.includes(k))).map((ix) => ix.name) : [], estimatedDocs: def.count },
        indexSuggestion: big && d.filter !== "{}" ? `db.${req.collection}.createIndex({ status: 1, createdAt: -1 })` : undefined,
        changedFields: (["filter", "projection", "sort", "limit"] as const).filter((k) => String(editor?.[k] ?? "") !== String(k === "filter" ? d.filter : k === "sort" ? d.sort : k === "limit" ? d.limit : "")),
        extraConfirm: big,
      };
      const base = { notes: pl.notes, repairs: 0, model: "claude-haiku-4-5", tookMs: Date.now() - started + 900, problems: [] as string[] };
      if (!d.why.length && !writeAsk) {
        return { ...base, status: "needsClarification", clarification: d.hu ? "Melyik mezőre szűrjek? A séma alapján státuszra, dátumra vagy végösszegre tudok." : "Which field should I filter on? From the schema I can use status, dates or total.", message: "", draft: undefined };
      }
      if (!l.ok) return { ...base, status: "failed", message: "The AI could not produce a valid query. Try rephrasing, or write the filter yourself.", problems: [l.message] };
      return { ...base, status: "ready", message: "", draft };
    },
    async cancel(tab) {
      const stop = running.get(tab);
      stop?.();
      return !!stop;
    },
    async explain(req) {
      guard(req);
      await sleep(host.latency * 3);
      const how = req.plan?.includes("COLLSCAN") ? "reads every document of the collection" : "uses an index";
      return { text: `This query on ${req.collection} filters with ${req.editor?.filter.trim() || "nothing"}${req.editor?.sort ? ` and sorts by ${req.editor.sort}` : ""}. The server ${how}.` };
    },
  };
}

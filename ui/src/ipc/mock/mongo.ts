import type { CancelView, ConnectionView, MongoIpc, PlanView, ProfileView, ReadCommand, RoleChip, RunRequest, WindowView } from "../mongo";
import { getPath, type Doc, type Json } from "../../modules/mongo/ejson";
import { LiteralError, parseLiteral } from "../../modules/mongo/shellLiteral";
import { cmp, collectionsFor, matches, MOCK_DB, norm, NOW_MS, project, rangeOf, SLOW_COLLECTIONS, type CollDef } from "./mongoData";
import { createMockMongoEngine, type MockEngine } from "./mongoCore";
import { createMockMongoAi } from "./mongoAi";
import type { AiIpc } from "../mongoAi";
import { isShowcase } from "./showcase";

export { MOCK_DB } from "./mongoData";
export { injectedCode, MOCK_DIAGNOSES, parseConnection, renderConnectionMasked } from "./mongoCore";

// A deterministic synthetic MongoDB for UI work and tests (`?scenario=mongo`), implementing the same `MongoIpc` as the Rust
// gateway: profiles, connect with the role probe, `run` returning a first window, `window` for paging, `cancel`. Nothing here
// touches a network. Filters that cannot be answered by index arithmetic scan a bounded prefix (6000 documents) and then
// report a count as an estimate, like `estimatedDocumentCount`.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const fail = (code: string, message: string): never => {
  throw { code, message };
};

export interface MockMongoOptions {
  /** Start with the switch on and the five fixture profiles. Default: `?scenario=mongo` or `?mongo=on`. */
  seeded?: boolean;
  /** Per call delay; 0 in tests. */
  latencyMs?: number;
  /** Pretend the build has no `mongo-studio` feature. */
  compiled?: boolean;
  /** Pretend a jail refuses the network (`readOnly` jail). */
  network?: "full" | "loopbackOnly" | "refused";
}

export interface MockMongoWorld {
  mongo: MongoIpc;
  ai: AiIpc;
  /** Test hook: the profile as the gateway would hand it out. */
  profile(id: string): ProfileView | undefined;
  /** Test hooks of the connection manager: tamper, queued import file, last export, vault size, trusted host keys. */
  engine: MockEngine;
}

/**
 * The seeded world. Everything is neutral (an unrelated web shop) except `happy-local` and `happy-production`, which carry
 * `domain: "happy"` and therefore the Hungarian restaurant data and wording.
 */
function seed(engine: MockEngine): void {
  const std = { auth: { mechanism: "none" as const }, tls: { mode: "auto" as const }, tunnel: { kind: "none" as const } };
  engine.seed({ id: "local-fixture", name: "Local fixture", environment: "local", color: "#4f9d69", aiMode: "schemaOnly", spec: { ...std, scheme: "standard", hosts: [{ host: "127.0.0.1", port: 27017 }] } });
  engine.seed({ id: "sandbox-atlas", name: "Sandbox (Atlas)", environment: "sandbox", color: "#d9a441", spec: { scheme: "srv", hosts: [{ host: "sandbox.k3x9q.mongodb.net" }], auth: { mechanism: "default", username: "reader", source: "admin", savePassword: true }, tls: { mode: "auto" }, tunnel: { kind: "none" } }, password: "seed-secret", group: "Acme", favorite: true });
  engine.seed({ id: "production", name: "Acme production", environment: "production", color: "#e5484d", tenantLock: "shopId", group: "Acme", spec: { scheme: "standard", hosts: [{ host: "db1.acme.example", port: 27017 }], auth: { mechanism: "default", username: "reader", source: "admin", savePassword: true }, tls: { mode: "on" }, tunnel: { kind: "none" } }, password: "seed-secret" });
  // The showcase scenario (website screenshots) shows the neutral shop world only.
  if (isShowcase()) return;
  engine.seed({ id: "happy-local", name: "Happy fixture", environment: "local", color: "#7c6cf0", aiMode: "schemaOnly", domain: "happy", spec: { ...std, scheme: "standard", hosts: [{ host: "127.0.0.1", port: 27018 }] } });
  engine.seed({ id: "happy-production", name: "Happy production", environment: "production", color: "#e5484d", tenantLock: "restaurant", domain: "happy", spec: { scheme: "standard", hosts: [{ host: "db1.happy.internal", port: 27017 }], auth: { mechanism: "default", username: "reader", source: "admin", savePassword: true }, tls: { mode: "on" }, tunnel: { kind: "none" } }, password: "seed-secret" });
}

const ROLES: Record<string, RoleChip> = {
  "local-fixture": { role: "readOnly" },
  "sandbox-atlas": { role: "unknown", reason: "the server did not return privileges (Atlas or a restricted user)" },
  production: { role: "readOnly" },
  "happy-local": { role: "readOnly" },
  "happy-production": { role: "readOnly" },
};

interface Cursor {
  cmd: ReadCommand;
  /** The connection the cursor belongs to (a disconnect drops it). */
  conn: string;
  /** Matched documents for scans; undefined for index-order reads that are generated on demand. */
  hits?: Doc[];
  def?: CollDef;
  desc: boolean;
  skip: number;
  limit: number;
  /** All rows the command can return. */
  size: number;
  proj: Json;
  elapsedMs: number;
  plan?: PlanView;
  rows?: string[];
}

export function createMockMongoWorld(opts: MockMongoOptions = {}): MockMongoWorld {
  const params = new URLSearchParams(globalThis.location?.search);
  const seeded = opts.seeded ?? (params.get("scenario") === "mongo" || params.get("mongo") === "on" || isShowcase());
  const latency = opts.latencyMs ?? 120;
  const cursors = new Map<string, Cursor>();
  const running = new Set<string>();
  const engine = createMockMongoEngine({
    enabled: seeded,
    compiled: opts.compiled,
    network: opts.network,
    latencyMs: Math.round(latency / 3),
    roles: ROLES,
    localHits: seeded ? [{ host: "127.0.0.1", port: 27017 }] : [],
    onClose: (id) => {
      for (const [tab, c] of cursors) if (c.conn === id) cursors.delete(tab);
    },
  });
  if (seeded) seed(engine);
  const core = engine.api;

  const wait = (ms = latency) => (ms > 0 ? sleep(ms) : Promise.resolve());
  const requireOn = () => engine.need();
  const find = (id: string): ProfileView => engine.view(id) ?? fail("mongoNotFound", "Unknown connection");
  const need = (id: string): ConnectionView => {
    requireOn();
    return engine.connection(id) ?? fail("mongoNotConnected", "connect first");
  };
  const collectionsOf = (id: string): Record<string, CollDef> => collectionsFor(engine.view(id)?.domain);
  const coll = (id: string, name: string): CollDef => collectionsOf(id)[name] ?? fail("mongoRejected", `unknown collection "${name}"`);
  const literal = (text: string | null | undefined, what: string): Json => {
    if (!text?.trim()) return {};
    try {
      return parseLiteral(text, NOW_MS);
    } catch (e) {
      if (e instanceof LiteralError) return fail("mongoParse", `${what}: ${e.message} (line ${e.line}, column ${e.column})`);
      throw e;
    }
  };

  function planFor(def: CollDef, filter: Json, sort: Json): PlanView {
    const fkeys = typeof filter === "object" && filter && !Array.isArray(filter) ? Object.keys(filter) : [];
    const skeys = typeof sort === "object" && sort && !Array.isArray(sort) ? Object.keys(sort) : [];
    const idx = def.indexes.find((ix) => fkeys.some((k) => Object.keys(ix.key)[0] === k)) ?? (!fkeys.length && skeys.length === 1 ? def.indexes.find((ix) => skeys[0] in ix.key) : undefined);
    const needsSort = skeys.length > 0 && !(idx && skeys.every((k) => k in idx.key));
    const stages = [...(needsSort ? ["SORT"] : []), ...(idx ? ["FETCH", "IXSCAN"] : ["COLLSCAN"])];
    const warnings = !idx && def.count > 50_000 ? [`COLLSCAN on about ${def.count.toLocaleString("en-US")} documents. Add a filter on an indexed field or an index.`] : [];
    return { stages, collscan: !idx, indexNames: idx ? [idx.name] : [], engine: "classic", rejectedPlans: idx ? 1 : 0, warnings };
  }

  async function startFind(req: RunRequest, cmd: Extract<ReadCommand, { cmd: "find" }>): Promise<Cursor> {
    const def = coll(req.connection, cmd.collection);
    const filter = literal(cmd.filter, "Filter");
    const sort = literal(cmd.sort, "Sort");
    const proj = literal(cmd.projection, "Project");
    const skip = cmd.skip ?? 0;
    const limit = Math.min(cmd.limit && cmd.limit > 0 ? cmd.limit : 1000, 1000);
    const started = Date.now();
    running.add(req.tab);
    const gone = () => void (running.has(req.tab) || fail("mongoCancelled", "cancelled"));
    try {
      const total = def.slow || SLOW_COLLECTIONS.includes(cmd.collection) ? 2400 : latency;
      for (let waited = 0; waited < total; waited += 100) {
        await sleep(Math.min(100, total - waited));
        gone();
      }
      const empty = typeof filter !== "object" || filter === null || !Object.keys(filter).length;
      const sortKeys = typeof sort === "object" && sort !== null && !Array.isArray(sort) ? Object.entries(sort) : [];
      const first = sortKeys[0];
      const byIndex = !first || (sortKeys.length === 1 && ["_id", "createdAt", "at"].includes(first[0]));
      const desc = !!first && Number(first[1]) < 0;
      const plan = planFor(def, filter, sort);
      if (empty && byIndex) return { cmd, conn: req.connection, def, desc, skip, limit, size: Math.max(0, Math.min(def.count - skip, limit)), proj, elapsedMs: Math.max(1, Date.now() - started), plan };
      const [lo, hi] = rangeOf(def, filter);
      const budget = Math.min(hi - lo, 8000);
      const hits: Doc[] = [];
      for (let k = 0; k < budget; k++) {
        if (k % 500 === 0) (await wait(0), gone());
        const d = def.gen(desc && byIndex ? hi - 1 - k : lo + k);
        if (matches(d, filter)) hits.push(d);
      }
      if (first && !byIndex) hits.sort((a, b) => sortKeys.reduce((c, [key, dir]) => c || cmp(norm(getPath(a, key)), norm(getPath(b, key))) * (Number(dir) < 0 ? -1 : 1), 0));
      const rows = hits.slice(skip, skip + limit);
      return { cmd, conn: req.connection, hits: rows, desc, skip, limit, size: rows.length, proj, elapsedMs: Math.max(1, Date.now() - started), plan };
    } finally {
      running.delete(req.tab);
    }
  }

  function windowOf(tab: string, c: Cursor, offset: number, count: number, secondary: boolean): WindowView {
    const lo = Math.min(Math.max(offset, 0), c.size);
    const hi = Math.min(lo + count, c.size);
    let docs: string[];
    if (c.rows) docs = c.rows.slice(lo, hi);
    else if (c.hits) docs = c.hits.slice(lo, hi).map((d) => JSON.stringify(project(d, c.proj)));
    else {
      docs = [];
      for (let k = lo; k < hi; k++) docs.push(JSON.stringify(project(c.def!.gen(c.desc ? c.def!.count - 1 - (c.skip + k) : c.skip + k), c.proj)));
    }
    const loaded = Math.min(c.size, 1000);
    const bytes = docs.reduce((a, d) => a + d.length, 0);
    return { tab, docs, offset: lo, loaded, truncated: false, hasMore: hi < c.size, bytes, elapsedMs: c.elapsedMs, plan: c.plan ?? null, secondaryOk: secondary };
  }

  const mongo: MongoIpc = {
    ...core,
    async setEnabled(on) {
      if (!on) (cursors.clear(), running.clear());
      return core.setEnabled(on);
    },
    async run(req) {
      const conn = need(req.connection);
      const p = find(req.connection);
      const secondary = conn.readPreference === "secondaryPreferred";
      const cmd = req.command;
      const size = req.pageSize ?? 50;
      if (p.tenantLock && cmd.cmd === "find" && !(cmd.filter ?? "").includes(p.tenantLock)) fail("mongoRejected", `tenant lock: the filter must constrain \`${p.tenantLock}\``);
      let c: Cursor;
      switch (cmd.cmd) {
        case "listDatabases":
          await wait();
          c = { cmd, conn: req.connection, desc: false, skip: 0, limit: 1000, size: 2, proj: {}, elapsedMs: 4, rows: [MOCK_DB, "intely_test_archive"].map((name) => JSON.stringify({ name })) };
          break;
        case "listCollections":
          await wait();
          c = { cmd, conn: req.connection, desc: false, skip: 0, limit: 1000, size: 0, proj: {}, elapsedMs: 5, rows: (cmd.db === MOCK_DB ? Object.keys(collectionsOf(req.connection)).sort() : ["daily_totals", "orders_2025"]).map((name) => JSON.stringify({ name })) };
          c.size = c.rows!.length;
          break;
        case "listIndexes":
          await wait();
          c = { cmd, conn: req.connection, desc: false, skip: 0, limit: 1000, size: 0, proj: {}, elapsedMs: 4, rows: coll(req.connection, cmd.collection).indexes.map((ix) => JSON.stringify({ v: { $numberInt: "2" }, key: ix.key, name: ix.name })) };
          c.size = c.rows!.length;
          break;
        case "count": {
          await wait(latency / 2);
          const def = coll(req.connection, cmd.collection);
          const f = literal(cmd.filter, "Filter");
          const empty = typeof f !== "object" || f === null || !Object.keys(f).length;
          let n = def.count;
          if (!empty) {
            const [lo, hi] = rangeOf(def, f);
            const budget = Math.min(hi - lo, 8000);
            let hit = 0;
            for (let k = 0; k < budget; k++) if (matches(def.gen(lo + k), f)) hit++;
            n = budget === hi - lo ? hit : Math.round((hit / budget) * (hi - lo));
          }
          c = { cmd, conn: req.connection, desc: false, skip: 0, limit: 1, size: 1, proj: {}, elapsedMs: 6, rows: [JSON.stringify({ count: n, capped: n >= 100_000 })] };
          break;
        }
        case "sample": {
          await wait();
          const def = coll(req.connection, cmd.collection);
          const n = Math.min(cmd.size, def.count);
          c = { cmd, conn: req.connection, desc: false, skip: 0, limit: n, size: n, proj: {}, elapsedMs: 18, rows: Array.from({ length: n }, (_, i) => JSON.stringify(def.gen(Math.floor((i * def.count) / n)))) };
          break;
        }
        case "find":
          c = await startFind(req, cmd);
          break;
        case "explain": {
          await wait();
          if (cmd.inner.cmd !== "find") fail("mongoRejected", "the mock explains finds only");
          const inner = cmd.inner as Extract<ReadCommand, { cmd: "find" }>;
          const def = coll(req.connection, inner.collection);
          const plan = planFor(def, literal(inner.filter, "Filter"), literal(inner.sort, "Sort"));
          if (cmd.executionStats) Object.assign(plan, { docsExamined: plan.collscan ? def.count : 50, keysExamined: plan.collscan ? 0 : 50, nReturned: 50 });
          c = { cmd, conn: req.connection, desc: false, skip: 0, limit: 1, size: 1, proj: {}, elapsedMs: cmd.executionStats ? (plan.collscan ? 410 : 3) : 7, plan, rows: [JSON.stringify({ queryPlanner: { namespace: `${inner.db}.${inner.collection}`, winningPlan: { stage: plan.stages[0] }, rejectedPlans: [] }, ok: { $numberInt: "1" } })] };
          break;
        }
        default:
          return fail("mongoRejected", "the mock does not run aggregations");
      }
      cursors.set(req.tab, c);
      return windowOf(req.tab, c, 0, size, secondary);
    },
    async window(tab, offset, count) {
      requireOn();
      const c = cursors.get(tab) ?? fail("mongoNotFound", "no cursor in this tab: run a query first");
      return windowOf(tab, c, offset, count, false);
    },
    async cursorClose(tab) {
      cursors.delete(tab);
    },
    async cancel(tab): Promise<CancelView> {
      const was = running.delete(tab);
      return { cancelled: was, killed: was };
    },
  };

  return {
    mongo,
    ai: createMockMongoAi({ latency, enabled: () => engine.isOn(), connected: (id) => !!engine.connection(id), profile: (id) => engine.view(id) }),
    profile: (id) => engine.view(id),
    engine,
  };
}

/** Just the gateway (what `ipc.mongo` is); use `createMockMongoWorld` when the AI mock must share its connections. */
export const createMockMongo = (opts: MockMongoOptions = {}): MongoIpc => createMockMongoWorld(opts).mongo;

/** Test helper that adds a notice, as the Rust side does after a tamper reset. */
export const MOCK_NOTICE = { profileId: "production", message: "The safety settings of Acme production were changed outside the IDE and were reset to read-only with AI off." };

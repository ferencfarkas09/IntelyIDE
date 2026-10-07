// The studio's view of `ipc.mongo`: the tree listings, a counted find, explain and the schema sample, all built from `run`
// and `window` (the gateway has no other way in, and no write path). Tab ids are 1 to 64 of letters, digits, - and _.

import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { PlanView, ReadCommand, WindowView } from "../../ipc/mongo";
import { buildDigest, type DigestIndex, type SchemaDigest } from "./digest";
import { parseDoc, type Doc } from "./ejson";

export const newTabKey = (): string => `mg${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;

/** A fragment of an id that is safe inside a tab id (letters, digits, - and _; the gateway allows 64 characters). */
export const tabPart = (s: string, max = 24): string => s.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, max);

const parseAll = <T = Doc>(w: WindowView): T[] => w.docs.map((d) => JSON.parse(d) as T);

export interface DbRow {
  name: string;
}
export interface CollRow {
  name: string;
}

export async function listDatabases(connection: string): Promise<DbRow[]> {
  return parseAll<DbRow>(await ipc.mongo.run({ tab: `${tabPart(connection, 40)}-dbs`, connection, command: { cmd: "listDatabases" }, pageSize: 200 }));
}

export async function listCollections(connection: string, db: string): Promise<CollRow[]> {
  const w = await ipc.mongo.run({ tab: `${tabPart(connection, 40)}-colls`, connection, command: { cmd: "listCollections", db }, pageSize: 200 });
  return parseAll<CollRow>(w).sort((a, b) => a.name.localeCompare(b.name));
}

export async function countOf(connection: string, tab: string, db: string, collection: string, filter = ""): Promise<{ value: number; capped: boolean }> {
  const w = await ipc.mongo.run({ tab: `${tab}-n`, connection, command: { cmd: "count", db, collection, filter }, pageSize: 1 });
  const r = JSON.parse(w.docs[0] ?? "{}") as { count?: number; capped?: boolean };
  return { value: Number(r.count ?? 0), capped: !!r.capped };
}

export interface IndexRow extends DigestIndex {
  unique?: boolean;
}

/** Sample documents and indexes of a collection, folded into a digest (field names, types, shares). */
export async function loadDigest(connection: string, tab: string, db: string, collection: string, size = 200, tenantCandidates?: readonly string[]): Promise<SchemaDigest> {
  const [sample, idx] = await Promise.all([
    ipc.mongo.run({ tab: `${tab}-s`, connection, command: { cmd: "sample", db, collection, size }, pageSize: 200 }),
    ipc.mongo.run({ tab: `${tab}-i`, connection, command: { cmd: "listIndexes", db, collection }, pageSize: 100 }).catch(() => undefined),
  ]);
  const docs = sample.docs.map(parseDoc);
  // `sample` returns up to 200 per window; the gateway keeps up to `size` and the digest wants them all.
  let rest = sample.loaded - sample.docs.length;
  let offset = sample.docs.length;
  while (rest > 0 && offset < size) {
    const more = await ipc.mongo.window(`${tab}-s`, offset, 200);
    if (!more.docs.length) break;
    docs.push(...more.docs.map(parseDoc));
    offset += more.docs.length;
    rest = sample.loaded - offset;
  }
  const indexes: IndexRow[] = (idx?.docs ?? []).map((d) => {
    const r = JSON.parse(d) as { name?: string; key?: Record<string, unknown>; unique?: boolean };
    return { name: String(r.name ?? "?"), key: Object.fromEntries(Object.entries(r.key ?? {}).map(([k, v]) => [k, typeof v === "object" && v ? Number(Object.values(v)[0]) : (v as number | string)])), unique: r.unique };
  });
  return buildDigest(docs, indexes, tenantCandidates);
}

export interface ExplainOut {
  plan: PlanView;
  raw: string;
  elapsedMs: number;
}

export async function explainFind(connection: string, tab: string, cmd: Extract<ReadCommand, { cmd: "find" }>, executionStats: boolean): Promise<ExplainOut> {
  const w = await ipc.mongo.run({ tab: `${tab}-x`, connection, command: { cmd: "explain", inner: cmd, executionStats }, pageSize: 1 });
  if (!w.plan) throw { code: "mongoServer", message: t("mongo.api.noPlan") };
  return { plan: w.plan, raw: w.docs[0] ?? "{}", elapsedMs: w.elapsedMs };
}

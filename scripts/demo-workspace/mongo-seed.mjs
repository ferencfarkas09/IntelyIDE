#!/usr/bin/env node
// Neutral, deterministic dataset for the Mongo Studio screenshot ((design notes: release-ci-spec) 6.5, shot `mongo`).
// Fictional Fernbank Cycles shop data: customers, products, orders, refunds. No real person, no real address, e-mail
// only on *.example. Pure generator plus two optional CLI actions:
//   node mongo-seed.mjs --out <new dir under the temp dir>          writes <collection>.ndjson (extended JSON) + manifest.json
//   node mongo-seed.mjs --out <dir> --import <mongodb://127.0.0.1:PORT> [--mongoimport <binary>]
//                                                                    loads the files with mongoimport into a LOCAL server
// The import refuses every host except localhost / 127.0.0.1 / [::1] and every URI with credentials. Nothing here
// starts a server; the tour starts its own short-lived mongod (INTELY_DEMO_MONGOD) and passes the URI.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadBrand } from "./lib/brand.mjs";
import { DemoError } from "./lib/errors.mjs";
import { assertFreshRoot } from "./lib/fs.mjs";

export const DATABASE = "fernbank_demo";
export const COLLECTIONS = ["customers", "products", "orders", "refunds"];

/** Small seeded generator (mulberry32): same seed, same numbers, on every machine. */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = (list) => list[int(0, list.length - 1)];
  return { next, int, pick };
}

const FIRST = ["Alma", "Bruno", "Clara", "Dev", "Elin", "Farid", "Greta", "Hugo", "Ines", "Jonas", "Kira", "Lars", "Maya", "Nils", "Olga", "Pavel", "Rosa", "Sven", "Tara", "Ulla"];
const LAST = ["Andersen", "Bianchi", "Costa", "Dubois", "Eriksen", "Fischer", "Garcia", "Horvat", "Ivanov", "Jensen", "Kowalski", "Larsen", "Moreau", "Novak", "Olsen", "Petrov"];
const CITIES = ["Northgate", "Eastport", "Lakeside", "Riverton", "Hillcrest", "Stonebridge"];
const CATALOG = [
  ["City Cruiser 7", "bikes", 64900],
  ["Trail Runner 29", "bikes", 119900],
  ["Folding Commuter", "bikes", 89900],
  ["Cargo Hauler", "bikes", 189900],
  ["Road Sprint 105", "bikes", 139900],
  ["Helmet Aero", "accessories", 8900],
  ["Helmet Urban", "accessories", 5900],
  ["Lock Chain 120", "accessories", 4500],
  ["Bell Brass", "accessories", 1200],
  ["Front Light Pro", "parts", 3900],
  ["Rear Light Duo", "parts", 2400],
  ["Brake Pads Disc", "parts", 2200],
  ["Tyre 700x35", "parts", 3100],
  ["Chain 11-speed", "parts", 2900],
  ["Saddle Comfort", "parts", 4900],
  ["Pannier Set 40L", "accessories", 9900],
];
const STATUS = ["pending", "paid", "shipped", "delivered", "delivered", "delivered", "refunded"];
const REASONS = ["damaged", "wrong_item", "not_as_described", "changed_mind", "other"];

const oid = (r) => ({ $oid: Array.from({ length: 24 }, () => "0123456789abcdef"[r.int(0, 15)]).join("") });
const date = (ms) => ({ $date: new Date(ms).toISOString() });

/** The whole dataset as plain objects in MongoDB extended JSON (relaxed enough for mongoimport and Studio). */
export function generateDataset({ seed = 20260928, customers = 60, orders = 240, brand = loadBrand() } = {}) {
  const r = rng(seed);
  const lo = Date.parse(`${brand.anchor.start}T08:00:00Z`);
  const hi = Date.parse(`${brand.anchor.end}T18:00:00Z`);
  const domain = "mail.example";

  const productDocs = CATALOG.map(([name, category, priceCents], i) => ({
    _id: oid(r),
    sku: "FB-" + String(1000 + i),
    name,
    category,
    priceCents,
    stock: r.int(0, 40),
    active: r.next() > 0.08,
  }));
  const customerDocs = Array.from({ length: customers }, (_, i) => {
    const first = r.pick(FIRST);
    const last = r.pick(LAST);
    return {
      _id: oid(r),
      name: first + " " + last,
      email: (first + "." + last + i).toLowerCase() + "@" + domain,
      city: r.pick(CITIES),
      createdAt: date(lo - r.int(10, 400) * 86400000),
      newsletter: r.next() > 0.5,
    };
  });
  const orderDocs = [];
  const refundDocs = [];
  for (let i = 0; i < orders; i++) {
    const customer = r.pick(customerDocs);
    const lines = Array.from({ length: r.int(1, 3) }, () => {
      const p = r.pick(productDocs);
      return { sku: p.sku, name: p.name, quantity: r.int(1, 2), priceCents: p.priceCents };
    });
    const totalCents = lines.reduce((sum, l) => sum + l.priceCents * l.quantity, 0);
    const createdAt = lo + Math.floor((i / orders) * (hi - lo)) + r.int(0, 3600000);
    const status = r.pick(STATUS);
    const order = { _id: oid(r), number: "FB-O-" + String(5000 + i), customerId: customer._id, status, lines, totalCents, createdAt: date(createdAt) };
    if (status === "refunded") {
      const amountCents = Math.min(totalCents, lines[0].priceCents);
      order.refundedCents = amountCents;
      refundDocs.push({ _id: oid(r), orderId: order._id, orderNumber: order.number, amountCents, reason: r.pick(REASONS), status: r.pick(["approved", "approved", "paid_out"]), requestedAt: date(Math.min(hi, createdAt + r.int(2, 20) * 86400000)) });
    }
    orderDocs.push(order);
  }
  return { database: DATABASE, collections: { customers: customerDocs, products: productDocs, orders: orderDocs, refunds: refundDocs } };
}

export const toNdjson = (docs) => docs.map((d) => JSON.stringify(d)).join("\n") + "\n";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Throws unless `uri` is a credential-free mongodb:// URI that points at this machine. */
export function assertLocalUri(uri) {
  let u;
  try {
    u = new URL(uri);
  } catch {
    throw new DemoError(`not a URI: ${uri}`);
  }
  if (u.protocol !== "mongodb:") throw new DemoError("only mongodb:// URIs are accepted (no mongodb+srv)");
  if (u.username || u.password) throw new DemoError("refusing a URI with credentials");
  if (!LOCAL_HOSTS.has(u.hostname)) throw new DemoError(`refusing non-local host ${u.hostname}`);
  return u;
}

/** Writes the NDJSON files and manifest.json into a fresh directory below the temp dir. */
export function writeDataset(dir, dataset = generateDataset()) {
  const root = assertFreshRoot(dir);
  mkdirSync(root, { recursive: true });
  const manifest = { database: dataset.database, collections: {} };
  for (const [name, docs] of Object.entries(dataset.collections)) {
    writeFileSync(join(root, `${name}.ndjson`), toNdjson(docs));
    manifest.collections[name] = docs.length;
  }
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { root, manifest };
}

/** Runs `mongoimport` once per collection against a local server. Returns the list of argument vectors it ran. */
export function importDataset(root, uri, { binary = "mongoimport", run = spawnSync } = {}) {
  assertLocalUri(uri);
  const ran = [];
  for (const name of COLLECTIONS) {
    const args = ["--uri", uri, "--db", DATABASE, "--collection", name, "--drop", "--file", join(root, `${name}.ndjson`)];
    const res = run(binary, args, { encoding: "utf8" });
    if (res.error || res.status !== 0) throw new DemoError(`mongoimport failed for ${name}: ${res.error?.message ?? res.stderr}`, 1);
    ran.push(args);
  }
  return ran;
}

function parse(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new DemoError(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--out") o.out = val();
    else if (a === "--import") o.uri = val();
    else if (a === "--mongoimport") o.binary = val();
    else if (a === "--seed") o.seed = Number(val());
    else throw new DemoError(`unknown argument: ${a}`);
  }
  if (!o.out) throw new DemoError("--out <new dir under the temp dir> is required");
  return o;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const o = parse(process.argv.slice(2));
    if (o.uri) assertLocalUri(o.uri);
    const { root, manifest } = writeDataset(o.out, generateDataset(o.seed ? { seed: o.seed } : {}));
    if (o.uri) importDataset(root, o.uri, { binary: o.binary });
    process.stdout.write(`mongo-seed: ${DATABASE} ${JSON.stringify(manifest.collections)}\n${root}\n`);
  } catch (e) {
    process.stderr.write(`mongo-seed: ${e instanceof DemoError ? e.message : e.stack}\n`);
    process.exit(e instanceof DemoError ? e.exitCode ?? 2 : 1);
  }
}

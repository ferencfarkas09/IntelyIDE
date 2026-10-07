import { dateMs, getPath, type Doc, type Json } from "../../modules/mongo/ejson";

// The synthetic datasets of the mongo mock (`?scenario=mongo`). Documents are generated on demand from their index, so a
// 100,000-document collection costs no memory. Names, e-mails and phone numbers are fake (example.test, no real people).
// Two worlds: the neutral one (shops, orders, customers; English) every profile gets by default, and the Happy one (restaurants,
// Hungarian) only for profiles with `domain: "happy"` (see `collectionsFor`).

export const MOCK_DB = "intely_test_shop";
/** "Now" of the mock world, so dates and relative times are identical on every load. */
export const NOW_MS = Date.UTC(2026, 9, 3, 9, 30, 0);
const BASE_MS = Date.UTC(2026, 7, 1, 6, 0, 0);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s: string): number => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);
const hex = (n: number, width: number) => n.toString(16).padStart(width, "0").slice(-width);
const oid = (coll: string, i: number, ts: number): Json => ({ $oid: hex(Math.floor(ts / 1000), 8) + hex(hash(coll), 10) + hex(i, 6) });
const date = (ms: number): Json => ({ $date: { $numberLong: String(ms) } });
const int = (n: number): Json => ({ $numberInt: String(n) });
const dbl = (n: number): Json => ({ $numberDouble: Number.isInteger(n) ? n.toFixed(1) : String(n) });
const ascii = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const STATUSES = ["open", "paid", "paid", "paid", "void", "cancelled", "closed"] as const;
const DISHES = [
  ["HUN-001", "Gulyásleves", 2490], ["HUN-014", "Rántott sajt hasábburgonyával", 3890], ["HUN-022", "Somlói galuska", 1690], ["HUN-031", "Túrós csusza", 2790],
  ["HUN-040", "Lángos tejföllel", 1590], ["HUN-052", "Hortobágyi palacsinta", 2390], ["DRK-003", "Szürkebarát 1 dl", 790], ["DRK-011", "Házi limonádé", 890],
] as const;
const FIRST = ["Anna", "Péter", "Zsófia", "Bence", "Réka", "Gábor", "Eszter", "Máté", "Lilla", "Ádám", "Dóra", "Levente"];
const LAST = ["Kovács", "Szűcs", "Tóth", "Nagy", "Horváth", "Kiss", "Varga", "Molnár", "Németh", "Fekete", "Papp", "Őri"];
const RESTAURANTS = ["Gólya Étterem", "Hold utcai Bisztró", "Dunakorzó", "Balatoni Csárda", "Pest Kávézó", "Tokaji Pince", "Margit Szendvics", "Zugló Grill", "Debreceni Kemence", "Pécsi Fogadó", "Soproni Vendéglő", "Győri Kerti Sör"];

type Gen = (i: number) => Doc;

const orderAt: Gen = (i) => {
  const r = mulberry32(hash("orders") ^ (i * 2654435761));
  const ts = BASE_MS + i * 52_000 + Math.floor(r() * 30_000);
  const status = STATUSES[Math.floor(r() * STATUSES.length)];
  const n = 1 + Math.floor(r() * 4);
  let sum = 0;
  const items = Array.from({ length: n }, () => {
    const [sku, name, price] = DISHES[Math.floor(r() * DISHES.length)];
    const qty = 1 + Math.floor(r() * 3);
    sum += qty * price;
    return { sku, name, qty: int(qty), price: int(price) };
  });
  const trap = r() < 0.04;
  const total: Json = trap ? `${String(sum).replace(/\B(?=(\d{3})+$)/g, " ")} Ft` : r() < 0.5 ? int(sum) : dbl(sum + (r() < 0.2 ? 0.5 : 0));
  const first = FIRST[Math.floor(r() * FIRST.length)];
  const last = LAST[Math.floor(r() * LAST.length)];
  const paid = status === "paid" || status === "closed";
  const doc: Doc = {
    _id: oid("orders", i, ts),
    restaurant: oid("restaurants", i % 12, BASE_MS - 86_400_000 * 90),
    status,
    total,
    currency: "HUF",
    table: int(1 + Math.floor(r() * 40)),
    createdAt: date(ts),
    paidAt: paid ? date(ts + 600_000 + Math.floor(r() * 2_400_000)) : null,
    items,
    payments: paid ? [{ method: r() < 0.6 ? "card" : "cash", amount: int(sum) }] : [],
    customer: { name: `${last} ${first}`, email: `${ascii(last)}.${ascii(first)}+${i % 97}@example.test`, phone: `+3620${String(1000000 + Math.floor(r() * 8999999))}` },
  };
  if (r() < 0.012) doc.note = "Allergia: dió, mogyoró. ".repeat(60);
  return doc;
};

const customerAt: Gen = (i) => {
  const r = mulberry32(hash("customers") ^ (i * 40503));
  const first = FIRST[Math.floor(r() * FIRST.length)];
  const last = LAST[Math.floor(r() * LAST.length)];
  return {
    _id: oid("customers", i, BASE_MS - 86_400_000 * (400 - (i % 300))),
    name: `${last} ${first}`,
    email: `${ascii(last)}.${ascii(first)}${i}@example.test`,
    phone: `+3630${String(1000000 + Math.floor(r() * 8999999))}`,
    taxNumber: `${Math.floor(10000000 + r() * 89999999)}-2-42`,
    address: { zip: String(1000 + Math.floor(r() * 8999)), city: ["Budapest", "Debrecen", "Szeged", "Pécs", "Győr"][Math.floor(r() * 5)], street: `${LAST[Math.floor(r() * LAST.length)]} utca ${1 + Math.floor(r() * 80)}.` },
    visits: int(Math.floor(r() * 60)),
    tier: ["regular", "silver", "gold"][Math.floor(r() * 3)],
    createdAt: date(BASE_MS - 86_400_000 * (400 - (i % 300))),
  };
};

const productAt: Gen = (i) => {
  const r = mulberry32(hash("products") ^ (i * 977));
  const [sku, name, price] = DISHES[i % DISHES.length];
  return { _id: oid("products", i, BASE_MS - 86_400_000 * 200), sku: `${sku}-${i}`, name: `${name} #${i}`, price: int(price + Math.floor(r() * 10) * 50), vat: dbl(i % 3 === 0 ? 0.05 : 0.27), active: r() < 0.9, tags: r() < 0.5 ? ["menu", "daily"] : ["menu"] };
};

const restaurantAt: Gen = (i) => ({
  _id: oid("restaurants", i, BASE_MS - 86_400_000 * 90),
  name: RESTAURANTS[i % RESTAURANTS.length],
  city: ["Budapest", "Balatonfüred", "Tokaj", "Pécs", "Sopron", "Győr"][i % 6],
  seats: int(24 + i * 6),
  openedAt: date(BASE_MS - 86_400_000 * (700 + i * 31)),
});

const invoiceAt: Gen = (i) => {
  const r = mulberry32(hash("invoices") ^ (i * 31337));
  const ts = BASE_MS + i * 270_000;
  return { _id: oid("invoices", i, ts), serial: `HP-2026-${String(i + 1).padStart(6, "0")}`, orderId: oid("orders", Math.floor(r() * 100000), ts), net: int(1000 + Math.floor(r() * 90000)), vat: dbl(27), issuedAt: date(ts), buyer: { name: `${LAST[i % LAST.length]} Kft.`, taxNumber: `${Math.floor(10000000 + r() * 89999999)}-2-13` } };
};

const auditAt: Gen = (i) => {
  const ts = BASE_MS + i * 40_000;
  return { _id: oid("audit_log", i, ts), at: date(ts), level: ["info", "info", "warn", "error"][i % 4], event: ["login", "order.create", "order.void", "printer.timeout"][i % 4], expireAt: date(ts + 30 * 86_400_000) };
};

export interface CollDef {
  count: number;
  /** Documents are generated in time order: `timeField` at `BASE + i * step`, so a date range maps to an index range. */
  timeField?: string;
  step?: number;
  gen: Gen;
  /** Slow collections take seconds, so Cancel can be tried. */
  slow?: boolean;
  indexes: { name: string; key: Record<string, number> }[];
  sizeBytes: number;
}
const id_ = { name: "_id_", key: { _id: 1 } };
const HAPPY_COLLECTIONS: Record<string, CollDef> = {
  orders: { count: 100_000, timeField: "createdAt", step: 52_000, gen: orderAt, sizeBytes: 78_400_000, indexes: [id_, { name: "restaurant_1_createdAt_-1", key: { restaurant: 1, createdAt: -1 } }] },
  customers: { count: 2_400, gen: customerAt, sizeBytes: 1_020_000, indexes: [id_] },
  products: { count: 310, gen: productAt, sizeBytes: 96_000, indexes: [id_] },
  restaurants: { count: 12, gen: restaurantAt, sizeBytes: 3_400, indexes: [id_] },
  invoices: { count: 18_500, timeField: "issuedAt", step: 270_000, gen: invoiceAt, sizeBytes: 5_100_000, indexes: [id_] },
  audit_log: { count: 54_000, timeField: "at", step: 40_000, gen: auditAt, slow: true, sizeBytes: 9_800_000, indexes: [id_, { name: "expireAt_1", key: { expireAt: 1 } }] },
};

// --- the neutral world: an unrelated web shop (Acme) --------------------------------------------------------------------------

const N_FIRST = ["Alice", "Bob", "Carol", "David", "Emma", "Frank", "Grace", "Henry", "Irene", "Jack", "Kate", "Liam"];
const N_LAST = ["Smith", "Jones", "Brown", "Taylor", "Wilson", "Davies", "Evans", "Thomas", "Roberts", "Walker", "Wright", "Hall"];
const N_SHOPS = ["Acme Outlet", "Acme Online", "Harbour Store", "Maple Market", "Northside Books", "Cedar Home", "Blue Door Coffee", "Riverside Toys", "Oak & Iron", "Summit Sports", "Lantern Gifts", "Willow Garden"];
const N_ITEMS = [["SKU-001", "Notebook A5", 450], ["SKU-014", "Desk lamp", 3890], ["SKU-022", "Coffee beans 1 kg", 1690], ["SKU-031", "Water bottle", 790], ["SKU-040", "Backpack", 5990], ["SKU-052", "Headphones", 8490], ["SKU-063", "Phone case", 1290], ["SKU-071", "Gift card 25", 2500]] as const;
const N_STATUSES = ["open", "paid", "paid", "paid", "refunded", "cancelled", "shipped"] as const;

const nOrderAt: Gen = (i) => {
  const r = mulberry32(hash("n-orders") ^ (i * 2654435761));
  const ts = BASE_MS + i * 52_000 + Math.floor(r() * 30_000);
  const status = N_STATUSES[Math.floor(r() * N_STATUSES.length)];
  const n = 1 + Math.floor(r() * 4);
  let sum = 0;
  const items = Array.from({ length: n }, () => {
    const [sku, name, price] = N_ITEMS[Math.floor(r() * N_ITEMS.length)];
    const qty = 1 + Math.floor(r() * 3);
    sum += qty * price;
    return { sku, name, qty: int(qty), price: int(price) };
  });
  const trap = r() < 0.04;
  const total: Json = trap ? `${sum / 100} EUR` : r() < 0.5 ? int(sum) : dbl(sum + (r() < 0.2 ? 0.5 : 0));
  const first = N_FIRST[Math.floor(r() * N_FIRST.length)];
  const last = N_LAST[Math.floor(r() * N_LAST.length)];
  const paid = status === "paid" || status === "shipped";
  return {
    _id: oid("orders", i, ts),
    shopId: oid("shops", i % 12, BASE_MS - 86_400_000 * 90),
    status,
    total,
    currency: "EUR",
    createdAt: date(ts),
    paidAt: paid ? date(ts + 600_000 + Math.floor(r() * 2_400_000)) : null,
    items,
    customer: { name: `${first} ${last}`, email: `${ascii(first)}.${ascii(last)}+${i % 97}@example.test`, phone: `+4470${String(10000000 + Math.floor(r() * 89999999))}` },
  };
};

const nCustomerAt: Gen = (i) => {
  const r = mulberry32(hash("n-customers") ^ (i * 40503));
  const first = N_FIRST[Math.floor(r() * N_FIRST.length)];
  const last = N_LAST[Math.floor(r() * N_LAST.length)];
  return {
    _id: oid("customers", i, BASE_MS - 86_400_000 * (400 - (i % 300))),
    name: `${first} ${last}`,
    email: `${ascii(first)}.${ascii(last)}${i}@example.test`,
    phone: `+4475${String(10000000 + Math.floor(r() * 89999999))}`,
    address: { zip: `EC${1 + Math.floor(r() * 9)}A ${1 + Math.floor(r() * 9)}XY`, city: ["London", "Leeds", "Bristol", "Glasgow", "Cardiff"][Math.floor(r() * 5)], street: `${N_LAST[Math.floor(r() * N_LAST.length)]} Road ${1 + Math.floor(r() * 80)}` },
    orders: int(Math.floor(r() * 60)),
    tier: ["standard", "silver", "gold"][Math.floor(r() * 3)],
    createdAt: date(BASE_MS - 86_400_000 * (400 - (i % 300))),
  };
};

const nProductAt: Gen = (i) => {
  const r = mulberry32(hash("n-products") ^ (i * 977));
  const [sku, name, price] = N_ITEMS[i % N_ITEMS.length];
  return { _id: oid("products", i, BASE_MS - 86_400_000 * 200), sku: `${sku}-${i}`, name: `${name} #${i}`, price: int(price + Math.floor(r() * 10) * 50), vat: dbl(i % 3 === 0 ? 0.05 : 0.2), active: r() < 0.9, tags: r() < 0.5 ? ["catalog", "featured"] : ["catalog"] };
};

const nShopAt: Gen = (i) => ({
  _id: oid("shops", i, BASE_MS - 86_400_000 * 90),
  name: N_SHOPS[i % N_SHOPS.length],
  city: ["London", "Leeds", "Bristol", "Glasgow", "Cardiff", "York"][i % 6],
  staff: int(3 + i * 2),
  openedAt: date(BASE_MS - 86_400_000 * (700 + i * 31)),
});

const nInvoiceAt: Gen = (i) => {
  const r = mulberry32(hash("n-invoices") ^ (i * 31337));
  const ts = BASE_MS + i * 270_000;
  return { _id: oid("invoices", i, ts), serial: `INV-2026-${String(i + 1).padStart(6, "0")}`, orderId: oid("orders", Math.floor(r() * 100000), ts), net: int(1000 + Math.floor(r() * 90000)), vat: dbl(20), issuedAt: date(ts), buyer: { name: `${N_LAST[i % N_LAST.length]} Ltd`, taxNumber: `GB${Math.floor(100000000 + r() * 899999999)}` } };
};

const nEventAt: Gen = (i) => {
  const ts = BASE_MS + i * 40_000;
  return { _id: oid("events", i, ts), at: date(ts), level: ["info", "info", "warn", "error"][i % 4], type: ["login", "order.create", "order.refund", "printer.timeout"][i % 4], expireAt: date(ts + 30 * 86_400_000) };
};

const GENERIC_COLLECTIONS: Record<string, CollDef> = {
  orders: { count: 100_000, timeField: "createdAt", step: 52_000, gen: nOrderAt, sizeBytes: 78_400_000, indexes: [id_, { name: "shopId_1_createdAt_-1", key: { shopId: 1, createdAt: -1 } }] },
  customers: { count: 2_400, gen: nCustomerAt, sizeBytes: 1_020_000, indexes: [id_] },
  products: { count: 310, gen: nProductAt, sizeBytes: 96_000, indexes: [id_] },
  shops: { count: 12, gen: nShopAt, sizeBytes: 3_400, indexes: [id_] },
  invoices: { count: 18_500, timeField: "issuedAt", step: 270_000, gen: nInvoiceAt, sizeBytes: 5_100_000, indexes: [id_] },
  events: { count: 54_000, timeField: "at", step: 40_000, gen: nEventAt, slow: true, sizeBytes: 9_800_000, indexes: [id_, { name: "expireAt_1", key: { expireAt: 1 } }] },
};

/** The collections a profile of this domain sees: neutral unless it is a Happy profile. */
export const collectionsFor = (domain: "generic" | "happy" | null | undefined): Record<string, CollDef> => (domain === "happy" ? HAPPY_COLLECTIONS : GENERIC_COLLECTIONS);
/** Slow collections take seconds, so Cancel can be tried (`audit_log` in the Happy world, `events` in the neutral one). */
export const SLOW_COLLECTIONS = ["audit_log", "events"];

// --- a small matcher for the filters a person types ---------------------------------------------------------------

type Norm = number | string | boolean | null | undefined;
export function norm(v: Json | undefined): Norm {
  if (v === null || v === undefined || typeof v !== "object") return v;
  if (Array.isArray(v)) return JSON.stringify(v);
  const k = Object.keys(v)[0];
  switch (k) {
    case "$oid": return `oid:${(v as { $oid: string }).$oid}`;
    case "$date": return dateMs(v);
    case "$numberInt": case "$numberLong": case "$numberDouble": case "$numberDecimal": return Number((v as Record<string, string>)[k]);
    default: return JSON.stringify(v);
  }
}
export const cmp = (a: Norm, b: Norm): number =>
  a === b ? 0 : a === null || a === undefined ? -1 : b === null || b === undefined ? 1 : typeof a === typeof b ? (a < b ? -1 : 1) : typeof a === "number" ? -1 : 1;

const TYPED = ["$oid", "$date", "$regularExpression", "$numberInt", "$numberLong", "$numberDouble", "$numberDecimal"];
const bad = (message: string): never => {
  throw { code: "mongoRejected", message };
};

function valuesAt(doc: Doc, path: string): (Json | undefined)[] {
  const v = getPath(doc, path);
  return Array.isArray(v) ? [v, ...v] : [v];
}

function cond(vals: (Json | undefined)[], expected: Json): boolean {
  const isOps = typeof expected === "object" && expected !== null && !Array.isArray(expected) && Object.keys(expected).some((k) => k.startsWith("$")) && !TYPED.some((t) => t in expected);
  if (isOps) {
    const same = (v: Json | undefined, arg: Json) => v !== undefined && v !== null && typeof norm(v) === typeof norm(arg);
    return Object.entries(expected as Doc).every(([op, arg]) => {
      switch (op) {
        case "$gt": return vals.some((v) => same(v, arg) && cmp(norm(v), norm(arg)) > 0);
        case "$gte": return vals.some((v) => same(v, arg) && cmp(norm(v), norm(arg)) >= 0);
        case "$lt": return vals.some((v) => same(v, arg) && cmp(norm(v), norm(arg)) < 0);
        case "$lte": return vals.some((v) => same(v, arg) && cmp(norm(v), norm(arg)) <= 0);
        case "$ne": return !vals.some((v) => norm(v) === norm(arg));
        case "$in": return Array.isArray(arg) && vals.some((v) => arg.some((a) => norm(v) === norm(a)));
        case "$nin": return Array.isArray(arg) && !vals.some((v) => arg.some((a) => norm(v) === norm(a)));
        case "$exists": return (vals[0] !== undefined) === !!arg;
        case "$regex": return vals.some((v) => typeof v === "string" && new RegExp(String(arg)).test(v));
        case "$size": return Array.isArray(vals[0]) && vals[0].length === arg;
        default: return bad(`Operator ${op} is not supported by the mock`);
      }
    });
  }
  if (typeof expected === "object" && expected !== null && "$regularExpression" in expected) {
    const r = expected.$regularExpression as { pattern: string; options: string };
    const re = new RegExp(r.pattern, r.options);
    return vals.some((v) => typeof v === "string" && re.test(v));
  }
  const e = norm(expected);
  return vals.some((v) => norm(v) === e) || (e === null && vals[0] === undefined);
}

export function matches(doc: Doc, filter: Json): boolean {
  if (typeof filter !== "object" || filter === null || Array.isArray(filter)) return true;
  return Object.entries(filter).every(([k, v]) => {
    if (k === "$and") return Array.isArray(v) && v.every((f) => matches(doc, f));
    if (k === "$or") return Array.isArray(v) && v.some((f) => matches(doc, f));
    if (k === "$nor") return Array.isArray(v) && !v.some((f) => matches(doc, f));
    if (k.startsWith("$")) return bad(`Operator ${k} is not allowed here`);
    return cond(valuesAt(doc, k), v);
  });
}

export function project(doc: Doc, spec: Json | undefined): Doc {
  if (!spec || typeof spec !== "object" || Array.isArray(spec) || !Object.keys(spec).length) return doc;
  const entries = Object.entries(spec);
  const inclusive = entries.some(([k, v]) => k !== "_id" && (v === 1 || v === true));
  const out: Doc = {};
  if (inclusive) {
    if (spec._id !== 0 && spec._id !== false && "_id" in doc) out._id = doc._id;
    for (const [k, v] of entries) if ((v === 1 || v === true) && k in doc) out[k] = doc[k];
  } else {
    for (const [k, v] of Object.entries(doc)) if (!(k in spec && (spec[k] === 0 || spec[k] === false))) out[k] = v;
  }
  return out;
}

/** The index range a filter on the collection's time field can touch, so a date range is found without scanning everything. */
export function rangeOf(def: CollDef, filter: Json): [number, number] {
  const cond = def.timeField && typeof filter === "object" && filter && !Array.isArray(filter) ? (filter as Doc)[def.timeField] : undefined;
  if (!def.step || typeof cond !== "object" || cond === null || Array.isArray(cond)) return [0, def.count];
  const ms = (v: Json | undefined) => dateMs(v as Json);
  const lo = ms((cond as Doc).$gte ?? (cond as Doc).$gt);
  const hi = ms((cond as Doc).$lte ?? (cond as Doc).$lt);
  const at = (t: number) => Math.floor((t - BASE_MS) / def.step!);
  return [lo === undefined ? 0 : Math.max(0, at(lo) - 2), hi === undefined ? def.count : Math.min(def.count, at(hi) + 3)];
}

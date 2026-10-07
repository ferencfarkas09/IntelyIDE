#!/usr/bin/env node
// Deterministic SYNTHETIC Happy-shaped dataset as canonical Extended JSON, one NDJSON file per collection.
// No real data, no network, no database access: it only writes files. Load them with up.sh (throwaway loopback mongod).
//   node scripts/mongo-fixture/seed.mjs --out <dir> [--orders 50000] [--seed 1]
import { mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const out = arg('out');
if (!out) { console.error('usage: seed.mjs --out <dir> [--orders N] [--seed N]'); process.exit(2); }
const N_ORDERS = Number(arg('orders', 50000));
const SEED = Number(arg('seed', 1));
mkdirSync(out, { recursive: true });

// mulberry32
let a = SEED >>> 0;
const rnd = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = (arr) => arr[int(0, arr.length - 1)];
const wpick = (pairs) => { let r = rnd() * pairs.reduce((s, p) => s + p[1], 0); for (const [v, w] of pairs) { if ((r -= w) < 0) return v; } return pairs[0][0]; };

// Fixed anchor so "last 7 days" style questions are reproducible: 2026-10-03T00:00:00Z.
const ANCHOR = Date.UTC(2026, 9, 3);
const DAY = 86400000;
let ctr = 0;
const oid = (kind, tsMs) => ({ $oid: (Math.floor(tsMs / 1000) >>> 0).toString(16).padStart(8, '0') + kind.toString(16).padStart(4, '0') + SEED.toString(16).padStart(6, '0') + (ctr++).toString(16).padStart(6, '0') });
const i32 = (n) => ({ $numberInt: String(n) });
const dbl = (n) => ({ $numberDouble: Number.isInteger(n) ? n.toFixed(1) : String(n) });
const num = (n) => (Number.isInteger(n) ? i32(n) : dbl(n));
const date = (ms) => ({ $date: { $numberLong: String(ms) } });

const FIRST = ['Anna', 'Béla', 'Csilla', 'Dávid', 'Eszter', 'Ferenc', 'Gábor', 'Hanna', 'István', 'Judit', 'Kata', 'László', 'Márta', 'Nóra', 'Olivér', 'Péter', 'Réka', 'Sándor', 'Tamás', 'Zsófia', 'Ádám', 'Ilona', 'Ödön', 'Ügyes', 'Kálmán', 'Katalin'];
const LAST = ['Kovács', 'Nagy', 'Szabó', 'Tóth', 'Kiss', 'Varga', 'Molnár', 'Németh', 'Farkas', 'Balogh', 'Papp', 'Takács', 'Juhász', 'Lakatos', 'Mészáros', 'Őri', 'Fekete', 'Kocsis', 'Orsós', 'Kürti'];
const CITIES = [['Budapest', 1000], ['Debrecen', 4024], ['Szeged', 6720], ['Pécs', 7621], ['Győr', 9021], ['Miskolc', 3525], ['Eger', 3300], ['Kecskemét', 6000]];
const STREETS = ['Kossuth Lajos utca', 'Petőfi Sándor utca', 'Fő tér', 'Dózsa György út', 'Árpád út', 'Széchenyi utca'];
const REST = ['Gólya Étterem', 'Hangulat Bisztró', 'Három Hattyú Vendéglő', 'Kék Duna Kávézó', 'Pipacs Kert', 'Rozmaring Presszó', 'Öreg Csárda', 'Tűzhely Konyha', 'Lángos Király', 'Halászcsárda Tisza', 'Bagolyvár', 'Őszirózsa Étkezde'];
const PRODUCTS = [['Gulyásleves', 'leves', 1890], ['Húsleves', 'leves', 1490], ['Bableves', 'leves', 1690], ['Halászlé', 'leves', 2490], ['Paprikás csirke nokedlivel', 'főétel', 3490], ['Rántott szelet', 'főétel', 3290], ['Pörkölt', 'főétel', 3690], ['Töltött káposzta', 'főétel', 3590], ['Lángos', 'főétel', 1290], ['Rakott krumpli', 'főétel', 2990], ['Túrógombóc', 'desszert', 1790], ['Somlói galuska', 'desszert', 1890], ['Palacsinta', 'desszert', 1390], ['Dobos torta', 'desszert', 1990], ['Ásványvíz', 'ital', 590], ['Kávé', 'ital', 690], ['Csapolt sör', 'ital', 990], ['Fröccs', 'ital', 790], ['Házi limonádé', 'ital', 1190], ['Tokaji bor 1 dl', 'ital', 1490]];
const NOTES = ['Allergia: dió', 'Gyorsan kérjük', 'Gyerekszék kell', 'Születésnap, gyertyával', 'Külön számlát kérnek', null, null, null, null, null];

const write = (name, rows) => { const s = createWriteStream(join(out, `${name}.ndjson`)); for (const r of rows) s.write(JSON.stringify(r) + '\n'); s.end(); return rows.length; };
const counts = {};

// restaurants
const restaurants = REST.map((name, i) => {
  const [city, zip] = CITIES[i % CITIES.length];
  return { _id: oid(1, ANCHOR - 900 * DAY), name, city, address: { zip: String(zip), street: `${pick(STREETS)} ${int(1, 80)}.` }, timezone: 'Europe/Budapest', active: i !== 11, currency: 'HUF', settings: { vatRate: i32(27), tipEnabled: i % 2 === 0 }, createdAt: date(ANCHOR - int(300, 900) * DAY) };
});
counts.restaurants = write('restaurants', restaurants);
const rid = restaurants.map((r) => r._id);

// users (staff); restaurants[] refs, no password fields at all
const ROLES = ['owner', 'manager', 'waiter', 'cook'];
const users = Array.from({ length: 36 }, (_, i) => {
  const fn = pick(FIRST), ln = pick(LAST);
  return { _id: oid(2, ANCHOR - 800 * DAY), name: `${ln} ${fn}`, email: `staff${i}@example.test`, role: ROLES[i % 4], restaurants: [pick(rid), ...(rnd() < 0.2 ? [pick(rid)] : [])], phone: `+3620${int(1000000, 9999999)}`, active: rnd() > 0.1, createdAt: date(ANCHOR - int(100, 700) * DAY) };
});
counts.users = write('users', users);

// products
const products = [];
for (const r of rid) for (const [name, category, price] of PRODUCTS) if (rnd() < 0.85) products.push({ _id: oid(3, ANCHOR - 600 * DAY), restaurant: r, name, category, price: rnd() < 0.1 ? dbl(price + 0.5) : i32(price), vatRate: i32(category === 'ital' && name.includes('bor') ? 27 : 27), active: rnd() > 0.05 });
counts.products = write('products', products);

// customers (fake PII, *.example.test)
const SEG = [['regular', 70], ['vip', 8], ['new', 22]];
const customers = Array.from({ length: 2000 }, (_, i) => {
  const fn = pick(FIRST), ln = pick(LAST), [city, zip] = pick(CITIES);
  const c = { _id: oid(4, ANCHOR - int(1, 700) * DAY), restaurant: pick(rid), name: `${ln} ${fn}`, segment: wpick(SEG), loyaltyPoints: rnd() < 0.2 ? dbl(int(0, 900) + 0.5) : i32(int(0, 1500)), birthDate: date(Date.UTC(int(1950, 2005), int(0, 11), int(1, 28))), address: { city, zip: String(zip), street: `${pick(STREETS)} ${int(1, 99)}.` }, deleted: rnd() < 0.06, createdAt: date(ANCHOR - int(1, 700) * DAY) };
  const r = rnd();
  if (r < 0.15) c.email = null; else if (r < 0.3) { /* email missing */ } else c.email = `${fn}.${ln}${i}@example.test`.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (rnd() < 0.7) c.phone = `+3630${int(1000000, 9999999)}`;
  return c;
});
counts.customers = write('customers', customers);
const cid = customers.map((c) => c._id);

// orders
const STATUS = [['closed', 55], ['paid', 22], ['open', 8], ['cancelled', 10], ['refunded', 5]];
const TYPE = [['dine_in', 65], ['takeaway', 20], ['delivery', 15]];
const PAY = [['card', 55], ['cash', 35], ['szep', 10]];
const TABLES = ['Terasz 1', 'Terasz 3', 'Belső 2', 'Belső 7', 'Pult 1', 'Kert 4'];
const seqPer = new Map();
const ordersStream = createWriteStream(join(out, 'orders.ndjson'));
for (let i = 0; i < N_ORDERS; i++) {
  const age = Math.floor(Math.pow(rnd(), 1.6) * 400); // denser towards today
  const created = ANCHOR - age * DAY - int(0, DAY - 1) + (age === 0 ? -DAY / 2 : 0);
  const r = pick(rid);
  const seq = (seqPer.get(r.$oid) ?? 0) + 1; seqPer.set(r.$oid, seq);
  const status = age < 1 && rnd() < 0.4 ? 'open' : wpick(STATUS);
  const lines = Array.from({ length: int(1, 6) }, () => { const p = pick(products); const price = p.price.$numberInt ? Number(p.price.$numberInt) : Number(p.price.$numberDouble); return { product: p._id, name: p.name, qty: i32(int(1, 4)), unitPrice: p.price, category: p.category, _price: price }; });
  const sum = lines.reduce((s, l) => s + l._price * Number(l.qty.$numberInt), 0);
  const items = lines.map(({ _price, ...l }) => l);
  const roll = rnd();
  const total = roll < 0.04 ? String(sum) /* TRAP: numeric string */ : roll < 0.19 ? dbl(sum + 0.5) : num(sum);
  const o = { _id: oid(5, created), restaurant: r, number: i32(seq), status, type: wpick(TYPE), createdAt: date(created), total, currency: 'HUF', items };
  if (rnd() < 0.7) o.customer = pick(cid);
  if (rnd() < 0.5) o.waiter = pick(users)._id;
  if (status !== 'open') o.closedAt = date(created + int(20, 140) * 60000);
  if (status === 'closed' || status === 'paid' || status === 'refunded') o.payments = [{ method: wpick(PAY), amount: num(sum), paidAt: date(created + int(20, 140) * 60000) }];
  const t = rnd(); if (t < 0.3) o.tip = null; else if (t < 0.55) o.tip = i32(int(0, 8) * 100); // else: tip missing
  if (o.type === 'dine_in') o.table = pick(TABLES);
  const n = pick(NOTES); if (n) o.note = n;
  if (rnd() < 0.12) o.discountPercent = i32(pick([5, 10, 15, 20]));
  if (rnd() < 0.1) o.tags = ['stammgast'];
  ordersStream.write(JSON.stringify(o) + '\n');
}
ordersStream.end();
counts.orders = N_ORDERS;

// legacy BSON corpus: shaped like data written by mongoose 6 / driver 4 era stacks (synthetic)
const legacy = [
  { _id: { $oid: '000000000000000000000001' }, kind: 'symbol', sym: { $symbol: 'régi-szimbólum' } },
  { _id: { $oid: '000000000000000000000002' }, kind: 'dbpointer', ptr: { $dbPointer: { $ref: 'restaurants', $id: { $oid: '000000000000000000000009' } } } },
  { _id: { $oid: '000000000000000000000003' }, kind: 'undefined', u: { $undefined: true } },
  { _id: { $oid: '000000000000000000000004' }, kind: 'numbers', i: i32(7), l: { $numberLong: '9007199254740993' }, d: dbl(7), d2: dbl(0.1), neg0: { $numberDouble: '-0.0' }, big: { $numberLong: '-9223372036854775808' }, l2: { $numberLong: '5' }, d3: dbl(5), dec: { $numberDecimal: '12345.6789' }, inf: { $numberDouble: 'Infinity' }, nan: { $numberDouble: 'NaN' } },
  { _id: { $oid: '000000000000000000000005' }, kind: 'dates', pre1970: date(-86400000 * 365 * 30), epoch: date(0), far: date(Date.UTC(2199, 0, 1)), neg1: date(-1) },
  { _id: { $oid: '000000000000000000000006' }, kind: 'misc', ts: { $timestamp: { t: 1700000000, i: 3 } }, min: { $minKey: 1 }, max: { $maxKey: 1 }, uuid: { $binary: { base64: 'EjRWeBI0EjQSNBI0EjQSNA==', subType: '04' } }, bin: { $binary: { base64: 'AQID', subType: '00' } }, re: { $regularExpression: { pattern: '^Kov', options: 'i' } }, nul: null, arr: [i32(1), dbl(2.5), 'három', null, { n: i32(4) }] },
  { _id: { $oid: '000000000000000000000007' }, kind: 'code', code: { $code: 'function(){ return 1 }' } },
  { _id: { $oid: '000000000000000000000008' }, kind: 'mixed-int-double', v: i32(5) },
  { _id: { $oid: '00000000000000000000000a' }, kind: 'mixed-int-double', v: dbl(5.5) },
  { _id: { $oid: '00000000000000000000000b' }, kind: 'unicode', s: 'Árvíztűrő tükörfúrógép 😀', 'kulcs.pont': 1 },
];
counts.legacy = write('legacy', legacy);

writeFileSync(join(out, 'manifest.json'), JSON.stringify({ seed: SEED, anchor: new Date(ANCHOR).toISOString(), counts, restaurantNames: REST }, null, 1));
console.log(JSON.stringify(counts));

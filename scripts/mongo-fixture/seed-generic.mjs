#!/usr/bin/env node
// Deterministic, generic, English SYNTHETIC `shop` dataset as canonical Extended JSON, one NDJSON file per collection:
// products, customers, orders. No real data, no network, no database access: it only writes files. matrix.sh loads them
// into throwaway containers. Same seed => byte-identical files.
//   node scripts/mongo-fixture/seed-generic.mjs --out <dir> [--orders 500] [--seed 1]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const out = arg('out');
if (!out) { console.error('usage: seed-generic.mjs --out <dir> [--orders N] [--seed N]'); process.exit(2); }
const N_ORDERS = Number(arg('orders', 500));
const SEED = Number(arg('seed', 1));
mkdirSync(out, { recursive: true });

let a = SEED >>> 0; // mulberry32
const rnd = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = (arr) => arr[int(0, arr.length - 1)];

const ANCHOR = Date.UTC(2026, 9, 3); // fixed so "last 7 days" style questions are reproducible
const DAY = 86400000;
let ctr = 0;
const oid = (kind, tsMs) => ({ $oid: (Math.floor(tsMs / 1000) >>> 0).toString(16).padStart(8, '0') + kind.toString(16).padStart(4, '0') + SEED.toString(16).padStart(6, '0') + (ctr++).toString(16).padStart(6, '0') });
const i32 = (n) => ({ $numberInt: String(n) });
const date = (ms) => ({ $date: { $numberLong: String(ms) } });

const FIRST = ['Alice', 'Bob', 'Carol', 'David', 'Emma', 'Frank', 'Grace', 'Henry', 'Irene', 'Jack', 'Kate', 'Liam', 'Maya', 'Noah', 'Olivia', 'Paul'];
const LAST = ['Smith', 'Jones', 'Brown', 'Taylor', 'Wilson', 'Davies', 'Evans', 'Thomas', 'Roberts', 'Walker'];
const CITIES = ['London', 'Leeds', 'Bristol', 'Dublin', 'Cork', 'Berlin', 'Lyon', 'Porto'];
const PRODUCTS = [['Notebook', 'stationery', 450], ['Pen set', 'stationery', 790], ['Desk lamp', 'home', 2490], ['Mug', 'home', 650], ['Backpack', 'bags', 4990], ['Water bottle', 'outdoor', 1290], ['Headphones', 'electronics', 5990], ['USB cable', 'electronics', 590], ['Plant pot', 'home', 1190], ['Tote bag', 'bags', 990]];
const STATUSES = ['new', 'paid', 'shipped', 'delivered', 'cancelled'];

const write = (name, rows) => { writeFileSync(join(out, `${name}.ndjson`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n'); return rows.length; };

const products = PRODUCTS.map(([name, category, price], i) => ({ _id: oid(1, ANCHOR - 400 * DAY), sku: `SKU-${1000 + i}`, name, category, price: i32(price), stock: i32(int(0, 200)), active: i === 9 ? false : true }));
const customers = Array.from({ length: 40 }, (_, i) => {
  const first = pick(FIRST), last = pick(LAST);
  return { _id: oid(2, ANCHOR - int(30, 300) * DAY), name: `${first} ${last}`, email: `${first}.${last}${i}@example.test`.toLowerCase(), city: pick(CITIES), createdAt: date(ANCHOR - int(30, 300) * DAY) };
});
const orders = Array.from({ length: N_ORDERS }, () => {
  const ts = ANCHOR - int(0, 120) * DAY - int(0, DAY - 1);
  const lines = Array.from({ length: int(1, 4) }, () => { const p = pick(products); return { sku: p.sku, qty: i32(int(1, 3)), price: p.price }; });
  const total = lines.reduce((s, l) => s + Number(l.price.$numberInt) * Number(l.qty.$numberInt), 0);
  return { _id: oid(3, ts), customerId: pick(customers)._id, status: pick(STATUSES), lines, total: i32(total), createdAt: date(ts) };
});
const n = { products: write('products', products), customers: write('customers', customers), orders: write('orders', orders) };
console.error(`seed-generic: ${JSON.stringify(n)} -> ${out}`);

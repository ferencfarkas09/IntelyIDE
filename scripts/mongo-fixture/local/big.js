// mongosh script (run by local.sh): a few hundred thousand synthetic documents for the windowed-cursor, cancel and cost-warning
// proofs. Deterministic (no Math.random), no real data. env: MLP_BIG (document count, default 300000).
const N = Number(process.env.MLP_BIG || 300000);
const big = db.getSiblingDB('intely_test_big');
const KINDS = ['click', 'view', 'buy', 'refund', 'login', 'logout', 'error', 'sync'];
const PAD = 'lorem ipsum dolor sit amet '.repeat(6);
let batch = [];
for (let i = 0; i < N; i++) {
  batch.push({ n: i, bucket: i % 1000, kind: KINDS[i % 8], ts: new Date(Date.UTC(2026, 0, 1) + i * 60000), score: (i * 7919) % 10007, text: PAD + i });
  if (batch.length === 5000) { big.events.insertMany(batch, { ordered: false }); batch = []; }
}
if (batch.length) big.events.insertMany(batch, { ordered: false });
big.events.createIndex({ n: 1 });
big.events.createIndex({ kind: 1, ts: -1 });
// a tiny second collection so $lookup / $unionWith inside the database has a target
big.kinds.insertMany(KINDS.map((k, i) => ({ _id: k, weight: i + 1 })));
print(`loaded intely_test_big.events: ${big.events.countDocuments({})}`);

#!/usr/bin/env node
// Free stand-in for claude-complete.mjs (INTELY_MONGO_AI_SCRIPT): the same stdin/stdout protocol, NO model call. For debugging the
// e2e scenario x and the UI around the AI bar without spending the real-call budget. It always answers a find on `orders`:
// a question that names "Pizza" gets a clarification (INTELY_STUB_PIZZA=bad: an invalid query the validator refuses on every repair,
// so the answer ends as a failure), anything else gets the 10 newest orders. Counts calls like the real script.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
try {
  const p = JSON.parse(readFileSync(0, 'utf8'));
  const used = existsSync(p.counter) ? Number(readFileSync(p.counter, 'utf8')) : 0;
  if (used >= p.cap) { out({ error: `call cap ${p.cap} reached` }); process.exit(0); }
  writeFileSync(p.counter, String(used + 1));
  const q = String(p.user ?? '');
  const structured = /pizza/i.test(q) && process.env.INTELY_STUB_PIZZA === 'bad'
    ? { mode: 'find', collection: 'orders', filter: '{"$where": "1"}', explanation: 'stub: invalid on purpose' }
    : /pizza/i.test(q)
    ? { mode: 'find', collection: 'orders', filter: '{}', explanation: 'stub', needsClarification: 'Which restaurant do you mean? The data only knows restaurant ids.' }
    : { mode: 'find', collection: 'orders', filter: '{}', sort: '{"createdAt": -1}', limit: 10, explanation: 'A 10 legutobbi rendeles (stub).', confidence: 'high' };
  out({ structured, ms: 5, costUsd: 0, usage: null, turns: 1, tools: [] });
} catch (e) {
  out({ error: String(e).slice(0, 300) });
}
process.exit(0);

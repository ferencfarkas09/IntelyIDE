// A sidecar for the delegation tests: records every session/start body and, on session/prompt (text = JSON
// {out, asks:[{toolId, intent}], events:[...]}), asks the host's policy about all `asks` AT ONCE (parallel Agent calls),
// optionally emits events, and writes {starts, replies} to `out`.
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

const send = (id, type, body) => process.stdout.write(`${JSON.stringify({ v: 1, id, type, body })}\n`);
const pending = new Map();
let nextId = 1000;
const ask = (type, body, timeoutMs = 5000) =>
  new Promise((resolve) => {
    const id = nextId++;
    const t = setTimeout(() => { pending.delete(id); resolve({ timeout: true }); }, timeoutMs);
    pending.set(id, (b) => { clearTimeout(t); resolve(b); });
    send(id, type, body);
  });

send(1, 'hello', { pid: process.pid, version: 'fake', node: process.version, providers: ['mock', 'claude'] });
setInterval(() => send(2, 'heartbeat', { pid: process.pid, loaded: [], sessions: 1 }), 2000).unref();

const starts = [];
const rl = createInterface({ input: process.stdin });
let agentId = '';
let seq = 1;
rl.on('line', async (line) => {
  const m = JSON.parse(line);
  if (m.type === 'reply') { pending.get(m.id)?.(m.body); pending.delete(m.id); return; }
  if (m.type === 'session/start') { agentId = m.body.agentId; seq = m.body.nextSeq ?? 1; starts.push(m.body); send(m.id, 'reply', { ok: true, nativeId: `fake-native-${starts.length}` }); return; }
  if (m.type === 'session/prompt') {
    send(m.id, 'reply', { ok: true });
    const job = JSON.parse(m.body.text);
    const replies = {};
    await Promise.all((job.asks ?? []).map(async (a) => { replies[a.toolId] = await ask('policy/decide', { agentId, toolId: a.toolId, provider: 'claude', intent: a.intent }); }));
    if (job.events?.length) {
      const events = job.events.map((e) => ({ seq: seq++, ts: Date.now(), ...e }));
      send(nextId++, 'events/batch', { agentId, provider: 'claude', events });
    }
    writeFileSync(job.out, JSON.stringify({ starts, replies }));
    return;
  }
  send(m.id, 'reply', { ok: true });
});
rl.on('close', () => process.exit(0));

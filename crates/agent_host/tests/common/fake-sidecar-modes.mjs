// A sidecar for the permission-mode tests (permission-modes spec 8.2, H-1..H-6): it takes a slot like the real one, records every
// message the host sends it (`session/start`, `session/permission`, `permission/answer`, ...) in `<dir>/fake-log.jsonl`
// (<dir> = the parent of the session's cwd, i.e. the test's temp directory), and reads how to behave from `<dir>/fake-control.json`:
//   { "permissionReply": "ok" | "error" | "drop",   // session/permission: accept, refuse, or never answer (the host times out after 5 s)
//     "answerReply":     "ok" | "drop",             // permission/answer: take it (and resolve the card), or never answer
//     "startError":      "<text>" }                // session/start: refuse with this detail
// A `session/prompt` whose text is JSON {asks:[{toolId,intent}], events:[...]} asks the host's policy about every `asks` entry (the replies
// are logged as {type:"replies"}) and emits `events` as one events/batch (seq continues from the session's next_seq).
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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

let dir = null;
let started = 0;
const sessions = new Map(); // agentId -> { provider, seq, lease }
const control = () => {
  try { return JSON.parse(readFileSync(join(dir, 'fake-control.json'), 'utf8')); } catch { return {}; }
};
const log = (o) => { if (dir) appendFileSync(join(dir, 'fake-log.jsonl'), `${JSON.stringify(o)}\n`); };
const emit = (agentId, events) => {
  const s = sessions.get(agentId);
  if (!s) return;
  const batch = events.map((e) => ({ seq: s.seq++, ts: Date.now(), ...e }));
  send(nextId++, 'events/batch', { agentId, provider: s.provider, events: batch });
};

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const m = JSON.parse(line);
  if (m.type === 'reply') { pending.get(m.id)?.(m.body); pending.delete(m.id); return; }
  if (m.type === 'session/start') {
    const { agentId, provider } = m.body;
    dir = dirname(m.body.cwd);
    log({ type: 'session/start', body: m.body });
    if (control().startError) { send(m.id, 'reply', { error: 'open', detail: String(control().startError) }); return; }
    const lease = await ask('slot/acquire', { agentId, provider, writer: m.body.writer === true, repoId: m.body.repoId });
    if (lease.error) { send(m.id, 'reply', { error: lease.error, detail: lease.detail }); return; }
    sessions.set(agentId, { provider, seq: m.body.nextSeq ?? 1, lease: lease.leaseId });
    started += 1;
    send(m.id, 'reply', { ok: true, nativeId: `fake-native-${started}` });
    emit(agentId, [{ kind: 'session.started', nativeId: `fake-native-${started}`, model: 'fake-1', effective: { permission: m.body.role.permission } }]);
    return;
  }
  if (m.type === 'session/close') {
    const closing = sessions.get(m.body.agentId);
    if (closing) { send(nextId++, 'slot/release', { leaseId: closing.lease }); sessions.delete(m.body.agentId); }
    send(m.id, 'reply', { ok: true });
    return;
  }
  if (m.type === 'session/permission') {
    log({ type: 'session/permission', body: m.body });
    const how = control().permissionReply ?? 'ok';
    if (how === 'drop') return;
    if (how === 'error') { send(m.id, 'reply', { error: 'rejected', detail: 'the fake agent refused the mode' }); return; }
    send(m.id, 'reply', { ok: true });
    emit(m.body.agentId, [{ kind: 'session.info', effective: { permission: m.body.mode, reason: 'user' } }]);
    return;
  }
  if (m.type === 'permission/answer') {
    log({ type: 'permission/answer', body: m.body });
    if ((control().answerReply ?? 'ok') === 'drop') return;
    send(m.id, 'reply', { ok: true });
    if (m.body.outcome === 'allow' && m.body.mode) emit(m.body.agentId, [{ kind: 'session.info', effective: { permission: m.body.mode, reason: 'planApproved' } }]);
    emit(m.body.agentId, [{ kind: 'permission.resolved', reqId: m.body.reqId, outcome: m.body.outcome === 'allow' ? 'allow' : 'deny', by: 'user' }]);
    return;
  }
  if (m.type === 'session/prompt') {
    send(m.id, 'reply', { ok: true });
    let job = {};
    try { job = JSON.parse(m.body.text); } catch { /* a plain prompt */ }
    log({ type: 'session/prompt', body: m.body });
    const replies = {};
    const agentId = m.body.agentId;
    await Promise.all((job.asks ?? []).map(async (a) => { replies[a.toolId] = await ask('policy/decide', { agentId, toolId: a.toolId, provider: 'claude', intent: a.intent }); }));
    if (job.asks?.length) log({ type: 'replies', replies });
    if (job.events?.length) emit(agentId, job.events);
    return;
  }
  send(m.id, 'reply', { ok: true });
});
rl.on('close', () => process.exit(0));

// A sidecar that only exercises the host's protocol handling: it says hello, accepts session/start and, on
// session/prompt (text = path of an output file), fires policy/decide requests and an unknown message type and writes the
// replies it got to that file. Used by tests/protocol.rs.
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

const send = (id, type, body) => process.stdout.write(`${JSON.stringify({ v: 1, id, type, body })}\n`);
const pending = new Map();
let nextId = 1000;
const ask = (type, body, timeoutMs = 3000) =>
  new Promise((resolve) => {
    const id = nextId++;
    const t = setTimeout(() => { pending.delete(id); resolve({ timeout: true }); }, timeoutMs);
    pending.set(id, (b) => { clearTimeout(t); resolve(b); });
    send(id, type, body);
  });

send(1, 'hello', { pid: process.pid, version: 'fake', node: process.version, providers: ['mock'] });
setInterval(() => send(2, 'heartbeat', { pid: process.pid, loaded: [], sessions: 1 }), 2000).unref();

const rl = createInterface({ input: process.stdin });
let agentId = '';
rl.on('line', async (line) => {
  const m = JSON.parse(line);
  if (m.type === 'reply') { pending.get(m.id)?.(m.body); pending.delete(m.id); return; }
  if (m.type === 'session/start') { agentId = m.body.agentId; send(m.id, 'reply', { ok: true, nativeId: 'fake-native' }); return; }
  if (m.type === 'session/prompt') {
    send(m.id, 'reply', { ok: true });
    const out = m.body.text;
    const intent = (o) => ({ class: 'exec', tool: 'Bash', paths: [], summary: 's', ...o });
    const replies = {
      hardStop: await ask('policy/decide', { agentId, toolId: 't1', provider: 'claude', intent: intent({ rawCommand: 'git push origin HEAD' }) }),
      absoluteGit: await ask('policy/decide', { agentId, toolId: 't2', provider: 'claude', intent: intent({ rawCommand: '/usr/bin/git commit -m x' }) }),
      unknownAgent: await ask('policy/decide', { agentId: 'nobody', toolId: 't3', provider: 'claude', intent: intent({ rawCommand: 'ls' }) }),
      garbage: await ask('policy/decide', { nonsense: true }),
      forbiddenType: await ask('fs/read', { path: '/etc/passwd' }),
      secondHardStop: await ask('policy/decide', { agentId, toolId: 't4', provider: 'claude', intent: intent({ rawCommand: 'sh -c "git commit -m y"' }) }),
    };
    writeFileSync(out, JSON.stringify(replies));
    return;
  }
  send(m.id, 'reply', { ok: true });
});
rl.on('close', () => process.exit(0));

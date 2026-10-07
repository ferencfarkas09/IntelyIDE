#!/usr/bin/env node
// Scripted fake ACP agent (providers-plan 5.7): line-delimited JSON-RPC 2.0 over stdio, no SDK, behaviour from a JSONL script.
//   node sidecar/tests/fakes/fake-acp-agent.mjs <script.jsonl>
// Env: FAKE_ACP_LOG=<file>  every message received, every message sent and the outcomes of `request` steps, one JSON per line.
//
// Built-in defaults (a script overrides any of them with an `on` line): initialize, session/new, session/load, session/resume,
// session/set_config_option, session/set_mode, session/prompt (streams "ok", ends the turn with end_turn) and session/cancel
// (aborts the running chain and answers the pending prompt with stopReason "cancelled").
//
// Script format, one JSON object per line (`//` lines are comments, a step may span lines, `dt` = ms to wait first):
//   {"op":"on","method":"session/prompt","reply":{...}}       answer a request with a result ("error":{code,message} for an error)
//   {"op":"on","method":"session/prompt","then":[steps]}      run steps when the message arrives (a request stays PENDING until a
//                                                             `respond` step answers it, or until `reply` was given)
//   {"op":"on","method":"session/cancel","ignore":true}       swallow the message (a cancel that is never honoured)
// Steps (inside `then`, or at the top level of the file where they run at startup):
//   {"op":"update","update":{"sessionUpdate":"agent_message_chunk",...}}   session/update notification for the current session
//   {"op":"send","msg":{...}}                                  write one JSON line (any notification or request)
//   {"op":"request","name":"perm","method":"session/request_permission","params":{...}}   client-bound request; the reply is
//                                                              kept under "name" for later ${perm.result.outcome.optionId} templates
//   {"op":"respond","result":{...}} | {"op":"respond","error":{...}} [,"to":"prompt"]   answer the triggering request (or the pending prompt)
//   {"op":"raw","line":"not json"}                             a line written verbatim (protocol garbage)
//   {"op":"spawn","cmd":"sleep","args":["600"],"detached":true}  grandchild; its pid goes to the log as {"fake":"grandchild","pid":N}
//   {"op":"ignore_sigterm"}                                  survive SIGTERM (only SIGKILL ends the process)
//   {"op":"wait","ms":50}  {"op":"hang"}  {"op":"crash","code":3}  {"op":"exit"}
// Templates: any string "${a.b.c}" in a step is replaced from the saved replies (${name.result...}) or from the triggering
// request (${req.params...}); a string that is exactly one placeholder keeps the value's type.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';

const LOG = process.env.FAKE_ACP_LOG;
const log = (dir, m) => { if (LOG) try { fs.appendFileSync(LOG, `${JSON.stringify({ dir, m })}\n`); } catch { /* ignore */ } };

function parseScript(text) {
  const steps = [];
  let buf = '';
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!buf && (!l || l.startsWith('//'))) continue;
    buf += l;
    try { steps.push(JSON.parse(buf)); buf = ''; } catch { /* the step continues on the next line */ }
  }
  if (buf) throw new Error(`fake-acp-agent: unterminated step: ${buf.slice(0, 60)}`);
  return steps;
}

const MODEL_OPT = { id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: 'fast-1', options: [{ value: 'fast-1', name: 'Fast 1' }, { value: 'pro-2', name: 'Pro 2' }] };
const THOUGHT_OPT = { id: 'thinking', name: 'Thinking', type: 'select', category: 'thought_level', currentValue: 'medium', options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] };
const MODE_OPT = { id: 'mode', name: 'Mode', type: 'select', category: 'mode', currentValue: 'default', options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }, { value: 'yolo', name: 'Yolo' }] };
let configOptions = [MODEL_OPT, THOUGHT_OPT, MODE_OPT];
let sessionId = 's1';

const DEFAULTS = {
  initialize: { reply: () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true }, sessionCapabilities: { resume: {} } }, authMethods: [], agentInfo: { name: 'fake-acp-agent', version: '0.0.1' } }) },
  'session/new': { reply: () => ({ sessionId, configOptions }) },
  'session/load': { reply: () => ({ configOptions }) },
  'session/resume': { reply: () => ({ configOptions }) },
  'session/set_config_option': { reply: (p) => { configOptions = configOptions.map((o) => (o.id === p.configId ? { ...o, currentValue: p.value } : o)); return { configOptions }; } },
  'session/set_mode': { reply: () => ({}) },
  'session/prompt': { then: [{ op: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } }, { op: 'respond', result: { stopReason: 'end_turn' } }] },
  'session/cancel': { builtinCancel: true },
};

const handlers = new Map();
const vars = {};
const waiting = new Map(); // outgoing request id -> resolver
let pendingPrompt = null; // id of the session/prompt request that has not been answered yet
const chains = new Set();
let nextId = 9000;

const write = (o) => { const line = typeof o === 'string' ? o : JSON.stringify(o); log('out', o); process.stdout.write(`${line}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lookup = (path) => path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), vars);
function fill(v) {
  if (typeof v === 'string') {
    const m = /^\$\{([^}]+)\}$/.exec(v);
    if (m) return lookup(m[1]);
    return v.replace(/\$\{([^}]+)\}/g, (_, p) => { const x = lookup(p); return x === undefined ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x); });
  }
  if (Array.isArray(v)) return v.map(fill);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
  return v;
}

async function run(steps, req) {
  const chain = { aborted: false, wake: null };
  chains.add(chain);
  try {
    for (const raw of steps) {
      if (chain.aborted) return;
      if (raw.dt) await sleep(raw.dt);
      if (chain.aborted) return;
      const s = raw.op === 'on' ? raw : fill(raw);
      switch (s.op) {
        case 'on': handlers.set(s.method, s); break;
        case 'update': write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: s.update } }); break;
        case 'send': write(s.msg); break;
        case 'raw': write(s.line); break;
        case 'wait': await sleep(s.ms); break;
        case 'request': {
          const id = ++nextId;
          const p = new Promise((res) => { waiting.set(id, { res, name: s.name }); chain.wake = () => res(null); });
          write({ jsonrpc: '2.0', id, method: s.method, params: { sessionId, ...s.params } });
          await p;
          chain.wake = null;
          break;
        }
        case 'respond': {
          const id = s.to === 'prompt' ? pendingPrompt : (req?.id ?? pendingPrompt);
          if (id == null) break;
          if (id === pendingPrompt) pendingPrompt = null;
          write({ jsonrpc: '2.0', id, ...(s.error ? { error: s.error } : { result: s.result ?? {} }) });
          break;
        }
        case 'spawn': {
          const c = spawn(s.cmd, s.args ?? [], { detached: s.detached !== false, stdio: 'ignore' });
          c.unref();
          log('fake', { fake: 'grandchild', pid: c.pid });
          break;
        }
        case 'ignore_sigterm': process.on('SIGTERM', () => {}); break;
        case 'hang': await new Promise(() => {}); break;
        case 'crash': process.exit(s.code ?? 1); break;
        case 'exit': process.exit(0); break;
        default: throw new Error(`fake-acp-agent: unknown op ${s.op}`);
      }
    }
  } finally {
    chains.delete(chain);
  }
}

function onLine(line) {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  log('in', m);
  if (m.id !== undefined && !m.method && waiting.has(m.id)) {
    // recorded even when a cancel already moved the chain on: the log shows what the client answered
    const w = waiting.get(m.id);
    waiting.delete(m.id);
    vars[w.name] = m;
    log('reply', { name: w.name, reply: m });
    w.res(m);
    return;
  }
  if (!m.method) return;
  if (m.params?.sessionId && m.method === 'session/load') sessionId = m.params.sessionId;
  vars.req = m;
  if (m.method === 'session/new' || m.method === 'session/load') vars.cwd = m.params?.cwd; // templates: ${cwd}/file
  const h = handlers.get(m.method) ?? DEFAULTS[m.method];
  if (!h || h.ignore) {
    if (m.id !== undefined && !h) write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
    return;
  }
  if (h.builtinCancel) {
    for (const c of chains) { c.aborted = true; c.wake?.(); }
    if (pendingPrompt != null) { const id = pendingPrompt; pendingPrompt = null; write({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } }); }
    return;
  }
  if (m.method === 'session/prompt') pendingPrompt = m.id;
  const reply = h.reply !== undefined ? (typeof h.reply === 'function' ? h.reply(m.params) : fill(h.reply)) : undefined;
  if (m.id !== undefined && (reply !== undefined || h.error)) {
    write({ jsonrpc: '2.0', id: m.id, ...(h.error ? { error: h.error } : { result: reply }) });
    if (m.id === pendingPrompt) pendingPrompt = null;
  }
  if (h.then) run(h.then, m).catch((e) => { process.stderr.write(`${e.message}\n`); process.exit(2); });
}

const script = parseScript(fs.readFileSync(process.argv[2], 'utf8'));
// Top-level `on` lines register handlers; every other op runs at startup, in order, after the handlers are in place.
for (const s of script) if (s.op === 'on') handlers.set(s.method, s);
readline.createInterface({ input: process.stdin }).on('line', onLine);
const startup = script.filter((s) => s.op !== 'on');
if (startup.length) run(startup).catch((e) => { process.stderr.write(`${e.message}\n`); process.exit(2); });

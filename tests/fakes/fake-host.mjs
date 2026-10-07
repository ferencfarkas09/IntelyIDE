// Fake Rust host: spawns the sidecar (node sidecar/dist/index.js), speaks the NDJSON protocol of providers-plan 5.5 and
// records everything. Used by sidecar tests, scripts/enforcement-suite.mjs and later by the fake ACP/Codex harness.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SIDECAR = path.resolve(HERE, '..', '..', 'sidecar', 'dist', 'index.js');

/** Policy reply behaviours: a function (body) => reply body, or one of the strings 'silent' | 'garbage' | 'malformed'. */
export class FakeHost extends EventEmitter {
  constructor({ providers = ['mock'], policy = () => ({ decision: 'allow', by: 'saved' }), slot, sidecar = SIDECAR, env = {}, args = [] } = {}) {
    super();
    this.opts = { providers, sidecar, env, args };
    this.policy = policy;
    this.slot = slot ?? (() => ({ leaseId: 'L1', ttlMs: 15000, treeBudgetMb: 650 }));
    this.nextId = 1000;
    this.waiters = new Map();
    this.all = [];
    this.eventsByAgent = new Map();
    this.heartbeats = [];
    this.policyCalls = [];
    this.slotCalls = [];
    this.cancelDone = [];
  }

  async start() {
    const { providers, sidecar, env, args } = this.opts;
    this.child = spawn(process.execPath, [sidecar, `--providers=${providers.join(',')}`, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    this.stderr = '';
    this.child.stderr.on('data', (d) => { this.stderr += d; });
    this.exited = new Promise((r) => this.child.once('exit', (code, sig) => { this.exitInfo = { code, sig }; r(this.exitInfo); }));
    readline.createInterface({ input: this.child.stdout }).on('line', (l) => this.onLine(l));
    this.hello = await this.waitFor((m) => m.type === 'hello', 10000);
    return this;
  }

  write(obj) { this.child.stdin.write(`${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`); }

  onLine(line) {
    let m;
    try { m = JSON.parse(line); } catch { this.emit('garbage', line); return; }
    this.all.push(m);
    for (const [pred, w] of [...this.waiters]) if (pred(m)) { this.waiters.delete(pred); clearTimeout(w.t); w.resolve(m); }
    switch (m.type) {
      case 'heartbeat': this.heartbeats.push({ at: Date.now(), body: m.body }); break;
      case 'events/batch': {
        const list = this.eventsByAgent.get(m.body.agentId) ?? [];
        for (const e of m.body.events) list.push({ ...e, agentId: m.body.agentId, provider: m.body.provider });
        this.eventsByAgent.set(m.body.agentId, list);
        this.emit('events', m.body);
        break;
      }
      case 'policy/decide': this.onPolicy(m); break;
      case 'slot/acquire': case 'slot/renew': case 'slot/release': this.onSlot(m); break;
      case 'cancel/done': this.cancelDone.push(m.body); break;
      default:
    }
  }

  onPolicy(m) {
    this.policyCalls.push(m.body);
    const r = typeof this.policy === 'function' ? this.policy(m.body) : this.policy;
    Promise.resolve(r).then((out) => {
      if (out === 'silent') return;
      if (out === 'garbage') { this.write('{{not json'); return; }
      if (out === 'malformed') { this.reply(m.id, { nonsense: true }); return; }
      this.reply(m.id, out);
    });
  }

  onSlot(m) {
    this.slotCalls.push({ type: m.type, body: m.body });
    if (m.type === 'slot/acquire') this.reply(m.id, this.slot(m.body));
    else this.reply(m.id, { ok: true });
  }

  reply(id, body) { this.write({ v: 1, id, type: 'reply', body }); }

  waitFor(pred, timeoutMs = 10000) {
    const hit = this.all.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiters.delete(pred); reject(new Error(`timeout waiting for message (stderr: ${this.stderr.slice(-300)})`)); }, timeoutMs);
      this.waiters.set(pred, { resolve, t });
    });
  }

  /** Rust -> sidecar request, resolves with the reply body. */
  request(type, body, timeoutMs = 30000) {
    const id = this.nextId++;
    const p = this.waitFor((m) => m.type === 'reply' && m.id === id, timeoutMs).then((m) => m.body);
    this.write({ v: 1, id, type, body });
    return p;
  }

  startSession(body) { return this.request('session/start', body); }
  prompt(agentId, text) { return this.request('session/prompt', { agentId, text }); }
  answer(agentId, reqId, a) { return this.request('permission/answer', { agentId, reqId, ...a }); }
  cancel(agentId, softMs = 5000, termMs = 3000) { return this.request('cancel/request', { agentId, softMs, termMs }); }
  closeSession(agentId) { return this.request('session/close', { agentId }); }

  events(agentId) { return this.eventsByAgent.get(agentId) ?? []; }

  /** Resolves when `n` turn.end events exist for the agent; rejects with the event tail on timeout. */
  async waitTurnEnd(agentId, n = 1, timeoutMs = 60000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (this.events(agentId).filter((e) => e.kind === 'turn.end').length >= n) return this.events(agentId);
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timeout waiting for turn.end #${n}: ${JSON.stringify(this.events(agentId).slice(-5).map((e) => e.kind))} stderr=${this.stderr.slice(-300)}`);
  }

  async waitEvent(agentId, pred, timeoutMs = 30000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const hit = this.events(agentId).find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('timeout waiting for event');
  }

  /** Close stdin like a dying parent; returns the exit info. */
  async stop() {
    if (this.exitInfo) return this.exitInfo;
    this.child.stdin.end();
    const to = setTimeout(() => this.child.kill('SIGKILL'), 8000);
    const r = await this.exited;
    clearTimeout(to);
    return r;
  }

  kill(sig = 'SIGKILL') { this.child.kill(sig); }
}

export const MOCK_ROLE = { name: 'mock', model: 'mock-1', permission: 'edit' };

/** session/start body for the mock provider. */
export function mockStart(agentId, scenario = 'plain-reply', { mock, ...extra } = {}) {
  return { agentId, provider: 'mock', role: MOCK_ROLE, cwd: process.cwd(), env: {}, auth: { mode: 'subscription', key: null }, mock: { scenario, speed: 0, ...mock }, ...extra };
}

/** Removes the CLI's transcript directory of a throw-away fixture (only dirs whose name contains "isw-"; real projects are never touched). */
export function dropTranscripts(cwd) {
  const dir = path.join(os.homedir(), '.claude', 'projects', fs.realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
  if (path.basename(dir).includes('isw-')) fs.rmSync(dir, { recursive: true, force: true });
}

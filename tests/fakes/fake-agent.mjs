#!/usr/bin/env node
// Scripted fake agent for protocol tests (providers-plan 5.7). Line-delimited JSON-RPC over stdio, behaviour from a JSONL script:
//   node tests/fakes/fake-agent.mjs <script.jsonl>
// The same runtime will back the fake ACP agent (5b) and the fake Codex app-server (5c); only the scripts differ.
//
// Script format (one JSON object per line, `//` lines are comments, `dt` = ms to wait first):
//   {"op":"on","method":"initialize","reply":{...}}          answer an incoming request with a result  ("error":{...} for an error)
//   {"op":"on","method":"session/prompt","then":[steps]}     (a step may span lines) run steps when the request arrives (reply first when "reply" is set)
//   {"op":"on","method":"session/cancel","ignore":true}      swallow the message (a cancel that is never honoured)
//   {"op":"send","msg":{...}}                                 write one JSON line (notification or request)
//   {"op":"request","name":"perm","msg":{"id":"p1",...}}      send a request and remember the reply under "name"
//   {"op":"raw","line":"not json"}                            write a line verbatim (protocol garbage, unknown vendor methods)
//   {"op":"spawn","cmd":"sleep","args":["60"]}                start a detached grandchild; announces {"fake":"grandchild","pid":N}
//   {"op":"wait","ms":50}   {"op":"hang"}   {"op":"crash","code":3}   {"op":"exit"}
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';

// A step may span several lines: lines are joined until the buffer parses.
function parseScript(text) {
  const steps = [];
  let buf = '';
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!buf && (!l || l.startsWith('//'))) continue;
    buf += l;
    try { steps.push(JSON.parse(buf)); buf = ''; } catch { /* continue on the next line */ }
  }
  if (buf) throw new Error(`fake-agent: unterminated step: ${buf.slice(0, 60)}`);
  return steps;
}
const script = parseScript(fs.readFileSync(process.argv[2], 'utf8'));
const handlers = new Map();
const replies = new Map();
const write = (o) => process.stdout.write(`${typeof o === 'string' ? o : JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(steps) {
  for (const s of steps) {
    if (s.dt) await sleep(s.dt);
    switch (s.op) {
      case 'on': handlers.set(s.method, s); break;
      case 'send': write(s.msg); break;
      case 'raw': write(s.line); break;
      case 'wait': await sleep(s.ms); break;
      case 'request': {
        const p = new Promise((res) => replies.set(s.msg.id, res));
        write(s.msg);
        replies.set(s.name, await p);
        break;
      }
      case 'spawn': {
        const c = spawn(s.cmd, s.args ?? [], { detached: true, stdio: 'ignore' });
        c.unref();
        write({ fake: 'grandchild', pid: c.pid });
        break;
      }
      case 'hang': await new Promise(() => {}); break;
      case 'crash': process.exit(s.code ?? 1); break;
      case 'exit': process.exit(0); break;
      default: throw new Error(`fake-agent: unknown op ${s.op}`);
    }
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && !m.method && replies.has(m.id)) { replies.get(m.id)(m); return; }
  const h = handlers.get(m.method);
  if (!h || h.ignore) return;
  if (m.id !== undefined && (h.reply !== undefined || h.error)) write({ jsonrpc: '2.0', id: m.id, ...(h.error ? { error: h.error } : { result: h.reply }) });
  if (h.then) run(h.then).catch((e) => { process.stderr.write(`${e.message}\n`); process.exit(2); });
});

run(script).catch((e) => { process.stderr.write(`${e.message}\n`); process.exit(2); });

#!/usr/bin/env node
// Fake `codex` CLI for the Codex adapter (providers-plan 5.7): answers `--version`, `login status`, `features list` and speaks the
// app-server JSONL JSON-RPC (method names recorded from codex-cli 0.146.0, see (design notes: providers-plan) "Codex spike results").
// Fakes prove protocol handling, not vendor behaviour. An accepted approval REALLY runs the command in the thread's cwd, so the
// enforcement suites can assert on the git state of a fixture repo afterwards.
//
// Env: FAKE_CODEX_SCENARIO (name below), FAKE_CODEX_COMMAND (command of the approval scenarios), FAKE_CODEX_OFFER
// (`plain` | `session` | `session-only`: which decisions the approval offers), FAKE_CODEX_LOG (JSONL file with every line in/out).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const SCENARIO = process.env.FAKE_CODEX_SCENARIO ?? 'text';
const LOG = process.env.FAKE_CODEX_LOG;
const VERSION = process.env.FAKE_CODEX_VERSION ?? '0.146.0';

if (argv[0] === '--version') { console.log(`codex-cli ${VERSION}`); process.exit(0); }
if (argv[0] === 'login' && argv[1] === 'status') {
  if (SCENARIO === 'logged-out') { console.error('Not logged in'); process.exit(1); }
  console.log('Logged in using ChatGPT'); process.exit(0);
}
if (argv[0] === 'features' && argv[1] === 'list') {
  if (SCENARIO === 'features-fail') process.exit(2);
  for (const f of ['apps', 'browser_use', 'computer_use', 'plugins', 'hooks', 'multi_agent', 'memories', 'goals', 'shell_tool']) console.log(`${f.padEnd(36)} stable   true`);
  process.exit(0);
}
if (argv[0] !== 'app-server') { console.error(`fake codex: unsupported ${argv.join(' ')}`); process.exit(2); }
if (SCENARIO === 'unknown-feature') {
  // the real CLI aborts on an unknown --disable; the adapter must only name features listed by `features list`
  const dis = argv.flatMap((a, i) => (a === '--disable' ? [argv[i + 1]] : []));
  const known = new Set(['apps', 'browser_use', 'computer_use', 'plugins', 'hooks', 'multi_agent', 'memories', 'goals', 'shell_tool']);
  const bad = dis.find((f) => !known.has(f));
  if (bad) { console.error(`Error: Unknown feature flag: ${bad}`); process.exit(1); }
}
if (SCENARIO === 'spawn-hang') setInterval(() => undefined, 1000); // never answers initialize

const record = (dir, m) => { if (LOG) fs.appendFileSync(LOG, `${JSON.stringify({ dir, m })}\n`); };
const send = (o) => { record('out', o); process.stdout.write(`${JSON.stringify(o)}\n`); };
const notify = (method, params) => send({ method, params });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let serverId = 1000;
const waiting = new Map();
/** Server -> client request; resolves with the client's answer message. */
const ask = (method, params) => new Promise((resolve) => { const id = serverId++; waiting.set(id, resolve); send({ id, method, params }); });

const THREAD = 'th-1';
let cwd = process.cwd();
let turnNo = 0;
let curTurn = null;
let interrupted = false;
let profile = ':workspace';
let approvalPolicy = 'on-request';
const MODELS = [
  { id: 'fake-luna', model: 'fake-luna', displayName: 'Fake Luna', description: 'fast', hidden: false, isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: ['low', 'medium', 'high'].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })) },
  { id: 'fake-plain', model: 'fake-plain', displayName: 'Fake Plain', description: 'no effort', hidden: false, isDefault: false, defaultReasoningEffort: 'none', supportedReasoningEfforts: [] },
  { id: 'fake-hidden', model: 'fake-hidden', displayName: 'Hidden', description: 'x', hidden: true, isDefault: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: [] },
];

const turnObj = (status, extra = {}) => ({ id: curTurn, items: [], status, ...extra });
const sandboxOf = (p) => (p === ':read-only' ? { type: 'readOnly', networkAccess: false } : p === ':danger-full-access' ? { type: 'dangerFullAccess' } : { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false });

function threadResponse(params) {
  if (params.cwd) cwd = params.cwd;
  profile = params.permissions ?? ':workspace';
  approvalPolicy = params.approvalPolicy ?? 'on-request';
  if (SCENARIO === 'drift-start') return { model: params.model, approvalPolicy, sandbox: sandboxOf(profile) };
  if (SCENARIO === 'wrong-profile') return { model: params.model, approvalPolicy, sandbox: sandboxOf(':danger-full-access'), activePermissionProfile: { id: ':danger-full-access' }, thread: { id: THREAD } };
  if (SCENARIO === 'wrong-approval') return { model: params.model, approvalPolicy: 'never', sandbox: sandboxOf(profile), activePermissionProfile: { id: profile }, thread: { id: THREAD } };
  if (SCENARIO === 'network-on') return { model: params.model, approvalPolicy, sandbox: { ...sandboxOf(profile), networkAccess: true }, activePermissionProfile: { id: profile }, thread: { id: THREAD } };
  return { model: SCENARIO === 'rerouted-model' ? 'fake-luna' : (params.model ?? 'fake-luna'), approvalPolicy, sandbox: sandboxOf(profile), activePermissionProfile: { id: profile }, thread: { id: THREAD, status: { type: 'idle' } } };
}

function offeredDecisions() {
  switch (process.env.FAKE_CODEX_OFFER ?? 'plain') {
    case 'session': return { availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'], proposedExecpolicyAmendment: ['git', 'commit'] };
    case 'session-only': return { availableDecisions: ['acceptForSession', 'decline'], proposedExecpolicyAmendment: ['git', 'commit'] };
    default: return {};
  }
}

const usage = (n = 1) => notify('thread/tokenUsage/updated', { threadId: THREAD, turnId: curTurn, tokenUsage: { modelContextWindow: 200000, last: { inputTokens: 100 * n, cachedInputTokens: 40 * n, outputTokens: 10 * n, reasoningOutputTokens: 5 * n, totalTokens: 110 * n }, total: { inputTokens: 100 * turnNo, cachedInputTokens: 40 * turnNo, outputTokens: 10 * turnNo, reasoningOutputTokens: 5 * turnNo, totalTokens: 110 * turnNo } } });
const finish = (status = 'completed', extra = {}) => notify('turn/completed', { threadId: THREAD, turn: turnObj(status, extra) });
const item = (method, it, extra = {}) => notify(method, { threadId: THREAD, turnId: curTurn, item: it, ...(method === 'item/started' ? { startedAtMs: Date.now() } : { completedAtMs: Date.now() }), ...extra });
const message = async (id, text) => {
  item('item/started', { type: 'agentMessage', id, text: '' });
  for (const part of text.match(/.{1,8}/g) ?? []) { notify('item/agentMessage/delta', { threadId: THREAD, turnId: curTurn, itemId: id, delta: part }); await sleep(5); }
  item('item/completed', { type: 'agentMessage', id, text, phase: 'final_answer' });
};

/** Runs `cmd` for real, but only when the client accepted. */
function execIf(decision, cmd) {
  if (decision !== 'accept' && decision !== 'acceptForSession' && !decision?.acceptWithExecpolicyAmendment) return { ran: false };
  const r = spawnSync('/bin/sh', ['-c', cmd], { cwd, encoding: 'utf8', env: process.env });
  return { ran: true, code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

async function commandApproval(command, id = 'cmd-1') {
  const base = { type: 'commandExecution', id, command, cwd, commandActions: [{ type: 'unknown', command }], status: 'inProgress', source: 'agent' };
  item('item/started', base);
  const reply = await ask('item/commandExecution/requestApproval', { threadId: THREAD, turnId: curTurn, itemId: id, command, cwd, reason: 'needs approval', startedAtMs: Date.now(), ...offeredDecisions() });
  if (reply.error) { item('item/completed', { ...base, status: 'declined' }); return reply; }
  const decision = reply.result?.decision;
  const run = execIf(decision, command);
  item('item/completed', { ...base, status: run.ran ? 'completed' : 'declined', exitCode: run.ran ? run.code : null, aggregatedOutput: run.out ?? null, durationMs: 5 });
  return reply;
}

async function fileApproval(relPath, content, { grantRoot } = {}) {
  const id = 'file-1';
  const change = { path: relPath, kind: { type: 'add' }, diff: content };
  item('item/started', { type: 'fileChange', id, changes: [change], status: 'inProgress' });
  const reply = await ask('item/fileChange/requestApproval', { threadId: THREAD, turnId: curTurn, itemId: id, reason: 'write', startedAtMs: Date.now(), ...(grantRoot ? { grantRoot } : {}) });
  const decision = reply.result?.decision;
  const accepted = decision === 'accept' || decision === 'acceptForSession';
  if (accepted) { const full = relPath.startsWith('/') ? relPath : `${cwd}/${relPath}`; fs.mkdirSync(full.replace(/\/[^/]*$/, ''), { recursive: true }); fs.writeFileSync(full, content); }
  item('item/completed', { type: 'fileChange', id, changes: [change], status: accepted ? 'completed' : 'declined' });
  return reply;
}

async function runTurn() {
  const cmd = process.env.FAKE_CODEX_COMMAND ?? 'git commit --allow-empty -m x';
  notify('turn/started', { threadId: THREAD, turn: turnObj('inProgress') });
  switch (SCENARIO) {
    case 'text': await message('msg-1', 'Hello from the fake codex.'); break;
    case 'reasoning':
      item('item/started', { type: 'reasoning', id: 'rs-1', summary: [], content: [] });
      notify('item/reasoning/summaryTextDelta', { threadId: THREAD, turnId: curTurn, itemId: 'rs-1', summaryIndex: 0, delta: 'Thinking about ' });
      notify('item/reasoning/summaryTextDelta', { threadId: THREAD, turnId: curTurn, itemId: 'rs-1', summaryIndex: 0, delta: 'the task.' });
      item('item/completed', { type: 'reasoning', id: 'rs-1', summary: ['Thinking about the task.'], content: [] });
      await message('msg-1', 'Done.'); break;
    case 'tools': {
      const ls = { type: 'commandExecution', id: 'cmd-1', command: '/bin/zsh -lc ls', cwd, commandActions: [{ type: 'listFiles', command: 'ls', path: null }], status: 'inProgress', source: 'agent' };
      item('item/started', ls);
      notify('item/commandExecution/outputDelta', { threadId: THREAD, turnId: curTurn, itemId: 'cmd-1', delta: 'a.txt\n' });
      item('item/completed', { ...ls, status: 'completed', exitCode: 0, aggregatedOutput: 'a.txt\n', durationMs: 12 });
      const bad = { ...ls, id: 'cmd-2', command: '/bin/zsh -lc false', commandActions: [{ type: 'unknown', command: 'false' }] };
      item('item/started', bad);
      item('item/completed', { ...bad, status: 'completed', exitCode: 1, aggregatedOutput: '', durationMs: 3 });
      item('item/started', { type: 'mcpToolCall', id: 'mcp-1', server: 'srv', tool: 'look', arguments: { q: 'x' }, status: 'inProgress' });
      item('item/completed', { type: 'mcpToolCall', id: 'mcp-1', server: 'srv', tool: 'look', arguments: { q: 'x' }, status: 'completed', result: { content: [] } });
      const fc = { type: 'fileChange', id: 'file-9', changes: [{ path: 'new.txt', kind: { type: 'add' }, diff: 'hi\n' }], status: 'inProgress' };
      item('item/started', fc); item('item/completed', { ...fc, status: 'completed' });
      notify('turn/plan/updated', { threadId: THREAD, turnId: curTurn, plan: [{ step: 'look', status: 'completed' }, { step: 'edit', status: 'inProgress' }] });
      await message('msg-1', 'listed'); break;
    }
    case 'approve-command': await commandApproval(cmd); await message('msg-1', 'finished'); break;
    case 'approve-twice': await commandApproval(cmd, 'cmd-1'); await commandApproval(process.env.FAKE_CODEX_COMMAND2 ?? 'ls', 'cmd-2'); await message('msg-1', 'finished'); break;
    case 'approve-many': { const list = JSON.parse(process.env.FAKE_CODEX_COMMANDS ?? '[]'); for (let i = 0; i < list.length; i++) await commandApproval(list[i], `cmd-${i + 1}`); await message('msg-1', 'finished'); break; }
    case 'approve-file': await fileApproval(process.env.FAKE_CODEX_PATH ?? 'out.txt', 'content\n'); await message('msg-1', 'finished'); break;
    case 'grant-root': await fileApproval('out.txt', 'content\n', { grantRoot: cwd }); await message('msg-1', 'finished'); break;
    case 'approve-network': {
      const reply = await ask('item/commandExecution/requestApproval', { threadId: THREAD, turnId: curTurn, itemId: 'cmd-1', command: 'curl https://example.com', cwd, networkApprovalContext: { host: 'example.com', protocol: 'https' }, startedAtMs: Date.now() });
      void reply; await message('msg-1', 'finished'); break;
    }
    case 'extra-permissions': {
      await ask('item/commandExecution/requestApproval', { threadId: THREAD, turnId: curTurn, itemId: 'cmd-1', command: 'ls', cwd, additionalPermissions: { fileSystem: { write: ['/'] } }, startedAtMs: Date.now() });
      await ask('item/permissions/requestApproval', { threadId: THREAD, turnId: curTurn, itemId: 'perm-1', cwd, permissions: { network: { enabled: true } }, startedAtMs: Date.now() });
      await message('msg-1', 'finished'); break;
    }
    case 'legacy-exec': await ask('execCommandApproval', { callId: 'old-1', conversationId: THREAD, command: ['git', 'push', 'origin', 'HEAD'], cwd, parsedCmd: [], reason: null }); await message('msg-1', 'finished'); break;
    case 'user-input': {
      await ask('item/tool/requestUserInput', { threadId: THREAD, turnId: curTurn, itemId: 'q-item', questions: [{ id: 'q1', header: 'H', question: 'Pick one', options: [{ label: 'red', description: '' }, { label: 'blue', description: '' }] }, { id: 'q2', header: 'S', question: 'Token?', isSecret: true }] });
      await message('msg-1', 'finished'); break;
    }
    case 'unknown-requests': {
      const a = await ask('weird/request', { x: 1 });
      const b = await ask('mcpServer/elicitation/request', { message: 'm', mode: 'form', requestedSchema: {} });
      const c = await ask('item/tool/call', { callId: 'c', tool: 't', arguments: {}, threadId: THREAD, turnId: curTurn });
      record('note', { unknownRequestAnswers: [a, b, c] });
      await message('msg-1', 'finished'); break;
    }
    case 'hang-until-interrupt': case 'interrupt-ignored': {
      await message('msg-1', 'working');
      item('item/started', { type: 'commandExecution', id: 'cmd-1', command: 'sleep 100', cwd, commandActions: [], status: 'inProgress', source: 'agent' });
      for (let i = 0; i < 400 && !(interrupted && SCENARIO === 'hang-until-interrupt'); i++) await sleep(25);
      if (SCENARIO === 'hang-until-interrupt') finish('interrupted');
      return;
    }
    case 'approval-then-interrupt': {
      const p = commandApproval(cmd);
      await p; return;
    }
    case 'crash': await message('msg-1', 'about to'); console.error('fatal: simulated crash token=sk-abcdefghijklmnop12345678'); process.exit(3); break;
    case 'drift': {
      notify('item/agentMessage/delta', { threadId: THREAD, turnId: curTurn, delta: 'no item id' });
      notify('item/agentMessage/delta', { threadId: THREAD, turnId: curTurn, delta: 'again, no item id' });
      notify('thread/tokenUsage/updated', { threadId: THREAD, tokenUsage: 'garbage' });
      notify('item/brandNew/event', { threadId: THREAD, whatever: true });
      process.stdout.write('this is not json\n');
      process.stdout.write('{"id": 5}\n');
      item('item/started', { type: 'futureItemKind', id: 'f-1' });
      await message('msg-1', 'survived drift'); break;
    }
    case 'error-turn':
      notify('error', { threadId: THREAD, turnId: curTurn, willRetry: false, error: { message: 'Could not validate your refresh token. token=sk-abcdefghijklmnop12345678', codexErrorInfo: 'unauthorized' } });
      finish('failed', { error: { message: 'unauthorized', codexErrorInfo: 'unauthorized' } }); return;
    case 'retry-then-ok':
      notify('error', { threadId: THREAD, turnId: curTurn, willRetry: true, error: { message: 'stream dropped', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } } });
      await message('msg-1', 'recovered'); break;
    case 'rate-limited':
      notify('account/rateLimits/updated', { rateLimits: { rateLimitReachedType: 'rate_limit_reached', primary: { usedPercent: 100, resetsAt: Math.floor(Date.now() / 1000) + 60 } } });
      await message('msg-1', 'limited'); break;
    case 'other-thread':
      notify('item/agentMessage/delta', { threadId: 'th-OTHER', turnId: 'x', itemId: 'm-other', delta: 'not ours' });
      await message('msg-1', 'ours'); break;
    default: await message('msg-1', 'unknown scenario');
  }
  usage();
  finish('completed');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  record('in', m);
  if (m.method && m.id !== undefined) return void handle(m);
  if (m.method) return; // initialized
  const w = waiting.get(m.id);
  if (w) { waiting.delete(m.id); w(m); }
});

function handle(m) {
  if (SCENARIO === 'spawn-hang') return; // never answers
  const reply = (result) => send({ id: m.id, result });
  const p = m.params ?? {};
  switch (m.method) {
    case 'initialize':
      record('note', { argv, envKeys: Object.keys(process.env), path: process.env.PATH });
      if (SCENARIO === 'old-version') return reply({ userAgent: 'fake/0.100.0 (Mac OS; x86_64)', codexHome: '/fake', platformFamily: 'unix', platformOs: 'macos' });
      return reply({ userAgent: `fake/${VERSION} (Mac OS; x86_64)`, codexHome: '/fake', platformFamily: 'unix', platformOs: 'macos' });
    case 'account/read':
      if (SCENARIO === 'logged-out') return reply({ account: null, requiresOpenaiAuth: true });
      if (SCENARIO === 'api-key-account') return reply({ account: { type: 'apiKey' }, requiresOpenaiAuth: true });
      return reply({ account: { type: 'chatgpt', email: null, planType: 'plus' }, requiresOpenaiAuth: true });
    case 'model/list': if (SCENARIO === 'models-fail') return send({ id: m.id, error: { code: -32603, message: 'boom' } }); return reply({ data: MODELS, nextCursor: null });
    case 'thread/start': case 'thread/resume': return reply(threadResponse(p));
    case 'turn/start': {
      turnNo++; curTurn = `turn-${turnNo}`; interrupted = false;
      record('note', { turnStart: p });
      reply({ turn: turnObj('inProgress') });
      void runTurn();
      return undefined;
    }
    case 'turn/interrupt':
      interrupted = true;
      if (SCENARIO === 'interrupt-ignored') return reply({});
      reply({});
      if (SCENARIO === 'approval-then-interrupt') setTimeout(() => finish('interrupted'), 50);
      return undefined;
    default: return send({ id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
  }
}

process.stdin.on('end', () => process.exit(0));

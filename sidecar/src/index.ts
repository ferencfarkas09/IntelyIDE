// Sidecar entry: NDJSON over stdio (providers-plan 5.5). Standalone: `node sidecar/dist/index.js [--providers=claude,mock]`.
// Exits on stdin EOF, on signals and when the parent disappears (orphan protection), after stopping every child.
import { createInterface } from 'node:readline';
import { HistoryService } from './history.js';
import { SidecarHost } from './host.js';
import { Loader } from './loader.js';
import { ProtocolClient } from './protocol.js';
import { registry } from './registry.js';

declare const SIDECAR_VERSION: string;
const VERSION = typeof SIDECAR_VERSION === 'string' ? SIDECAR_VERSION : 'dev';

const arg = process.argv.find((a) => a.startsWith('--providers='));
const enabled = (arg ? arg.slice('--providers='.length) : 'claude').split(',').map((s) => s.trim()).filter(Boolean);

const loader = new Loader(registry, enabled);
const proto = new ProtocolClient({
  write: (line) => { process.stdout.write(`${line}\n`); },
  heartbeatBody: () => ({ pid: process.pid, loaded: loader.loaded(), sessions: host.count }),
});
const host = new SidecarHost(proto, loader);
new HistoryService(proto);

let stopping = false;
async function stop(code: number): Promise<never> {
  if (!stopping) {
    stopping = true;
    await Promise.race([host.shutdown(), new Promise((r) => setTimeout(r, 4000))]);
    proto.close();
    await new Promise<void>((r) => process.stdout.write('', () => r()));
  }
  process.exit(code);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (l) => proto.receive(l));
rl.on('close', () => void stop(0));
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => void stop(0));
process.stdout.on('error', () => void stop(1));

const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent) { void stop(0); return; }
  try { process.kill(parent, 0); } catch { void stop(0); }
}, 2000).unref();

proto.start({ pid: process.pid, version: VERSION, node: process.version, providers: enabled });

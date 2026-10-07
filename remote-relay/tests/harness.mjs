// Local-only test harness: wrangler dev on loopback + fake Mac / fake phone clients. Never contacts Cloudflare.
import { spawn } from "node:child_process";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { newKeyPem, signBundle } from "../scripts/bundle-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const root = join(here, "..");

// Config guard (remote-plan 6.1): the harness refuses any relay host that is not loopback.
export function assertLoopback(host) {
  if (!(host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost")) && process.env.INTELY_REMOTE_STAGING !== "1") {
    throw new Error(`refusing non-loopback relay host: ${host}`);
  }
}

const sha = (s) => createHash("sha256").update(s).digest("hex");
export const token = () => randomBytes(24).toString("base64url"); // 32 chars
export const roomId = () => randomBytes(16).toString("base64url"); // 22 chars
export { sha };

export async function startRelay({ vars = {}, port = 20000 + Math.floor(Math.random() * 20000) } = {}) {
  assertLoopback("127.0.0.1");
  const tmp = mkdtempSync(join(tmpdir(), "intely-relay-"));
  const persist = join(tmp, "state");
  const dist = join(tmp, "pwa");
  cpSync(join(here, "fixtures/pwa"), dist, { recursive: true });
  const keyPem = newKeyPem();
  writeFileSync(join(dist, "bundle.json"), JSON.stringify(signBundle(dist, keyPem)));
  const args = ["dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", persist, "--assets", dist, "--inspector-port", "0"];
  for (const [k, v] of Object.entries({ JOIN_RATE_PER_MIN: "1000", ...vars })) args.push("--var", `${k}:${v}`);
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmp,
    XDG_CONFIG_HOME: join(tmp, "xdg"), WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(tmp, "logs"),
    CI: "1", NO_COLOR: "1", WRANGLER_HIDE_BANNER: "true",
  }; // no CLOUDFLARE_* variables: wrangler has no way to authenticate even by accident
  const child = spawn(join(root, "node_modules/.bin/wrangler"), args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    try { if ((await fetch(base + "/api/health")).ok) break; } catch {}
    if (child.exitCode !== null) throw new Error("wrangler exited early:\n" + log.slice(-2000));
    if (Date.now() - t0 > 240_000) { child.kill(); throw new Error("wrangler start timeout:\n" + log.slice(-2000)); }
    await new Promise((r) => setTimeout(r, 500));
  }
  return {
    base, ws: `ws://127.0.0.1:${port}`, persist, dist, tmp, log: () => log,
    async stop() {
      child.kill("SIGTERM");
      await new Promise((r) => { const t = setTimeout(() => { child.kill("SIGKILL"); r(); }, 5000); child.on("exit", () => { clearTimeout(t); r(); }); });
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** Raw bytes of every file under the DO persistence dir (sqlite + wal), for "the relay cannot read the payload" assertions. */
export function persistedFiles(dir) {
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d)) { const p = join(d, e); statSync(p).isDirectory() ? walk(p) : out.push(p); } };
  try { walk(dir); } catch {}
  return out;
}
export const persistedBytes = (dir) => persistedFiles(dir).map((p) => ({ p, b: readFileSync(p) }));

export class Client {
  constructor(url, protocols) {
    this.msgs = [];
    this.waiters = [];
    this.closed = null;
    this.ws = new WebSocket(url, protocols);
    this.ws.binaryType = "arraybuffer";
    this.pongs = 0;
    // The first auto ping/pong matters: workerd (local) completes a server-initiated close of a socket that never sent anything only at DO eviction (~10 s).
    this.opened = new Promise((res, rej) => { this.ws.onopen = () => { this.ws.send("ping"); res(this); }; this.ws.onerror = () => rej(new Error("ws error")); });
    this.ws.onmessage = (e) => e.data === "pong" ? this.pongs++ : this.push(typeof e.data === "string" ? { text: JSON.parse(e.data) } : { bin: new Uint8Array(e.data) });
    this.ws.onclose = (e) => { this.closed = { code: e.code }; this.waiters.splice(0).forEach((w) => w.tick()); };
  }
  push(m) { this.msgs.push(m); this.waiters.slice().forEach((w) => w.tick()); }
  /** Resolve with (and consume) the first message matching pred. */
  next(pred, ms = 8000) {
    return new Promise((res, rej) => {
      const w = {
        tick: () => {
          const i = this.msgs.findIndex(pred);
          if (i >= 0) { clearTimeout(timer); this.waiters = this.waiters.filter((x) => x !== w); res(this.msgs.splice(i, 1)[0]); }
          else if (this.closed) { clearTimeout(timer); this.waiters = this.waiters.filter((x) => x !== w); rej(new Error("closed " + this.closed.code)); }
        },
      };
      const timer = setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); rej(new Error("timeout; have " + JSON.stringify(this.msgs.map((m) => m.text ?? m.bin?.length)))); }, ms);
      this.waiters.push(w);
      w.tick();
    });
  }
  text(t, ms) { return this.next((m) => m.text?.t === t, ms).then((m) => m.text); }
  bin(ms) { return this.next((m) => m.bin, ms).then((m) => m.bin); }
  sendJson(o) { this.ws.send(JSON.stringify(o)); }
  sendBin(b) { this.ws.send(b); }
  closedWith(ms = 5000) { return new Promise((res, rej) => { const t0 = Date.now(); const i = setInterval(() => { if (this.closed) { clearInterval(i); res(this.closed.code); } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error("not closed")); } }, 25); }); }
  close() { try { this.ws.close(); } catch {} }
}

export async function openWs(relay, room, protocol) {
  const c = new Client(`${relay.ws}/r/${room}/ws`, ["intely.v1", protocol]);
  await c.opened;
  return c;
}
export const tryWs = (relay, room, protocol) =>
  new Promise((res) => {
    const c = new Client(`${relay.ws}/r/${room}/ws`, protocol ? ["intely.v1", protocol] : ["intely.v1"]);
    c.opened.then(() => res({ ok: true, c }), () => res({ ok: false }));
  });

export async function createRoom(relay, macToken = token(), room = roomId()) {
  const r = await fetch(`${relay.base}/r/${room}/create`, { method: "PUT", headers: { authorization: `Bearer ${macToken}` } });
  return { room, macToken, status: r.status };
}
export const stat = async (relay, room, macToken) => (await fetch(`${relay.base}/r/${room}/stat`, { headers: { authorization: `Bearer ${macToken}` } })).json();

/** Mac->relay frame: [1][idLen][id][body] */
export function macFrame(toId, body) {
  const id = Buffer.from(toId ?? "");
  return Buffer.concat([Buffer.from([1, id.length]), id, Buffer.from(body)]);
}
/** Parse relay->Mac frame. */
export function parseToMac(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const n = b[6];
  return { qid: dv.getUint32(2), from: Buffer.from(b.subarray(7, 7 + n)).toString(), body: b.subarray(7 + n) };
}

// A stand-in "Noise channel": AES-256-GCM with a key that never leaves the test. The relay only ever sees the output.
export async function sealer() {
  const key = await webcrypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  return {
    async seal(plain) {
      const iv = webcrypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, Buffer.from(plain)));
      return Buffer.concat([iv, ct]);
    },
    async open(buf) {
      const b = new Uint8Array(buf);
      return Buffer.from(await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: b.subarray(0, 12) }, key, b.subarray(12))).toString();
    },
  };
}

export async function enroll(relay, room, mac, id = "dev-" + randomBytes(4).toString("hex")) {
  const tok = token();
  mac.sendJson({ t: "dev.add", id, hash: sha(tok), op: id });
  await mac.next((m) => m.text?.t === "ok" && m.text.op === id);
  return { id, tok, protocol: `dev.${id}.${tok}` };
}

export function fakePushService(status = 201) {
  const calls = [];
  let current = status;
  const srv = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { calls.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) }); res.statusCode = current; res.end(); });
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok({ calls, port: srv.address().port, setStatus: (s) => (current = s), close: () => srv.close() })));
}
void mkdirSync; void httpRequest;

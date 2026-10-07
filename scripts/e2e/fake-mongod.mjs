// A tiny fake mongod for the e2e scenarios x2 and x3 (no Docker, no real server): loopback only, no auth, no TLS, read-only
// answers for the handful of commands the studio sends (hello/isMaster, ping, buildInfo, connectionStatus, listDatabases,
// listCollections, count, find). Anything else answers an error. It prints one JSON line {"ready":true,"port":N} and
// exits on SIGTERM. Usage: node fake-mongod.mjs [port]   (default: a random free port)
import net from "node:net";

// ---- BSON (just enough) -----------------------------------------------------------------------------------------------------------
const cstr = (s) => Buffer.concat([Buffer.from(s, "utf8"), Buffer.from([0])]);
function enc(value) {
  const parts = [];
  for (const [k, v] of Object.entries(value)) parts.push(el(k, v));
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(4);
  head.writeInt32LE(body.length + 5);
  return Buffer.concat([head, body, Buffer.from([0])]);
}
function el(k, v) {
  const key = cstr(k);
  if (v === null) return Buffer.concat([Buffer.from([0x0a]), key]);
  if (typeof v === "boolean") return Buffer.concat([Buffer.from([0x08]), key, Buffer.from([v ? 1 : 0])]);
  if (typeof v === "string") {
    const s = Buffer.from(v, "utf8");
    const l = Buffer.alloc(4);
    l.writeInt32LE(s.length + 1);
    return Buffer.concat([Buffer.from([0x02]), key, l, s, Buffer.from([0])]);
  }
  if (v instanceof Date) {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(BigInt(v.getTime()));
    return Buffer.concat([Buffer.from([0x09]), key, b]);
  }
  if (typeof v === "bigint") {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(v);
    return Buffer.concat([Buffer.from([0x12]), key, b]);
  }
  if (typeof v === "number") {
    const b = Buffer.alloc(Number.isInteger(v) ? 4 : 8);
    if (b.length === 4) b.writeInt32LE(v); else b.writeDoubleLE(v);
    return Buffer.concat([Buffer.from([b.length === 4 ? 0x10 : 0x01]), key, b]);
  }
  if (Array.isArray(v)) return Buffer.concat([Buffer.from([0x04]), key, enc(Object.fromEntries(v.map((x, i) => [String(i), x])))]);
  if (v && v.$double !== undefined) {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(v.$double);
    return Buffer.concat([Buffer.from([0x01]), key, b]);
  }
  return Buffer.concat([Buffer.from([0x03]), key, enc(v)]);
}
const dbl = (n) => ({ $double: n });

/** The name of the first key and, when it is a string, a few string/int fields of the command document. */
function firstKey(doc) {
  if (doc.length < 6) return "";
  const end = doc.indexOf(0, 5);
  return doc.toString("utf8", 5, end);
}

// ---- the data -----------------------------------------------------------------------------------------------------------------------
const ORDERS = [
  { _id: 1, status: "paid", total: 42 },
  { _id: 2, status: "open", total: 17 },
  { _id: 3, status: "paid", total: 99 },
];

function answer(cmd) {
  process.stderr.write(`${new Date().toISOString()} ${cmd}\n`); // one line per command: run.sh keeps it as evidence of what the app sent
  switch (cmd) {
    case "hello":
    case "isMaster":
    case "ismaster":
      return {
        ismaster: true, isWritablePrimary: true, helloOk: true, maxBsonObjectSize: 16777216, maxMessageSizeBytes: 48000000, maxWriteBatchSize: 100000,
        localTime: new Date(), logicalSessionTimeoutMinutes: 30, connectionId: 1, minWireVersion: 0, maxWireVersion: 21, readOnly: false, ok: dbl(1),
      };
    case "ping":
    case "endSessions":
    case "killCursors":
      return { ok: dbl(1) };
    case "buildInfo":
    case "buildinfo":
      return { version: "7.0.0", versionArray: [7, 0, 0, 0], ok: dbl(1) };
    case "connectionStatus":
      return { authInfo: { authenticatedUsers: [], authenticatedUserRoles: [], authenticatedUserPrivileges: [] }, ok: dbl(1) };
    case "listDatabases":
      return { databases: [{ name: "fakeshop", sizeOnDisk: dbl(8192), empty: false }], totalSize: dbl(8192), ok: dbl(1) };
    case "listCollections":
      return { cursor: { id: 0n, ns: "fakeshop.$cmd.listCollections", firstBatch: [{ name: "orders", type: "collection", options: {}, info: { readOnly: false } }] }, ok: dbl(1) };
    case "count":
      return { n: ORDERS.length, ok: dbl(1) };
    case "listIndexes":
      return { cursor: { id: 0n, ns: "fakeshop.orders", firstBatch: [{ v: 2, key: { _id: 1 }, name: "_id_" }] }, ok: dbl(1) };
    case "aggregate":
    case "getMore":
      return { cursor: { id: 0n, ns: "fakeshop.orders", [cmd === "getMore" ? "nextBatch" : "firstBatch"]: cmd === "getMore" ? [] : ORDERS }, ok: dbl(1) };
    case "distinct":
      return { values: ["paid", "open"], ok: dbl(1) };
    case "find":
      return { cursor: { id: 0n, ns: "fakeshop.orders", firstBatch: ORDERS }, ok: dbl(1) };
    default:
      return { ok: dbl(0), errmsg: `fake mongod: no such command: '${cmd}'`, code: 59, codeName: "CommandNotFound" };
  }
}

// ---- wire protocol ---------------------------------------------------------------------------------------------------------------
function header(len, respTo, op) {
  const h = Buffer.alloc(16);
  h.writeInt32LE(len, 0);
  h.writeInt32LE(1, 4);
  h.writeInt32LE(respTo, 8);
  h.writeInt32LE(op, 12);
  return h;
}
function handle(sock, msg) {
  const reqId = msg.readInt32LE(4);
  const op = msg.readInt32LE(12);
  if (op === 2004) { // OP_QUERY (the legacy handshake): flags, cstring ns, skip, return, doc
    let p = 20;
    p = msg.indexOf(0, p) + 1 + 8;
    const reply = enc(answer(firstKey(msg.subarray(p))));
    const body = Buffer.alloc(20);
    body.writeInt32LE(8, 0); // AwaitCapable
    body.writeInt32LE(1, 16); // numberReturned
    const all = Buffer.concat([body, reply]);
    sock.write(Buffer.concat([header(16 + all.length, reqId, 1), all]));
    return;
  }
  if (op === 2013) { // OP_MSG: flagBits, then sections; kind 0 = the command document
    let p = 20;
    let doc;
    while (p < msg.length) {
      const kind = msg[p++];
      if (kind === 0) { const l = msg.readInt32LE(p); doc = msg.subarray(p, p + l); break; }
      p += msg.readInt32LE(p);
    }
    const reply = enc(answer(doc ? firstKey(doc) : ""));
    const all = Buffer.concat([Buffer.alloc(4), Buffer.from([0]), reply]);
    sock.write(Buffer.concat([header(16 + all.length, reqId, 2013), all]));
    return;
  }
  sock.destroy();
}

const server = net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  sock.on("error", () => {});
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 16) {
      const len = buf.readInt32LE(0);
      if (len < 16 || len > 1 << 20) return sock.destroy();
      if (buf.length < len) break;
      const msg = buf.subarray(0, len);
      buf = buf.subarray(len);
      try { handle(sock, msg); } catch { sock.destroy(); }
    }
  });
});
const want = Number(process.argv[2] ?? 0);
server.listen(want, "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({ ready: true, port: server.address().port })}\n`);
});
process.on("SIGTERM", () => process.exit(0));

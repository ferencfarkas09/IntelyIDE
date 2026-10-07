// Minimal deterministic ustar writer/reader for the demo fixture cache (`--tar` / `--restore`).
// Deterministic = sorted entries, fixed mtime, uid/gid 0, root path replaced by a placeholder in git `config`
// and `FETCH_HEAD` files, and git index stat data zeroed (the index is otherwise the one file whose bytes differ between runs).
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DemoError } from "./errors.mjs";

const ROOT_MARK = "@@DEMO_ROOT@@";
export const TAR_TOP = ["repos", "remotes", "extra"];
/** Git files that embed the root path (insteadOf rewrite, fetch source). */
const PATHY = new Set(["config", "FETCH_HEAD"]);

/** Zero every stat field of a git index (v2/v3), drop extensions, recompute the checksum. Other versions: unchanged. */
export function normalizeIndex(buf) {
  if (buf.length < 32 || buf.toString("latin1", 0, 4) !== "DIRC") return buf;
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) return buf;
  const count = buf.readUInt32BE(8);
  const out = Buffer.from(buf);
  let pos = 12;
  for (let i = 0; i < count; i++) {
    const start = pos;
    out.fill(0, start, start + 24); // ctime, mtime, dev, ino
    out.fill(0, start + 28, start + 36); // uid, gid (mode at 24..28 and size at 36..40 stay)
    const flags = buf.readUInt16BE(start + 60); // sha1 at 40..60
    const extended = version >= 3 && (flags & 0x4000) !== 0;
    const nameStart = start + 62 + (extended ? 2 : 0);
    let nameEnd = nameStart + (flags & 0x0fff);
    if ((flags & 0x0fff) === 0x0fff) nameEnd = buf.indexOf(0, nameStart);
    pos = start + Math.ceil((nameEnd - start + 1) / 8) * 8;
  }
  const body = out.subarray(0, pos);
  return Buffer.concat([body, createHash("sha1").update(body).digest()]);
}

function pad(str, len) {
  const b = Buffer.alloc(len);
  b.write(str, 0, len, "utf8");
  return b;
}
const oct = (n, len) => pad(n.toString(8).padStart(len - 1, "0"), len);

function header(name, { size, mode, dir, mtime }) {
  let prefix = "";
  let nm = name;
  if (Buffer.byteLength(nm) > 100) {
    const cut = nm.lastIndexOf("/", 155);
    prefix = nm.slice(0, cut);
    nm = nm.slice(cut + 1);
    if (cut < 0 || Buffer.byteLength(nm) > 100 || Buffer.byteLength(prefix) > 155) throw new DemoError(`tar: path too long: ${name}`, 1);
  }
  const h = Buffer.alloc(512);
  pad(nm, 100).copy(h, 0);
  oct(mode, 8).copy(h, 100);
  oct(0, 8).copy(h, 108);
  oct(0, 8).copy(h, 116);
  oct(size, 12).copy(h, 124);
  oct(mtime, 12).copy(h, 136);
  h.fill(0x20, 148, 156);
  h[156] = dir ? 0x35 : 0x30;
  h.write("ustar\0", 257, "latin1");
  h.write("00", 263, "latin1");
  pad(prefix, 155).copy(h, 345);
  let sum = 0;
  for (const b of h) sum += b;
  oct(sum, 7).copy(h, 148);
  h[155] = 0x20;
  return h;
}

function listEntries(root, top) {
  const out = [];
  const rec = (rel) => {
    const abs = join(root, rel);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) throw new DemoError(`tar: refusing symlink ${rel}`, 1);
    if (st.isDirectory()) {
      out.push({ rel, dir: true, mode: st.mode & 0o7777 });
      for (const n of readdirSync(abs).sort()) rec(`${rel}/${n}`);
    } else if (st.isFile()) out.push({ rel, dir: false, mode: st.mode & 0o7777 });
  };
  for (const t of top) if (existsSync(join(root, t))) rec(t);
  return out;
}

/** Writes `file` with the contents of repos/, remotes/ and extra/ below `root`. */
export function packTree(root, file, mtime) {
  const parts = [];
  for (const e of listEntries(root, TAR_TOP)) {
    if (e.dir) {
      parts.push(header(`${e.rel}/`, { size: 0, mode: e.mode, dir: true, mtime }));
      continue;
    }
    let data = readFileSync(join(root, e.rel));
    const base = basename(e.rel);
    if (PATHY.has(base)) data = Buffer.from(data.toString("utf8").split(root).join(ROOT_MARK), "utf8");
    else if (base === "index") data = normalizeIndex(data);
    parts.push(header(e.rel, { size: data.length, mode: e.mode, dir: false, mtime }));
    parts.push(data);
    const rest = data.length % 512;
    if (rest) parts.push(Buffer.alloc(512 - rest));
  }
  parts.push(Buffer.alloc(1024));
  writeFileSync(file, Buffer.concat(parts));
}

const readStr = (b, from, len) => {
  const end = b.indexOf(0, from);
  return b.toString("utf8", from, end >= 0 && end < from + len ? end : from + len);
};

/** Unpacks a tar made by packTree into the (empty) `root`, rewriting the root placeholder. */
export function unpackTree(file, root) {
  const buf = readFileSync(file);
  const made = new Set();
  const mk = (dir, mode = 0o755) => {
    if (made.has(dir)) return;
    mkdirSync(dir, { recursive: true, mode });
    made.add(dir);
  };
  mk(root);
  let pos = 0;
  while (pos + 512 <= buf.length) {
    const h = buf.subarray(pos, pos + 512);
    if (h.every((b) => b === 0)) break;
    const name = (readStr(h, 345, 155) ? `${readStr(h, 345, 155)}/` : "") + readStr(h, 0, 100);
    const type = String.fromCharCode(h[156]);
    const size = parseInt(readStr(h, 124, 12).trim() || "0", 8);
    const mode = parseInt(readStr(h, 100, 8).trim() || "644", 8);
    pos += 512;
    const rel = name.replace(/\/$/, "");
    const segs = rel.split("/");
    if (!rel || rel.startsWith("/") || segs.some((s) => s === "" || s === "." || s === "..") || !TAR_TOP.includes(segs[0])) throw new DemoError(`tar: unsafe entry ${JSON.stringify(name)}`);
    const dest = join(root, rel);
    if (type === "5") {
      mk(dest, mode);
      chmodSync(dest, mode);
    } else if (type === "0" || type === "\0") {
      let data = buf.subarray(pos, pos + size);
      if (PATHY.has(basename(rel))) data = Buffer.from(data.toString("utf8").split(ROOT_MARK).join(root), "utf8");
      mk(dirname(dest));
      writeFileSync(dest, data, { mode });
      chmodSync(dest, mode);
      pos += Math.ceil(size / 512) * 512;
    } else throw new DemoError(`tar: unsupported entry type ${JSON.stringify(type)} for ${name}`);
  }
}

export function assertTarTarget(file) {
  if (!file) throw new DemoError("no tar file given");
  if (!existsSync(dirname(file)) || !statSync(dirname(file)).isDirectory()) throw new DemoError(`tar directory does not exist: ${dirname(file)}`);
}

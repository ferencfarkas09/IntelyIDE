// Streaming reader for .tar.gz headers (ustar, pax, GNU long names). Used to audit the updater
// tarball (no `._*`, no hard links, one top-level IntelyIDE.app, relative symlinks without `..`) and
// to sum its unpacked size. Reads the whole archive once, keeps only headers and the files asked for.
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";

function octal(buf) {
  if (buf[0] & 0x80) {
    let n = 0;
    for (let i = 1; i < buf.length; i++) n = n * 256 + buf[i];
    return n;
  }
  const t = buf.toString("latin1").replace(/\0.*$/s, "").trim();
  return t === "" ? 0 : parseInt(t, 8);
}

function cstr(buf) {
  const i = buf.indexOf(0);
  return buf.toString("utf8", 0, i < 0 ? buf.length : i);
}

function parsePax(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(buf.toString("latin1", i, sp), 10);
    if (!(len > 0)) break;
    const rec = buf.toString("utf8", sp + 1, i + len - 1);
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/**
 * Returns {entries, files}. entries: {name, type, size, linkname, mode}. type is one of
 * file, dir, symlink, hardlink, other. `capture` is a Set of exact names whose bytes (<= 1 MiB)
 * are returned in `files`.
 */
export async function readTarGz(path, { capture = new Set() } = {}) {
  const gz = createGunzip();
  createReadStream(path).on("error", (e) => gz.destroy(e)).pipe(gz);
  const entries = [];
  const files = {};
  let queue = [];
  let queued = 0;
  const take = async function* () {
    for await (const chunk of gz) yield chunk;
  };
  const it = take()[Symbol.asyncIterator]();
  let done = false;
  async function need(n) {
    while (queued < n && !done) {
      const { value, done: d } = await it.next();
      if (d) done = true;
      else {
        queue.push(value);
        queued += value.length;
      }
    }
    return queued >= n;
  }
  function pull(n) {
    const buf = queue.length === 1 ? queue[0] : Buffer.concat(queue);
    const head = buf.subarray(0, n);
    const rest = buf.subarray(n);
    queue = rest.length ? [rest] : [];
    queued = rest.length;
    return head;
  }
  async function skip(n) {
    let left = n;
    while (left > 0) {
      if (!(await need(1))) throw new Error("tar: truncated");
      const step = Math.min(left, queued);
      pull(step);
      left -= step;
    }
  }
  let pax = {};
  let gnuName = null;
  let gnuLink = null;
  for (;;) {
    if (!(await need(512))) break;
    const h = pull(512);
    if (h.every((b) => b === 0)) break;
    const size = octal(h.subarray(124, 136));
    const flag = String.fromCharCode(h[156] || 0x30);
    const padded = Math.ceil(size / 512) * 512;
    if (flag === "x" || flag === "g" || flag === "L" || flag === "K") {
      if (size > 1024 * 1024) throw new Error("tar: oversized extended header");
      if (!(await need(padded))) throw new Error("tar: truncated");
      const data = pull(padded).subarray(0, size);
      if (flag === "x") pax = { ...pax, ...parsePax(data) };
      else if (flag === "L") gnuName = cstr(data);
      else if (flag === "K") gnuLink = cstr(data);
      continue;
    }
    let name = cstr(h.subarray(0, 100));
    const magic = h.toString("latin1", 257, 262);
    if (magic === "ustar") {
      const prefix = cstr(h.subarray(345, 500));
      if (prefix) name = `${prefix}/${name}`;
    }
    name = pax.path ?? gnuName ?? name;
    const linkname = pax.linkpath ?? gnuLink ?? cstr(h.subarray(157, 257));
    const realSize = pax.size !== undefined ? Number(pax.size) : size;
    const type = { 0: "file", "\0": "file", 5: "dir", 2: "symlink", 1: "hardlink" }[flag] ?? "other";
    const entry = { name, type, size: type === "file" ? realSize : 0, linkname: type === "symlink" || type === "hardlink" ? linkname : "", mode: octal(h.subarray(100, 108)) };
    entries.push(entry);
    pax = {};
    gnuName = null;
    gnuLink = null;
    const dataLen = type === "file" || type === "other" ? realSize : 0;
    const dataPadded = Math.ceil(dataLen / 512) * 512;
    if (type === "file" && capture.has(name) && dataLen <= 1024 * 1024) {
      if (!(await need(dataPadded))) throw new Error("tar: truncated");
      files[name] = Buffer.from(pull(dataPadded).subarray(0, dataLen));
    } else {
      await skip(dataPadded);
    }
  }
  gz.destroy();
  return { entries, files };
}

/** Audit rules of spec 4.13 item 2. Returns an array of problem strings (empty = fine). */
export function auditEntries(entries, topLevel) {
  const bad = [];
  if (entries.length === 0) bad.push("empty archive");
  for (const e of entries) {
    const clean = e.name.replace(/\/+$/, "");
    const parts = clean.split("/");
    if (parts[0] !== topLevel) bad.push(`entry outside ${topLevel}: ${e.name}`);
    if (parts.some((p) => p === ".." || p === "") || e.name.startsWith("/")) bad.push(`unsafe path: ${e.name}`);
    if (parts.some((p) => p.startsWith("._"))) bad.push(`AppleDouble entry: ${e.name}`);
    if (e.type === "hardlink") bad.push(`hard link: ${e.name}`);
    if (e.type === "other") bad.push(`special entry: ${e.name}`);
    if (e.type === "symlink") {
      if (e.linkname.startsWith("/")) bad.push(`absolute symlink: ${e.name} -> ${e.linkname}`);
      if (e.linkname.split("/").includes("..")) bad.push(`symlink with '..': ${e.name} -> ${e.linkname}`);
    }
  }
  return bad;
}

export function unpackedBytes(entries) {
  return entries.reduce((n, e) => n + (e.type === "file" ? e.size : 0), 0);
}

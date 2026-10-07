// Dependency-free PNG reader/writer for the screenshot checks and tests.
// Reads 8-bit, non-interlaced grey / grey+alpha / RGB / RGBA / palette images.
import { createHash } from "node:crypto";
import { crc32, deflateSync, inflateSync } from "node:zlib";

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function assertPng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("not a PNG (bad signature)");
  }
}

/** Chunks in file order: [{ name, length, offset, data }]. Verifies each CRC. */
export function listChunksFull(buf) {
  assertPng(buf);
  const out = [];
  let p = 8;
  while (p + 12 <= buf.length) {
    const length = buf.readUInt32BE(p);
    const name = buf.toString("latin1", p + 4, p + 8);
    if (p + 12 + length > buf.length) throw new Error(`truncated chunk ${name}`);
    const data = buf.subarray(p + 8, p + 8 + length);
    const crc = buf.readUInt32BE(p + 8 + length);
    if (crc32(buf.subarray(p + 4, p + 8 + length)) !== crc) throw new Error(`bad CRC in chunk ${name}`);
    out.push({ name, length, offset: p, data });
    p += 12 + length;
    if (name === "IEND") break;
  }
  if (!out.length || out[out.length - 1].name !== "IEND") throw new Error("missing IEND");
  return out;
}

export const listChunks = (buf) => listChunksFull(buf).map((c) => c.name);

export function readHeader(buf) {
  const ch = listChunksFull(buf);
  if (ch[0].name !== "IHDR" || ch[0].length !== 13) throw new Error("missing IHDR");
  const d = ch[0].data;
  return {
    width: d.readUInt32BE(0),
    height: d.readUInt32BE(4),
    bitDepth: d[8],
    colorType: d[9],
    interlace: d[12],
  };
}

/** Full decode to RGBA. Returns { width, height, chunks, pixels (Uint8Array RGBA) }. */
export function readPng(buf) {
  const chunks = listChunksFull(buf);
  const h = readHeader(buf);
  if (h.bitDepth !== 8) throw new Error(`unsupported bit depth ${h.bitDepth}`);
  if (h.interlace !== 0) throw new Error("interlaced PNG is not supported");
  const nch = CHANNELS[h.colorType];
  if (!nch) throw new Error(`unsupported colour type ${h.colorType}`);
  const idat = Buffer.concat(chunks.filter((c) => c.name === "IDAT").map((c) => c.data));
  const raw = inflateSync(idat);
  const stride = h.width * nch;
  if (raw.length !== (stride + 1) * h.height) throw new Error("bad IDAT length");
  const px = Buffer.alloc(stride * h.height);
  for (let y = 0; y < h.height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= nch ? px[dst + x - nch] : 0;
      const b = y > 0 ? px[dst - stride + x] : 0;
      const c = x >= nch && y > 0 ? px[dst - stride + x - nch] : 0;
      let v = raw[src + x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (ft !== 0) throw new Error(`bad filter type ${ft}`);
      px[dst + x] = v & 255;
    }
  }
  const pixels = new Uint8Array(h.width * h.height * 4);
  const plte = chunks.find((c) => c.name === "PLTE")?.data;
  const trns = chunks.find((c) => c.name === "tRNS")?.data;
  for (let i = 0, n = h.width * h.height; i < n; i++) {
    const o = i * 4;
    const s = i * nch;
    if (h.colorType === 6) {
      pixels.set(px.subarray(s, s + 4), o);
    } else if (h.colorType === 2) {
      pixels[o] = px[s]; pixels[o + 1] = px[s + 1]; pixels[o + 2] = px[s + 2]; pixels[o + 3] = 255;
    } else if (h.colorType === 0) {
      pixels[o] = pixels[o + 1] = pixels[o + 2] = px[s]; pixels[o + 3] = 255;
    } else if (h.colorType === 4) {
      pixels[o] = pixels[o + 1] = pixels[o + 2] = px[s]; pixels[o + 3] = px[s + 1];
    } else {
      if (!plte) throw new Error("palette image without PLTE");
      const k = px[s];
      pixels[o] = plte[k * 3]; pixels[o + 1] = plte[k * 3 + 1]; pixels[o + 2] = plte[k * 3 + 2];
      pixels[o + 3] = trns && k < trns.length ? trns[k] : 255;
    }
  }
  return { width: h.width, height: h.height, chunks: chunks.map((c) => c.name), pixels };
}

/** Encode RGBA (Uint8Array, 4 bytes per pixel) as a minimal PNG: IHDR, IDAT, IEND only. */
export function encodePng(width, height, rgba) {
  if (rgba.length !== width * height * 4) throw new Error("rgba length does not match size");
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const chunk = (name, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(name, 4, "latin1");
    const body = Buffer.concat([head.subarray(4), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([head.subarray(0, 4), body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Insert an ancillary chunk before IEND (used by tests to plant metadata). */
export function insertChunk(buf, name, data) {
  const chunks = listChunksFull(buf);
  const iend = chunks[chunks.length - 1];
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(name, 4, "latin1");
  const body = Buffer.concat([head.subarray(4), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([buf.subarray(0, iend.offset), head.subarray(0, 4), body, tail, buf.subarray(iend.offset)]);
}

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Luminance statistics (0..255) over the whole image or a region { x, y, w, h }. */
export function luminanceStats(img, region) {
  const r = region ?? { x: 0, y: 0, w: img.width, h: img.height };
  let n = 0, sum = 0, sum2 = 0, min = 255, max = 0;
  for (let y = r.y; y < Math.min(img.height, r.y + r.h); y++) {
    for (let x = r.x; x < Math.min(img.width, r.x + r.w); x++) {
      const o = (y * img.width + x) * 4;
      const l = lum(img.pixels[o], img.pixels[o + 1], img.pixels[o + 2]);
      n++; sum += l; sum2 += l * l;
      if (l < min) min = l;
      if (l > max) max = l;
    }
  }
  if (!n) return { mean: 0, stdev: 0, min: 0, max: 0, count: 0 };
  const mean = sum / n;
  return { mean, stdev: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), min, max, count: n };
}

/** Box-averaged luminance grid, cols x rows, row-major Float64Array. */
export function sampleGrid(img, cols, rows) {
  const out = new Float64Array(cols * rows);
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const x0 = Math.floor((gx * img.width) / cols), x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * img.width) / cols));
      const y0 = Math.floor((gy * img.height) / rows), y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * img.height) / rows));
      let s = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const o = (y * img.width + x) * 4;
        s += lum(img.pixels[o], img.pixels[o + 1], img.pixels[o + 2]); n++;
      }
      out[gy * cols + gx] = s / n;
    }
  }
  return out;
}

/** Fraction of grid cells whose luminance differs by more than `threshold`. */
export function differingFraction(a, b, { cols = 48, rows = 30, threshold = 8 } = {}) {
  const ga = sampleGrid(a, cols, rows);
  const gb = sampleGrid(b, cols, rows);
  let d = 0;
  for (let i = 0; i < ga.length; i++) if (Math.abs(ga[i] - gb[i]) > threshold) d++;
  return d / ga.length;
}

export function pixelAt(img, x, y) {
  const o = (y * img.width + x) * 4;
  return [img.pixels[o], img.pixels[o + 1], img.pixels[o + 2], img.pixels[o + 3]];
}

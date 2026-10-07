// A small QR encoder for the pairing code (byte mode, error correction M, versions 1 to 12 = up to 288 bytes). The repo has no QR
// dependency and the pairing link is plain ASCII, so this is all that is needed. Structure follows ISO/IEC 18004; the Reed-Solomon
// output is pinned against the well-known "HELLO WORLD" 1-M vector in qr.test.ts.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 256) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
const mul = (a: number, b: number): number => (a && b ? EXP[LOG[a]! + LOG[b]!]! : 0);

function generator(n: number): number[] {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array<number>(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] = next[j]! ^ g[j]!;
      next[j + 1] = next[j + 1]! ^ mul(g[j]!, EXP[i]!);
    }
    g = next;
  }
  return g;
}

/** The `n` Reed-Solomon check bytes of `data`. */
export function rsRemainder(data: number[], n: number): number[] {
  const g = generator(n);
  const rem = new Array<number>(n).fill(0);
  for (const b of data) {
    const f = b ^ rem.shift()!;
    rem.push(0);
    for (let i = 0; i < n; i++) rem[i] = rem[i]! ^ mul(g[i + 1]!, f);
  }
  return rem;
}

/** Level M: [total codewords, check bytes per block, [blocks, data bytes per block][]]. */
const M: Record<number, [number, number, [number, number][]]> = {
  1: [26, 10, [[1, 16]]],
  2: [44, 16, [[1, 28]]],
  3: [70, 26, [[1, 44]]],
  4: [100, 18, [[2, 32]]],
  5: [134, 24, [[2, 43]]],
  6: [172, 16, [[4, 27]]],
  7: [196, 18, [[4, 31]]],
  8: [242, 22, [[2, 38], [2, 39]]],
  9: [292, 22, [[3, 36], [2, 37]]],
  10: [346, 26, [[4, 43], [1, 44]]],
  11: [404, 30, [[1, 50], [4, 51]]],
  12: [466, 22, [[6, 36], [2, 37]]],
};
const ALIGN: Record<number, number[]> = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50], 11: [6, 30, 54], 12: [6, 32, 58] };
const dataBytes = (v: number): number => M[v]![2].reduce((n, [b, d]) => n + b * d, 0);

export const MAX_BYTES = 288;

function chooseVersion(len: number): number {
  for (let v = 1; v <= 12; v++) {
    const header = v < 10 ? 12 : 20; // mode (4) + count (8 or 16)
    if (Math.ceil((header + len * 8) / 8) <= dataBytes(v)) return v;
  }
  throw new Error(`QR: ${len} bytes do not fit (max ${MAX_BYTES})`);
}

function dataCodewords(bytes: number[], v: number): number[] {
  const bits: number[] = [];
  const put = (val: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, v < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const cap = dataBytes(v) * 8;
  put(0, Math.min(4, cap - bits.length));
  while (bits.length % 8) bits.push(0);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let pad = 0xec; out.length < dataBytes(v); pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

/** Splits into blocks, appends check bytes per block and interleaves. */
export function interleave(data: number[], v: number): number[] {
  const [, eccLen, groups] = M[v]!;
  const blocks: number[][] = [];
  let pos = 0;
  for (const [count, size] of groups) for (let i = 0; i < count; i++, pos += size) blocks.push(data.slice(pos, pos + size));
  const ecc = blocks.map((b) => rsRemainder(b, eccLen));
  const out: number[] = [];
  const maxData = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.length) out.push(b[i]!);
  for (let i = 0; i < eccLen; i++) for (const e of ecc) out.push(e[i]!);
  return out;
}

const bit = (x: number, i: number): boolean => ((x >>> i) & 1) === 1;

function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask; // level M = 00
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

class Grid {
  readonly size: number;
  readonly m: boolean[][];
  readonly fn: boolean[][];
  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.m = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.fn = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.functionPatterns();
  }
  private set(x: number, y: number, dark: boolean): void {
    this.m[y]![x] = dark;
    this.fn[y]![x] = true;
  }
  private finder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) this.set(x, y, d !== 2 && d !== 4);
      }
  }
  private functionPatterns(): void {
    const s = this.size;
    for (let i = 0; i < s; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    this.finder(3, 3);
    this.finder(s - 4, 3);
    this.finder(3, s - 4);
    const pos = ALIGN[this.version]!;
    for (const ax of pos)
      for (const ay of pos) {
        if ((ax === 6 && ay === 6) || (ax === 6 && ay === s - 7) || (ax === s - 7 && ay === 6)) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    this.format(0); // reserves the cells
    if (this.version >= 7) {
      let rem = this.version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (this.version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const a = s - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.set(a, b, bit(bits, i));
        this.set(b, a, bit(bits, i));
      }
    }
  }
  format(mask: number): void {
    const s = this.size;
    const bits = formatBits(mask);
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(bits, i));
    this.set(8, 7, bit(bits, 6));
    this.set(8, 8, bit(bits, 7));
    this.set(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) this.set(s - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) this.set(8, s - 15 + i, bit(bits, i));
    this.set(8, s - 8, true);
  }
  place(codewords: number[]): void {
    const s = this.size;
    let i = 0;
    for (let right = s - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < s; vert++)
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? s - 1 - vert : vert;
          if (!this.fn[y]![x] && i < codewords.length * 8) {
            this.m[y]![x] = bit(codewords[i >>> 3]!, 7 - (i & 7));
            i++;
          }
        }
    }
  }
  mask(k: number): void {
    for (let y = 0; y < this.size; y++)
      for (let x = 0; x < this.size; x++) {
        if (this.fn[y]![x]) continue;
        const flip = [(x + y) % 2 === 0, y % 2 === 0, x % 3 === 0, (x + y) % 3 === 0, (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, ((x * y) % 2) + ((x * y) % 3) === 0, (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (((x + y) % 2) + ((x * y) % 3)) % 2 === 0][k]!;
        if (flip) this.m[y]![x] = !this.m[y]![x];
      }
  }
  penalty(): number {
    const s = this.size;
    const m = this.m;
    let p = 0;
    const runs = (get: (a: number, b: number) => boolean) => {
      for (let a = 0; a < s; a++) {
        let run = 1;
        for (let b = 1; b <= s; b++) {
          if (b < s && get(a, b) === get(a, b - 1)) run++;
          else {
            if (run >= 5) p += 3 + (run - 5);
            run = 1;
          }
        }
      }
    };
    runs((a, b) => m[a]![b]!);
    runs((a, b) => m[b]![a]!);
    for (let y = 0; y < s - 1; y++) for (let x = 0; x < s - 1; x++) if (m[y]![x] === m[y]![x + 1] && m[y]![x] === m[y + 1]![x] && m[y]![x] === m[y + 1]![x + 1]) p += 3;
    const pat = [true, false, true, true, true, false, true];
    const scan = (get: (a: number, b: number) => boolean) => {
      for (let a = 0; a < s; a++)
        for (let b = 0; b + 6 < s; b++) {
          if (!pat.every((v, i) => get(a, b + i) === v)) continue;
          const before = b >= 4 && [1, 2, 3, 4].every((i) => !get(a, b - i));
          const after = b + 10 < s && [7, 8, 9, 10].every((i) => !get(a, b + i));
          if (before || after) p += 40;
        }
    };
    scan((a, b) => m[a]![b]!);
    scan((a, b) => m[b]![a]!);
    const dark = m.reduce((n, row) => n + row.filter(Boolean).length, 0);
    p += 10 * (Math.ceil(Math.abs((dark * 100) / (s * s) - 50) / 5) - 1);
    return p;
  }
}

/** The QR code of an ASCII/UTF-8 text as a square matrix of dark modules. */
export function encodeQr(text: string): boolean[][] {
  const bytes = Array.from(new TextEncoder().encode(text));
  const v = chooseVersion(bytes.length);
  const codewords = interleave(dataCodewords(bytes, v), v);
  let best: Grid | null = null;
  let bestScore = Infinity;
  for (let k = 0; k < 8; k++) {
    const g = new Grid(v);
    g.place(codewords);
    g.mask(k);
    g.format(k);
    const score = g.penalty();
    if (score < bestScore) {
      best = g;
      bestScore = score;
    }
  }
  return best!.m;
}

/** One SVG path (unit squares) for the matrix, with a 4-module quiet zone; use viewBox `0 0 size size`. */
export function qrPath(matrix: boolean[][], quiet = 4): { d: string; size: number } {
  const parts: string[] = [];
  matrix.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      let end = x;
      while (end < row.length && row[end]) end++;
      parts.push(`M${x + quiet} ${y + quiet}h${end - x}v1h${-(end - x)}z`);
      x = end;
    }
  });
  return { d: parts.join(""), size: matrix.length + quiet * 2 };
}

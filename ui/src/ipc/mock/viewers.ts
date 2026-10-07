import type { ViewersIpc } from "../viewers";

const enc = new TextEncoder();

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const x of bytes) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** A valid RGBA PNG made of stored (uncompressed) deflate blocks: no zlib needed, deterministic. */
export function makePng(w: number, h: number, px: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const raw = new Uint8Array(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    const o = y * (1 + w * 4);
    for (let x = 0; x < w; x++) raw.set(px(x, y), o + 1 + x * 4);
  }
  const blocks: number[] = [0x78, 0x01];
  for (let i = 0; i < raw.length; i += 65535) {
    const n = Math.min(65535, raw.length - i);
    blocks.push(i + n >= raw.length ? 1 : 0, n & 255, n >> 8, ~n & 255, (~n >> 8) & 255, ...raw.subarray(i, i + n));
  }
  const ad = adler32(raw);
  blocks.push(ad >>> 24, (ad >> 16) & 255, (ad >> 8) & 255, ad & 255);
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(enc.encode(type), 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(blocks)), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}

const SAMPLE_JSON = {
  name: "intely-fixture",
  version: "1.4.2",
  private: true,
  scripts: { dev: "vite", build: "vite build", test: "vitest run" },
  dependencies: Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`pkg-${String(i).padStart(2, "0")}`, `^${1 + (i % 4)}.${i}.0`])),
  orders: Array.from({ length: 1200 }, (_, i) => ({
    id: i + 1,
    status: ["open", "paid", "void"][i % 3],
    total: Math.round((i * 37.5 + 12) * 100) / 100,
    customer: { name: `Customer ${i + 1}`, vip: i % 17 === 0, tags: i % 5 === 0 ? ["hu", "loyal"] : [] },
    note: i % 50 === 0 ? "árvíztűrő tükörfúrógép" : null,
  })),
  empty: { object: {}, array: [] },
};

const LEVELS = ["INFO", "INFO", "DEBUG", "WARN", "INFO", "ERROR"];
function logLine(i: number): string {
  const ts = `2026-10-03T12:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`;
  if (i % 7 === 0) return JSON.stringify({ ts, level: LEVELS[i % 6].toLowerCase(), msg: `order ${i} accepted`, order: { id: i, total: i * 3 }, tags: ["pos", "hu"] });
  return `${ts} ${LEVELS[i % 6]} order ${i} ${i % 11 === 0 ? "payment declined for terminal 3" : "accepted"}`;
}

function lines(n: number, f: (i: number) => string): string {
  return Array.from({ length: n }, (_, i) => f(i + 1)).join("\n") + "\n";
}

const MARKDOWN = `# Release notes

A **safe** preview: *no* remote content, \`inline code\` and ~~strike~~.

## Checklist

- [x] Viewers
- [ ] Resource HUD
  - nested item with a [link](https://example.com/docs)
  - another one

1. first
2. second

> Quoted text with <b>raw html</b> shown as text.

| Name | Qty |
| --- | ---: |
| Apple | 3 |
| Pear | 12 |

\`\`\`ts
export const answer = 42;
\`\`\`

![remote](https://example.com/x.png)

---
Last line.
`;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80" width="120" height="80"><rect width="120" height="80" rx="10" fill="#4b3fd6"/><circle cx="40" cy="40" r="22" fill="#2ee6c5"/><path d="M70 28h30M70 40h22M70 52h30" stroke="#fff" stroke-width="6" stroke-linecap="round"/><script>alert(1)</script></svg>`;

const PDF = "%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";

/** Path -> bytes. Anything not listed is a short text file, so any path opens in the mock. */
export function mockFileBytes(path: string): Uint8Array {
  switch (path) {
    case "data/sample.json":
    case "package.json":
    case "data/export.json":
      return enc.encode(JSON.stringify(SAMPLE_JSON));
    case "data/events.jsonl":
      return enc.encode(lines(2000, (i) => JSON.stringify({ id: i, type: ["created", "paid", "shipped"][i % 3], at: `2026-10-03T10:00:${String(i % 60).padStart(2, "0")}Z`, items: [{ sku: `S-${i}`, qty: (i % 4) + 1 }] })));
    case "data/huge.log":
      return enc.encode(lines(120_000, logLine));
    case "data/broken.json":
      return enc.encode('{"a": [1, 2, 3,\n "b": }');
    case "docs/spec.md":
    case "README.md":
      return enc.encode(MARKDOWN);
    case "assets/logo.svg":
      return enc.encode(SVG);
    case "assets/pixel.png":
    case "assets/logo.png":
      return makePng(96, 64, (x, y) => [Math.floor((255 * x) / 96), Math.floor((255 * y) / 64), 180, (x >> 3) + (y >> 3) & 1 ? 255 : 200]);
    case "docs/guide.pdf":
      return enc.encode(PDF);
    default:
      return enc.encode(`{"path": ${JSON.stringify(path)}}\n`);
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const GUARDED = (p: string) => p.split("/").pop()!.startsWith(".env") || p.split("/").includes(".git");

export function createMockViewers(): ViewersIpc & { opened: string[] } {
  const cache = new Map<string, Uint8Array>();
  const bytes = (p: string) => {
    let b = cache.get(p);
    if (!b) cache.set(p, (b = mockFileBytes(p)));
    return b;
  };
  const check = (p: string) => {
    if (GUARDED(p)) throw { code: "guardBlocked", message: `${p} is a guarded file` };
    if (p.startsWith("/") || p.split("/").includes("..")) throw { code: "invalidSelection", message: `path "${p}" is not repo-relative` };
  };
  const opened: string[] = [];
  return {
    opened,
    async stat(_repoId, path) {
      check(path);
      return { size: bytes(path).length, mtimeMs: 1_700_000_000_000 };
    },
    async readRange(_repoId, path, offset, len) {
      check(path);
      const b = bytes(path);
      const end = Math.min(b.length, offset + Math.min(len, 8 * 1024 * 1024));
      const slice = b.subarray(Math.min(offset, b.length), end);
      return { base64: toBase64(slice), offset, len: slice.length, eof: end >= b.length };
    },
    async openExternal(_repoId, path) {
      check(path);
      opened.push(path);
    },
  };
}

import type { DirEntry, FileChanged, FilesIpc } from "../files";
import type { Unsubscribe } from "../index";

/** Repo-relative path -> text. A deterministic tree shared by every mock repo. A key ending in "/" is an empty directory. */
export type MockTree = Map<string, string>;

const lines = (n: number, row: (i: number) => string) => Array.from({ length: n }, (_, i) => row(i + 1)).join("\n") + "\n";

const SEED: [string, string][] = [
  ["README.md", "# Fixture repo\n\nA tiny tree for the mock Ipc.\n\n- árvíztűrő tükörfúrógép\n- ÁRVÍZTŰRŐ TÜKÖRFÚRÓGÉP\n"],
  ["package.json", '{\n  "name": "fixture",\n  "version": "1.0.0"\n}\n'],
  [".gitignore", "node_modules/\ndist/\n.env\n"],
  [".env", "SECRET=1\n"],
  ["src/index.ts", 'export const answer = 42;\nconsole.log("hello");\n'],
  ["src/util/format.ts", 'export const pad = (n: number) => String(n).padStart(2, "0");\n'],
  ["src/api/routes/index.js", "const router = require('express').Router();\n\nrouter.get('/orders', require('../controllers/orderController').list);\n\nmodule.exports = router;\n"],
  ["src/api/controllers/orderController.js", "exports.list = async (req, res) => {\n\tconst orders = await req.db.orders.find();\n\tres.json(orders);\n};\n"],
  [
    "src/api/services/invoiceService.js",
    "'use strict';\n\n" +
      lines(420, (i) => `function step${i}(input) {\n  return input + ${i};\n}\n`) +
      "\nmodule.exports = { step1 };\n",
  ],
  ["src/api/services/loyaltyService.js", "exports.accrue = (points, total) => points + Math.floor(total / 100);\n"],
  ["src/api/migrations/20261001_add_loyalty.js", "exports.up = (knex) => knex.schema.createTable('loyalty', (t) => t.increments());\n"],
  ["src/components/modules/orders/OrdersTable.tsx", 'export function OrdersTable() {\n  return <table class="orders" />;\n}\n'],
  ["docs/windows.txt", "Line one\r\nLine two\r\nLine three\r\n"],
  ["docs/notes.txt", "x".repeat(2000) + "\nshort second line\n"],
  ["assets/logo.png", "\u0000PNG"],
  ["data/export.json", "[]"],
  ["data/huge.log", lines(40, (i) => `2026-10-03 12:00:${String(i).padStart(2, "0")} INFO order ${i} accepted\n`)],
  ["docs/hu-latin2.txt", "árvíztűrő tükörfúrógép\nÁRVÍZTŰRŐ TÜKÖRFÚRÓGÉP\n"],
  ["node_modules/left-pad/index.js", "module.exports = (s, n) => s.padStart(n);\n"],
  ["dist/bundle.js", "(()=>{})();\n"],
  ["empty-dir/", ""],
];

const BINARY = new Set(["assets/logo.png"]);
const TOO_LARGE = new Map([["data/export.json", 8_400_000]]);
/** Over 5 MiB with a text prefix: the editor opens it read-only. */
const PARTIAL = new Map([["data/huge.log", 12_800_000]]);
/** Stored as ISO-8859-2 on a real disk: detected as latin2, and other encodings show the usual mix-ups. */
const LATIN2 = new Set(["docs/hu-latin2.txt"]);
const MOJIBAKE: Record<string, string> = { "ő": "õ", "ű": "û", "Ő": "Õ", "Ű": "Û" };
const CRLF = new Set(["docs/windows.txt"]);
const IGNORED = ["node_modules", "dist", ".env"];

const isNeverRead = (path: string) => path.split("/").pop()!.startsWith(".env");
const isIgnored = (path: string) => IGNORED.some((p) => path === p || path.startsWith(`${p}/`));
const sizeOf = (path: string, text: string) => TOO_LARGE.get(path) ?? PARTIAL.get(path) ?? text.length;

const fail = (code: string, message: string) => ({ code, message });

export function createMockFiles(): { api: FilesIpc; tree: MockTree } {
  const tree: MockTree = new Map(SEED);
  const mtimes = new Map<string, number>();
  const listeners = new Set<(e: FileChanged) => void>();
  /** The encoding each file was last saved with (the mock stores text, so this is the only trace of it). */
  const savedAs = new Map<string, string | undefined>();
  const mtime = (path: string) => mtimes.get(path) ?? 1_700_000_000_000;
  const emit = (e: FileChanged) => queueMicrotask(() => listeners.forEach((cb) => cb(e)));
  const under = (path: string) => [...tree.keys()].filter((k) => k === path || k === `${path}/` || k.startsWith(`${path}/`));

  const api: FilesIpc = {
    async listDir(_repoId, relPath) {
      const prefix = relPath ? `${relPath.replace(/\/$/, "")}/` : "";
      const seen = new Map<string, DirEntry>();
      for (const [path, text] of tree) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        if (!rest) continue;
        const name = rest.split("/")[0];
        const full = prefix + name;
        const ignored = isIgnored(full) || undefined;
        if (rest.includes("/")) seen.set(name, { name, kind: "dir", ignored });
        else seen.set(name, { name, kind: "file", size: sizeOf(path, text), ignored, neverRead: isNeverRead(path) || undefined });
      }
      return [...seen.values()].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
    },
    async readFile(_repoId, relPath, opts) {
      const text = tree.get(relPath);
      if (text === undefined || relPath.endsWith("/")) throw fail("io", `${relPath}: no such file`);
      const base = { size: sizeOf(relPath, text), mtimeMs: mtime(relPath) };
      if (BINARY.has(relPath)) return { ...base, binary: true, tooLarge: false, eol: "none", guard: "ok" };
      if (TOO_LARGE.has(relPath)) return { ...base, binary: false, tooLarge: true, eol: "lf", guard: "tooLarge" };
      if (PARTIAL.has(relPath)) return { ...base, text, binary: false, tooLarge: true, eol: "lf", encoding: "utf8", guard: "ok" };
      if (LATIN2.has(relPath)) {
        const enc = opts?.encoding ?? "latin2";
        if (enc === "utf8" || enc === "utf8Bom" || enc === "utf16le" || enc === "utf16be") throw fail("io", `the bytes are not valid ${enc === "utf8" || enc === "utf8Bom" ? "UTF-8" : "UTF-16"}`);
        const shown = enc === "latin1" ? text.replace(/[őűŐŰ]/g, (c) => MOJIBAKE[c]) : text;
        return { ...base, text: shown, binary: false, tooLarge: false, eol: "lf", encoding: enc, guard: "ok" };
      }
      const secret = isNeverRead(relPath);
      const eol = CRLF.has(relPath) ? "crlf" : text.includes("\n") ? "lf" : "none";
      return { ...base, text: secret && !opts?.reveal ? undefined : text, binary: false, tooLarge: false, eol, guard: secret ? "secret" : "ok" };
    },
    async writeFile(repoId, relPath, text, expectedMtimeMs, opts) {
      if (tree.has(relPath) ? expectedMtimeMs !== mtime(relPath) : expectedMtimeMs !== 0) throw fail("staleFile", `${relPath} changed on disk`);
      const created = !tree.has(relPath);
      tree.set(relPath, text);
      savedAs.set(relPath, opts?.encoding);
      const next = mtime(relPath) + 1;
      mtimes.set(relPath, next);
      emit({ repoId, path: relPath, kind: created ? "created" : "changed" });
      return { mtimeMs: next };
    },
    async quickOpenIndex() {
      return [...tree.keys()].filter((p) => !p.endsWith("/") && !isNeverRead(p) && !isIgnored(p)).sort();
    },
    async createEntry(repoId, relPath, kind) {
      if (under(relPath).length) throw fail("exists", `${relPath} already exists`);
      tree.set(kind === "dir" ? `${relPath}/` : relPath, "");
      emit({ repoId, path: relPath, kind: "created" });
    },
    async renameEntry(repoId, from, to) {
      if (under(to).length) throw fail("exists", `${to} already exists`);
      for (const key of under(from)) {
        tree.set(to + key.slice(from.length), tree.get(key)!);
        tree.delete(key);
        emit({ repoId, path: key, kind: "deleted" });
        emit({ repoId, path: to + key.slice(from.length), kind: "created" });
      }
    },
    async trashEntry(repoId, relPath) {
      for (const key of under(relPath)) {
        tree.delete(key);
        emit({ repoId, path: key, kind: "deleted" });
      }
    },
    async revealEntry() {},
    async watch() {},
    async unwatch() {},
    onFileChanged(cb): Unsubscribe {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };

  // Browser QA: simulate an edit made by another program, e.g. __mockFiles.external("README.md", "new text").
  if ((import.meta.env?.DEV || import.meta.env?.VITE_MOCK_IPC) && typeof window !== "undefined") {
    (window as unknown as { __mockFiles: unknown }).__mockFiles = {
      tree,
      savedAs,
      external(path: string, text: string | null, repoId = "backend") {
        if (text === null) tree.delete(path);
        else tree.set(path, text);
        mtimes.set(path, mtime(path) + 1);
        emit({ repoId, path, kind: text === null ? "deleted" : "changed" });
      },
    };
  }
  return { api, tree };
}

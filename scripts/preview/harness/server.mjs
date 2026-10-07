#!/usr/bin/env node
// IDE-owned component preview harness server ((design notes: preview-plan), Stage B).
//
//   node server.mjs '<json>'      json: { repoRoot, stateDir, file, exportName, ideRoot? }
//
// Bundles ONE component of a repo into a page that renders it in isolation, serves it on a random loopback port and
// rebuilds on save (the page reloads through an SSE event; the IDE re-sends the props). Everything it writes goes to
// `<stateDir>/harness/<key>/` (the generated entry and the bundle stays in memory): NEVER into the repo, no existing repo
// file is edited, no repo dependency is added, `.env*` is never read. The bundler is esbuild: the repo's own copy when it
// has one, else the IDE's (an IDE development dependency). react and react-dom always come from the repo, one copy.
// The page cannot call a real API: a CSP (`connect-src 'self'`) plus stubs for fetch, XHR, WebSocket and EventSource.
//
// stdout: one JSON line when ready: {"ready":true,"port":N,"engine":"repo|ide","esbuild":"x.y.z","available":{...},"workdir":"..."}
// or {"ready":false,"code":"...","error":"..."} and exit 1. The process exits when stdin closes (the IDE died) or on SIGTERM.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ALLOWED_EXT = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs"]);
const IDENT = /^(default|[A-Za-z_$][\w$]{0,99})$/;

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const fail = (code, error) => {
  out({ ready: false, code, error });
  process.exit(1);
};

let cfg;
try {
  cfg = JSON.parse(process.argv[2] ?? "");
} catch {
  fail("badConfig", "the harness needs one JSON argument");
}
const { stateDir, file, exportName } = cfg;
if (typeof cfg.repoRoot !== "string" || typeof stateDir !== "string" || typeof file !== "string" || !IDENT.test(String(exportName))) fail("badConfig", "repoRoot, stateDir, file and a valid exportName are required");

if (path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) fail("outsideRepo", "the component path must be relative and stay inside the repository");
let repoRoot;
let componentAbs;
try {
  repoRoot = fs.realpathSync(cfg.repoRoot);
  componentAbs = fs.realpathSync(path.resolve(repoRoot, file));
} catch {
  fail("notFound", `cannot find ${file} in the repository`);
}
if (componentAbs !== repoRoot && !componentAbs.startsWith(repoRoot + path.sep)) fail("outsideRepo", "the component resolves outside the repository");
if (componentAbs.split(path.sep).includes("node_modules")) fail("outsideRepo", "components inside node_modules are not previewed");
if (!ALLOWED_EXT.has(path.extname(componentAbs).toLowerCase())) fail("badFile", "only .js .jsx .ts .tsx .mjs files can be previewed");

// ---------------------------------------------------------------------------------------------------- tool resolution
const repoRequire = createRequire(path.join(repoRoot, "package.json"));
const pkgDir = (name) => {
  try {
    return path.dirname(repoRequire.resolve(`${name}/package.json`));
  } catch {
    try {
      // packages with an `exports` map that hides package.json: walk up from the main file
      let d = path.dirname(repoRequire.resolve(name));
      while (d !== path.dirname(d)) {
        if (fs.existsSync(path.join(d, "package.json")) && JSON.parse(fs.readFileSync(path.join(d, "package.json"), "utf8")).name === name) return d;
        d = path.dirname(d);
      }
    } catch {
      /* not installed */
    }
    return undefined;
  }
};

function loadEsbuild() {
  const tries = [];
  const repoDir = pkgDir("esbuild");
  if (repoDir) tries.push({ dir: repoDir, engine: "repo" });
  if (process.env.INTELY_ESBUILD_DIR) tries.push({ dir: process.env.INTELY_ESBUILD_DIR, engine: "ide" });
  const roots = [cfg.ideRoot, path.resolve(here, "../../..")].filter(Boolean);
  for (const root of roots) {
    const store = path.join(root, "node_modules", ".pnpm");
    try {
      for (const e of fs.readdirSync(store).filter((n) => /^esbuild@\d/.test(n)).sort().reverse()) tries.push({ dir: path.join(store, e, "node_modules", "esbuild"), engine: "ide" });
    } catch {
      /* no store here */
    }
  }
  for (const t of tries) {
    try {
      const r = createRequire(path.join(t.dir, "package.json"));
      const esbuild = r(t.dir);
      if (typeof esbuild.context === "function") return { esbuild, engine: t.engine, version: esbuild.version };
    } catch {
      /* try the next one */
    }
  }
  fail("noBundler", "no usable esbuild was found: neither the repository nor the IDE installation has one (run the package install of the IDE, or set INTELY_ESBUILD_DIR)");
}

const reactDir = pkgDir("react");
const reactDomDir = pkgDir("react-dom");
if (!reactDir || !reactDomDir) fail("noReact", "react and react-dom are not installed in the repository (install the repository's dependencies yourself, the IDE does not)");
const reactVersion = JSON.parse(fs.readFileSync(path.join(reactDir, "package.json"), "utf8")).version;
const reactMajor = Number(reactVersion.split(".")[0]);
if (reactMajor < 16 || (reactMajor === 16 && Number(reactVersion.split(".")[1]) < 14)) fail("oldReact", `React ${reactVersion} has no automatic JSX runtime; the component preview needs React 16.14 or newer`);
const hasClient = fs.existsSync(path.join(reactDomDir, "client.js"));

const optional = {
  ReactRedux: "react-redux",
  MuiStyles: "@mui/material/styles",
  SC: "styled-components",
  RR: "react-router-dom",
};
const optionalFound = {};
for (const [k, spec] of Object.entries(optional)) {
  try {
    repoRequire.resolve(spec);
    optionalFound[k] = spec;
  } catch {
    /* not in this repo: the wrapper stays unavailable */
  }
}
const available = { redux: !!optionalFound.ReactRedux, mui: !!optionalFound.MuiStyles, styled: !!optionalFound.SC, router: !!optionalFound.RR };

const { esbuild, engine, version } = loadEsbuild();

// ------------------------------------------------------------------------------------------------------- workdir/entry
const key = crypto.createHash("sha256").update(`${repoRoot}\0${path.relative(repoRoot, componentAbs)}`).digest("hex").slice(0, 16);
const workdir = path.join(path.resolve(stateDir), "harness", key);
fs.mkdirSync(workdir, { recursive: true });
const q = JSON.stringify;
// Wrapper libraries are bundled only when the component's own import graph already uses them (a Provider for a library the
// component never imports would be pointless, and MUI alone is about 1.5 MB to parse on every reload).
const LIB_PKG = { ReactRedux: "/node_modules/react-redux/", MuiStyles: "/node_modules/@mui/material/", SC: "/node_modules/styled-components/", RR: "/node_modules/react-router" };
function makeEntry(libs) {
  const used = Object.entries(optionalFound).filter(([k]) => libs.has(k));
  return `${[
    `import ${q(path.join(here, "early.js"))};`,
    `import * as React from "react";`,
    `import * as ReactDOM from "react-dom";`,
    hasClient ? `import { createRoot } from "react-dom/client";` : `const createRoot = null;`,
    `import * as Mod from ${q(componentAbs)};`,
    `import { boot } from ${q(path.join(here, "runtime.js"))};`,
    ...used.map(([k, spec]) => `import * as ${k} from ${q(spec)};`),
    `boot({ React, ReactDOM, createRoot, Mod, exportName: ${q(exportName)}, file: ${q(path.relative(repoRoot, componentAbs))}, libs: { ${Object.keys(optional).map((k) => (libs.has(k) && optionalFound[k] ? k : `${k}: undefined`)).join(", ")} } });`,
  ].join("\n")}\n`;
}
let libs = new Set();
const entry = path.join(workdir, "entry.jsx");
fs.writeFileSync(entry, makeEntry(libs));
const shim = path.join(workdir, "process-shim.js");
fs.writeFileSync(shim, `export var process = (typeof globalThis.process !== "undefined" && globalThis.process.env) ? globalThis.process : { env: { NODE_ENV: "development" }, browser: true, version: "", versions: {}, nextTick: function (f) { var a = [].slice.call(arguments, 1); Promise.resolve().then(function () { f.apply(null, a); }); }, cwd: function () { return "/"; }, platform: "browser", argv: [] };\n`);

// ---------------------------------------------------------------------------------------------------------- bundling
let seq = 0;
let files = new Map();
let errors = [];
let lastMs = 0;
let lastMeta;
const clients = new Set();

const compilerPlugin = {
  name: "intely-styles",
  setup(b) {
    b.onLoad({ filter: /\.(less|scss|sass)$/ }, async (args) => {
      const ext = path.extname(args.path).slice(1);
      try {
        if (ext === "less") {
          const less = repoRequire("less");
          const r = await less.render(fs.readFileSync(args.path, "utf8"), { filename: args.path, javascriptEnabled: true });
          return { contents: r.css, loader: "css", resolveDir: path.dirname(args.path) };
        }
        const sass = repoRequire("sass");
        return { contents: sass.compile(args.path).css, loader: "css", resolveDir: path.dirname(args.path) };
      } catch (e) {
        return { contents: `/* ${ext} not compiled in the preview: ${String(e.message ?? e).split("\n")[0].replace(/\*\//g, "")} */`, loader: "css", warnings: [{ text: `${path.basename(args.path)} was not compiled (${ext} compiler missing or failed); its styles are not applied` }] };
      }
    });
  },
};

const formatMessage = (m) => ({ text: m.text, file: m.location ? path.relative(repoRoot, path.resolve(repoRoot, m.location.file)) : "", line: m.location?.line ?? 0, col: (m.location?.column ?? 0) + 1, lineText: m.location?.lineText?.slice(0, 200) ?? "" });

// The repo's tsconfig/jsconfig gives esbuild its paths and baseUrl; a generated config in the state dir extends it and only
// switches JSX to the development runtime (a repo's own `jsx` setting would otherwise win and drop the source info).
const repoTsconfig = ["tsconfig.json", "jsconfig.json"].map((n) => path.join(repoRoot, n)).find((p) => fs.existsSync(p));
const tsconfigPath = path.join(workdir, "tsconfig.json");
fs.writeFileSync(tsconfigPath, JSON.stringify({ ...(repoTsconfig ? { extends: repoTsconfig } : {}), compilerOptions: { jsx: "react-jsxdev" } }));

const ctx = await esbuild.context({
  entryPoints: [entry],
  outdir: path.join(workdir, "out"),
  entryNames: "bundle",
  absWorkingDir: repoRoot,
  bundle: true,
  metafile: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2020",
  jsx: "automatic",
  jsxDev: true,
  keepNames: true,
  sourcemap: false,
  logLevel: "silent",
  legalComments: "none",
  alias: { react: reactDir, "react-dom": reactDomDir },
  nodePaths: [path.join(repoRoot, "node_modules")],
  inject: [shim],
  define: { "process.env.NODE_ENV": '"development"', global: "globalThis" },
  ...(tsconfigPath ? { tsconfig: tsconfigPath } : {}),
  loader: {
    ".js": "jsx", ".mjs": "jsx", ".module.css": "local-css",
    ".png": "dataurl", ".jpg": "dataurl", ".jpeg": "dataurl", ".gif": "dataurl", ".webp": "dataurl", ".svg": "dataurl", ".ico": "dataurl",
    ".woff": "dataurl", ".woff2": "dataurl", ".ttf": "dataurl", ".otf": "dataurl", ".eot": "dataurl",
  },
  plugins: [
    compilerPlugin,
    {
      name: "intely-end",
      setup(b) {
        let t0 = 0;
        b.onStart(() => void (t0 = Date.now()));
        b.onEnd((result) => {
          lastMs = Date.now() - t0;
          lastMeta = result.metafile;
          errors = result.errors.map(formatMessage);
          if (result.errors.length === 0) {
            files = new Map(result.outputFiles.map((f) => [`/${path.basename(f.path)}`, f.contents]));
          }
          seq += 1;
          for (const res of clients) res.write(`data: ${JSON.stringify({ seq, ok: errors.length === 0 })}\n\n`);
          process.stderr.write(`[harness] build #${seq} ${errors.length ? `failed (${errors.length} errors)` : "ok"} in ${lastMs} ms\n`);
        });
      },
    },
  ],
});

function neededLibs(meta) {
  const need = new Set();
  if (!meta) return libs;
  const entryKey = path.relative(repoRoot, entry);
  for (const [file, input] of Object.entries(meta.inputs)) {
    if (file === entryKey || path.resolve(repoRoot, file) === entry) continue;
    for (const imp of input.imports) {
      const p = `/${imp.path.replace(/\\/g, "/")}`;
      for (const [k, marker] of Object.entries(LIB_PKG)) if (optionalFound[k] && p.includes(marker)) need.add(k);
    }
  }
  return need;
}
const sameSet = (x, y) => x.size === y.size && [...x].every((v) => y.has(v));
async function build() {
  await ctx.rebuild().catch(() => undefined); // errors are in `errors`; the page shows them
  const need = neededLibs(lastMeta);
  if (!sameSet(need, libs)) {
    libs = need;
    fs.writeFileSync(entry, makeEntry(libs));
    await ctx.rebuild().catch(() => undefined);
  }
}
await build();
// Save detection: FSEvents through fs.watch (a few ms) instead of esbuild's own polling watcher (about 2 s); the poller stays
// as the fallback when a recursive watch is not available.
const WATCHED = /\.(jsx?|tsx?|mjs|cjs|json|css|less|scss|sass|svg)$/i;
let building = false;
let again = false;
let timer;
async function rebuild() {
  if (building) return void (again = true);
  building = true;
  try {
    await build();
  } catch {
    /* the plugin recorded the errors */
  }
  building = false;
  if (again) {
    again = false;
    void rebuild();
  }
}
let watcher;
try {
  watcher = fs.watch(repoRoot, { recursive: true }, (_ev, name) => {
    if (!name || !WATCHED.test(name)) return;
    const parts = String(name).split(path.sep);
    if (parts.includes("node_modules") || parts.includes(".git")) return;
    clearTimeout(timer);
    timer = setTimeout(() => void rebuild(), 40);
  });
  watcher.on("error", () => {});
} catch {
  await ctx.watch().catch(() => undefined);
}

// ------------------------------------------------------------------------------------------------------------ server
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; base-uri 'none'; form-action 'none'";

function page() {
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${CSP}"><title>Component preview</title>${files.has("/bundle.css") ? `<link rel="stylesheet" href="/bundle.css?v=${seq}">` : ""}<style>html,body{margin:0}</style></head><body><div id="root"></div>`;
  const reload = `<script>(function(){var b=${seq};try{var es=new EventSource("/__intely/events");es.onmessage=function(e){var d=JSON.parse(e.data);if(d.seq!==b)location.reload()}}catch(e){}})()</script>`;
  if (errors.length === 0 && files.has("/bundle.js")) return `${head}<script>window.__INTELY_BUILD__=${seq}</script><script src="/bundle.js?v=${seq}"></script>${reload}</body></html>`;
  const list = errors
    .map((e) => `<div class="e"><b>${esc(e.file ? `${e.file}:${e.line}:${e.col}` : "build")}</b><div>${esc(e.text)}</div>${e.lineText ? `<pre>${esc(e.lineText)}\n${" ".repeat(Math.max(0, e.col - 1))}^</pre>` : ""}</div>`)
    .join("");
  const report = JSON.stringify({ intely: "preview/status/1", state: "buildError", message: errors[0]?.text ?? "build failed", errors: errors.slice(0, 20) }).replace(/</g, "\\u003c");
  return `${head}<style>body{font:13px/1.5 system-ui,sans-serif;padding:16px;background:#1b1d22;color:#e8eaed}.e{border:1px solid #d95b5b;background:rgba(217,91,91,.12);border-radius:8px;padding:12px;margin:0 0 12px}pre{font:12px ui-monospace,monospace;margin:6px 0 0;overflow:auto}h1{font-size:15px;margin:0 0 12px}</style><div role="alert" data-intely-build-error><h1>The component could not be built</h1>${list}</div><script>try{parent.postMessage(${report},"*")}catch(e){}</script>${reload}</body></html>`;
}

const MIME = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
let port = 0;
const server = http.createServer((req, res) => {
  const host = String(req.headers.host ?? "");
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    res.writeHead(421).end("misdirected request");
    return;
  }
  const url = new URL(req.url ?? "/", "http://x");
  const base = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
  if (req.method !== "GET") return void res.writeHead(405, base).end();
  if (url.pathname === "/" || url.pathname === "/index.html") return void res.writeHead(200, { ...base, "Content-Type": "text/html; charset=utf-8" }).end(page());
  if (url.pathname === "/__intely/events") {
    res.writeHead(200, { ...base, "Content-Type": "text/event-stream", Connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ seq, ok: errors.length === 0 })}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (url.pathname === "/__intely/status") return void res.writeHead(200, { ...base, "Content-Type": "application/json" }).end(JSON.stringify({ seq, ok: errors.length === 0, errors, ms: lastMs }));
  const body = files.get(url.pathname);
  if (body) return void res.writeHead(200, { ...base, "Content-Type": MIME[path.extname(url.pathname)] ?? "application/octet-stream" }).end(Buffer.from(body));
  res.writeHead(404, base).end("not found");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
port = server.address().port;

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  watcher?.close();
  for (const res of clients) res.end();
  server.close();
  await ctx.dispose().catch(() => undefined);
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.stdin.on("end", shutdown);
process.stdin.on("error", shutdown);
process.stdin.resume();

out({ ready: true, port, engine, esbuild: version, react: reactVersion, installed: available, uses: { redux: libs.has("ReactRedux"), mui: libs.has("MuiStyles"), styled: libs.has("SC"), router: libs.has("RR") }, workdir, buildOk: errors.length === 0, ms: lastMs, entry });

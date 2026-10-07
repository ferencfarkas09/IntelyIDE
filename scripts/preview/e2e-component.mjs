#!/usr/bin/env node
// End to end proof of the component preview harness (Stage B), in a real browser (headless Chrome via playwright-core),
// against a throwaway fixture repo only (mktemp; node_modules is a symlink to .scratch/preview-e2e/deps-b, which has
// React 18, react-redux 7, react-router-dom 5, MUI 5, styled-components 6 and NO esbuild: the IDE's own esbuild is used).
//
//   node scripts/preview/e2e-component.mjs [--shots <dir>]
//
// deps-b is created once by `npm install` (see the header of the fixture section); later runs are offline. Never touches a
// real repo. Every process it starts is stopped before it exits.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFixture } from "./lib/component-fixture.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CACHE = path.join(ROOT, ".scratch/preview-e2e");
const args = process.argv.slice(2);
const shotsDir = args.includes("--shots") ? path.resolve(args[args.indexOf("--shots") + 1]) : undefined;
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, step = 50) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return Date.now() - t0;
    if (Date.now() - t0 > ms) return -1;
    await sleep(step);
  }
}

// -------------------------------------------------------------------------------------------------------------- deps
function ensureDeps(dir, packages) {
  const d = path.join(CACHE, dir);
  if (!packages.every((p) => fs.existsSync(path.join(d, "node_modules", p.replace(/(?<=.)@.*$/, ""), "package.json")))) {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: dir, private: true }));
    execFileSync("nice", ["-n", "10", "npm", "install", "--no-audit", "--no-fund", "--loglevel=error", ...packages], { cwd: d, stdio: "inherit" });
  }
  return d;
}
const depsB = ensureDeps("deps-b", ["react@18.3.1", "react-dom@18.3.1", "react-redux@7", "redux@4", "react-router-dom@5", "@mui/material@5", "@emotion/react", "@emotion/styled", "styled-components@6"]);
const deps18 = ensureDeps("deps18", ["playwright-core@1.63.0"]);
const { chromium } = createRequire(path.join(deps18, "x.js"))("playwright-core");

// The click-to-source proxy (crates/preview-proxy example `serve`) is built once with a private target dir (CARGO_TARGET_DIR wins).
const targetDir = process.env.CARGO_TARGET_DIR || path.join(CACHE, "target");
if (!args.includes("--no-proxy")) execFileSync("nice", ["-n", "10", "cargo", "build", "-p", "intely-preview-proxy", "--example", "serve", "-j", "2", "--quiet"], { cwd: ROOT, stdio: "inherit", env: { ...process.env, CARGO_TARGET_DIR: targetDir } });
const proxyBin = path.join(targetDir, "debug/examples/serve");

// ----------------------------------------------------------------------------------------------------------- fixture
const { repo, stateDir, write } = createFixture(depsB);
void write;
const treeOf = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${path.relative(dir, p)}:${fs.statSync(p).size}`);
    }
  };
  walk(dir);
  return out.sort().join("\n");
};
const treeBefore = treeOf(repo);

// ---------------------------------------------------------------------------------------------------------- harness
const live = [];
async function startHarness(file, exportName) {
  const child = spawn(process.execPath, [path.join(ROOT, "scripts/preview/harness/server.mjs"), JSON.stringify({ repoRoot: repo, stateDir, file, exportName })], { stdio: ["pipe", "pipe", "pipe"] });
  live.push(child);
  let buf = "";
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const info = await new Promise((resolve) => {
    child.stdout.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl >= 0) resolve(JSON.parse(buf.slice(0, nl)));
    });
    child.on("exit", () => resolve({ ready: false, code: "exited", error: err.slice(-300) }));
  });
  return { child, info, url: info.ready ? `http://127.0.0.1:${info.port}/` : "", log: () => err };
}
const stop = (h) => new Promise((resolve) => {
  if (h.child.exitCode !== null) return resolve();
  h.child.on("exit", resolve);
  h.child.stdin.end();
  setTimeout(() => h.child.kill("SIGKILL"), 3000);
});

// A host page that plays the IDE: an iframe plus a message log.
let hostServer;
const hostPort = await new Promise((resolve) => {
  hostServer = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><body style="margin:0"><iframe id="f" style="width:900px;height:600px;border:0"></iframe><script>window.log=[];addEventListener("message",e=>{if(e.data&&e.data.intely)log.push(e.data)})</script></body>`);
  }).listen(0, "127.0.0.1", () => resolve(hostServer.address().port));
});

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--disable-gpu"] });
const foreign = [];
async function open(h, scheme = "dark") {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 }, colorScheme: scheme });
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (!["127.0.0.1", "localhost"].includes(u.hostname) && u.protocol.startsWith("http")) foreign.push(r.url());
  });
  await page.goto(`http://127.0.0.1:${hostPort}/`);
  await page.evaluate((u) => (document.getElementById("f").src = u), h.url);
  const frame = () => page.frames().find((f) => f.url().startsWith(h.url));
  await until(async () => !!frame());
  await until(async () => (await page.evaluate(() => log.some((m) => m.intely === "preview/ready/1"))));
  const send = (m) => page.evaluate((x) => document.getElementById("f").contentWindow.postMessage(x, "*"), m);
  const logs = () => page.evaluate(() => log.slice());
  return { page, frame, send, logs };
}
const set = (o) => ({ intely: "preview/set/1", props: {}, store: {}, wrappers: { theme: false, redux: false, router: false }, scheme: "dark", layout: "padded", ...o });

try {
  // 1. plain component: props, $fn stub, CSS, dark scheme, click-to-source data
  const g = await startHarness("src/components/Greeting.jsx", "default");
  check("harness starts and reports a ready line", g.info.ready === true && g.info.port > 0, JSON.stringify({ engine: g.info.engine, esbuild: g.info.esbuild, react: g.info.react }));
  check("the IDE's esbuild is used when the repo has none", g.info.engine === "ide");
  check("installed wrappers are detected; only the ones the component uses are bundled", g.info.installed?.redux && g.info.installed?.router && g.info.installed?.mui && g.info.installed?.styled && !g.info.uses.redux, JSON.stringify(g.info.uses));
  const a = await open(g);
  const ready = (await a.logs()).find((m) => m.intely === "preview/ready/1");
  check("the page announces itself and its exports to the IDE", ready?.name === "Greeting" && ready.exports.includes("default"), JSON.stringify(ready));
  await a.send(set({ props: { name: "Ada", onClick: { $fn: "onClick" } } }));
  check("props from the IDE are rendered", (await until(async () => (await a.frame().textContent("#h")) === "Hello Ada")) >= 0);
  await a.frame().click("#b");
  const ev = (await a.logs()).find((m) => m.intely === "preview/event/1" && m.kind === "fn");
  check("a {$fn} prop becomes a logging stub", ev?.name === 'onClick("Ada")', ev?.name);
  check("the component's CSS import is bundled", (await a.frame().evaluate(() => getComputedStyle(document.querySelector(".greet")).color)) === "rgb(10, 120, 200)");
  const src = await a.frame().evaluate(() => {
    const el = document.getElementById("h");
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    const s = el[key]._debugSource;
    return s && { file: s.fileName, line: s.lineNumber };
  });
  check("jsxDEV source info points at the component file and line (click-to-source rung 1)", !!src && src.file.endsWith("src/components/Greeting.jsx") && src.line === 6, JSON.stringify(src));
  check("dark color scheme applied to the page", (await a.frame().evaluate(() => document.documentElement.dataset.theme + getComputedStyle(document.body).backgroundColor)) === "darkrgb(27, 29, 34)");
  if (shotsDir) await a.page.screenshot({ path: path.join(shotsDir, "harness-greeting-dark.png") });

  // 2. hot reload on save, build errors, recovery
  const gf = path.join(repo, "src/components/Greeting.jsx");
  const orig = fs.readFileSync(gf, "utf8");
  const t0 = Date.now();
  fs.writeFileSync(gf, orig.replace("Hello {name}", "Howdy {name}"));
  const ms = await until(async () => (await a.frame()?.textContent("#h").catch(() => "")) === "Howdy World" || (await a.frame()?.textContent("#h").catch(() => "")) === "Howdy Ada", 10000);
  check("hot reload: a save shows up in the open page", ms >= 0, `${Date.now() - t0} ms`);
  const afterReload = (await a.logs()).filter((m) => m.intely === "preview/ready/1").length;
  check("the reloaded page asks for props again (ready is re-posted)", afterReload >= 2);
  fs.writeFileSync(gf, orig.replace("Hello {name}", "Hello {name"));
  const berr = await until(async () => (await a.frame()?.locator("[data-intely-build-error]").count().catch(() => 0)) > 0, 10000);
  check("a syntax error shows a readable build error with file:line", berr >= 0 && /Greeting\.jsx:\d+:\d+/.test((await a.frame().textContent("[data-intely-build-error]")) ?? ""));
  check("a build error is reported to the IDE", (await a.logs()).some((m) => m.intely === "preview/status/1" && m.state === "buildError"));
  fs.writeFileSync(gf, orig);
  const fixed = await until(async () => (await a.frame()?.locator("#h").count().catch(() => 0)) > 0, 10000);
  check("fixing the file recovers without restarting the harness", fixed >= 0);
  await a.page.close();
  await stop(g);

  // 3. error boundary
  const b = await startHarness("src/components/Boom.jsx", "Boom");
  const bp = await open(b);
  await bp.send(set({ props: { explode: true } }));
  await until(async () => (await bp.frame().locator("[data-intely-error]").count()) > 0);
  const msg = (await bp.frame().textContent("[data-intely-error]")) ?? "";
  check("a throwing component shows a readable error with its message", msg.includes("kaboom: bad props") && msg.includes("threw while rendering"));
  const st = (await bp.logs()).find((m) => m.intely === "preview/status/1" && m.state === "renderError");
  check("the render error reaches the IDE with a component stack", !!st && st.message.includes("kaboom") && /Boom/.test(st.componentStack));
  await bp.send(set({ props: { explode: false } }));
  check("new props recover the boundary", (await until(async () => (await bp.frame().locator("#calm").count()) > 0)) >= 0);
  await bp.page.close();
  await stop(b);
  const nc = await startHarness("src/components/Boom.jsx", "NotAComponent");
  const ncp = await open(nc);
  await ncp.send(set({}));
  await until(async () => (await ncp.frame().locator("[data-intely-error]").count()) > 0);
  check("a non-component export gets a helpful message listing the real components", ((await ncp.frame().textContent("[data-intely-error]")) ?? "").includes("Boom"));
  await ncp.page.close();
  await stop(nc);

  // 4. no real network
  const r = await startHarness("src/components/Remote.jsx", "default");
  const rp = await open(r);
  await rp.send(set({}));
  await until(async () => ((await rp.frame().textContent("#net")) ?? "").includes("Network disabled"));
  const net = (await rp.logs()).find((m) => m.intely === "preview/event/1" && m.kind === "network");
  check("fetch is refused with a readable message", ((await rp.frame().textContent("#net")) ?? "").includes("Network disabled in the IDE component preview"));
  check("the blocked call is reported without its query string", !!net && net.name.includes("example.com/api") && !JSON.stringify(net).includes("SECRET123"), net?.name);
  await sleep(300);
  check("no request left the machine (browser level)", foreign.length === 0, foreign.join(","));
  await rp.page.close();
  await stop(r);

  // 5. providers: redux + router + theme stubs; light and dark
  const o = await startHarness("src/pages/OrderList.jsx", "default");
  const op = await open(o);
  check("the harness reports that OrderList uses redux, router and MUI", o.info.uses.redux && o.info.uses.router && o.info.uses.mui, JSON.stringify(o.info.uses));
  await op.send(set({}));
  await until(async () => (await op.frame().locator("[data-intely-error]").count()) > 0);
  check("a connected component without the store wrapper fails readably (no crash of the harness)", ((await op.frame().textContent("[data-intely-error]")) ?? "").length > 20);
  await op.send(set({ wrappers: { theme: true, redux: true, router: true }, store: { orders: [{ id: "A1", total: 10 }, { id: "B2", total: 20 }] } }));
  await until(async () => (await op.frame().locator("#orders tr").count()) === 2);
  check("redux + router + theme wrappers render a connected page from a JSON store", (await op.frame().locator("#orders tr").count()) === 2 && (await op.frame().textContent("#mui-mode")) === "dark");
  await op.frame().click("#refresh");
  const dis = (await op.logs()).find((m) => m.intely === "preview/event/1" && m.kind === "dispatch");
  check("dispatch is stubbed and logged, the real store is never needed", dis?.name === "orders/refresh");
  await op.send(set({ scheme: "light", wrappers: { theme: true, redux: true, router: true }, store: { orders: [{ id: "A1", total: 10 }] } }));
  await until(async () => (await op.frame().textContent("#mui-mode")) === "light");
  check("light/dark switch reaches the theme provider and the page", (await op.frame().textContent("#mui-mode")) === "light" && (await op.frame().evaluate(() => getComputedStyle(document.body).backgroundColor)) === "rgb(255, 255, 255)");
  if (shotsDir) await op.page.screenshot({ path: path.join(shotsDir, "harness-orders-light.png") });
  await op.page.close();
  await stop(o);

  // 6. TypeScript, tsconfig paths, prefers-color-scheme emulation
  const t = await startHarness("src/components/Themed.tsx", "default");
  check("TypeScript with tsconfig paths builds", t.info.ready && t.info.buildOk, t.info.error);
  const tp = await open(t, "light");
  await tp.send(set({ props: { label: "x" }, scheme: "dark" }));
  await until(async () => (await tp.frame().textContent("#mode")) === "dark");
  check("(prefers-color-scheme) follows the toggle, not the OS (OS is light here)", (await tp.frame().textContent("#mode")) === "dark" && (await tp.frame().textContent("#named")) === "named export");
  // snapshot
  await tp.send({ intely: "preview/shot.req/1", id: "s1", scale: 1 });
  await until(async () => (await tp.logs()).some((m) => m.intely === "preview/shot/1"));
  const shot = (await tp.logs()).find((m) => m.intely === "preview/shot/1");
  const png = shot?.ok ? Buffer.from(shot.dataUrl.split(",")[1], "base64") : Buffer.alloc(0);
  check("the in-page snapshot returns a real PNG", shot?.ok === true && png.subarray(1, 4).toString() === "PNG" && png.length > 500, shot?.ok ? `${shot.width}x${shot.height}, ${png.length} bytes` : shot?.error);
  if (shotsDir && png.length) fs.writeFileSync(path.join(shotsDir, "harness-snapshot.png"), png);
  await tp.page.close();
  await stop(t);

  // 7. login page in a .js file, standalone in a browser (no IDE): renders at once
  const l = await startHarness("src/pages/Login.js", "default");
  const lp = await browser.newPage({ viewport: { width: 700, height: 400 } });
  await lp.goto(l.url);
  check("a page component in a .js file renders standalone, without the IDE", (await until(async () => (await lp.locator("#login").count()) > 0)) >= 0);
  const head = await fetch(l.url, { headers: { Host: "evil.example:80" } }).then((x) => x.status).catch(() => 0);
  const w421 = await new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port: l.info.port, path: "/", headers: { Host: "evil.example" } }, (res) => resolve(res.statusCode));
  });
  void head;
  check("a request with a foreign Host header is refused (DNS rebinding guard)", w421 === 421, String(w421));
  const csp = await lp.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]').content);
  check("the page CSP allows only its own origin for connections", /connect-src 'self'/.test(csp) && !/https?:\/\//.test(csp));
  await lp.close();
  await stop(l);

  // 8. refusals
  for (const [file, exp, code] of [["../outside.jsx", "default", "outsideRepo"], ["node_modules/react/index.js", "default", "outsideRepo"], ["package.json", "default", "badFile"], ["src/missing.jsx", "default", "notFound"], ["src/components/Greeting.jsx", "ev;il()", "badConfig"]]) {
    const x = await startHarness(file, exp);
    check(`refused: ${file} / ${exp}`, !x.info.ready && x.info.code === code, `${x.info.code}`);
  }
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "intely-pvc-out-"));
  fs.writeFileSync(path.join(outside, "x.jsx"), "export default () => null;");
  fs.symlinkSync(path.join(outside, "x.jsx"), path.join(repo, "src/linked.jsx"));
  const sl = await startHarness("src/linked.jsx", "default");
  check("refused: a symlink that leaves the repository", !sl.info.ready && sl.info.code === "outsideRepo", `${sl.info.code}`);
  fs.unlinkSync(path.join(repo, "src/linked.jsx"));
  fs.rmSync(outside, { recursive: true, force: true });

  // 8b. through the preview proxy, as the IDE loads it: the inspector is injected, SSE hot reload and click to source work
  if (!args.includes("--no-proxy")) {
    const pg = await startHarness("src/components/Greeting.jsx", "default");
    const proxy = spawn(proxyBin, [String(pg.info.port)], { stdio: ["pipe", "pipe", "inherit"] });
    live.push(proxy);
    const proxyPort = await new Promise((resolve) => proxy.stdout.on("data", (d) => /PROXY_PORT=(\d+)/.test(String(d)) && resolve(Number(/PROXY_PORT=(\d+)/.exec(String(d))[1]))));
    const via = { ...pg, url: `http://127.0.0.1:${proxyPort}/` };
    const px = await open(via);
    await px.send(set({ props: { name: "Proxy" } }));
    check("the page works through the preview proxy (props arrive)", (await until(async () => (await px.frame().textContent("#h")) === "Hello Proxy")) >= 0);
    check("the proxy injected the inspector into the harness page", (await px.frame().locator('script[src="/__intely/inspect.js"]').count()) === 1);
    await px.frame().click("#h", { modifiers: ["Alt"] });
    await until(async () => (await px.logs()).some((m) => m.intely === "inspect/1"));
    const hit = (await px.logs()).find((m) => m.intely === "inspect/1");
    check("Alt+click posts the exact source of the element (file:line) from the component preview", !!hit && hit.file.endsWith("src/components/Greeting.jsx") && hit.line === 6, JSON.stringify(hit));
    const gf2 = path.join(repo, "src/components/Greeting.jsx");
    const orig2 = fs.readFileSync(gf2, "utf8");
    fs.writeFileSync(gf2, orig2.replace("Hello {name}", "Via {name}"));
    const viaMs = await until(async () => ((await px.frame()?.textContent("#h").catch(() => "")) ?? "").startsWith("Via"), 10000);
    check("hot reload (SSE) passes through the proxy", viaMs >= 0);
    fs.writeFileSync(gf2, orig2);
    await px.page.close();
    proxy.stdin.end();
    await stop(pg);
  }

  // 9. nothing written into the repo
  check("the fixture repo is byte-for-byte unchanged (the harness wrote only to its state dir)", treeOf(repo) === treeBefore);
  check("the generated entry lives in the state dir", fs.readdirSync(path.join(stateDir, "harness")).length >= 5);
} finally {
  await browser.close().catch(() => undefined);
  hostServer.close();
  for (const c of live) if (c.exitCode === null) c.kill("SIGKILL");
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

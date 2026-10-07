#!/usr/bin/env node
// End to end proof of click-to-source in a real browser (headless Chrome via playwright-core), against throwaway
// fixtures only: a tiny React app is built into a temp dir, served on loopback by a stand-in "dev server"
// (HTML, bundle, SSE /__webpack_hmr, WebSocket /ws, X-Frame-Options: DENY), fronted by the Rust preview proxy
// (crates/preview-proxy, example `serve`), and embedded in a host page that plays the IDE (iframe + message listener).
//
//   node scripts/preview/e2e-inspect.mjs [--only <variant>] [--shots <dir>]
//
// Variants: babel-classic (admin's way: Babel preset-react development:true, React 18), esbuild-dev (jsxDEV, React 18),
// no-source (React 18, no plugin: name fallback), react19-stack (React 19 _debugStack + linked source map).
// First run installs the fixture dependencies into .scratch/preview-e2e (network), later runs are offline.
// Never touches a real repo; every process it starts is stopped before it exits.

import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CACHE = path.join(ROOT, ".scratch/preview-e2e");
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
const shotsDir = args.includes("--shots") ? path.resolve(args[args.indexOf("--shots") + 1]) : undefined;
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

// ---------------------------------------------------------------------------------------------------------------- setup

function ensureDeps(dir, packages) {
  const d = path.join(CACHE, dir);
  const have = (pkg) => fs.existsSync(path.join(d, "node_modules", pkg.replace(/(?<=.)@.*$/, ""), "package.json"));
  if (!packages.every(have)) {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: dir, private: true }));
    execFileSync("nice", ["-n", "10", "npm", "install", "--no-audit", "--no-fund", "--loglevel=error", ...packages], { cwd: d, stdio: "inherit" });
  }
  return d;
}

const deps18 = ensureDeps("deps18", ["react@18.3.1", "react-dom@18.3.1", "esbuild", "@babel/core@7", "@babel/preset-react@7", "playwright-core@1.63.0"]);
const deps19 = ensureDeps("deps19", ["react@19", "react-dom@19", "esbuild"]);
const req18 = createRequire(path.join(deps18, "x.js"));
const req19 = createRequire(path.join(deps19, "x.js"));
const { chromium } = req18("playwright-core");

const targetDir = process.env.CARGO_TARGET_DIR || path.join(CACHE, "target");
execFileSync("nice", ["-n", "10", "cargo", "build", "-p", "intely-preview-proxy", "--example", "serve", "-j", "2", "--quiet"], { cwd: ROOT, stdio: "inherit", env: { ...process.env, CARGO_TARGET_DIR: targetDir } });
const proxyBin = path.join(targetDir, "debug/examples/serve");

const APP = `import React, { useState } from "react";
import { createRoot } from "react-dom/client";

function Greeting({ name }) {
  return <h1 id="greet">Hello {name}</h1>;
}

function Counter() {
  const [n, setN] = useState(0);
  return (
    <div id="box">
      <button id="inc" onClick={() => setN(n + 1)}>count {n}</button>
    </div>
  );
}

export default function App() {
  return (
    <main>
      <Greeting name="IDE" />
      <Counter />
      <a id="lnk" href="#clicked">link</a>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
`;
const lineOf = (needle) => APP.split("\n").findIndex((l) => l.includes(needle)) + 1;

const VARIANTS = {
  "babel-classic": {
    deps: deps18,
    req: req18,
    exact: true,
    async build(tmp, esbuild) {
      const babel = req18("@babel/core");
      const file = path.join(tmp, "src/App.jsx");
      const out = babel.transformSync(APP, { filename: file, configFile: false, babelrc: false, sourceType: "module", presets: [[req18.resolve("@babel/preset-react"), { development: true }]] }).code;
      fs.writeFileSync(path.join(tmp, "build/App.compiled.js"), out);
      await esbuild.build({ entryPoints: [path.join(tmp, "build/App.compiled.js")], bundle: true, outfile: path.join(tmp, "build/bundle.js"), define: { "process.env.NODE_ENV": '"development"' }, nodePaths: [path.join(deps18, "node_modules")], logLevel: "error" });
    },
  },
  "esbuild-dev": {
    deps: deps18,
    req: req18,
    exact: true,
    async build(tmp, esbuild) {
      await esbuild.build({ entryPoints: [path.join(tmp, "src/App.jsx")], bundle: true, outfile: path.join(tmp, "build/bundle.js"), jsx: "automatic", jsxDev: true, define: { "process.env.NODE_ENV": '"development"' }, nodePaths: [path.join(deps18, "node_modules")], logLevel: "error" });
    },
  },
  "no-source": {
    deps: deps18,
    req: req18,
    exact: false,
    async build(tmp, esbuild) {
      await esbuild.build({ entryPoints: [path.join(tmp, "src/App.jsx")], bundle: true, outfile: path.join(tmp, "build/bundle.js"), jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' }, nodePaths: [path.join(deps18, "node_modules")], logLevel: "error" });
    },
  },
  "react19-stack": {
    deps: deps19,
    req: req19,
    exact: true,
    async build(tmp, esbuild) {
      await esbuild.build({ entryPoints: [path.join(tmp, "src/App.jsx")], bundle: true, outfile: path.join(tmp, "build/bundle.js"), sourcemap: "linked", jsx: "automatic", jsxDev: true, define: { "process.env.NODE_ENV": '"development"' }, nodePaths: [path.join(deps19, "node_modules")], logLevel: "error" });
    },
  },
};

// ------------------------------------------------------------------------------------------------- stand-in dev server

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function devServer(buildDir) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (status, type, body, extra = {}) => (res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body), ...extra }), res.end(body));
    if (url.pathname === "/") {
      return send(200, "text/html; charset=utf-8", '<!doctype html><html><head><meta charset="utf-8"><title>fixture</title></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>', { "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" });
    }
    if (url.pathname === "/bundle.js" || url.pathname === "/bundle.js.map") {
      const f = path.join(buildDir, url.pathname);
      return fs.existsSync(f) ? send(200, url.pathname.endsWith(".map") ? "application/json" : "text/javascript", fs.readFileSync(f)) : send(404, "text/plain", "no");
    }
    if (url.pathname === "/__webpack_hmr") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      let n = 0;
      const t = setInterval(() => res.write(`data: {"action":"sync","n":${++n}}\n\n`), 200);
      return req.on("close", () => clearInterval(t));
    }
    send(404, "text/plain", "no");
  });
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${crypto.createHash("sha1").update(key + GUID).digest("base64")}\r\n\r\n`);
    const frame = (text) => Buffer.concat([Buffer.from([0x81, Buffer.byteLength(text)]), Buffer.from(text)]);
    socket.write(frame("hello"));
    socket.on("data", (buf) => {
      if ((buf[0] & 0x0f) !== 1) return;
      const len = buf[1] & 0x7f;
      const mask = buf.subarray(2, 6);
      const payload = Buffer.from(buf.subarray(6, 6 + len).map((b, i) => b ^ mask[i % 4]));
      socket.write(frame(`echo:${payload.toString()}`));
    });
    socket.on("error", () => {});
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

function hostServer(proxyPort) {
  const html = `<!doctype html><html><body style="margin:0;font:14px system-ui"><div style="padding:6px 10px;background:#222;color:#ddd">IDE stand-in host (preview below)</div>
<iframe data-intely-preview data-repo-id="fixture" src="http://127.0.0.1:${proxyPort}/" style="width:900px;height:420px;border:0"></iframe>
<script>window.__msgs=[];addEventListener("message",e=>__msgs.push({origin:e.origin,fromFrame:e.source===document.querySelector("iframe").contentWindow,data:e.data}));</script></body></html>`;
  const server = http.createServer((_, res) => (res.writeHead(200, { "Content-Type": "text/html" }), res.end(html)));
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

function startProxy(upstreamPort) {
  const child = spawn(proxyBin, [String(upstreamPort)], { stdio: ["pipe", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      const m = /PROXY_PORT=(\d+)/.exec(buf);
      if (m) resolve({ child, port: Number(m[1]) });
    });
    child.on("error", reject);
    setTimeout(() => reject(new Error("proxy did not start")), 15000);
  });
}

const stopProxy = (p) =>
  new Promise((resolve) => {
    p.child.once("exit", resolve);
    p.child.stdin.end();
    setTimeout(() => (p.child.kill("SIGKILL"), resolve()), 3000);
  });

// ------------------------------------------------------------------------------------------------------------ one variant

async function runVariant(name, v, browser, firstRun) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "intely-preview-e2e-"));
  const cleanups = [];
  try {
    fs.mkdirSync(path.join(tmp, "src"));
    fs.mkdirSync(path.join(tmp, "build"));
    fs.writeFileSync(path.join(tmp, "src/App.jsx"), APP);
    await v.build(tmp, v.req("esbuild"));

    const dev = await devServer(path.join(tmp, "build"));
    cleanups.push(() => dev.server.close());
    const proxy = await startProxy(dev.port);
    cleanups.push(() => stopProxy(proxy));
    const host = await hostServer(proxy.port);
    cleanups.push(() => host.server.close());

    const page = await browser.newPage({ viewport: { width: 900, height: 470 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${host.port}/host.html`);
    const frame = await (await page.waitForSelector("iframe")).contentFrame();
    await frame.waitForSelector("#inc", { timeout: 15000 });
    const label = (s) => `[${name}] ${s}`;
    const msgs = () => page.evaluate(() => window.__msgs);
    const text = (sel) => frame.locator(sel).innerText();
    const waitMsgs = async (n) => {
      for (let i = 0; i < 60; i++) {
        const m = await msgs();
        if (m.length >= n) return m;
        await page.waitForTimeout(100);
      }
      return msgs();
    };

    check(label("X-Frame-Options: DENY is stripped, so the frame renders"), (await text("#inc")).startsWith("count"));
    check(label("inspector script was injected and served by the proxy"), await frame.evaluate(() => !!window.__INTELY_INSPECT__ && !!document.querySelector("script[data-intely]")));

    // a plain click is the app's click
    await frame.click("#inc");
    check(label("plain click reaches the app (count 1) and sends nothing"), (await text("#inc")) === "count 1" && (await msgs()).length === 0);

    // Alt+click on the button
    await frame.click("#inc", { modifiers: ["Alt"] });
    let m = await waitMsgs(1);
    check(label("Alt+click does not trigger the app's own handler"), (await text("#inc")) === "count 1");
    const d = m[0]?.data;
    check(label("message came from the preview frame at the proxy origin"), m[0]?.fromFrame === true && m[0]?.origin === `http://127.0.0.1:${proxy.port}`);
    check(label("message carries exactly {intely,file,line,col,componentName}"), !!d && Object.keys(d).sort().join() === "col,componentName,file,intely,line", JSON.stringify(d));
    if (v.exact) {
      check(label("button maps to its file and line"), d?.file.endsWith("src/App.jsx") && d.line === lineOf('<button id="inc"') && d.col > 0 && d.componentName === "Counter", `${d?.file}:${d?.line}:${d?.col} ${d?.componentName}`);
    } else {
      check(label("no source info: component name only"), d?.file === "" && d.line === 0 && d.col === 0 && d.componentName === "Counter", JSON.stringify(d));
    }

    // Cmd+click on the heading (a component rendered with a prop)
    await frame.click("#greet", { modifiers: ["Meta"] });
    m = await waitMsgs(2);
    const g = m[1]?.data;
    check(label("Cmd+click maps the heading to its component"), v.exact ? g?.file.endsWith("src/App.jsx") && g.line === lineOf('<h1 id="greet"') && g.componentName === "Greeting" : g?.componentName === "Greeting" && g.file === "", JSON.stringify(g));

    // links are not followed during an inspect click
    await frame.click("#lnk", { modifiers: ["Alt"] });
    await waitMsgs(3);
    check(label("Alt+click on a link does not navigate"), (await frame.evaluate(() => location.hash)) === "");

    // inspect mode from the host (the Inspect toggle)
    await page.evaluate(() => (document.querySelector("iframe").contentWindow.postMessage({ intely: "inspect.mode/1", on: true }, new URL(document.querySelector("iframe").src).origin), 0));
    await page.waitForTimeout(150);
    await frame.hover("#inc");
    const hl = await frame.evaluate(() => {
      const o = document.querySelector("[data-intely-overlay]");
      return o ? { display: o.style.display, label: o.textContent } : null;
    });
    check(label("inspect mode highlights the hovered element with its component name"), hl?.display === "block" && hl.label === "Counter", JSON.stringify(hl));
    if (shotsDir && firstRun) await page.screenshot({ path: path.join(shotsDir, `inspect-${name}.png`) });
    const before = (await msgs()).length;
    await frame.click("#inc");
    await waitMsgs(before + 1);
    check(label("in inspect mode a plain click maps and is swallowed"), (await msgs()).length === before + 1 && (await text("#inc")) === "count 1");
    await page.evaluate(() => document.querySelector("iframe").contentWindow.postMessage({ intely: "inspect.mode/1", on: false }, new URL(document.querySelector("iframe").src).origin));
    await page.waitForTimeout(150);
    await frame.click("#inc");
    check(label("inspect mode off: plain click is the app's again"), (await text("#inc")) === "count 2");

    // a page cannot switch inspect mode on for itself from another window, and the IDE message is origin-addressed
    check(label("no page errors"), errors.length === 0, errors.join(" | "));

    if (firstRun) {
      const sse = await frame.evaluate(
        () =>
          new Promise((resolve) => {
            const es = new EventSource("/__webpack_hmr");
            const t = [];
            es.onmessage = () => {
              t.push(performance.now());
              if (t.length === 4) (es.close(), resolve(t));
            };
            setTimeout(() => (es.close(), resolve(t)), 6000);
          }),
      );
      const gaps = sse.slice(1).map((x, i) => x - sse[i]);
      check(label("SSE /__webpack_hmr streams through the proxy event by event"), sse.length === 4 && gaps.every((g) => g > 80 && g < 1500), gaps.map(Math.round).join(","));
      const ws = await frame.evaluate(
        () =>
          new Promise((resolve) => {
            const got = [];
            const w = new WebSocket(`ws://${location.host}/ws`);
            w.onmessage = (e) => {
              got.push(e.data);
              if (e.data === "hello") w.send("ping");
              if (got.length === 2) (w.close(), resolve(got));
            };
            w.onerror = () => resolve(got);
            setTimeout(() => resolve(got), 6000);
          }),
      );
      check(label("WebSocket upgrade tunnels both ways"), ws.join() === "hello,echo:ping", ws.join());
    }
    await page.close();
  } finally {
    for (const c of cleanups.reverse()) await c();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------------------------------------------------------ main

// the installed Google Chrome, headless (the Playwright-bundled browser is not downloaded on this machine)
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--disable-gpu"] });
try {
  let first = true;
  for (const [name, v] of Object.entries(VARIANTS)) {
    if (only && only !== name) continue;
    try {
      await runVariant(name, v, browser, first);
    } catch (e) {
      check(`[${name}] ran to the end`, false, String(e?.stack || e).split("\n").slice(0, 3).join(" "));
    }
    first = false;
  }
} finally {
  await browser.close();
}
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
process.exit(bad.length ? 1 : 0);

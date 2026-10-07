#!/usr/bin/env node
// Screenshots of the component preview tab in the mock UI (Vite dev server on :1420 or --url), headless Chrome only, never a
// desktop capture. A throwaway fixture repo and the real harness run on loopback; the mock UI opens the tab and loads the frame
// from `?harness=`. Output: <dir>/<screen>-<theme>-<lang>.png
//
//   node scripts/preview/shots-component.mjs --dir .scratch/pvc-shots [--url http://localhost:1420]
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFixture } from "./lib/component-fixture.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const dir = path.resolve(arg("--dir", path.join(ROOT, ".scratch/pvc-shots")));
const base = arg("--url", "http://localhost:1420");
fs.mkdirSync(dir, { recursive: true });
const depsB = path.join(ROOT, ".scratch/preview-e2e/deps-b");
const { chromium } = createRequire(path.join(ROOT, ".scratch/preview-e2e/deps18/x.js"))("playwright-core");
const { repo, stateDir, write } = createFixture(depsB);
write("src/components/Boom.jsx", `import React from "react";\nexport default function Boom({ explode = true, label = "Order total" }) {\n  if (explode) throw new Error("Cannot read properties of undefined (reading 'total')");\n  return <b>{label}</b>;\n}\n`);
write("src/components/Remote.jsx", `import React, { useEffect, useState } from "react";\nexport default function Remote({ title = "Live prices" }) {\n  const [msg, setMsg] = useState("loading...");\n  useEffect(() => { fetch("https://api.example.com/prices?token=abc").catch((e) => setMsg(e.message)); }, []);\n  return <section><h3>{title}</h3><p>{msg}</p></section>;\n}\n`);
write("src/components/Table.jsx", `import React from "react";\nexport default function Table({ rows = [], title = "Orders", onSelect }) {\n  return (\n    <div style={{ font: "14px system-ui", maxWidth: 560 }}>\n      <h3 style={{ margin: "0 0 8px" }}>{title}</h3>\n      <table style={{ width: "100%", borderCollapse: "collapse" }}>\n        <tbody>{rows.map((r) => <tr key={r.id} onClick={() => onSelect && onSelect(r.id)} style={{ borderBottom: "1px solid #8884" }}><td style={{ padding: 6 }}>{r.id}</td><td>{r.customer}</td><td style={{ textAlign: "right" }}>{r.total}</td></tr>)}</tbody>\n      </table>\n    </div>\n  );\n}\n`);

const live = [];
async function harness(file) {
  const child = spawn(process.execPath, [path.join(ROOT, "scripts/preview/harness/server.mjs"), JSON.stringify({ repoRoot: repo, stateDir, file, exportName: "default" })], { stdio: ["pipe", "pipe", "inherit"] });
  live.push(child);
  const info = await new Promise((resolve) => child.stdout.on("data", (d) => resolve(JSON.parse(String(d).split("\n")[0]))));
  return { info, source: fs.readFileSync(path.join(repo, file), "utf8"), file };
}

const SCREENS = [
  { name: "orders", file: "src/pages/OrderList.jsx", props: {}, store: { orders: [{ id: "A-1042", total: 1890 }, { id: "A-1043", total: 450 }, { id: "A-1044", total: 12990 }] }, tab: "props", viewport: "fit", scheme: "dark" },
  { name: "table", file: "src/components/Table.jsx", props: { title: "Open orders", rows: [{ id: "A-1042", customer: "Kovács Bt.", total: "1 890 Ft" }, { id: "A-1043", customer: "Szabó és Társa", total: "450 Ft" }], onSelect: { $fn: "onSelect" } }, tab: "props", viewport: "fit", scheme: "dark" },
  { name: "login-phone", file: "src/pages/Login.js", props: { title: "Bejelentkezés" }, tab: "props", viewport: "phone", layout: "full", scheme: "light" },
  { name: "error", file: "src/components/Boom.jsx", props: { explode: true }, tab: "props", viewport: "fit", scheme: "dark" },
  { name: "events", file: "src/components/Remote.jsx", props: {}, tab: "events", viewport: "fit", scheme: "dark" },
  { name: "badjson", file: "src/components/Greeting.jsx", props: null, rawProps: '{\n  "name": "Ada",\n  "onClick": \n}', tab: "props", viewport: "tablet", scheme: "dark" },
];

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--disable-gpu"] });
const problems = [];
try {
  const servers = new Map();
  for (const s of SCREENS) if (!servers.has(s.file)) servers.set(s.file, await harness(s.file));
  for (const lang of ["en", "hu"]) {
    for (const theme of ["dark", "light"]) {
      for (const s of SCREENS) {
        for (let attempt = 0; attempt < 3; attempt++) {
        try {
        if (lang === "hu" && !["orders", "login-phone", "events"].includes(s.name)) continue;
        if (theme === "light" && !["orders", "table", "login-phone"].includes(s.name)) continue;
        const h = servers.get(s.file);
        const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, colorScheme: theme });
        await ctx.addInitScript(([l, t]) => { localStorage.setItem("intely.locale", l); localStorage.setItem("intely.theme", t); localStorage.removeItem("intely.extra.previewComponent"); }, [lang, theme]);
        const page = await ctx.newPage();
        page.on("pageerror", (e) => problems.push(`${s.name}/${theme}/${lang}: ${e.message}`));
        page.on("console", (m) => m.type() === "error" && !/Failed to load resource|favicon/.test(m.text()) && problems.push(`${s.name}/${theme}/${lang} console: ${m.text().slice(0, 200)}`));
        await page.goto(`${base}/?scenario=normal&harness=${encodeURIComponent(`http://127.0.0.1:${h.info.port}`)}`);
        await page.waitForTimeout(1500);
        await page.evaluate(async ({ source, file, props, store, viewport, layout, scheme, theme, rawProps }) => {
          // Vite stamps modules with ?t=<hmr time> after a hot update: import the very URLs the app loaded, or this is a second instance.
          const urls = performance.getEntriesByType("resource").map((e) => e.name);
          const load = (re, fallback) => import(urls.find((u) => re.test(u)) ?? fallback);
          const { ipc } = await load(/\/src\/ipc\/index\.ts/, "/src/ipc/index.ts");
          const tabs = await load(/\/src\/platform\/tabs\.ts/, "/src/platform/tabs.ts");
          const ws = await load(/\/src\/store\/workspace\.ts/, "/src/store/workspace.ts");
          const themeMod = await load(/\/src\/theme\/theme\.ts/, "/src/theme/theme.ts");
          themeMod.setThemePreference?.(theme);
          for (let i = 0; i < 60 && ws.repos().length === 0; i++) await new Promise((r) => setTimeout(r, 100));
          const repoId = ws.repos()[0]?.id ?? "mock-repo";
          ipc.files.readFile = async () => ({ text: source });
          const key = `component:${repoId}:${file}#default`;
          await ipc.settings.set("preview", { [key]: { scheme, viewport, layout: layout ?? "padded", ...(props ? { props: JSON.stringify(props, null, 2) } : {}), ...(rawProps ? { props: rawProps } : {}), ...(store ? { store: JSON.stringify(store, null, 2) } : {}) } });
          tabs.openTab({ type: "preview-component", id: `previewc:${repoId}:${file}`, title: file, params: { repoId, path: file, export: "default" } });
        }, { source: h.source, file: s.file, props: s.props, store: s.store, viewport: s.viewport, layout: s.layout, scheme: s.scheme === "light" || theme === "light" ? "light" : "dark", theme, rawProps: s.rawProps });
        await page.waitForSelector('[data-testid="component-preview"][data-phase="ready"]', { timeout: 15000 }).catch(() => problems.push(`${s.name}/${theme}/${lang}: never reached ready`));
        await page.waitForTimeout(1800);
        if (s.tab === "events") await page.getByRole("radio", { name: /Events|Események/ }).click().catch(() => {});
        if (s.name === "orders") await page.getByRole("radio", { name: /Store|Store/ }).first().click().catch(() => {});
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(dir, `${s.name}-${theme}-${lang}.png`) });
        await ctx.close();
        break;
        } catch (e) {
          problems.push(`${s.name}/${theme}/${lang} attempt ${attempt}: ${String(e.message).split("\n")[0]}`);
        }
        }
      }
    }
  }
} finally {
  await browser.close();
  for (const c of live) if (c.exitCode === null) c.stdin.end();
  setTimeout(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
    for (const c of live) c.kill("SIGKILL");
    console.log(problems.length ? `PROBLEMS:\n${problems.join("\n")}` : "no page errors");
    process.exit(0);
  }, 1500);
}

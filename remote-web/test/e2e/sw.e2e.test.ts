// The REAL service worker (built dist/sw.js) in headless Chrome against a loopback static server. No wrangler, no relay, no network
// beyond 127.0.0.1. Builds are re-signed here with throwaway keys, so this does not depend on the key of `pnpm build`.
// Covers: verified shell install, pin upgrade, offline start from the verified cache, refusal of a wrong key / tampered file /
// older seq (the verified copy keeps serving), and a legitimate new build that waits for "reload". iOS Safari is NOT covered.
import { cpSync, createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { webRoot } from "../support/relay";

/* eslint-disable @typescript-eslint/no-explicit-any */
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".woff2": "font/woff2" };

let lib: any;
let tmp: string;
let server: Server;
let base = "";
let root = "";
let dead = false;
let browser: Browser;
let ctx: BrowserContext;
let page: Page;
const sites: Record<string, { dir: string; hash: string; pub: string }> = {};
const consoleErrors: string[] = [];

/** Copies the built dist, adds `extra` files, re-signs it with `pem` at `seq`. */
function makeSite(name: string, pem: string, seq: number, extra: Record<string, string> = {}, tamper?: (dir: string) => void) {
  const dir = join(tmp, name);
  cpSync(join(webRoot, "dist"), dir, { recursive: true });
  rmSync(join(dir, "bundle.json"));
  for (const [p, c] of Object.entries(extra)) writeFileSync(join(dir, p), c);
  const b = lib.signBundle(dir, pem, { seq });
  writeFileSync(join(dir, "bundle.json"), JSON.stringify(b));
  tamper?.(dir);
  sites[name] = { dir, hash: b.manifestSha256, pub: b.pubkey };
}

const idb = (key: string) =>
  page.evaluate(
    (k) =>
      new Promise<any>((res) => {
        indexedDB.databases().then((dbs) => {
          if (!dbs.some((d) => d.name === "intely-pin")) return res(null);
          const r = indexedDB.open("intely-pin");
          r.onsuccess = () => {
            const db = r.result;
            try {
              const q = db.transaction("pin").objectStore("pin").get(k);
              q.onsuccess = () => (db.close(), res(q.result ?? null));
              q.onerror = () => (db.close(), res(null));
            } catch {
              db.close();
              res(null);
            }
          };
          r.onerror = () => res(null);
        });
      }),
    key,
  );

const poll = (fn: () => unknown, timeout = 20_000) => expect.poll(fn as () => Promise<unknown> | unknown, { timeout, interval: 150 });
const runningHash = () => page.evaluate(async () => (await (await fetch("/bundle.json", { cache: "no-store" })).json()).manifestSha256 as string);
const listen = () =>
  page.evaluate(() => {
    (window as any).__msgs = [];
    navigator.serviceWorker.addEventListener("message", (e) => (window as any).__msgs.push(e.data));
  });
const askCheck = async () => {
  if (!(await page.evaluate(() => !!(window as any).__msgs))) await listen(); // a reload drops the listener
  await page.evaluate(() => navigator.serviceWorker.controller?.postMessage({ type: "check" }));
};
const lastMsg = () => page.evaluate(() => (window as any).__msgs.filter((m: any) => m.type === "verify").at(-1) ?? null);

beforeAll(async () => {
  expect(existsSync(join(webRoot, "dist/sw.js"))).toBe(true); // run `pnpm build` first
  lib = await import(pathToFileURL(join(webRoot, "../remote-relay/scripts/bundle-lib.mjs")).href);
  tmp = mkdtempSync(join(tmpdir(), "intely-sw-e2e-"));
  const k1 = lib.newKeyPem();
  const k2 = lib.newKeyPem();
  makeSite("s1", k1, 1000);
  makeSite("s2", k1, 2000, { "build.txt": "second build\n" });
  makeSite("wrongKey", k2, 3000);
  makeSite("tampered", k1, 2500, { "build.txt": "x\n" }, (d) => writeFileSync(join(d, "build.txt"), "changed after signing\n"));
  makeSite("old", k1, 500);
  root = sites.s1!.dir;

  const headers = Object.fromEntries(
    readFileSync(join(webRoot, "dist/_headers"), "utf8")
      .split("\n")
      .filter((l) => /^\s+\S+:/.test(l))
      .map((l) => l.trim().split(/:\s+/, 2) as [string, string]),
  );
  server = createServer((req, res) => {
    if (dead) return void req.socket.destroy();
    const url = new URL(req.url ?? "/", "http://x");
    let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    if (p === "/" || p.endsWith("/")) p += "index.html";
    let file = join(root, p);
    if (!existsSync(file) || !statSync(file).isFile()) file = join(root, "index.html"); // SPA
    res.writeHead(200, { ...headers, "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const executablePath = process.env.INTELY_CHROME ?? join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-x64/chrome-headless-shell");
  browser = await chromium.launch({ headless: true, executablePath });
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "allow" });
  page = await ctx.newPage();
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
});

afterAll(async () => {
  await ctx?.close();
  await browser?.close();
  await new Promise((r) => server?.close(r));
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("service worker in a real browser (order matters)", () => {
  it("first visit: downloads, verifies and installs the shell (hash-only, no pin yet)", async () => {
    await page.goto(base + "/");
    await page.getByRole("heading", { name: "IntelyIDE Remote" }).waitFor();
    await poll(async () => (await idb("activeShell"))?.hash).toBe(sites.s1!.hash);
    expect((await idb("activeShell")).signed).toBe(false);
    await page.reload(); // now controlled
    await poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await listen();
  });

  it("pairing writes the pin: the cached shell is re-verified under it and becomes signed", async () => {
    await page.evaluate(
      (pub) =>
        new Promise<void>((res) => {
          const r = indexedDB.open("intely-pin", 1);
          r.onupgradeneeded = () => void r.result.createObjectStore("pin");
          r.onsuccess = () => {
            const tx = r.result.transaction("pin", "readwrite");
            const s = tx.objectStore("pin");
            s.put(pub, "bundlePub");
            s.put(0, "maxSeq");
            s.put(location.host, "relayHost");
            tx.oncomplete = () => (r.result.close(), res());
          };
        }).then(() => navigator.serviceWorker.controller?.postMessage({ type: "pin-updated" })),
      sites.s1!.pub,
    );
    await poll(async () => (await idb("activeShell"))?.signed).toBe(true);
    expect(await idb("maxSeq")).toBe(1000);
  });

  it("starts offline from the verified cache (navigation is cache-first)", async () => {
    dead = true;
    try {
      await page.reload();
      await page.getByRole("heading", { name: "IntelyIDE Remote" }).waitFor({ timeout: 15_000 });
      expect(await runningHash()).toBe(sites.s1!.hash); // /bundle.json answered from the running shell
    } finally {
      dead = false;
    }
  });

  it("refuses a build signed by another key and keeps serving the verified one", async () => {
    root = sites.wrongKey!.dir;
    await askCheck();
    await poll(async () => (await lastMsg())?.reason).toBe("keyMismatch");
    expect((await idb("activeShell")).hash).toBe(sites.s1!.hash);
    expect(await idb("pendingShell")).toBeNull();
  });

  it("refuses a build whose file differs from its signed manifest", async () => {
    root = sites.tampered!.dir;
    await askCheck();
    await poll(async () => (await lastMsg())?.reason).toBe("fileMismatch");
    expect(await idb("pendingShell")).toBeNull();
  });

  it("a legitimate newer build waits as pending, does not replace the running one, and activates after the reload tap", async () => {
    root = sites.s2!.dir;
    await askCheck();
    await poll(async () => (await idb("pendingShell"))?.hash).toBe(sites.s2!.hash);
    expect((await lastMsg()).pending).toBe(true);
    expect((await idb("activeShell")).hash).toBe(sites.s1!.hash);
    expect(await idb("maxSeq")).toBe(1000); // raised only on activation
    await page.reload();
    expect(await runningHash()).toBe(sites.s1!.hash); // still the old verified shell
    await listen();
    const reloaded = page.waitForEvent("load");
    await page.evaluate(() => navigator.serviceWorker.controller?.postMessage({ type: "activate" }));
    await reloaded;
    await poll(runningHash).toBe(sites.s2!.hash);
    expect(await idb("maxSeq")).toBe(2000);
    expect(await idb("pendingShell")).toBeNull();
    expect(await page.evaluate(() => caches.keys())).toEqual(["intely-shell-" + sites.s2!.hash]);
  });

  it("refuses an older signed build (downgrade) after a newer one was activated", async () => {
    root = sites.old!.dir;
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await listen();
    await askCheck();
    await poll(async () => (await lastMsg())?.reason).toBe("rollback");
    expect((await idb("activeShell")).hash).toBe(sites.s2!.hash);
  });

  it("had no page errors", () => {
    expect(consoleErrors).toEqual([]);
  });
});

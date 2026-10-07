// The PHONE and FIXTURE half of the `cf` scenario (scripts/e2e/run.sh --only cf; the Mac half is scripts/e2e/cf-remote.js). It runs
// the loopback relay (wrangler dev --local, 127.0.0.1 only, no Cloudflare variables) with the static assets taken from a FIXTURE
// directory that the fake wrangler fills when the app "deploys", the phone (headless Chrome against the PWA that relay serves), and a
// small file protocol with the Mac script (.cf-cmd / .cf-ack in a fixture repo; the page may not reach loopback, CSP).
// Nothing here contacts anything but 127.0.0.1. Needs: INTELY_CF_CONTROL (fixture repo dir), INTELY_CF_WORK (e2e dir, app.pid appears
// there), INTELY_CF_PORT, INTELY_CF_FAKE (fake wrangler dir), INTELY_CF_SERVE (the relay's asset dir), INTELY_CF_DATA, INTELY_CF_SHOTS.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { webRoot } from "../support/relay";

/* eslint-disable @typescript-eslint/no-explicit-any */
const env = (k: string): string => process.env[k] ?? "";
const CTL = env("INTELY_CF_CONTROL");
const WORK = env("INTELY_CF_WORK");
const PORT = Number(env("INTELY_CF_PORT"));
const FAKE = env("INTELY_CF_FAKE");
const SERVE = env("INTELY_CF_SERVE");
const DATA = env("INTELY_CF_DATA");
const SHOTS = env("INTELY_CF_SHOTS") || join(WORK, "shots");
const CMD = join(CTL, ".cf-cmd");
const ACK = join(CTL, ".cf-ack");
const RESULT = join(WORK, "driver-result.json");
mkdirSync(SHOTS, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const base = `http://127.0.0.1:${PORT}`;
let relay: ChildProcess | null = null;
let relayLog = "";
let relayTmp = "";
let browser: Browser;
let ctx: BrowserContext;
let page: Page;
const failures: string[] = [];
const results: Record<string, unknown> = {};
const foreign: string[] = [];
const violations: string[] = [];

const note = (name: string, ok: boolean, detail?: unknown) => {
  results[name] = { ok, detail: detail === undefined ? undefined : String(detail).slice(0, 400) };
  if (!ok) failures.push(`${name}: ${String(detail).slice(0, 300)}`);
};

const shot = async (name: string) => {
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await sleep(150);
    await page.screenshot({ path: join(SHOTS, `cf-phone-${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: "dark" });
};

const appPid = (): number => Number(readFileSync(join(WORK, "app.pid"), "utf8").trim());

/** `wrangler dev --local` on loopback, serving SERVE as the static assets (the relay Worker and Room are the real source). */
async function startRelay(): Promise<void> {
  relayTmp = mkdtempSync(join(tmpdir(), "intely-cf-relay-"));
  const relayRoot = join(webRoot, "../remote-relay");
  const bin = join(relayRoot, "node_modules", ".bin", "wrangler"); // dev --local only: never a deploy, never an account
  const args = ["dev", "--local", "--ip", "127.0.0.1", "--port", String(PORT), "--persist-to", join(relayTmp, "state"), "--assets", SERVE, "--inspector-port", "0", "--var", "JOIN_RATE_PER_MIN:1000"];
  const childEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: relayTmp,
    XDG_CONFIG_HOME: join(relayTmp, "xdg"),
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_LOG_PATH: join(relayTmp, "logs"),
    CI: "1",
    NO_COLOR: "1",
    WRANGLER_HIDE_BANNER: "true",
  } as NodeJS.ProcessEnv;
  relay = spawn(bin, args, { cwd: relayRoot, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  relay.stdout!.on("data", (d) => (relayLog += d));
  relay.stderr!.on("data", (d) => (relayLog += d));
  const t0 = Date.now();
  for (;;) {
    try {
      if ((await fetch(base + "/api/health")).ok) return;
    } catch {
      /* not up yet */
    }
    if (relay.exitCode !== null) throw new Error("the loopback relay exited early:\n" + relayLog.slice(-2000));
    if (Date.now() - t0 > 240_000) throw new Error("the loopback relay start timed out:\n" + relayLog.slice(-2000));
    await sleep(500);
  }
}

async function stopRelay(): Promise<void> {
  if (!relay) return;
  const r = relay;
  r.kill("SIGTERM");
  await new Promise<void>((res) => {
    const t = setTimeout(() => (r.kill("SIGKILL"), res()), 5000);
    r.on("exit", () => (clearTimeout(t), res()));
  });
  rmSync(relayTmp, { recursive: true, force: true });
}

beforeAll(async () => {
  await startRelay();
  const executablePath = process.env.INTELY_CHROME ?? join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-x64/chrome-headless-shell");
  browser = await chromium.launch({ headless: true, executablePath });
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "dark", serviceWorkers: "allow" });
  page = await ctx.newPage();
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (!["127.0.0.1", "localhost"].includes(u.hostname) && u.protocol.startsWith("http")) foreign.push(r.url());
  });
  await page.exposeFunction("__csp", (v: string) => violations.push(v));
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => (window as any).__csp(`${e.violatedDirective} ${e.blockedURI}`)));
  writeFileSync(join(WORK, "relay.ready"), base);
});

afterAll(async () => {
  note("the phone reached no host but loopback", foreign.length === 0, foreign.join(" "));
  note("no CSP violation on the phone", violations.length === 0, violations.join(" | "));
  writeFileSync(RESULT, JSON.stringify({ ok: failures.length === 0, failures, results }, null, 1));
  await ctx?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await stopRelay().catch(() => {});
  // The ACK stays: the app may still be polling for the answer to `bye` (a loaded machine read it too late once); run.sh removes both after the app exits.
  if (existsSync(CMD)) unlinkSync(CMD);
});

async function nextCmd(timeout = 420_000): Promise<{ name: string; arg: any }> {
  const t0 = Date.now();
  for (;;) {
    if (existsSync(CMD)) {
      const raw = readFileSync(CMD, "utf8").trim();
      if (raw.includes("|")) {
        unlinkSync(CMD);
        const i = raw.indexOf("|");
        return { name: raw.slice(0, i), arg: JSON.parse(raw.slice(i + 1) || "{}") };
      }
    }
    try {
      process.kill(appPid(), 0);
    } catch {
      if (existsSync(join(WORK, "app.pid"))) throw new Error("the app is gone");
    }
    if (Date.now() - t0 > timeout) throw new Error("the app sent no command for " + timeout / 1000 + " s");
    await sleep(120);
  }
}
const ackBack = (cmdLine: string, payload: unknown) => writeFileSync(ACK, JSON.stringify({ line: cmdLine, ...(payload as object) }) + "\n");

const group4 = (hex: string) => hex.slice(0, 16).match(/.{4}/g)!.join(" ");
const jsonOf = (f: string, d: any = null) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return d;
  }
};
const callsOf = (): any[] =>
  existsSync(join(FAKE, "calls.jsonl"))
    ? readFileSync(join(FAKE, "calls.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

/** Sockets of the app to the relay port and its thread count (the app must keep ONE process through the live apply). */
function sample(): { relaySockets: number; threads: number } {
  const pid = String(appPid());
  let lsof = "";
  try {
    lsof = execFileSync("lsof", ["-nP", "-a", "-p", pid, "-i"], { encoding: "utf8" });
  } catch {
    /* lsof exits 1 when nothing matches */
  }
  const lines = lsof.split("\n").slice(1).filter(Boolean);
  const threads = execFileSync("ps", ["-M", "-p", pid], { encoding: "utf8" }).split("\n").filter(Boolean).length - 1;
  return { relaySockets: lines.filter((l) => l.includes(`:${PORT}`)).length, threads };
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

/** Every regular file below `dir` (depth-limited), for the secret-leak scan. */
function filesBelow(dir: string, depth = 6): string[] {
  const out: string[] = [];
  const walk = (d: string, n: number) => {
    let names: string[] = [];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(d, name);
      let s;
      try {
        s = statSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        if (n > 0) walk(p, n - 1);
      } else if (s.isFile() && s.size < 8 << 20) out.push(p);
    }
  };
  walk(dir, depth);
  return out;
}

const listen = () =>
  page.evaluate(() => {
    (window as any).__msgs = [];
    navigator.serviceWorker.addEventListener("message", (e) => (window as any).__msgs.push(e.data));
  });
const askCheck = async () => {
  if (!(await page.evaluate(() => !!(window as any).__msgs))) await listen();
  await page.evaluate(() => {
    (window as any).__msgs.length = 0;
    navigator.serviceWorker.controller?.postMessage({ type: "check" });
  });
};
const lastVerify = () => page.evaluate(() => (window as any).__msgs.filter((m: any) => m.type === "verify").at(-1) ?? null);
async function pollFor<T>(fn: () => Promise<T | null | undefined | false>, what: string, timeout = 25_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error("timeout waiting for " + what);
    await sleep(150);
  }
}

it("drives the cloud set-up end to end (phone and fixture half)", async () => {
  let sasCode = "";
  for (;;) {
    const { name, arg } = await nextCmd();
    const line = `${name}|${JSON.stringify(arg)}`;
    try {
      switch (name) {
        case "hello": {
          const m = jsonOf(join(SERVE, "bundle.json"), {});
          ackBack(line, { base, serveHash: group4(m.manifestSha256 ?? "0".repeat(16)), serveFull: m.manifestSha256, serveSeq: m.seq });
          break;
        }
        case "scenario": {
          writeFileSync(join(FAKE, "scenario.json"), JSON.stringify(arg.set ?? {}));
          ackBack(line, { ok: true });
          break;
        }
        case "calls": {
          ackBack(line, { calls: callsOf().map((c) => ({ ts: c.ts, argv: c.argv, envNames: c.envNames, tokenInEnv: c.tokenInEnv, tokenMarkerInEnv: c.tokenMarkerInEnv, accountEnv: c.accountEnv, cwd: c.cwd, home: c.home, key: c.key, stdinSha256: c.stdinSha256, exit: c.exit })), secrets: jsonOf(join(FAKE, "secrets.json"), {}) });
          break;
        }
        case "staged": {
          const dir = join(DATA, "relay-deploy", arg.worker, "dist");
          const m = jsonOf(join(dir, "bundle.json"), null);
          const served = jsonOf(join(SERVE, "bundle.json"), null);
          const push = jsonOf(join(dir, "push-config.json"), null);
          ackBack(line, { staged: m && { manifestSha256: m.manifestSha256, pubkey: m.pubkey, seq: m.seq, v: m.v }, served: served && { manifestSha256: served.manifestSha256, pubkey: served.pubkey }, vapidPublic: push?.vapidPublicKey ?? null, group: m ? group4(m.manifestSha256) : null });
          break;
        }
        case "leaks": {
          // a marker that must not appear in any file the app wrote (settings, state dir, logs, ops log) or in the app's output
          const hits: string[] = [];
          for (const root of [DATA]) {
            for (const f of filesBelow(root)) {
              try {
                if (readFileSync(f).includes(arg.marker)) hits.push(f.replace(DATA, "<data>"));
              } catch {
                /* unreadable */
              }
            }
          }
          for (const f of ["stdout.txt", "stderr.txt"]) {
            const p = join(WORK, f);
            if (existsSync(p) && readFileSync(p).includes(arg.marker)) hits.push(f);
          }
          const opsPath = join(DATA, "relay-deploy", "ops.jsonl");
          ackBack(line, { hits: [...new Set(hits)], ops: existsSync(opsPath) ? readFileSync(opsPath, "utf8").split("\n").filter(Boolean).length : 0, opsText: existsSync(opsPath) ? readFileSync(opsPath, "utf8").slice(-1500) : "" });
          break;
        }
        case "sample": {
          const s = sample();
          const ws = relayLog.split("\n").filter((l) => /\/r\/.*\/ws/.test(l));
          results[`sample ${arg.label}`] = s;
          ackBack(line, { ...s, relayLog: ws.length, pid: appPid() });
          break;
        }
        case "pair": {
          await page.goto(base + "/");
          await page.getByRole("heading", { name: "IntelyIDE Remote" }).waitFor();
          await expect.poll(async () => ((await page.getByTestId("bundle-hash").textContent()) ?? "").trim(), { timeout: 15_000 }).not.toBe("");
          const phoneHash = ((await page.getByTestId("bundle-hash").textContent()) ?? "").trim();
          await page.getByPlaceholder("https://…/#p=…").fill(arg.link);
          await page.getByRole("button", { name: "Connect" }).click();
          sasCode = ((await page.getByTestId("sas").textContent()) ?? "").replace(/\s/g, "");
          await sleep(200);
          await shot("compare-code");
          ackBack(line, { sas: sasCode, phoneHash, link: arg.link.replace(/#.*/, "#<hidden>") });
          break;
        }
        case "paired": {
          await page.getByRole("heading", { name: "Sessions" }).waitFor({ timeout: 30_000 });
          await expect.poll(() => page.getByTestId("conn").getAttribute("data-conn"), { timeout: 20_000 }).toBe("live");
          // the welcome pin arrives with the first frames; the shell then becomes signed
          const pinned = async () => (await idb("bundlePub")) && (await idb("activeShell"))?.signed === true;
          try {
            await pollFor(pinned, "the pin and the signed shell", 10_000);
          } catch {
            await page.reload(); // the first visit is not controlled by the worker yet; a reload brings the verified shell and the pin check
            await page.getByRole("heading", { name: "Sessions" }).waitFor({ timeout: 30_000 });
            try {
              await pollFor(pinned, "the pin and the signed shell after a reload");
            } catch (e) {
              await askCheck();
              await sleep(4000);
              const verdict = await lastVerify();
              const dump = { verdict, bundlePub: await idb("bundlePub"), relayHost: await idb("relayHost"), maxSeq: await idb("maxSeq"), activeShell: await idb("activeShell"), pendingShell: await idb("pendingShell"), controlled: await page.evaluate(() => !!navigator.serviceWorker.controller), url: page.url() };
              throw new Error(`${(e as Error).message} ${JSON.stringify(dump)}`);
            }
          }
          await shot("sessions");
          ackBack(line, { conn: "live", bundlePub: await idb("bundlePub"), relayHost: await idb("relayHost"), maxSeq: await idb("maxSeq"), shell: await idb("activeShell") });
          break;
        }
        case "sw-tamper": {
          // 1. a manifest edited after signing (seq changed): the signature no longer verifies; the verified shell keeps serving
          const bundlePath = join(SERVE, "bundle.json");
          const original = readFileSync(bundlePath, "utf8");
          const activeBefore = (await idb("activeShell"))?.hash;
          if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) {
            await page.reload();
            await page.waitForFunction(() => !!navigator.serviceWorker.controller, undefined, { timeout: 20_000 });
          }
          await listen();
          const m = JSON.parse(original);
          writeFileSync(bundlePath, JSON.stringify({ ...m, seq: Number(m.seq) + 1 }));
          await askCheck();
          const bad = await pollFor(async () => await lastVerify(), "the verdict on the edited manifest");
          const activeAfterBad = (await idb("activeShell"))?.hash;
          // 2. a manifest signed by ANOTHER key: refused as keyMismatch, the verified shell keeps serving
          const lib: any = await import(pathToFileURL(join(webRoot, "../remote-relay/scripts/bundle-lib.mjs")).href);
          const other = mkdtempSync(join(tmpdir(), "intely-cf-other-"));
          cpSync(SERVE, other, { recursive: true });
          rmSync(join(other, "bundle.json"));
          const forged = lib.signBundle(other, lib.newKeyPem(), { seq: Number(m.seq) + 5 });
          writeFileSync(bundlePath, JSON.stringify(forged));
          rmSync(other, { recursive: true, force: true });
          await askCheck();
          const wrongKey = await pollFor(async () => await lastVerify(), "the verdict on the other key");
          // 3. the signed bundle the Mac deployed is accepted again
          writeFileSync(bundlePath, original);
          await askCheck();
          const good = await pollFor(async () => await lastVerify(), "the verdict on the signed bundle");
          ackBack(line, { bad, wrongKey, good, activeBefore, activeAfterBad, activeAfterKey: (await idb("activeShell"))?.hash, pin: await idb("bundlePub") });
          break;
        }
        case "shot": {
          await shot(arg.name);
          ackBack(line, { ok: true });
          break;
        }
        case "bye": {
          ackBack(line, { ok: true });
          return;
        }
        default:
          throw new Error("unknown command " + name);
      }
    } catch (e) {
      ackBack(line, { error: String((e as Error).message ?? e).slice(0, 500) });
      note(`command ${name}`, false, (e as Error).message);
    }
  }
}, 600_000);

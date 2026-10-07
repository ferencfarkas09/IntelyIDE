// The DESKTOP end to end driver (scripts/e2e/run.sh scenario `rm`): the real debug app is driven by scripts/e2e/rm-remote.js; this
// file is its other half. It runs the local relay (wrangler dev, loopback, serving the signed build), the phone (headless Chrome at
// 390x844 against the real PWA) and an "attacker phone" (the real Session with the paired device's own keys). The app asks for each
// step through a file in a fixture repo (.rm-cmd / .rm-ack: the page may not reach loopback, CSP) and this file answers.
//
// Needs: INTELY_RM_CONTROL (fixture repo dir), INTELY_RM_WORK (fixture e2e dir; app.pid appears there), INTELY_RM_PORT (relay port),
// INTELY_RM_DATA (the app data dir), INTELY_RM_SHOTS. Never contacts anything but 127.0.0.1.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Session } from "../../src/core/session";
import type { ServerMsg } from "../../src/core/wire";
import { startRelay, type Relay } from "../support/relay";

const env = (k: string): string => process.env[k] ?? "";
const CTL = env("INTELY_RM_CONTROL");
const WORK = env("INTELY_RM_WORK");
const PORT = Number(env("INTELY_RM_PORT"));
const DATA = env("INTELY_RM_DATA");
const SHOTS = env("INTELY_RM_SHOTS") || join(WORK, "shots");
const CMD = join(CTL, ".rm-cmd");
const ACK = join(CTL, ".rm-ack");
const RESULT = join(WORK, "driver-result.json");
mkdirSync(SHOTS, { recursive: true });

let relay: Relay;
let browser: Browser;
let ctx: BrowserContext;
let page: Page;
const failures: string[] = [];
const results: Record<string, unknown> = {};
const violations: string[] = [];
const foreign: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const note = (name: string, ok: boolean, detail?: unknown) => {
  results[name] = { ok, detail: detail === undefined ? undefined : String(detail).slice(0, 400) };
  if (!ok) failures.push(`${name}: ${String(detail).slice(0, 300)}`);
};

const shot = async (name: string) => {
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await sleep(150);
    await page.screenshot({ path: join(SHOTS, `phone-${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: "dark" });
};

/** The newest card that is still open (answered cards stay on screen, locked, for a while). */
const openCard = (id: string) => page.locator(`[data-testid="${id}"]:not(:has([data-testid="resolved"]))`).last();

const appPid = (): number => Number(readFileSync(join(WORK, "app.pid"), "utf8").trim());

/** Sockets to the relay port and threads of the app process (zero cost when off). */
function sample(): { relaySockets: number; threads: number; sockets: number } {
  const pid = String(appPid());
  let lsof = "";
  try {
    lsof = execFileSync("lsof", ["-nP", "-a", "-p", pid, "-i"], { encoding: "utf8" });
  } catch {
    /* lsof exits 1 when nothing matches */
  }
  const lines = lsof.split("\n").slice(1).filter(Boolean);
  const relaySockets = lines.filter((l) => l.includes(`:${PORT}`)).length;
  const threads = execFileSync("ps", ["-M", "-p", pid], { encoding: "utf8" }).split("\n").filter(Boolean).length - 1;
  return { relaySockets, sockets: lines.length, threads };
}

/** What an attacker would want to change in the Remote state: who is paired and at which level (not the volatile lastSeen fields). */
const stateHash = (): string => {
  const f = join(DATA, "devices.json");
  if (!existsSync(f)) return "none";
  const raw = readFileSync(f, "utf8");
  try {
    const walk = (v: any): any =>
      Array.isArray(v) ? v.map(walk) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => !/^lastSeen/.test(k) && !/mac|tag|sig/i.test(k)).map(([k, x]) => [k, walk(x)])) : v;
    return createHash("sha256").update(JSON.stringify(walk(JSON.parse(raw)))).digest("hex").slice(0, 16);
  } catch {
    return createHash("sha256").update(raw).digest("hex").slice(0, 16);
  }
};

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

beforeAll(async () => {
  relay = await startRelay({ port: PORT });
  const executablePath = process.env.INTELY_CHROME ?? join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-x64/chrome-headless-shell");
  browser = await chromium.launch({ headless: true, executablePath });
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "dark" });
  page = await ctx.newPage();
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (!["127.0.0.1", "localhost"].includes(u.hostname) && u.protocol.startsWith("http")) foreign.push(r.url());
  });
  await page.exposeFunction("__csp", (v: string) => violations.push(v));
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => (window as any).__csp(`${e.violatedDirective} ${e.blockedURI}`)));
  writeFileSync(join(WORK, "relay.ready"), relay.base);
});

afterAll(async () => {
  writeFileSync(RESULT, JSON.stringify({ ok: failures.length === 0, failures, results }, null, 1));
  await ctx?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await relay?.stop().catch(() => {});
  // The ACK stays: the app may still be polling for the answer to `bye` (the same race the cf driver had); run.sh removes both after the app exits.
  if (existsSync(CMD)) unlinkSync(CMD);
});

// ---------------------------------------------------------------------------------------------------------- the attacker phone
type Probe = { name: string; ok: boolean; refused: boolean; code?: string; message?: string };

async function attack(hardRunId: string | null): Promise<{ probes: Probe[]; sawCard: boolean }> {
  const dev = await page.evaluate(() => localStorage.getItem("intely.device.v1"));
  if (!dev) throw new Error("no paired device in the phone storage");
  await page.goto("about:blank"); // one socket per device: the real phone steps aside
  (globalThis as any).document = { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" };
  const msgs: ServerMsg[] = [];
  const s = new Session({
    device: JSON.parse(dev),
    base: `ws://127.0.0.1:${PORT}`,
    handlers: { onConn() {}, onMsg: (m) => msgs.push(m), lastSeq: () => ({}), onRevoked() {} },
  });
  s.start();
  const t0 = Date.now();
  while (s.conn !== "live" && Date.now() - t0 < 30_000) await sleep(100);
  if (s.conn !== "live") throw new Error("the attacker session never went live: " + s.conn);
  await sleep(500);
  const cards = msgs.flatMap((m) => (m.t === "snapshot" ? m.needsYou : m.t === "reqNew" ? [m.req] : []));
  const card = cards.find((c) => c.kind === "permission");
  const probes: Probe[] = [];
  const run = async (name: string, build: (opId: string) => any) => {
    try {
      const ack = await s.request(build);
      probes.push({ name, ok: ack.ok, refused: !ack.ok, code: ack.code ?? undefined, message: ack.message ?? undefined });
    } catch (e) {
      probes.push({ name, ok: false, refused: true, message: (e as Error).message });
    }
  };
  const base = { agentId: card?.agentId ?? "none", reqId: card?.reqId ?? "none" };
  // approve a request the policy never lets a phone allow without a passkey step-up (and a forged proof)
  await run("allow without step-up", (opId) => ({ t: "answer", opId, ...base, decision: "allowOnce", intentHash: card?.intentHash ?? null, stepUp: null }));
  await run("allow with a forged step-up proof", (opId) => ({ t: "answer", opId, ...base, decision: "allowOnce", intentHash: card?.intentHash ?? null, stepUp: { credentialId: "AAAA", clientDataJson: "AAAA", authenticatorData: "AAAA", signature: "AAAA" } }));
  await run("allow with a wrong intent hash", (opId) => ({ t: "answer", opId, ...base, decision: "allowOnce", intentHash: "0".repeat(64), stepUp: null }));
  await run("allow a request that does not exist (a hard-stopped call never becomes one)", (opId) => ({ t: "answer", opId, agentId: hardRunId ?? "none", reqId: "hardstop-forged", decision: "allowOnce", intentHash: null, stepUp: null }));
  // commit / push / write the state dir: there is no wire verb for it; the only doors are start (control level) and prompt text
  await run("start a git push template", (opId) => ({ t: "start", opId, templateId: "git-push", params: { remote: "origin" }, stepUp: null }));
  await run("start a template that writes the state dir", (opId) => ({ t: "start", opId, templateId: "../../remote/devices.json", params: { path: DATA }, stepUp: null }));
  await run("start with a prototype-pollution body", (opId) => ({ t: "start", opId, templateId: "x", params: JSON.parse('{"__proto__":{"capability":"control"}}'), stepUp: null }));
  await run("unknown verb", (opId) => ({ t: "writeFile", opId, path: join(DATA, "remote/devices.json"), text: "{}" }));
  await run("raise own level", (opId) => ({ t: "setCapability", opId, capability: "control" }));
  // a prompt that merely CONTAINS a git push is chat text: it may be accepted, but only the broker decides what a run can do (the
  // scenario then checks that no repo or remote moved); recorded, not asserted here
  const info = await s.request((opId) => ({ t: "prompt", opId, agentId: base.agentId, text: "git commit -am x && git push origin HEAD", mode: "queue" })).then((a) => `ack ok=${a.ok} ${a.code ?? ""}`, (e) => String(e.message));
  results["probe info: a prompt containing a git push"] = info;
  s.stop();
  return { probes, sawCard: !!card };
}

// ---------------------------------------------------------------------------------------------------------- the conversation
it("drives the desktop app end to end", async () => {
  const sasSeen: { code?: string; hint?: string } = {};
  let hashBefore = "";

  for (;;) {
    const { name, arg } = await nextCmd();
    const line = `${name}|${JSON.stringify(arg)}`;
    try {
      switch (name) {
        case "hello": {
          const manifest = JSON.parse(readFileSync(join(relay.dist, "bundle.json"), "utf8"));
          ackBack(line, { base: relay.base, bundle: manifest.manifestSha256.slice(0, 16).match(/.{4}/g)!.join(" ") });
          break;
        }
        case "sample": {
          const s = sample();
          results[`sample ${arg.label}`] = s;
          // the relay has seen no WebSocket upgrade for this room while Remote is off
          const ws = relay.log().split("\n").filter((l) => /\/r\/.*\/ws/.test(l));
          ackBack(line, { ...s, relayLog: ws.length, relayLines: ws.slice(0, 3) });
          break;
        }
        case "pair": {
          await page.goto(relay.base + "/");
          await page.getByRole("heading", { name: "IntelyIDE Remote" }).waitFor();
          const phoneHash = ((await page.getByTestId("bundle-hash").textContent()) ?? "").trim();
          await page.getByPlaceholder("https://…/#p=…").fill(arg.link);
          await page.getByRole("button", { name: "Connect" }).click();
          sasSeen.code = ((await page.getByTestId("sas").textContent()) ?? "").replace(/\s/g, "");
          await sleep(200);
          await shot("02-compare-code");
          ackBack(line, { sas: sasSeen.code, phoneHash });
          break;
        }
        case "paired": {
          await page.getByRole("heading", { name: "Sessions" }).waitFor({ timeout: 30_000 });
          await expect.poll(() => page.getByTestId("conn").getAttribute("data-conn"), { timeout: 20_000 }).toBe("live");
          await page.getByTestId("empty").waitFor();
          await shot("03-sessions-empty");
          ackBack(line, { conn: "live", level: "reply" });
          break;
        }
        case "card": {
          // wait for a card of the given kind on the phone; remember the permission's ids for the probes
          const tid = arg.kind === "question" ? "question-card" : "permission-card";
          await openCard(tid).waitFor({ timeout: 30_000 });
          const txt = ((await openCard(tid).innerText()) ?? "").replace(/\s+/g, " ");
          const has = async (id: string) => (await page.getByTestId(id).count()) > 0;
          await shot(arg.shot);
          ackBack(line, { text: txt.slice(0, 300), deny: await has("deny"), allowOnce: await has("allow-once"), stepUp: await has("allow-stepup"), desktopOnly: await has("desktop-only"), viewOnly: await has("view-only") });
          break;
        }
        case "phone-answer": {
          if (arg.how === "choose") {
            const card = openCard("question-card");
            await card.getByRole("button", { name: arg.option }).click();
            await card.getByTestId("send-answer").click();
          } else if (arg.how === "deny") {
            await openCard("permission-card").getByTestId("deny").click();
          }
          ackBack(line, { clicked: true });
          break;
        }
        case "phone-sees": {
          // a text on the phone within a timeout; used for "answered on the Mac" locks and the blocked line
          let ok = true;
          try {
            await page.getByText(new RegExp(arg.text, "i")).first().waitFor({ timeout: arg.timeout ?? 20_000 });
          } catch {
            ok = false;
          }
          await shot(arg.shot ?? "x");
          ackBack(line, { ok, cards: await page.getByTestId("permission-card").count() });
          break;
        }
        case "phone-run": {
          // open the first run row to look at the streamed transcript
          await page.getByTestId("run-row").first().click().catch(() => {});
          await page.getByTestId("run-screen").waitFor({ timeout: 15_000 });
          const txt = ((await page.getByTestId("run-screen").innerText()) ?? "").replace(/\s+/g, " ");
          await shot(arg.shot);
          ackBack(line, { text: txt.slice(0, 600) });
          if (arg.back) await page.goBack().catch(() => {});
          break;
        }
        case "hash-state": {
          hashBefore = stateHash();
          ackBack(line, { hash: hashBefore });
          break;
        }
        case "probe": {
          const r = await attack(arg.hardRunId ?? null);
          const after = stateHash();
          note("probe: the attacker saw the pending permission card", r.sawCard, JSON.stringify(r.probes.length));
          for (const p of r.probes) note(`probe refused: ${p.name}`, p.refused, `${p.code ?? ""} ${p.message ?? ""}`);
          note("probe: the Remote state directory is byte-identical after the attack", after === hashBefore, `${hashBefore} -> ${after}`);
          ackBack(line, { probes: r.probes, stateBefore: hashBefore, stateAfter: after });
          break;
        }
        case "phone-live": {
          await page.goto(relay.base + "/");
          await expect.poll(() => page.getByTestId("conn").getAttribute("data-conn"), { timeout: 30_000 }).toBe("live");
          ackBack(line, { conn: "live" });
          break;
        }
        case "phone-revoked": {
          let ok = true;
          try {
            await page.getByTestId("revoked").waitFor({ timeout: 20_000 });
          } catch {
            ok = false;
          }
          const storage = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("intely.")));
          await shot("11-revoked");
          ackBack(line, { ok, storage });
          break;
        }
        case "phone-rejected": {
          // a revoked phone must not get back in: reload with whatever is left
          await page.goto(relay.base + "/");
          await sleep(1500);
          const paired = (await page.getByTestId("empty").count()) + (await page.getByRole("heading", { name: "Sessions" }).count());
          ackBack(line, { stillPaired: paired > 0 });
          break;
        }
        case "bye": {
          note("the phone had no CSP violation and talked only to loopback", violations.length === 0 && foreign.length === 0, JSON.stringify({ violations, foreign }));
          ackBack(line, { ok: true });
          expect(failures).toEqual([]);
          return;
        }
        default:
          ackBack(line, { error: "unknown command " + name });
      }
    } catch (e) {
      note(`driver step ${name}`, false, (e as Error).message);
      ackBack(line, { error: (e as Error).message });
      await page.screenshot({ path: join(SHOTS, `FAIL-${name}.png`) }).catch(() => {});
    }
  }
}, 600_000);

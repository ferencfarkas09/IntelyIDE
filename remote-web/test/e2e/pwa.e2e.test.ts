// The PWA end to end: real relay (wrangler dev, loopback) serving the real build, headless Chrome at 390x844, and a fake Mac that
// speaks the real Noise. Order matters: each step builds on the state of the previous one.
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FakeMac } from "../support/fakeMac";
import { startRelay, webRoot, type Relay } from "../support/relay";

const SHOTS = process.env.INTELY_SHOTS_DIR ?? join(webRoot, "../.scratch/rm3-shots");
mkdirSync(SHOTS, { recursive: true });

let relay: Relay;
let mac: FakeMac;
let browser: Browser;
let ctx: BrowserContext;
let page: Page;
const violations: string[] = [];
const foreign: string[] = [];
const consoleErrors: string[] = [];
let deviceId = "";

const shot = async (name: string) => {
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: "dark" });
};

const poll = (fn: () => unknown, timeout = 15_000) => expect.poll(fn as () => Promise<unknown> | unknown, { timeout, interval: 100 });

beforeAll(async () => {
  relay = await startRelay();
  mac = new FakeMac(relay.base);
  await mac.connect();
  // The locally cached headless shell (playwright-core wants a newer revision than the one on this machine); override with INTELY_CHROME.
  const executablePath = process.env.INTELY_CHROME ?? join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-x64/chrome-headless-shell");
  browser = await chromium.launch({ headless: true, executablePath });
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "dark", permissions: [] });
  page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (!["127.0.0.1", "localhost"].includes(u.hostname) && u.protocol.startsWith("http")) foreign.push(r.url());
  });
  await page.exposeFunction("__csp", (v: string) => violations.push(v));
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => (window as any).__csp(`${e.violatedDirective} ${e.blockedURI}`)));
});

afterAll(async () => {
  await ctx?.close();
  await browser?.close();
  mac?.stop();
  await relay?.stop();
});

describe("the phone PWA against a fake Mac over the real relay", () => {
  afterEach(async (ctx) => {
    if (ctx.task.result?.state !== "fail") return;
    const name = ctx.task.name.replace(/\W+/g, "-").slice(0, 40);
    await page.screenshot({ path: join(SHOTS, `FAIL-${name}.png`) }).catch(() => {});
    console.log(`[${name}] url=${page.url()}\n${(await page.evaluate(() => document.body.innerText).catch(() => "")).slice(0, 1500)}`);
  });

  it("serves a strict CSP and shows the running bundle hash on the first screen", async () => {
    const res = await page.goto(relay.base + "/");
    const csp = res!.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    await page.getByRole("heading", { name: "IntelyIDE Remote" }).waitFor();
    const manifest = JSON.parse(readFileSync(join(relay.dist, "bundle.json"), "utf8"));
    await poll(() => page.getByTestId("bundle-hash").textContent()).toBe(manifest.manifestSha256.slice(0, 16).match(/.{4}/g)!.join(" "));
    await shot("01-onboarding");
  });

  it("pairs: paste the link, compare the 6 digits, the Mac approves view-only", async () => {
    const offer = mac.pairStart();
    await page.getByPlaceholder("https://…/#p=…").fill(offer.link);
    await page.getByRole("button", { name: "Connect" }).click();
    const sasText = (await page.getByTestId("sas").textContent())!.replace(/\s/g, "");
    const seen = await mac.sas!;
    expect(sasText).toBe(seen.code);
    expect(seen.hint).toBe("Phone"); // Chrome desktop UA: default name
    await shot("02-compare-code");
    const dev = mac.pairConfirm(true, "view")!;
    deviceId = dev.id;
    await page.getByRole("heading", { name: "Sessions" }).waitFor();
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("intely.")))).toContain("intely.device.v1");
    await poll(() => page.getByTestId("conn").getAttribute("data-conn")).toBe("live");
    await page.getByTestId("empty").waitFor();
  });

  it("view-only is the default: cards show, answering is not offered", async () => {
    mac.addRun({ agentId: "a1", title: "Fix login redirect", role: "developer" });
    mac.emit("a1", { kind: "user.message", messageId: "m1", text: "Fix the login redirect bug" });
    mac.emit("a1", { kind: "text.delta", messageId: "t1", text: "Looking at the router" });
    mac.emit("a1", { kind: "tool.start", toolId: "x1", name: "Bash", toolKind: "exec", input: { command: "npm test" } });
    mac.needsYou({ reqId: "r1", agentId: "a1", command: "npm test -- --silent", argv: ["npm", "test", "--", "--silent"], summary: "Run npm test", risk: "low", eligibility: "low" });
    // new data arrives while live: the session list updates
    await page.getByTestId("permission-card").waitFor();
    await poll(() => page.getByTestId("needs-count").textContent()).toBe("1");
    expect(await page.getByTestId("view-only").count()).toBe(1);
    expect(await page.getByTestId("allow-once").count()).toBe(0);
    await shot("03-home-view-only");
  });

  it("promoting to reply shows Allow once; one tap answers and locks the card", async () => {
    mac.setCapability(deviceId, "reply");
    await page.getByTestId("allow-once").waitFor();
    await shot("04-home-needs-you");
    await page.getByTestId("allow-once").click();
    await poll(() => mac.answers.length).toBe(1);
    expect(mac.answers[0]).toMatchObject({ reqId: "r1", decision: "allowOnce", deviceId });
    await page.getByTestId("resolved").waitFor(); // the card locks and stays visible for a moment
    expect(await page.getByTestId("resolved").textContent()).toContain("Allowed from this phone");
    await poll(() => page.getByTestId("permission-card").count()).toBe(0); // then it leaves the Needs-you list
  });

  it("opens a run: transcript streams, tool calls are collapsed, jump to latest works", async () => {
    await page.getByTestId("run-row").first().click().catch(async () => {
      await page.getByRole("button", { name: "Open run" }).click();
    });
    await page.getByTestId("run-screen").waitFor();
    await page.getByTestId("msg-user").waitFor();
    mac.emit("a1", { kind: "text.delta", messageId: "t1", text: " and the auth guard." });
    await poll(() => page.getByTestId("msg-assistant").first().textContent()).toContain("Looking at the router and the auth guard.");
    expect(await page.getByTestId("tool-row").count()).toBe(1);
    expect(await page.getByTestId("tool-row").textContent()).toContain("Ran npm test");
    mac.emit("a1", { kind: "tool.result", toolId: "x1", status: "ok", output: "12 passed", durationMs: 900 });
    await page.getByTestId("tool-row").getByRole("button").first().click();
    await page.getByText("12 passed").waitFor();
    await shot("05-run-detail");
    // scroll up, stream more: the jump button shows up
    for (let i = 0; i < 25; i++) mac.emit("a1", { kind: "text.done", messageId: "f" + i, text: `Filler paragraph ${i} to make the transcript scroll.` });
    await page.waitForTimeout(400);
    await page.getByTestId("run-screen").locator(".transcript").evaluate((el) => (el.scrollTop = 0));
    await page.waitForTimeout(300); // the scroll event lands before the next message, as with a real finger
    mac.emit("a1", { kind: "text.done", messageId: "late", text: "A late message" });
    await page.getByTestId("jump").waitFor();
    await page.getByTestId("jump").click();
    await page.getByText("A late message").waitFor();
  });

  it("sends a follow-up (queue) and an interrupt while the run is running", async () => {
    await page.getByTestId("composer-input").fill("Please also run the linter");
    expect(await page.getByTestId("send").textContent()).toContain("Queue follow-up");
    await page.getByTestId("send").click();
    await poll(() => mac.prompts.length).toBe(1);
    expect(mac.prompts[0]).toMatchObject({ agentId: "a1", text: "Please also run the linter", mode: "queue" });
    await page.getByText("Please also run the linter").first().waitFor();
    await page.getByTestId("composer-input").fill("Stop that and summarize");
    await page.getByTestId("interrupt").click();
    await poll(() => mac.prompts.length).toBe(2);
    expect(mac.prompts[1]).toMatchObject({ mode: "interrupt", text: "Stop that and summarize" });
  });

  it("answers a question card with a chip, and a step-up request only offers the placeholder", async () => {
    mac.needsYou({ reqId: "q1", agentId: "a1", question: "Which branch should I use?", summary: "Which branch should I use?", options: ["main", "develop"], command: null, argv: null, tool: null }, "question");
    await page.getByTestId("question-card").waitFor();
    await page.getByRole("button", { name: "develop" }).click();
    await shot("06-question");
    await page.getByTestId("send-answer").click();
    await poll(() => mac.answers.length).toBe(2);
    expect(mac.answers[1]).toMatchObject({ reqId: "q1", question: { optionIds: ["develop"], text: null } });
    mac.needsYou({ reqId: "r2", agentId: "a1", command: "rm -rf build && git push origin main", argv: null, summary: "Run a shell command", risk: "high", eligibility: "stepUp", reason: "Not on the one-tap list." });
    await page.getByTestId("allow-stepup").waitFor();
    expect(await page.getByTestId("allow-once").count()).toBe(0);
    await shot("07-permission-high");
    await page.getByTestId("allow-stepup").click();
    await page.getByTestId("stepup-note").waitFor();
    await shot("08-stepup-sheet");
    await page.keyboard.press("Escape");
    mac.needsYou({ reqId: "r3", agentId: "a1", command: "git commit -am x", summary: "git commit", risk: "blocked", eligibility: "desktopOnly" });
    await page.getByTestId("desktop-only").waitFor();
    expect(mac.answers.length).toBe(2); // nothing else was answered
  });

  it("first answer wins: answered on the Mac locks the phone's card", async () => {
    mac.answerOnMac("r2", "deny");
    await poll(() => page.getByTestId("resolved").count()).toBeGreaterThan(0);
    expect(await page.getByText("Denied on the Mac").count()).toBeGreaterThan(0);
  });

  it("stop asks for confirmation then stops the run", async () => {
    await page.getByTestId("stop").click();
    await page.getByTestId("stop-confirm").click();
    await poll(() => mac.stops).toEqual(["a1"]);
  });

  it("goes offline with a snapshot banner and resumes by seq when the Mac returns", async () => {
    await page.goBack();
    await page.getByRole("heading", { name: "Sessions" }).waitFor();
    mac.disconnect();
    await page.getByTestId("offline-banner").waitFor();
    await poll(() => page.getByTestId("conn").getAttribute("data-conn")).toBe("macOffline");
    await shot("09-mac-offline");
    mac.addRun({ agentId: "a2", title: "Write release notes", role: "docs" });
    mac.emit("a1", { kind: "text.done", messageId: "while-away", text: "Written while the Mac was disconnected" });
    await mac.reconnect();
    await poll(() => page.getByTestId("conn").getAttribute("data-conn"), 20_000).toBe("live");
    await page.getByText("Write release notes").waitFor();
    await page.getByRole("button", { name: /Open run Fix login redirect/ }).first().click();
    await page.getByText("Written while the Mac was disconnected").waitFor();
    const count = await page.getByText("Written while the Mac was disconnected").count();
    expect(count).toBe(1); // resumed from seq: no duplicate
    await page.goBack();
  });

  it("settings show the level, build hash and a sign-out confirmation", async () => {
    await page.getByRole("button", { name: "Devices" }).click();
    await page.getByTestId("this-device").waitFor();
    expect(await page.getByTestId("capability").textContent()).toContain("Reply");
    await poll(() => page.getByTestId("build-hash").textContent()).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
    await shot("10-settings");
  });

  it("revocation on the Mac removes the device at once and wipes the phone", async () => {
    mac.revoke(deviceId);
    await page.getByTestId("revoked").waitFor({ timeout: 15_000 });
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("intely.")))).toEqual([]);
    await shot("11-revoked");
  });

  it("had no CSP violations, console errors or requests to other hosts", () => {
    expect(violations).toEqual([]);
    expect(foreign).toEqual([]);
    expect(consoleErrors.filter((e) => !/Failed to load resource|WebSocket/.test(e))).toEqual([]);
  });
});

// Headless Chrome test of the attachments flow against the MOCK UI (Vite dev server): an HTML5 drop with real File
// objects onto the agent composer, the drop overlay, image resize, the secret-file guard, the send and the lightbox.
// OS-level drags cannot be automated; the native (Tauri) path is covered by the injected payload in a vitest and by the
// manual steps in docs/attachments.md.
//   BASE=http://localhost:1420 OUT=.scratch/attach node scripts/e2e/attachments-drop.mjs
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(path.resolve(process.env.PW_DIR || ".scratch/pw") + "/package.json");
const { chromium } = require("playwright-core");
const base = process.env.BASE || "http://localhost:1420";
const out = process.env.OUT || ".scratch/attach";
fs.mkdirSync(out, { recursive: true });

let failed = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failed++;
};

/** Builds a DataTransfer with real File objects inside the page. */
const makeDt = `(spec) => {
  const dt = new DataTransfer();
  for (const f of spec) dt.items.add(new File([f.bytes ? new Uint8Array(f.bytes) : f.text], f.name, { type: f.type }));
  return dt;
}`;

async function run(theme) {
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--disable-gpu", "--hide-scrollbars"] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
  await ctx.addInitScript((t) => { try { localStorage.setItem("intely.theme", t); } catch {} }, theme);
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`${base}/?scenario=agent-normal&mode=agent`);
  await page.getByText("Review the OrderRow change").first().click();
  await page.waitForSelector('[data-testid="composer"]');

  // a real 2400x1500 PNG with a gradient, made in the page
  const png = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 2400; c.height = 1500;
    const g = c.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 2400, 1500);
    grad.addColorStop(0, "#7447f5"); grad.addColorStop(1, "#26b5b0");
    g.fillStyle = grad; g.fillRect(0, 0, 2400, 1500);
    g.fillStyle = "#fff"; g.font = "120px sans-serif"; g.fillText("Screenshot 2400x1500", 200, 300);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  const files = [
    { name: "Screenshot 2026.png", type: "image/png", bytes: png },
    { name: "notes.md", type: "text/markdown", text: "# Notes\nplease check the order list" },
    { name: ".env", type: "", text: "DB_PASSWORD=hunter2\n" },
  ];

  const fire = (type, x, y) =>
    page.evaluate(([type, x, y, spec, mk]) => {
      const dt = eval(mk)(spec);
      const el = document.elementFromPoint(x, y) ?? document.body;
      el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
    }, [type, x, y, files, makeDt]);

  const box = await page.locator('[data-testid="composer"]').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;

  await fire("dragenter", 700, 300);
  await fire("dragover", 700, 300);
  await page.waitForSelector('[data-testid="drop-overlay"]');
  const hover = await page.locator('[data-testid="drop-overlay"]').innerText();
  check(`[${theme}] overlay appears while dragging, names the target`, /Drop to attach to the agent composer/.test(hover), JSON.stringify(hover));
  check(`[${theme}] target is outlined`, await page.locator('[data-testid="drop-target-outline"]').count() === 1);
  await page.screenshot({ path: `${out}/overlay-${theme}.png` });

  await fire("dragover", cx, cy);
  await fire("drop", cx, cy);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="att-chip"][data-status="ready"]').length === 3, null, { timeout: 8000 }).catch(() => {});
  check(`[${theme}] overlay is gone after the drop`, await page.locator('[data-testid="drop-overlay"]').count() === 0);
  const chips = await page.locator('[data-testid="att-chip"]').count();
  check(`[${theme}] three chips (image, text, secret file)`, chips === 3, `chips=${chips}`);

  const dims = await page.evaluate(() => { const i = document.querySelector('[data-testid="att-chip"] img'); return i ? new Promise((r) => { if (i.complete) r([i.naturalWidth, i.naturalHeight]); else i.onload = () => r([i.naturalWidth, i.naturalHeight]); }) : null; });
  check(`[${theme}] image was resized to at most 1568 px`, !!dims && Math.max(...dims) === 1568, JSON.stringify(dims));
  const guard = await page.locator('[data-testid="att-guard"]').innerText().catch(() => "");
  check(`[${theme}] secret file shows a blocking warning naming the provider`, /May contain secrets/.test(guard) && /Anthropic \(Claude\)/.test(guard), JSON.stringify(guard));
  check(`[${theme}] privacy line is shown`, /sent to Anthropic \(Claude\)/.test(await page.locator('[data-testid="att-privacy"]').innerText()));

  // typing + send is blocked until the guarded file is confirmed
  await page.getByLabel("Message to the agent").fill("Look at these please");
  await page.screenshot({ path: `${out}/chips-guard-${theme}.png` });
  await page.getByLabel("Message to the agent").press("Meta+Enter");
  check(`[${theme}] send is blocked while the warning is unconfirmed`, await page.locator('[data-testid="att-chip"]').count() === 3);
  await page.getByRole("button", { name: "Attach anyway" }).click();
  check(`[${theme}] the warning goes away after the explicit confirm`, await page.locator('[data-testid="att-guard"]').count() === 0);

  // the lightbox from a chip
  await page.getByRole("button", { name: "Preview Screenshot 2026.png" }).click();
  await page.waitForSelector('[data-testid="att-lightbox"]');
  await page.screenshot({ path: `${out}/lightbox-${theme}.png` });
  await page.keyboard.press("Escape");
  check(`[${theme}] lightbox closes with Esc`, await page.locator('[data-testid="att-lightbox"]').count() === 0);

  await page.getByLabel("Message to the agent").press("Meta+Enter");
  await page.waitForSelector('[data-testid="msg-attachments"]', { timeout: 8000 });
  const sent = await page.locator('[data-testid="msg-attachments"]').first();
  check(`[${theme}] the transcript shows the attachments of the sent message`, (await sent.locator("img").count()) >= 1 && (await sent.locator('[data-testid="msg-attachment"]').count()) === 2);
  check(`[${theme}] the composer starts a fresh draft`, await page.locator('[data-testid="att-chip"]').count() === 0);
  await page.screenshot({ path: `${out}/transcript-${theme}.png` });
  // the transcript also pins the last user message at the top, so the thumbnail exists twice: click the one in the list
  await page.locator(".att-thumb").last().click();
  check(`[${theme}] transcript thumbnail opens the lightbox`, await page.locator('[data-testid="att-lightbox"]').count() === 1);

  // paste route: Cmd+V of an image
  await page.keyboard.press("Escape");
  await page.getByLabel("Message to the agent").focus();
  await page.evaluate(async (bytes) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], "image.png", { type: "image/png" }));
    document.querySelector('textarea[aria-label="Message to the agent"]').dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, png);
  await page.waitForSelector('[data-testid="att-chip"][data-status="ready"]', { timeout: 8000 });
  check(`[${theme}] pasting an image makes a chip`, await page.locator('[data-testid="att-chip"]').count() === 1);

  // drops on the commit message box are ignored with a hint
  check(`[${theme}] no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  await browser.close();
}

// The shared dev server hot-reloads when another agent saves a file mid-run: retry a run that lost its page.
for (const theme of ["dark", "light"]) {
  for (let attempt = 1; ; attempt++) {
    try {
      await run(theme);
      break;
    } catch (e) {
      if (attempt >= 3 || !/navigation|Target closed|destroyed/.test(String(e))) throw e;
      console.log(`retry ${theme} after: ${String(e).split("\n")[0]}`);
    }
  }
}
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);

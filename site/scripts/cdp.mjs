// Minimal Chrome DevTools Protocol driver (no dependencies): launches headless Google Chrome and talks to it over a WebSocket.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
    s.on("error", rej);
  });

export async function launchChrome({ width = 1440, height = 900, dsf = 2 } = {}) {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "intely-shots-"));
  const proc = spawn(
    CHROME,
    ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, "--lang=en-US", `--force-device-scale-factor=${dsf}`, `--window-size=${width},${height}`, "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "about:blank"],
    { stdio: "ignore" },
  );
  let targets;
  // A busy Mac can take far longer than a second to bring headless Chrome up: wait up to a minute.
  for (let i = 0; i < 600; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      if (targets.some((t) => t.type === "page")) break;
    } catch {}
    await sleep(100);
  }
  if (!targets) throw new Error("headless Chrome did not answer on its debugging port");
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    } else listeners.forEach((l) => l(msg));
  };
  const send = (method, params = {}) => new Promise((res, rej) => (pending.set(++id, { res, rej }), ws.send(JSON.stringify({ id, method, params }))));
  const api = {
    send,
    on: (fn) => listeners.push(fn),
    async eval(expr) {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    async viewport(w = width, h = height, f = dsf) {
      await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: f, mobile: false });
    },
    /** Runs `source` in every new document before any page script. */
    async init(source) {
      await send("Page.addScriptToEvaluateOnNewDocument", { source });
    },
    async goto(url) {
      await send("Page.enable");
      await send("Page.navigate", { url });
    },
    async waitFor(expr, timeout = 15000, label = expr) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        try {
          if (await api.eval(expr)) return;
        } catch {}
        await sleep(100);
      }
      throw new Error(`timeout waiting for ${label}`);
    },
    /** Waits until the DOM stops changing for `quiet` ms and fonts are ready. */
    async settle(quiet = 400, timeout = 10000) {
      await api.eval(`document.fonts?.ready`);
      await api.eval(`new Promise((resolve) => {
        let t; const done = () => { obs.disconnect(); resolve(true); };
        const obs = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, ${quiet}); });
        obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        t = setTimeout(done, ${quiet}); setTimeout(done, ${timeout});
      })`);
    },
    async key(key, { code = key, vk = 0, modifiers = 0, text } = {}) {
      const base = { key, code, windowsVirtualKeyCode: vk, modifiers };
      await send("Input.dispatchKeyEvent", { type: "keyDown", ...base, text });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    },
    async click(x, y) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    },
    /** Types text into the focused element. */
    async type(text) {
      await send("Input.insertText", { text });
    },
    /** Clicks the first element matching `sel` (optionally whose text includes `text`). */
    async clickEl(sel, text) {
      await api.eval(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => !${JSON.stringify(text ?? "")} || (e.textContent || "").trim().includes(${JSON.stringify(text ?? "")}) || (e.getAttribute("aria-label") || "") === ${JSON.stringify(text ?? "")}); if (!e) throw new Error("no element ${sel}"); })()`).catch(() => {});
      const pt = await api.eval(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => !${JSON.stringify(text ?? "")} || (e.textContent || "").includes(${JSON.stringify(text ?? "")}) || (e.getAttribute("aria-label") || "").includes(${JSON.stringify(text ?? "")}));
        const e = els[0]; if (!e) return null; e.scrollIntoView({ block: "nearest" }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      if (!pt) throw new Error(`no element ${sel} ${text ?? ""}`);
      await api.click(pt.x, pt.y);
    },
    async shot(file, { w = width, h = height, f = dsf } = {}) {
      const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
      const { writeFileSync } = await import("node:fs");
      writeFileSync(file, Buffer.from(data, "base64"));
    },
    async close() {
      try { ws.close(); } catch {}
      proc.kill();
      await sleep(300);
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
  await api.viewport();
  await send("Page.enable");
  await send("Emulation.setLocaleOverride", { locale: "en-US" }).catch(() => {});
  await send("Emulation.setTimezoneOverride", { timezoneId: "Europe/London" }).catch(() => {});
  await api.init(`Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] }); Object.defineProperty(navigator, "language", { get: () => "en-US" });`);
  return api;
}

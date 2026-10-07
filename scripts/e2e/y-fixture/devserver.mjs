// Fixture "dev server" of e2e scenario y (never a real project): serves the prebuilt React bundle on a random loopback port,
// answers like a webpack dev server (X-Frame-Options: DENY, an SSE heartbeat on /__webpack_hmr) and prints the line the Run panel
// reads the port from. The page carries one piece of test glue: it replays an Alt+click inside the frame when the IDE page asks
// for it (a cross-origin frame cannot be clicked from the e2e script, and the harness has no OS-level mouse).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const GLUE = `window.addEventListener("message", function (e) {
  if (e.source !== window.parent) return;
  var d = e.data;
  if (!d || d.e2e !== "altclick") return;
  var el = document.querySelector(d.selector);
  if (el) el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, altKey: true, view: window }));
  window.parent.postMessage({ e2e: "altclicked", found: !!el }, "*");
});
window.parent.postMessage({ e2e: "ready" }, "*");`;
const INDEX = `<!doctype html><html><head><meta charset="utf-8"><title>Fixture app</title></head><body><div id="root"></div><script src="/bundle.js"></script><script>${GLUE}</script></body></html>`;

const srv = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const base = { "X-Frame-Options": "DENY", "Cache-Control": "no-store" };
  if (url.pathname === "/__webpack_hmr") {
    res.writeHead(200, { ...base, "Content-Type": "text/event-stream" });
    res.write("data: {\"action\":\"hello\"}\n\n");
    const t = setInterval(() => res.write("data: 💓\n\n"), 4000);
    req.on("close", () => clearInterval(t));
    return;
  }
  if (url.pathname === "/bundle.js") {
    res.writeHead(200, { ...base, "Content-Type": "text/javascript" });
    return res.end(fs.readFileSync(path.join(here, "public/bundle.js")));
  }
  res.writeHead(200, { ...base, "Content-Type": "text/html; charset=utf-8" });
  res.end(INDEX);
});
srv.listen(0, "127.0.0.1", () => {
  console.log(`Project is running at http://localhost:${srv.address().port}/`);
});

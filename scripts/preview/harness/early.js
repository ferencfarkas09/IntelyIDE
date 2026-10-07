// First module of every harness bundle: runs before the previewed component's module graph is evaluated.
// It makes the page safe (no real network, no real API), reports problems to the IDE and answers the IDE's
// color-scheme question. Everything it posts to the IDE is about this page only: no storage, cookies, headers or bodies.

export const PROTOCOL = {
  ready: "preview/ready/1",
  status: "preview/status/1",
  event: "preview/event/1",
  shot: "preview/shot/1",
  set: "preview/set/1",
  shotReq: "preview/shot.req/1",
  hello: "preview/hello/1",
};

const MAX_TEXT = 300;
const clip = (s) => {
  const t = String(s ?? "");
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}...` : t;
};

export const inIde = window.parent !== window;
export function post(message) {
  try {
    window.parent.postMessage(message, "*");
  } catch {
    /* no parent */
  }
}

let eventCount = 0;
export function logEvent(kind, name, detail) {
  if (eventCount++ > 500) return; // a render loop must not flood the IDE
  post({ intely: PROTOCOL.event, kind, name: clip(name), detail: detail === undefined ? undefined : clip(detail) });
}

// --- no real network ------------------------------------------------------------------------------------------------
const own = (url) => {
  try {
    return new URL(String(url), location.href).origin === location.origin;
  } catch {
    return false;
  }
};
const describe = (method, url) => {
  try {
    const u = new URL(String(url), location.href);
    return `${method} ${u.host}${u.pathname}`; // never the query string: it can carry tokens
  } catch {
    return `${method} (unparsable address)`;
  }
};
const blocked = (method, url) => {
  logEvent("network", describe(method, url), "blocked: the component preview never calls a real API");
  return new TypeError(`Network disabled in the IDE component preview (${describe(method, url)}). Pass the data as props or in the store instead.`);
};

const realFetch = window.fetch?.bind(window);
window.fetch = (input, init) => {
  const url = typeof input === "string" || input instanceof URL ? input : input?.url;
  if (own(url) && /\/__intely\//.test(String(url))) return realFetch(input, init);
  return Promise.reject(blocked(String(init?.method ?? input?.method ?? "GET").toUpperCase(), url));
};

const XHR = window.XMLHttpRequest;
if (XHR) {
  const open = XHR.prototype.open;
  XHR.prototype.open = function (method, url, ...rest) {
    this.__intelyBlocked = !(own(url) && /\/__intely\//.test(String(url)));
    this.__intelyDesc = [String(method).toUpperCase(), url];
    return open.call(this, method, this.__intelyBlocked ? "/__intely/blocked" : url, ...rest);
  };
  const send = XHR.prototype.send;
  XHR.prototype.send = function (body) {
    if (this.__intelyBlocked) {
      const err = blocked(...this.__intelyDesc);
      setTimeout(() => {
        this.dispatchEvent(new ProgressEvent("error"));
        this.onerror?.(new ProgressEvent("error"));
      }, 0);
      void err;
      return undefined;
    }
    return send.call(this, body);
  };
}

for (const name of ["WebSocket", "EventSource"]) {
  const Real = window[name];
  if (!Real) continue;
  window[name] = function Blocked(url, ...rest) {
    if (own(url) && /\/__intely\//.test(String(url))) return new Real(url, ...rest);
    blocked("OPEN", url);
    throw new DOMException(`${name} is disabled in the IDE component preview`, "SecurityError");
  };
  window[name].prototype = Real.prototype;
}
if (navigator.sendBeacon) navigator.sendBeacon = (url) => (blocked("BEACON", url), false);
if (navigator.serviceWorker) {
  try {
    navigator.serviceWorker.register = () => Promise.reject(new Error("Service workers are disabled in the IDE component preview"));
  } catch {
    /* read-only in this browser */
  }
}

document.addEventListener("securitypolicyviolation", (e) => {
  let host = "";
  try {
    host = new URL(e.blockedURI).host;
  } catch {
    host = e.blockedURI;
  }
  logEvent("network", `blocked ${e.effectiveDirective}: ${host || "inline"}`, "content security policy of the harness");
});

// --- color scheme ---------------------------------------------------------------------------------------------------
let scheme = "dark";
const mqls = new Set();
const realMatchMedia = window.matchMedia?.bind(window);
const darkQuery = /\(\s*prefers-color-scheme\s*:\s*dark\s*\)/i;
const lightQuery = /\(\s*prefers-color-scheme\s*:\s*light\s*\)/i;
window.matchMedia = (query) => {
  const q = String(query);
  if (!darkQuery.test(q) && !lightQuery.test(q)) return realMatchMedia(q);
  const listeners = new Set();
  const matches = () => (darkQuery.test(q) ? scheme === "dark" : scheme === "light");
  const mql = {
    media: q,
    get matches() {
      return matches();
    },
    onchange: null,
    addEventListener: (_t, cb) => listeners.add(cb),
    removeEventListener: (_t, cb) => listeners.delete(cb),
    addListener: (cb) => listeners.add(cb),
    removeListener: (cb) => listeners.delete(cb),
    dispatchEvent: () => true,
    __fire() {
      const ev = { matches: matches(), media: q };
      listeners.forEach((cb) => cb(ev));
      mql.onchange?.(ev);
    },
  };
  mqls.add(mql);
  return mql;
};

export function applyScheme(next) {
  const changed = next !== scheme;
  scheme = next === "light" ? "light" : "dark";
  const root = document.documentElement;
  root.style.colorScheme = scheme;
  root.dataset.theme = scheme;
  root.dataset.colorMode = scheme;
  root.classList.toggle("dark", scheme === "dark");
  root.classList.toggle("light", scheme === "light");
  if (document.body) {
    document.body.style.background = scheme === "dark" ? "#1b1d22" : "#ffffff";
    document.body.style.color = scheme === "dark" ? "#e8eaed" : "#1a1c21";
  }
  if (changed) mqls.forEach((m) => m.__fire());
}
export const currentScheme = () => scheme;

// --- problems -------------------------------------------------------------------------------------------------------
export function describeError(err) {
  const e = err instanceof Error ? err : new Error(typeof err === "string" ? err : JSON.stringify(err));
  return { name: e.name, message: clip(e.message || String(err)), stack: String(e.stack ?? "").split("\n").slice(0, 14).join("\n") };
}

window.addEventListener("error", (e) => {
  if (!e.error && !e.message) return;
  const d = describeError(e.error ?? e.message);
  post({ intely: PROTOCOL.status, state: "runtimeError", ...d });
  showFatal(d);
});
window.addEventListener("unhandledrejection", (e) => {
  const d = describeError(e.reason);
  logEvent("error", `Unhandled promise rejection: ${d.message}`);
});

for (const level of ["error", "warn"]) {
  const real = console[level].bind(console);
  console[level] = (...args) => {
    logEvent("console", level, args.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : "")).join(" ").replace(/%[sdoOcif]/g, ""));
    real(...args);
  };
}

export function showFatal(d) {
  const root = document.getElementById("root");
  if (!root || root.childElementCount > 0) return;
  const box = document.createElement("div");
  box.setAttribute("role", "alert");
  box.setAttribute("data-intely-error", "");
  box.style.cssText = "font:13px/1.5 system-ui,sans-serif;padding:16px;margin:16px;border:1px solid #d95b5b;border-radius:8px;background:rgba(217,91,91,.12);color:inherit;white-space:pre-wrap";
  const title = document.createElement("strong");
  title.textContent = `${d.name || "Error"} while loading the component`;
  const msg = document.createElement("div");
  msg.textContent = d.message;
  const pre = document.createElement("pre");
  pre.style.cssText = "margin:8px 0 0;font:12px ui-monospace,monospace;opacity:.8;overflow:auto";
  pre.textContent = d.stack;
  box.append(title, msg, pre);
  root.append(box);
}

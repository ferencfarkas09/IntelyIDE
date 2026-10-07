#!/usr/bin/env node
// A local stand-in for the Happy API ((design notes: integrations-plan)): fixtures for the endpoints the Time Tracer and Meet
// providers use, so tests never touch production. Loopback only. The Time Tracer shapes (timer.mjs) are the real backend's,
// read from its controllers; the Meet and chat ones are still the plan's guesses.
//
//   node scripts/mock-happy/server.mjs [--port 4010]      prints {"ready":true,"port":N,"token":"..."} when listening
//
// Test controls (no auth): GET /__mock/log, POST /__mock/reset, POST /__mock/fail {status, path?, count?}, POST /__mock/revoke
// (the token stops working: REST 401 and every socket dropped and refused). Team chat REST and the Socket.IO server are in
// chat.mjs (its controls: /__mock/chat/*); the Time Tracer is in timer.mjs (controls: /__mock/timer, /__mock/timer/bulk); the Socket.IO part needs `pnpm install` in this folder and is skipped without it.
import http from "node:http";
import { pathToFileURL } from "node:url";
import { createChat } from "./chat.mjs";
import { createNotifications } from "./notifications.mjs";
import { createTasks } from "./tasks.mjs";
import { createTimer } from "./timer.mjs";

export const MOCK_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1XzEiLCJkaWQiOiJtb2NrIn0.bW9jay1zaWduYXR1cmUtY2FuYXJ5LTAwMDE";
export const LIVEKIT_CANARY = "MOCK-LIVEKIT-CANARY-TOKEN";

// The same 24-hex id the chat and notification mocks use for "me" (the chat decides `mine` by comparing it with the sender).
const USER = { id: "5f0000000000000000000001", name: "Teszt Elek", email: "elek@example.test", effectiveRoles: ["admin", "timeTracker"], restaurants: [{ id: "r_1", name: "Demo Gastro" }] };

const MIN = 60_000;
export function createMockHappy({ token = MOCK_TOKEN, now = () => Date.now() } = {}) {
  let log = [];
  let failures = [];
  // Providers kept in their own files (notifications, tasks): each has `handle(method, path, url)`, `control`, `reset`.
  const goodToken = token;
  const notifications = createNotifications({ now });
  const chat = createChat({ now, token: () => token, notifications });
  const extras = [createTimer({ now }), notifications, createTasks({ now }), chat];

  const meetings = (status) => {
    const t = now();
    if (status === "live") {
      const standup = { id: "m_live_1", title: "Reggeli standup", status: "live", channel: { id: "c_1", name: "general" }, participantCount: 4, host: { name: "Kovács Anna" }, startedAt: new Date(t - 10 * MIN).toISOString() };
      return [standup, ...chat.startedMeetings()].filter((m) => !chat.endedMeetings().has(m.id));
    }
    return [
      { id: "m_soon_1", title: "Sprint review", status: "scheduled", channel: { id: "c_2", name: "dev" }, participantCount: 0, host: { name: "Nagy Péter" }, startsAt: new Date(t + 10 * MIN).toISOString() },
      { id: "m_later_1", title: "Retro", status: "scheduled", channel: { id: "c_2", name: "dev" }, participantCount: 0, host: { name: "Nagy Péter" }, startsAt: new Date(t + 180 * MIN).toISOString() },
    ];
  };

  const send = (res, status, body, headers = {}) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
    res.end(text);
  };

  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
        } catch {
          resolve({});
        }
      });
    });

  const handler = async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;
    if (path.startsWith("/__mock/")) {
      if (path === "/__mock/log") return send(res, 200, { count: log.length, requests: log });
      if (path === "/__mock/reset") {
        log = [];
        failures = [];
        token = goodToken;
        extras.forEach((x) => x.reset());
        return send(res, 200, { ok: true });
      }
      if (path === "/__mock/fail") {
        const f = await readBody(req);
        failures.push({ status: f.status ?? 500, path: f.path, left: f.count ?? 1000, code: f.code });
        return send(res, 200, { ok: true });
      }
      if (path === "/__mock/revoke") {
        token = `revoked-${goodToken}`;
        chat.dropSockets();
        return send(res, 200, { ok: true });
      }
      const owner = extras.find((x) => x.controls.includes(path));
      if (owner) return send(res, 200, owner.control(path, await readBody(req)));
      return send(res, 404, { code: "not_found" });
    }
    log.push({ method: req.method, path, query: url.search.slice(1), auth: Boolean(req.headers.authorization), deviceId: req.headers["x-device-id"] ?? null });
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${token}`) return send(res, 401, { code: "DEVICE_LOGGED_OUT", message: "Session revoked" });
    const failure = failures.find((f) => f.left > 0 && (!f.path || path.startsWith(f.path)));
    if (failure) {
      failure.left -= 1;
      return send(res, failure.status, { code: failure.code ?? (failure.status === 403 ? "forbidden_scope" : "mock_failure"), message: "Injected failure" });
    }
    const route = `${req.method} ${path}`;
    switch (route) {
      case "GET /api/user/me":
        return send(res, 200, USER);
      case "GET /api/chat/meetings":
        return send(res, 200, { meetings: meetings(url.searchParams.get("status") === "scheduled" ? "scheduled" : "live") });
      default: {
        const body = req.method !== "GET" && req.method !== "DELETE" ? await readBody(req) : {};
        for (const x of extras) {
          const out = x.handle(req.method, path, url, body);
          if (out) return send(res, out.status, out.body);
        }
        const join = /^\/api\/chat\/meetings\/([A-Za-z0-9_-]+)\/join$/.exec(path);
        if (req.method === "POST" && join) {
          return send(res, 200, { joinUrl: `https://meet.mock.test/meet/join#server=wss://lk.mock.test&token=${LIVEKIT_CANARY}&room=${join[1]}` });
        }
        return send(res, 404, { code: "not_found", message: "No such route" });
      }
    }
  };

  const server = http.createServer((req, res) => {
    handler(req, res).catch(() => send(res, 500, { code: "mock_error" }));
  });
  // Socket.IO shares the HTTP server; `listen` waits for it. Without the `socket.io` package only REST is served.
  server.socketReady = chat.attach(server);
  const close = server.close.bind(server);
  server.close = (cb) => {
    chat.closeSockets();
    server.closeAllConnections?.();
    return close(cb);
  };
  return server;
}

export async function listen(server, port = 0) {
  await server.socketReady;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const i = process.argv.indexOf("--port");
  const server = createMockHappy();
  const port = await listen(server, i > 0 ? Number(process.argv[i + 1]) : 0);
  console.log(JSON.stringify({ ready: true, port, token: MOCK_TOKEN }));
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => process.exit(0)));
}

import pkg from "../package.json" with { type: "json" };
import { bearer, parseCredential, ROOM_RE, sha256Hex } from "./auth.ts";
import { PROTOCOL } from "./config.ts";
import { pushConfig } from "./push.ts";
import { Room, type Env } from "./room.ts";
import { JoinLimiter } from "./limiter.ts";

export { Room, JoinLimiter };

const SEC = { "x-content-type-options": "nosniff", "cache-control": "no-store", "referrer-policy": "no-referrer" };

/** Build-time vars written by the deploy tooling into the generated wrangler config; both are optional and only echoed. */
type StatusEnv = Env & { RELAY_CODE_HASH?: string; RELAY_STAMP?: string };

type LimiterStub = { hit(n: number): Promise<boolean>; ping(): Promise<boolean> };
const limiterOf = (env: Env, name: string) => env.JOIN_LIMITER.get(env.JOIN_LIMITER.idFromName(name)) as unknown as LimiterStub;

/** Per-IP rate limit; runs before any Room is touched, so probing random room ids stays cheap. */
async function ipAllowed(request: Request, env: Env): Promise<boolean> {
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  return limiterOf(env, await sha256Hex(ip)).hit(Number(env.JOIN_RATE_PER_MIN) || 30);
}

/**
 * Cheapest checks first (no Durable Object is involved): the Room would answer exactly the same way, but only after the limiter
 * Durable Object and the Room Durable Object were both billed. Bodies and status codes mirror room.ts.
 */
function earlyReject(request: Request, sub: string): Response | null {
  const notFound = () => new Response("not found", { status: 404, headers: SEC });
  if (sub === "/ws") {
    if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") return notFound();
    if (!parseCredential(request.headers.get("sec-websocket-protocol"))) return new Response("unauthorized", { status: 401, headers: SEC });
  } else if (sub === "/create") {
    if (request.method !== "PUT") return notFound();
    if (!bearer(request)) return Response.json({ error: "token" }, { status: 400, headers: SEC });
  } else if (sub === "/stat") {
    if (request.method !== "GET") return notFound();
    if (!bearer(request)) return Response.json({ error: "auth" }, { status: 401, headers: SEC });
  } else return notFound();
  return null;
}

async function bundleHash(env: Env, url: URL): Promise<string | null> {
  try {
    const r = await env.ASSETS.fetch(new Request(new URL("/bundle.json", url), { headers: { accept: "application/json" } }));
    if (!r.ok) return null;
    const h = String(JSON.parse(await r.text()).manifestSha256 ?? "");
    return /^[0-9a-f]{64}$/.test(h) ? h : null;
  } catch {
    return null;
  }
}

const echo = (v: string | undefined): string | null => (v && /^[A-Za-z0-9:_.-]{1,128}$/.test(v) ? v : null);

// The Durable Object health answer is reused for a minute, so a status poll never costs more than one limiter call per minute
// per isolate. A cold isolate simply asks again.
let doHealth: { at: number; ok: boolean } | null = null;
async function durableObjectsOk(env: Env): Promise<boolean> {
  const now = Date.now();
  if (doHealth && now - doHealth.at < 60_000) return doHealth.ok;
  let ok = false;
  try {
    ok = (await limiterOf(env, "status-ping").ping()) === true;
  } catch {}
  doHealth = { at: now, ok };
  return ok;
}

/**
 * GET /api/status. Worker-only payload for everybody (no Durable Object is called, nothing about any room). The Mac proves
 * ownership with the credential it already has: `Authorization: Bearer <mac room token>` plus `x-intely-room: <room id>`.
 * Only a request that carries both in the right shape pays for one Room check (the same cost class as /r/<room>/stat);
 * if the Room accepts the token the payload also reports `do.ok`. A wrong token looks exactly like no token (auth:false).
 */
async function status(request: Request, env: StatusEnv, url: URL): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: { ...SEC, allow: "GET, HEAD" } });
  const token = bearer(request);
  const room = request.headers.get("x-intely-room");
  let auth = false;
  if (token && room && ROOM_RE.test(room)) {
    if (!(await ipAllowed(request, env))) return new Response("slow down", { status: 429, headers: { ...SEC, "retry-after": "60" } });
    const r = await env.ROOM.get(env.ROOM.idFromName(room)).fetch(new Request("https://room.invalid/stat", { headers: { authorization: `Bearer ${token}` } }));
    await r.body?.cancel();
    auth = r.status === 200;
  }
  return Response.json(
    {
      ok: true,
      auth,
      relay: { version: pkg.version, protocol: PROTOCOL, codeHash: echo(env.RELAY_CODE_HASH), stamp: echo(env.RELAY_STAMP) },
      bundle: { hash: await bundleHash(env, url) },
      push: { configured: pushConfig(env) !== null },
      ...(auth ? { do: { ok: await durableObjectsOk(env) } } : {}),
      now: Date.now(),
    },
    { headers: SEC },
  );
}

export default {
  async fetch(request: Request, env: StatusEnv): Promise<Response> {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === "/api/health") return Response.json({ ok: true }, { headers: SEC });
    if (p === "/api/status") return status(request, env, url);

    // Signed-bundle hash endpoint (remote-plan 2.3): serves the artifact produced by scripts/sign-bundle.mjs.
    if (p === "/api/bundle") {
      const r = await env.ASSETS.fetch(new Request(new URL("/bundle.json", url), { headers: { accept: "application/json" } }));
      if (!r.ok) return Response.json({ error: "no bundle" }, { status: 404, headers: SEC });
      const text = await r.text();
      let hash = "";
      try { hash = String(JSON.parse(text).manifestSha256 ?? ""); } catch {}
      return new Response(text, { headers: { ...SEC, "content-type": "application/json", "x-bundle-hash": hash } });
    }

    const m = p.match(/^\/r\/([^/]+)(\/.*)$/);
    if (m && ROOM_RE.test(m[1])) {
      const sub = m[2];
      const early = earlyReject(request, sub);
      if (early) return early;
      if (!(await ipAllowed(request, env))) return new Response("slow down", { status: 429, headers: { ...SEC, "retry-after": "60" } });
      const target = new URL(request.url);
      target.pathname = sub;
      return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(new Request(target, request));
    }
    if (p.startsWith("/r/") || p.startsWith("/api/")) return new Response("not found", { status: 404, headers: SEC });
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<StatusEnv>;

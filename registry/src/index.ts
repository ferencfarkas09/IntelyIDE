// IntelyIDE registry: a Cloudflare Worker with a D1 database (README.md). The routes of the app are /v1/*; /admin is for the owner.
import { admin } from "./admin.ts";
import * as api from "./api.ts";
import * as db from "./db.ts";
import * as news from "./newsletter.ts";
import type { Env } from "./types.ts";

const ROUTES: Record<string, { method: string; run: (req: Request, env: Env) => Promise<Response> }> = {
  "/v1/register": { method: "POST", run: api.register },
  "/v1/ping": { method: "POST", run: api.ping },
  "/v1/me": { method: "GET", run: api.me },
  "/v1/newsletter": { method: "POST", run: api.newsletter },
  "/v1/forget": { method: "POST", run: api.forget },
};

export async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  try {
    if (url.pathname === "/v1/health") return api.json(200, { ok: true, notice: api.noticeOf(env) });
    // without its secret the fingerprints and the request counters would be hashed with nothing: refuse instead of storing them weakly
    if ((env.PEPPER ?? "").length < 16) return api.json(503, { ok: false, error: "not_configured" });
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return await admin(req, env, url);
    const route = ROUTES[url.pathname];
    if (!route) return api.json(404, { ok: false, error: "not_found" });
    if (req.method !== route.method) return api.json(405, { ok: false, error: "method" }, { allow: route.method });
    return await route.run(req, env);
  } catch {
    // no detail: a message could carry a name or an address
    return api.json(500, { ok: false, error: "server" });
  }
}

/** Once a day: old counters and computers go, and Brevo is asked who confirmed (or left) among the newsletter requests. */
export async function upkeep(env: Env, now: number): Promise<void> {
  const days = Math.max(Number(env.RETENTION_DAYS ?? "730") || 730, 30);
  await db.purge(env.DB, now, days);
  if (!news.enabled(env)) return;
  for (const u of await db.newsletterQueue(env.DB, 100)) {
    const seen = await news.lookup(env, u.email);
    if (seen === null) continue;
    const next = news.nextStatus(u.newsletter_status, seen, u.newsletter_at, now);
    await db.setNewsletter(env.DB, u.id, next, false, now);
  }
}

export default {
  fetch: (req: Request, env: Env): Promise<Response> => handle(req, env),
  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext): void => {
    ctx.waitUntil(upkeep(env, api.nowSeconds()));
  },
} satisfies ExportedHandler<Env>;

// The admin side: /admin (a page that asks for the token) and /admin/api/* (JSON). Everything needs `Authorization: Bearer <ADMIN_TOKEN>`.
// Put Cloudflare Access in front of /admin* as well (README.md); the token is the second lock.
import { safeEqual } from "./crypto.ts";
import { json, limited, nowSeconds } from "./api.ts";
import * as db from "./db.ts";
import { LIMITS } from "./limiter.ts";
import * as news from "./newsletter.ts";
import type { Env } from "./types.ts";
import { ADMIN_CSS, ADMIN_HTML, ADMIN_JS } from "./admin-ui.ts";

const PAGE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const MIN_TOKEN = 24;

export const adminEnabled = (env: Env): boolean => (env.ADMIN_TOKEN ?? "").length >= MIN_TOKEN;

const notFound = (): Response => json(404, { ok: false, error: "not_found" });

function authorized(req: Request, env: Env): boolean {
  const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
  return !!m && safeEqual(m[1], env.ADMIN_TOKEN ?? "");
}

/** A cell for the CSV: quotes doubled, and a leading =, +, - or @ neutralised so a spreadsheet does not run it as a formula. */
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const iso = (v: number | string | null | undefined): string => (typeof v === "number" ? new Date(v * 1000).toISOString() : (v ?? "") + "");

export function toCsv(rows: Record<string, string | number | null>[]): string {
  const cols = ["user_id", "email", "name", "created_at", "consent_notice", "consent_at", "newsletter_status", "os", "os_version", "arch", "cpu_cores", "ram_gb", "locale", "tz", "app_version", "country", "region", "city", "first_seen", "last_seen", "launches"];
  const times = new Set(["created_at", "consent_at", "first_seen", "last_seen"]);
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => csvCell(times.has(c) ? iso(r[c] as number | null) : r[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}

export async function admin(req: Request, env: Env, url: URL): Promise<Response> {
  if (!adminEnabled(env)) return notFound();
  const path = url.pathname;
  if (req.method === "GET" && (path === "/admin" || path === "/admin/")) return new Response(ADMIN_HTML, { headers: { ...PAGE_HEADERS, "content-type": "text/html; charset=utf-8" } });
  if (req.method === "GET" && path === "/admin/app.js") return new Response(ADMIN_JS, { headers: { ...PAGE_HEADERS, "content-type": "text/javascript; charset=utf-8" } });
  if (req.method === "GET" && path === "/admin/app.css") return new Response(ADMIN_CSS, { headers: { ...PAGE_HEADERS, "content-type": "text/css; charset=utf-8" } });
  if (!path.startsWith("/admin/api/")) return notFound();

  const stop = await limited(req, env, LIMITS.admin);
  if (stop) return stop;
  if (!authorized(req, env)) return json(401, { ok: false, error: "token" });

  const now = nowSeconds();
  if (req.method === "GET" && path === "/admin/api/summary") return json(200, { ok: true, ...(await db.summary(env.DB, now)), newsletterEnabled: news.enabled(env), generatedAt: now });
  if (req.method === "GET" && path === "/admin/api/users") {
    const q = (url.searchParams.get("q") ?? "").slice(0, 100);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "50") || 50, 1), 200);
    const offset = Math.max(Number(url.searchParams.get("offset") ?? "0") || 0, 0);
    return json(200, { ok: true, users: await db.listUsers(env.DB, q, limit, offset) });
  }
  const one = /^\/admin\/api\/users\/([0-9a-f]{32})$/.exec(path);
  if (one && req.method === "GET") {
    const d = await db.userDetail(env.DB, one[1]);
    return d ? json(200, { ok: true, ...d }) : notFound();
  }
  if (one && req.method === "DELETE") {
    const d = await db.userDetail(env.DB, one[1]);
    if (!d) return notFound();
    // the contact at the provider first: if that fails nothing is deleted and the address is still known for a retry
    if (!(await news.erase(env, d.user.email))) return json(502, { ok: false, error: "newsletter_provider" });
    await db.deleteUser(env.DB, one[1]);
    return json(200, { ok: true });
  }
  if (req.method === "GET" && path === "/admin/api/export.csv") {
    return new Response(toCsv(await db.exportRows(env.DB)), {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="intelyide-registry.csv"', "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
  }
  return notFound();
}

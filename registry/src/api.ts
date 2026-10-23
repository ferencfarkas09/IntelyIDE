// The routes the app calls. Every answer is JSON and `no-store`. The app proves which install it is with the token it got at registration
// (`Authorization: Bearer <token>`); the token is kept only as a hash here.
import { randomHex, randomToken, sha256Hex } from "./crypto.ts";
import * as db from "./db.ts";
import { allow, LIMITS, type Limit } from "./limiter.ts";
import * as news from "./newsletter.ts";
import type { Env, NewsletterStatus, Place } from "./types.ts";
import { firstName, MAX_BODY_BYTES, parsePing, parseRegister, place } from "./validate.ts";

export const json = (status: number, body: unknown, extra?: Record<string, string>): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra } });

const bad = (error: string, status = 400): Response => json(status, { ok: false, error });

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export const noticeOf = (env: Env): string => env.NOTICE_VERSION || "2026-10-23";

/** The coarse place Cloudflare derives from the address of the request: country, region and city. The address itself is never read into a stored value. */
export function placeOf(req: Request): Place {
  const cf = (req as Request & { cf?: { country?: unknown; region?: unknown; city?: unknown } }).cf;
  return { country: place(cf?.country), region: place(cf?.region), city: place(cf?.city) };
}

export async function limited(req: Request, env: Env, limit: Limit): Promise<Response | null> {
  const address = req.headers.get("cf-connecting-ip") ?? "unknown";
  const ok = await allow(env.DB, env.PEPPER ?? "", address, limit, nowSeconds());
  return ok ? null : json(429, { ok: false, error: "slow_down" }, { "retry-after": "600" });
}

async function readJson(req: Request): Promise<{ ok: true; value: unknown } | { ok: false; res: Response }> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) return { ok: false, res: bad("content_type", 415) };
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return { ok: false, res: bad("too_large", 413) };
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return { ok: false, res: bad("too_large", 413) };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, res: bad("json") };
  }
}

async function sessionOf(req: Request, env: Env): Promise<db.Session | null> {
  const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.get("authorization") ?? "");
  return m ? db.sessionOf(env.DB, await sha256Hex(m[1])) : null;
}

const tokenHashOf = async (req: Request): Promise<string> => sha256Hex(/^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "");

const unknown = (): Response => bad("unknown_install", 401);

/** POST /v1/register: a person agreed in the app; the user and this computer are stored, a token comes back once. */
export async function register(req: Request, env: Env): Promise<Response> {
  const stop = await limited(req, env, LIMITS.register);
  if (stop) return stop;
  const body = await readJson(req);
  if (!body.ok) return body.res;
  const parsed = parseRegister(body.value);
  if (!parsed.ok) return bad(parsed.error);
  const input = parsed.value;
  const now = nowSeconds();
  const pepper = env.PEPPER ?? "";
  const token = randomToken();
  const saved = await db.saveRegistration(env.DB, {
    userId: randomHex(16),
    installId: randomHex(16),
    input,
    tokenHash: await sha256Hex(token),
    machineHash: await sha256Hex(`${pepper}:machine:${input.device.id}`),
    place: placeOf(req),
    now,
  });
  let status: NewsletterStatus = saved.status;
  // the box was ticked: ask for the confirmation mail, unless one is already waiting or the person is already on the list
  if (input.newsletter && (status === "none" || status === "failed" || status === "unsubscribed")) {
    status = await news.subscribe(env, input.email, firstName(input.name));
    if (status !== "none") await db.setNewsletter(env.DB, saved.userId, status, true, now);
  }
  return json(200, { ok: true, token, notice: noticeOf(env), newsletter: status });
}

/** POST /v1/ping: the app started. Keeps last seen, version and the details that can change. */
export async function ping(req: Request, env: Env): Promise<Response> {
  const stop = await limited(req, env, LIMITS.ping);
  if (stop) return stop;
  if (!(await sessionOf(req, env))) return unknown();
  const body = await readJson(req);
  if (!body.ok) return body.res;
  const parsed = parsePing(body.value);
  if (!parsed.ok) return bad(parsed.error);
  const found = await db.touchInstall(env.DB, await tokenHashOf(req), parsed.value.appVersion, parsed.value.device, placeOf(req), nowSeconds());
  return found ? json(200, { ok: true, notice: noticeOf(env) }) : unknown();
}

/** GET /v1/me: everything stored about this computer and its person, as the person can see it in Settings. */
export async function me(req: Request, env: Env): Promise<Response> {
  const stop = await limited(req, env, LIMITS.me);
  if (stop) return stop;
  const s = await sessionOf(req, env);
  if (!s) return unknown();
  const install = await db.installOf(env.DB, s.install_id);
  return json(200, {
    ok: true,
    notice: noticeOf(env),
    user: { name: s.name, email: s.email, consentNotice: s.consent_notice, consentAt: s.consent_at, newsletter: s.newsletter_status },
    computer: install,
    computers: await db.installCount(env.DB, s.id),
  });
}

/** POST /v1/newsletter {subscribe}: ticks or unticks the newsletter later, from Settings. */
export async function newsletter(req: Request, env: Env): Promise<Response> {
  const stop = await limited(req, env, LIMITS.newsletter);
  if (stop) return stop;
  const s = await sessionOf(req, env);
  if (!s) return unknown();
  const body = await readJson(req);
  if (!body.ok) return body.res;
  const want = (body.value as { subscribe?: unknown } | null)?.subscribe;
  if (typeof want !== "boolean") return bad("subscribe");
  const now = nowSeconds();
  let status: NewsletterStatus = s.newsletter_status;
  if (want) {
    if (status === "none" || status === "failed" || status === "unsubscribed") {
      status = await news.subscribe(env, s.email, firstName(s.name));
      if (status !== "none") await db.setNewsletter(env.DB, s.id, status, true, now);
    }
  } else if (status !== "none") {
    if (!(await news.unsubscribe(env, s.email))) return bad("try_later", 502);
    status = "unsubscribed";
    await db.setNewsletter(env.DB, s.id, status, false, now);
  }
  return json(200, { ok: true, newsletter: status });
}

/**
 * POST /v1/forget: removes this computer. When it was the last one of the person, the person goes too, with the newsletter contact at the provider.
 * Everything tied to an address on several computers is deleted on request by mail (docs/privacy.md).
 */
export async function forget(req: Request, env: Env): Promise<Response> {
  const stop = await limited(req, env, LIMITS.forget);
  if (stop) return stop;
  const s = await sessionOf(req, env);
  if (!s) return unknown();
  if ((await db.installCount(env.DB, s.id)) <= 1) {
    if (!(await news.erase(env, s.email))) return bad("try_later", 502);
    await db.deleteUser(env.DB, s.id);
    return json(200, { ok: true, removed: "all" });
  }
  await db.deleteInstall(env.DB, s.install_id);
  return json(200, { ok: true, removed: "computer" });
}

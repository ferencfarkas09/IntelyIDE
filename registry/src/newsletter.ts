// The newsletter, through Brevo's double opt-in: Brevo sends the confirmation mail, adds the address to the list only when the person clicks
// the link, and puts the unsubscribe link in every campaign. This Worker only asks, withdraws and asks again who confirmed.
// Nothing is sent for a person who did not tick the box in the app.
import type { Env, NewsletterStatus } from "./types.ts";

const API = "https://api.brevo.com/v3";
const TIMEOUT_MS = 8000;

export function enabled(env: Env): boolean {
  return env.NEWSLETTER_PROVIDER === "brevo" && !!env.BREVO_API_KEY && /^\d+$/.test(env.BREVO_LIST_ID ?? "") && /^\d+$/.test(env.BREVO_DOI_TEMPLATE_ID ?? "");
}

async function call(env: Env, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      redirect: "error",
      signal: ctl.signal,
      headers: { "api-key": env.BREVO_API_KEY ?? "", accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* 204 and empty bodies */
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

const contact = (email: string): string => `/contacts/${encodeURIComponent(email)}?identifierType=email_id`;

/** Asks Brevo to send the confirmation mail. 'pending' when it was accepted, 'failed' otherwise (the app asks again at the next registration). */
export async function subscribe(env: Env, email: string, firstName: string): Promise<NewsletterStatus> {
  if (!enabled(env)) return "none";
  try {
    const r = await call(env, "POST", "/contacts/doubleOptinConfirmation", {
      email,
      attributes: { FIRSTNAME: firstName, SOURCE: "IntelyIDE" },
      includeListIds: [Number(env.BREVO_LIST_ID)],
      templateId: Number(env.BREVO_DOI_TEMPLATE_ID),
      redirectionUrl: env.NEWSLETTER_REDIRECT_URL || "https://intelyhome.com/",
    });
    return r.status >= 200 && r.status < 300 ? "pending" : "failed";
  } catch {
    return "failed";
  }
}

/** Takes the address off the list (the contact stays in Brevo until it is erased). */
export async function unsubscribe(env: Env, email: string): Promise<boolean> {
  if (!enabled(env)) return true;
  try {
    const r = await call(env, "PUT", contact(email), { unlinkListIds: [Number(env.BREVO_LIST_ID)] });
    return (r.status >= 200 && r.status < 300) || r.status === 404;
  } catch {
    return false;
  }
}

/** Erases the contact at Brevo (a person who asked to delete their data). A contact that is not there counts as erased. */
export async function erase(env: Env, email: string): Promise<boolean> {
  if (!enabled(env)) return true;
  try {
    const r = await call(env, "DELETE", contact(email));
    return (r.status >= 200 && r.status < 300) || r.status === 404;
  } catch {
    return false;
  }
}

/** What Brevo knows about an address: on the list, blocked (unsubscribed from every mail), known but not on the list, or not known at all. `null` when it could not be asked. */
export type Lookup = "on" | "blocked" | "off" | "absent";

export async function lookup(env: Env, email: string): Promise<Lookup | null> {
  if (!enabled(env)) return null;
  try {
    const r = await call(env, "GET", contact(email));
    if (r.status === 404) return "absent";
    if (r.status !== 200 || typeof r.json !== "object" || r.json === null) return null;
    const c = r.json as { listIds?: unknown; emailBlacklisted?: unknown };
    if (c.emailBlacklisted === true) return "blocked";
    return Array.isArray(c.listIds) && c.listIds.includes(Number(env.BREVO_LIST_ID)) ? "on" : "off";
  } catch {
    return null;
  }
}

/** How long a confirmation mail may stay unanswered before the request is dropped. */
export const PENDING_SECONDS = 14 * 86400;

/**
 * The status after a look at Brevo. The confirmation mail creates the contact only when the person clicks, so "absent" is normal while
 * pending; a person who was subscribed and is gone or blocked has unsubscribed; a request nobody answered for two weeks lapses.
 */
export function nextStatus(current: NewsletterStatus, seen: Lookup, requestedAt: number | null, now: number): NewsletterStatus {
  if (seen === "on") return "subscribed";
  if (seen === "blocked") return "unsubscribed";
  if (current === "subscribed") return "unsubscribed";
  if (current === "pending" && requestedAt !== null && now - requestedAt > PENDING_SECONDS) return "none";
  return current;
}

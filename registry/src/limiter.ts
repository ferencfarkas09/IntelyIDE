import { sha256Hex } from "./crypto.ts";

export const WINDOW_SECONDS = 600;

export interface Limit {
  route: string;
  max: number;
}

export const LIMITS = {
  register: { route: "register", max: 10 },
  ping: { route: "ping", max: 120 },
  forget: { route: "forget", max: 10 },
  me: { route: "me", max: 60 },
  newsletter: { route: "newsletter", max: 20 },
  admin: { route: "admin", max: 60 },
} as const satisfies Record<string, Limit>;

/**
 * Counts a request of an address for a route in the current ten-minute window and tells whether it is still allowed. The address is
 * only used as the input of a salted hash; the counter row is deleted after a day and no address is stored.
 */
export async function allow(db: D1Database, pepper: string, address: string, limit: Limit, now: number): Promise<boolean> {
  const key = await sha256Hex(`${pepper}:rate:${limit.route}:${address}`);
  const win = Math.floor(now / WINDOW_SECONDS);
  const row = await db
    .prepare("INSERT INTO rate (k, n, win) VALUES (?, 1, ?) ON CONFLICT (k) DO UPDATE SET n = CASE WHEN rate.win = excluded.win THEN rate.n + 1 ELSE 1 END, win = excluded.win RETURNING n")
    .bind(key, win)
    .first<{ n: number }>();
  return (row?.n ?? 1) <= limit.max;
}

import type { DeviceUpdate, NewsletterStatus, Place, RegisterInput } from "./types.ts";

export interface UserRow {
  id: string;
  email: string;
  name: string;
  created_at: number;
  updated_at: number;
  consent_notice: string;
  consent_at: number;
  newsletter: number;
  newsletter_at: number | null;
  newsletter_status: NewsletterStatus;
  newsletter_checked_at: number | null;
}

export interface InstallRow {
  id: string;
  user_id: string;
  os: string;
  os_version: string;
  arch: string;
  cpu_cores: number;
  ram_gb: number;
  locale: string;
  tz: string;
  app_version: string;
  country: string | null;
  region: string | null;
  city: string | null;
  first_seen: number;
  last_seen: number;
  launches: number;
}

/** A person registers on a computer: the user row is created or updated, the computer is created or refreshed with a new token. */
export async function saveRegistration(
  db: D1Database,
  p: { userId: string; installId: string; input: RegisterInput; tokenHash: string; machineHash: string; place: Place; now: number },
): Promise<{ userId: string; status: NewsletterStatus; newsletterAt: number | null }> {
  const { input: i, place, now } = p;
  const d = i.device;
  const results = await db.batch([
    db
      .prepare(
        "INSERT INTO users (id, email, name, created_at, updated_at, consent_notice, consent_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (email) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at, consent_notice = excluded.consent_notice, consent_at = excluded.consent_at",
      )
      .bind(p.userId, i.email, i.name, now, now, i.notice, now),
    db
      .prepare(
        "INSERT INTO installs (id, user_id, token_hash, machine_hash, os, os_version, arch, cpu_cores, ram_gb, locale, tz, app_version, country, region, city, first_seen, last_seen, launches) " +
          "VALUES (?, (SELECT id FROM users WHERE email = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1) " +
          "ON CONFLICT (user_id, machine_hash) DO UPDATE SET token_hash = excluded.token_hash, os = excluded.os, os_version = excluded.os_version, arch = excluded.arch, " +
          "cpu_cores = excluded.cpu_cores, ram_gb = excluded.ram_gb, locale = excluded.locale, tz = excluded.tz, app_version = excluded.app_version, " +
          "country = excluded.country, region = excluded.region, city = excluded.city, last_seen = excluded.last_seen, launches = installs.launches + 1",
      )
      .bind(p.installId, i.email, p.tokenHash, p.machineHash, d.os, d.osVersion, d.arch, d.cpuCores, d.ramGb, d.locale, d.tz, i.appVersion, place.country, place.region, place.city, now, now),
    db.prepare("SELECT id, newsletter_status, newsletter_at FROM users WHERE email = ?").bind(i.email),
  ]);
  const row = (results[2].results as { id: string; newsletter_status: NewsletterStatus; newsletter_at: number | null }[])[0];
  return { userId: row.id, status: row.newsletter_status, newsletterAt: row.newsletter_at };
}

export async function setNewsletter(db: D1Database, userId: string, status: NewsletterStatus, asked: boolean, now: number): Promise<void> {
  await db
    .prepare("UPDATE users SET newsletter_status = ?, newsletter = ?, newsletter_at = CASE WHEN ? THEN ? ELSE newsletter_at END, newsletter_checked_at = ?, updated_at = ? WHERE id = ?")
    .bind(status, status === "pending" || status === "subscribed" ? 1 : 0, asked ? 1 : 0, now, now, now, userId)
    .run();
}

export interface Session extends UserRow {
  install_id: string;
}

/** The install behind a token (its hash), with its user. */
export async function sessionOf(db: D1Database, tokenHash: string): Promise<Session | null> {
  return db
    .prepare("SELECT u.*, i.id AS install_id FROM installs i JOIN users u ON u.id = i.user_id WHERE i.token_hash = ?")
    .bind(tokenHash)
    .first<Session>();
}

export async function installOf(db: D1Database, installId: string): Promise<InstallRow | null> {
  return db
    .prepare("SELECT id, user_id, os, os_version, arch, cpu_cores, ram_gb, locale, tz, app_version, country, region, city, first_seen, last_seen, launches FROM installs WHERE id = ?")
    .bind(installId)
    .first<InstallRow>();
}

/** A start of the app: last seen, version and the details that can change; the launch counts once an hour at most. False when the token is unknown. */
export async function touchInstall(db: D1Database, tokenHash: string, version: string, d: DeviceUpdate, place: Place, now: number): Promise<boolean> {
  const r = await db
    .prepare(
      "UPDATE installs SET launches = launches + CASE WHEN ? - last_seen >= 3600 THEN 1 ELSE 0 END, last_seen = ?, app_version = ?, os = ?, os_version = ?, arch = ?, cpu_cores = ?, ram_gb = ?, " +
        "locale = ?, tz = ?, country = COALESCE(?, country), region = COALESCE(?, region), city = COALESCE(?, city) WHERE token_hash = ?",
    )
    .bind(now, now, version, d.os, d.osVersion, d.arch, d.cpuCores, d.ramGb, d.locale, d.tz, place.country, place.region, place.city, tokenHash)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export async function installCount(db: D1Database, userId: string): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM installs WHERE user_id = ?").bind(userId).first<{ n: number }>();
  return r?.n ?? 0;
}

export async function deleteInstall(db: D1Database, installId: string): Promise<void> {
  await db.prepare("DELETE FROM installs WHERE id = ?").bind(installId).run();
}

/** Deletes a user with all their computers (the foreign key cascades). */
export async function deleteUser(db: D1Database, userId: string): Promise<boolean> {
  const r = await db.batch([db.prepare("DELETE FROM installs WHERE user_id = ?").bind(userId), db.prepare("DELETE FROM users WHERE id = ?").bind(userId)]);
  return (r[1].meta.changes ?? 0) > 0;
}

// ------------------------------------------------------------------------------------------------------------- admin reads

export interface Count {
  k: string | null;
  n: number;
}

const GROUPS = { os: "os", arch: "arch", version: "app_version", country: "country" } as const;

export async function summary(db: D1Database, now: number) {
  const day = 86400;
  const t = await db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM installs) AS installs, " +
        "(SELECT COUNT(*) FROM installs WHERE last_seen >= ?) AS active_7d, (SELECT COUNT(*) FROM installs WHERE last_seen >= ?) AS active_30d, " +
        "(SELECT COUNT(*) FROM installs WHERE first_seen >= ?) AS new_7d",
    )
    .bind(now - 7 * day, now - 30 * day, now - 7 * day)
    .first<{ users: number; installs: number; active_7d: number; active_30d: number; new_7d: number }>();
  const groups: Record<string, Count[]> = {};
  for (const [name, col] of Object.entries(GROUPS)) {
    groups[name] = (await db.prepare(`SELECT ${col} AS k, COUNT(*) AS n FROM installs GROUP BY ${col} ORDER BY n DESC, k LIMIT 20`).all<Count>()).results;
  }
  groups.city = (
    await db
      .prepare("SELECT COALESCE(country, '?') || ' · ' || COALESCE(city, '?') AS k, COUNT(*) AS n FROM installs GROUP BY country, city ORDER BY n DESC, k LIMIT 20")
      .all<Count>()
  ).results;
  groups.ram = (
    await db
      .prepare(
        "SELECT CASE WHEN ram_gb < 8 THEN '< 8 GB' WHEN ram_gb < 16 THEN '8-15 GB' WHEN ram_gb < 32 THEN '16-31 GB' ELSE '32 GB +' END AS k, COUNT(*) AS n FROM installs GROUP BY k ORDER BY MIN(ram_gb)",
      )
      .all<Count>()
  ).results;
  groups.newsletter = (await db.prepare("SELECT newsletter_status AS k, COUNT(*) AS n FROM users GROUP BY newsletter_status ORDER BY n DESC").all<Count>()).results;
  groups.computersPerUser = (
    await db
      .prepare("SELECT CASE WHEN c >= 3 THEN '3 or more' ELSE CAST(c AS TEXT) END AS k, COUNT(*) AS n FROM (SELECT COUNT(*) AS c FROM installs GROUP BY user_id) GROUP BY k ORDER BY k")
      .all<Count>()
  ).results;
  return { ...t, groups };
}

const like = (q: string): string => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function listUsers(db: D1Database, q: string, limit: number, offset: number) {
  const pattern = like(q);
  return (
    await db
      .prepare(
        "SELECT u.id, u.email, u.name, u.created_at, u.newsletter_status, COUNT(i.id) AS installs, MAX(i.last_seen) AS last_seen, GROUP_CONCAT(DISTINCT i.os) AS systems, GROUP_CONCAT(DISTINCT i.country) AS countries " +
          "FROM users u LEFT JOIN installs i ON i.user_id = u.id WHERE (? = '' OR u.email LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\') " +
          "GROUP BY u.id ORDER BY COALESCE(MAX(i.last_seen), 0) DESC, u.created_at DESC LIMIT ? OFFSET ?",
      )
      .bind(q, pattern, pattern, limit, offset)
      .all()
  ).results;
}

export async function userDetail(db: D1Database, id: string) {
  const user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
  if (!user) return null;
  const installs = (await db.prepare("SELECT id, os, os_version, arch, cpu_cores, ram_gb, locale, tz, app_version, country, region, city, first_seen, last_seen, launches FROM installs WHERE user_id = ? ORDER BY last_seen DESC").bind(id).all<InstallRow>()).results;
  return { user, installs };
}

export async function exportRows(db: D1Database) {
  return (
    await db
      .prepare(
        "SELECT u.id AS user_id, u.email, u.name, u.created_at, u.consent_notice, u.consent_at, u.newsletter_status, i.os, i.os_version, i.arch, i.cpu_cores, i.ram_gb, i.locale, i.tz, i.app_version, i.country, i.region, i.city, i.first_seen, i.last_seen, i.launches " +
          "FROM users u LEFT JOIN installs i ON i.user_id = u.id ORDER BY u.created_at, u.id, i.first_seen LIMIT 50000",
      )
      .all<Record<string, string | number | null>>()
  ).results;
}

// ------------------------------------------------------------------------------------------------------------- daily upkeep

export async function purge(db: D1Database, now: number, retentionDays: number): Promise<{ installs: number; users: number }> {
  const cutoff = now - retentionDays * 86400;
  const r = await db.batch([
    db.prepare("DELETE FROM rate WHERE win < ?").bind(Math.floor(now / 600) - 144),
    db.prepare("DELETE FROM installs WHERE last_seen < ?").bind(cutoff),
    // a person whose computers all expired and who is not on the newsletter has nothing left that needs keeping
    db.prepare("DELETE FROM users WHERE updated_at < ? AND newsletter_status IN ('none', 'unsubscribed', 'failed') AND NOT EXISTS (SELECT 1 FROM installs WHERE installs.user_id = users.id)").bind(cutoff),
  ]);
  return { installs: r[1].meta.changes ?? 0, users: r[2].meta.changes ?? 0 };
}

export async function newsletterQueue(db: D1Database, limit: number): Promise<Pick<UserRow, "id" | "email" | "newsletter_status" | "newsletter_at">[]> {
  return (
    await db
      .prepare("SELECT id, email, newsletter_status, newsletter_at FROM users WHERE newsletter_status IN ('pending', 'subscribed') ORDER BY COALESCE(newsletter_checked_at, 0) LIMIT ?")
      .bind(limit)
      .all<Pick<UserRow, "id" | "email" | "newsletter_status" | "newsletter_at">>()
  ).results;
}

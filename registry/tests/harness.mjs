// A D1 stand-in on top of node:sqlite (real SQLite, foreign keys on), with the migrations applied, so the Worker's handler runs in Node.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = new URL("../migrations/", import.meta.url).pathname;

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new Statement(this.db, this.sql, params);
  }
  get returnsRows() {
    return /^\s*select/i.test(this.sql) || /\breturning\b/i.test(this.sql);
  }
  async first() {
    return this.db.prepare(this.sql).get(...this.params) ?? null;
  }
  async all() {
    return { success: true, results: this.db.prepare(this.sql).all(...this.params), meta: {} };
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

export function newDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) sqlite.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  return {
    sqlite,
    prepare: (sql) => new Statement(sqlite, sql),
    async batch(statements) {
      const out = [];
      sqlite.exec("BEGIN");
      try {
        for (const s of statements) out.push(s.returnsRows ? await s.all() : await s.run());
        sqlite.exec("COMMIT");
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
      return out;
    },
  };
}

export const DEVICE = {
  id: "a".repeat(64),
  os: "macos",
  osVersion: "15.4.1",
  arch: "aarch64",
  cpuCores: 10,
  ramGb: 32,
  locale: "hu-HU",
  tz: "Europe/Budapest",
};

export const registerBody = (over = {}) => ({
  name: "Kovács Anna",
  email: "Anna@Example.com",
  consent: { storage: true, newsletter: false, notice: "2026-10-23" },
  appVersion: "1.13.0",
  device: { ...DEVICE },
  ...over,
});

export function makeEnv(over = {}) {
  return { DB: newDb(), PEPPER: "pepper-for-tests", NOTICE_VERSION: "2026-10-23", ...over };
}

/** A request the way Cloudflare delivers it: with the address header and the `cf` place. */
export function request(path, { method = "GET", body, token, headers = {}, ip = "203.0.113.7", cf = { country: "HU", region: "Budapest", city: "Budapest" } } = {}) {
  const h = { "cf-connecting-ip": ip, ...headers };
  if (body !== undefined) h["content-type"] ??= "application/json";
  if (token) h.authorization = `Bearer ${token}`;
  const req = new Request(`https://registry.test${path}`, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  Object.defineProperty(req, "cf", { value: cf });
  return req;
}

/** Records the calls to Brevo and answers like it does. */
export function fakeBrevo(answers = {}) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ method: init.method ?? "GET", path: u.pathname + u.search, host: u.host, body: init.body ? JSON.parse(init.body) : undefined, key: init.headers?.["api-key"] });
    const key = `${init.method ?? "GET"} ${u.pathname}`;
    const a = answers[key] ?? answers[`${init.method ?? "GET"}`] ?? { status: 204 };
    return new Response(a.body === undefined ? null : JSON.stringify(a.body), { status: a.status });
  };
  return { calls, restore: () => void (globalThis.fetch = real) };
}

export const BREVO_ENV = { NEWSLETTER_PROVIDER: "brevo", BREVO_API_KEY: "key-for-tests", BREVO_LIST_ID: "7", BREVO_DOI_TEMPLATE_ID: "9", NEWSLETTER_REDIRECT_URL: "https://intelyhome.com/newsletter/confirmed/" };

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { handle, upkeep } from "../src/index.ts";
import { csvCell, toCsv } from "../src/admin.ts";
import { nextStatus, PENDING_SECONDS } from "../src/newsletter.ts";
import { parseEmail, parsePing, parseRegister, parseVersion } from "../src/validate.ts";
import { safeEqual, sha256Hex } from "../src/crypto.ts";
import { BREVO_ENV, DEVICE, fakeBrevo, makeEnv, registerBody, request } from "./harness.mjs";

const ADMIN = "admin-token-that-is-long-enough-1234";
let brevo;
afterEach(() => brevo?.restore());

async function call(env, path, opts) {
  const res = await handle(request(path, opts), env);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* html, csv */
  }
  return { status: res.status, body, text, headers: res.headers };
}

const register = (env, body = registerBody(), opts = {}) => call(env, "/v1/register", { method: "POST", body, ...opts });
const count = (env, table) => env.DB.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

describe("validation", () => {
  it("accepts a normal registration and normalises it", () => {
    const r = parseRegister(registerBody({ name: "  Kovács Anna  " }));
    assert.ok(r.ok);
    assert.equal(r.value.email, "anna@example.com");
    assert.equal(r.value.name, "Kovács Anna");
    assert.equal(r.value.device.os, "macos");
  });
  it("turns an unknown system or architecture into other", () => {
    const r = parseRegister(registerBody({ device: { ...DEVICE, os: "haiku", arch: "riscv64" } }));
    assert.ok(r.ok);
    assert.equal(r.value.device.os, "other");
    assert.equal(r.value.device.arch, "other");
  });
  it("needs the consent to store, a boolean for the newsletter and a dated notice", () => {
    assert.deepEqual(parseRegister(registerBody({ consent: { storage: false, newsletter: false, notice: "2026-10-23" } })), { ok: false, error: "consent" });
    assert.deepEqual(parseRegister(registerBody({ consent: { newsletter: false, notice: "2026-10-23" } })), { ok: false, error: "consent" });
    assert.deepEqual(parseRegister(registerBody({ consent: { storage: true, newsletter: "yes", notice: "2026-10-23" } })), { ok: false, error: "consent.newsletter" });
    assert.deepEqual(parseRegister(registerBody({ consent: { storage: true, newsletter: true, notice: "today" } })), { ok: false, error: "consent.notice" });
  });
  it("rejects bad names, emails, versions and device fields", () => {
    for (const name of ["", "   ", "x".repeat(101), "a\nb", 5]) assert.equal(parseRegister(registerBody({ name })).ok, false, JSON.stringify(name));
    for (const email of ["", "no-at", "a@b", "a b@example.com", "<x>@example.com", `${"a".repeat(65)}@example.com`, "a@exam ple.com", "a@@example.com"]) assert.equal(parseEmail(email), null, email);
    assert.equal(parseEmail("Ünï@Example.COM"), null, "only plain ASCII addresses");
    assert.equal(parseEmail("first.last+tag@example.com"), "first.last+tag@example.com");
    for (const v of ["1.2", "1.2.3.4", "v1.2.3", "1.2.3-", "1.2.3 beta", "1.2.<3>"]) assert.equal(parseVersion(v), null, v);
    assert.equal(parseVersion("1.13.0-rc.1"), "1.13.0-rc.1");
    assert.equal(parseRegister(registerBody({ device: { ...DEVICE, id: "A".repeat(64) } })).ok, false, "upper case id");
    assert.equal(parseRegister(registerBody({ device: { ...DEVICE, id: "a".repeat(63) } })).ok, false);
    assert.equal(parseRegister(registerBody({ device: { ...DEVICE, cpuCores: 0 } })).ok, false);
    assert.equal(parseRegister(registerBody({ device: { ...DEVICE, ramGb: 1.5 } })).ok, false);
    assert.equal(parseRegister(registerBody({ device: { ...DEVICE, tz: "Europe/Budapest; drop table" } })).ok, false);
  });
  it("parses a ping", () => {
    const { id, ...rest } = DEVICE;
    assert.ok(parsePing({ appVersion: "1.13.0", device: rest }).ok);
    assert.equal(parsePing({ appVersion: "x", device: rest }).ok, false);
    assert.equal(id.length, 64);
  });
  it("compares secrets without early exit", () => {
    assert.ok(safeEqual("abc", "abc"));
    assert.ok(!safeEqual("abc", "abd"));
    assert.ok(!safeEqual("abc", "abcd"));
  });
});

describe("register", () => {
  it("stores the person and the computer, and returns a token once", async () => {
    const env = makeEnv();
    const r = await register(env);
    assert.equal(r.status, 200);
    assert.match(r.body.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(r.body.newsletter, "none");
    assert.equal(count(env, "users"), 1);
    assert.equal(count(env, "installs"), 1);
    const u = env.DB.sqlite.prepare("SELECT * FROM users").get();
    assert.equal(u.email, "anna@example.com");
    assert.equal(u.consent_notice, "2026-10-23");
    const i = env.DB.sqlite.prepare("SELECT * FROM installs").get();
    assert.equal(i.country, "HU");
    assert.equal(i.city, "Budapest");
    assert.equal(i.os, "macos");
    assert.equal(i.ram_gb, 32);
    assert.notEqual(i.token_hash, r.body.token, "the token itself is not stored");
    assert.equal(i.token_hash, await sha256Hex(r.body.token));
    assert.notEqual(i.machine_hash, DEVICE.id, "the fingerprint is hashed again with the secret");
    assert.equal(r.headers.get("cache-control"), "no-store");
  });
  it("keeps one person with several computers and one row for a computer registered twice", async () => {
    const env = makeEnv();
    const first = await register(env);
    const again = await register(env, registerBody({ name: "Anna K." }));
    assert.equal(count(env, "users"), 1);
    assert.equal(count(env, "installs"), 1, "same computer, same row");
    assert.equal(env.DB.sqlite.prepare("SELECT name FROM users").get().name, "Anna K.");
    assert.equal(env.DB.sqlite.prepare("SELECT launches FROM installs").get().launches, 2);
    const old = await call(env, "/v1/me", { token: first.body.token });
    assert.equal(old.status, 401, "registering again replaces the token");
    assert.equal((await call(env, "/v1/me", { token: again.body.token })).status, 200);
    await register(env, registerBody({ device: { ...DEVICE, id: "b".repeat(64), os: "windows", arch: "x86_64" } }));
    assert.equal(count(env, "users"), 1);
    assert.equal(count(env, "installs"), 2);
  });
  it("answers 400 for a bad body, 415 for the wrong type and 413 for a big one", async () => {
    const env = makeEnv();
    assert.equal((await register(env, { ...registerBody(), email: "nope" })).status, 400);
    assert.equal((await register(env, "{not json")).status, 400);
    assert.equal((await call(env, "/v1/register", { method: "POST", body: "x", headers: { "content-type": "text/plain" } })).status, 415);
    assert.equal((await register(env, registerBody({ name: "x".repeat(5000) }))).status, 413);
    assert.equal(count(env, "users"), 0);
  });
  it("limits the requests of one address", async () => {
    const env = makeEnv();
    for (let i = 0; i < 10; i++) assert.equal((await register(env, registerBody({ email: `p${i}@example.com` }))).status, 200);
    const stop = await register(env, registerBody({ email: "p11@example.com" }));
    assert.equal(stop.status, 429);
    assert.equal(stop.headers.get("retry-after"), "600");
    assert.equal((await register(env, registerBody({ email: "other@example.com" }), { ip: "198.51.100.9" })).status, 200, "another address is not affected");
  });
  it("stores no address anywhere", async () => {
    const env = makeEnv();
    await register(env, registerBody(), { ip: "203.0.113.77" });
    await call(env, "/v1/health", { ip: "203.0.113.77" });
    for (const table of ["users", "installs", "rate"]) {
      const dump = JSON.stringify(env.DB.sqlite.prepare(`SELECT * FROM ${table}`).all());
      assert.ok(!dump.includes("203.0.113.77"), `${table} holds the address`);
    }
    const columns = env.DB.sqlite.prepare("SELECT m.name AS t, p.name AS c FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table'").all();
    assert.deepEqual(columns.filter((c) => /(^|_)ip($|_)|address/i.test(c.c)), []);
  });
});

describe("ping, me and forget", () => {
  it("refreshes the computer and counts a launch once an hour", async () => {
    const env = makeEnv();
    const { body } = await register(env);
    const { id, ...device } = DEVICE;
    assert.equal(id.length, 64);
    const update = { appVersion: "1.14.0", device: { ...device, osVersion: "15.5", ramGb: 64 } };
    assert.equal((await call(env, "/v1/ping", { method: "POST", token: body.token, body: update })).status, 200);
    let row = env.DB.sqlite.prepare("SELECT * FROM installs").get();
    assert.equal(row.app_version, "1.14.0");
    assert.equal(row.os_version, "15.5");
    assert.equal(row.ram_gb, 64);
    assert.equal(row.launches, 1, "within the hour it is the same launch");
    env.DB.sqlite.prepare("UPDATE installs SET last_seen = last_seen - 7200").run();
    await call(env, "/v1/ping", { method: "POST", token: body.token, body: update });
    row = env.DB.sqlite.prepare("SELECT * FROM installs").get();
    assert.equal(row.launches, 2);
  });
  it("rejects a ping with an unknown or malformed token", async () => {
    const env = makeEnv();
    const { id, ...device } = DEVICE;
    assert.equal(id.length, 64);
    const body = { appVersion: "1.13.0", device };
    assert.equal((await call(env, "/v1/ping", { method: "POST", body })).status, 401);
    assert.equal((await call(env, "/v1/ping", { method: "POST", token: "x".repeat(43), body })).status, 401);
    assert.equal((await call(env, "/v1/ping", { method: "POST", token: "short", body })).status, 401);
  });
  it("shows what is stored about the person and the computer", async () => {
    const env = makeEnv();
    const { body } = await register(env);
    const me = await call(env, "/v1/me", { token: body.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, "anna@example.com");
    assert.equal(me.body.user.name, "Kovács Anna");
    assert.equal(me.body.computer.os, "macos");
    assert.equal(me.body.computer.city, "Budapest");
    assert.equal(me.body.computers, 1);
    assert.ok(!("token_hash" in me.body.computer) && !("machine_hash" in me.body.computer));
  });
  it("removes only this computer while the person has others", async () => {
    const env = makeEnv();
    const a = await register(env);
    await register(env, registerBody({ device: { ...DEVICE, id: "c".repeat(64) } }));
    const r = await call(env, "/v1/forget", { method: "POST", token: a.body.token, body: {} });
    assert.deepEqual(r.body, { ok: true, removed: "computer" });
    assert.equal(count(env, "installs"), 1);
    assert.equal(count(env, "users"), 1);
  });
  it("removes the person with the last computer, and the contact at the newsletter provider", async () => {
    brevo = fakeBrevo();
    const env = makeEnv(BREVO_ENV);
    const a = await register(env);
    const r = await call(env, "/v1/forget", { method: "POST", token: a.body.token, body: {} });
    assert.deepEqual(r.body, { ok: true, removed: "all" });
    assert.equal(count(env, "installs"), 0);
    assert.equal(count(env, "users"), 0);
    assert.deepEqual(brevo.calls.map((c) => [c.method, c.path]), [["DELETE", "/v3/contacts/anna%40example.com?identifierType=email_id"]]);
  });
  it("keeps everything when the provider cannot erase the contact", async () => {
    brevo = fakeBrevo({ DELETE: { status: 500 } });
    const env = makeEnv(BREVO_ENV);
    const a = await register(env);
    const r = await call(env, "/v1/forget", { method: "POST", token: a.body.token, body: {} });
    assert.equal(r.status, 502);
    assert.equal(count(env, "users"), 1);
  });
});

describe("newsletter", () => {
  it("sends nothing when the box was not ticked", async () => {
    brevo = fakeBrevo();
    const env = makeEnv(BREVO_ENV);
    const r = await register(env);
    assert.equal(r.body.newsletter, "none");
    assert.equal(brevo.calls.length, 0);
  });
  it("asks Brevo for the double opt-in mail when it was ticked", async () => {
    brevo = fakeBrevo();
    const env = makeEnv(BREVO_ENV);
    const r = await register(env, registerBody({ consent: { storage: true, newsletter: true, notice: "2026-10-23" } }));
    assert.equal(r.body.newsletter, "pending");
    assert.equal(brevo.calls.length, 1);
    const c = brevo.calls[0];
    assert.equal(c.host, "api.brevo.com");
    assert.equal(c.path, "/v3/contacts/doubleOptinConfirmation");
    assert.equal(c.key, "key-for-tests");
    assert.deepEqual(c.body, {
      email: "anna@example.com",
      attributes: { FIRSTNAME: "Kovács", SOURCE: "IntelyIDE" },
      includeListIds: [7],
      templateId: 9,
      redirectionUrl: "https://intelyhome.com/newsletter/confirmed/",
    });
    const u = env.DB.sqlite.prepare("SELECT * FROM users").get();
    assert.equal(u.newsletter_status, "pending");
    assert.equal(u.newsletter, 1);
    assert.ok(u.newsletter_at > 0);
  });
  it("does not ask again while a request is pending", async () => {
    brevo = fakeBrevo();
    const env = makeEnv(BREVO_ENV);
    const ticked = registerBody({ consent: { storage: true, newsletter: true, notice: "2026-10-23" } });
    await register(env, ticked);
    await register(env, ticked);
    assert.equal(brevo.calls.length, 1);
  });
  it("marks the request failed when Brevo refuses, and asks again next time", async () => {
    brevo = fakeBrevo({ POST: { status: 400, body: { message: "no" } } });
    const env = makeEnv(BREVO_ENV);
    const ticked = registerBody({ consent: { storage: true, newsletter: true, notice: "2026-10-23" } });
    assert.equal((await register(env, ticked)).body.newsletter, "failed");
    brevo.restore();
    brevo = fakeBrevo();
    assert.equal((await register(env, ticked)).body.newsletter, "pending");
  });
  it("stores the choice but contacts nobody when the provider is off", async () => {
    brevo = fakeBrevo();
    const env = makeEnv();
    const r = await register(env, registerBody({ consent: { storage: true, newsletter: true, notice: "2026-10-23" } }));
    assert.equal(r.body.newsletter, "none");
    assert.equal(brevo.calls.length, 0);
  });
  it("lets the person turn it on and off later", async () => {
    brevo = fakeBrevo();
    const env = makeEnv(BREVO_ENV);
    const { body } = await register(env);
    const on = await call(env, "/v1/newsletter", { method: "POST", token: body.token, body: { subscribe: true } });
    assert.equal(on.body.newsletter, "pending");
    const off = await call(env, "/v1/newsletter", { method: "POST", token: body.token, body: { subscribe: false } });
    assert.equal(off.body.newsletter, "unsubscribed");
    assert.deepEqual(brevo.calls.map((c) => c.method), ["POST", "PUT"]);
    assert.deepEqual(brevo.calls[1].body, { unlinkListIds: [7] });
    assert.equal((await call(env, "/v1/newsletter", { method: "POST", token: body.token, body: { subscribe: "yes" } })).status, 400);
  });
  it("works out the status from what Brevo says", () => {
    const now = 2_000_000_000;
    assert.equal(nextStatus("pending", "on", now - 10, now), "subscribed");
    assert.equal(nextStatus("pending", "absent", now - 10, now), "pending", "the contact appears only after the click");
    assert.equal(nextStatus("pending", "absent", now - PENDING_SECONDS - 1, now), "none", "nobody answered for two weeks");
    assert.equal(nextStatus("pending", "off", now - 10, now), "pending");
    assert.equal(nextStatus("subscribed", "off", now - 10, now), "unsubscribed");
    assert.equal(nextStatus("subscribed", "absent", now - 10, now), "unsubscribed");
    assert.equal(nextStatus("subscribed", "blocked", now - 10, now), "unsubscribed");
    assert.equal(nextStatus("pending", "blocked", now - 10, now), "unsubscribed");
    assert.equal(nextStatus("subscribed", "on", now - 10, now), "subscribed");
  });
  it("syncs the pending and subscribed ones in the daily upkeep", async () => {
    brevo = fakeBrevo({ GET: { status: 200, body: { listIds: [7], emailBlacklisted: false } } });
    const env = makeEnv(BREVO_ENV);
    await register(env, registerBody({ consent: { storage: true, newsletter: true, notice: "2026-10-23" } }));
    brevo.calls.length = 0;
    await upkeep(env, Math.floor(Date.now() / 1000));
    assert.equal(env.DB.sqlite.prepare("SELECT newsletter_status AS s FROM users").get().s, "subscribed");
    assert.deepEqual(brevo.calls.map((c) => c.method), ["GET"]);
  });
});

describe("daily upkeep", () => {
  it("deletes computers not seen for the retention time, and the people left with nothing", async () => {
    const env = makeEnv({ RETENTION_DAYS: "30" });
    await register(env);
    await register(env, registerBody({ email: "keep@example.com" }), { ip: "198.51.100.1" });
    const old = Math.floor(Date.now() / 1000) - 40 * 86400;
    env.DB.sqlite.prepare("UPDATE installs SET last_seen = ? WHERE user_id = (SELECT id FROM users WHERE email = 'anna@example.com')").run(old);
    env.DB.sqlite.prepare("UPDATE users SET updated_at = ? WHERE email = 'anna@example.com'").run(old);
    await upkeep(env, Math.floor(Date.now() / 1000));
    assert.deepEqual(env.DB.sqlite.prepare("SELECT email FROM users").all().map((u) => u.email), ["keep@example.com"]);
    assert.equal(count(env, "installs"), 1);
  });
  it("keeps someone who is on the newsletter even when the computers are gone", async () => {
    brevo = fakeBrevo({ GET: { status: 200, body: { listIds: [7] } } });
    const env = makeEnv({ ...BREVO_ENV, RETENTION_DAYS: "30" });
    await register(env, registerBody({ consent: { storage: true, newsletter: true, notice: "2026-10-23" } }));
    const old = Math.floor(Date.now() / 1000) - 40 * 86400;
    env.DB.sqlite.prepare("UPDATE installs SET last_seen = ?").run(old);
    env.DB.sqlite.prepare("UPDATE users SET updated_at = ?").run(old);
    await upkeep(env, Math.floor(Date.now() / 1000));
    assert.equal(count(env, "users"), 1);
    assert.equal(count(env, "installs"), 0);
  });
});

describe("admin", () => {
  const authed = { token: ADMIN };
  it("does not exist without a long enough token", async () => {
    for (const env of [makeEnv(), makeEnv({ ADMIN_TOKEN: "short" })]) {
      assert.equal((await call(env, "/admin")).status, 404);
      assert.equal((await call(env, "/admin/api/summary", authed)).status, 404);
    }
  });
  it("serves the page with a strict policy and nothing from the database", async () => {
    const env = makeEnv({ ADMIN_TOKEN: ADMIN });
    await register(env);
    const page = await call(env, "/admin");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.ok(!page.text.includes("anna@example.com"));
    assert.equal((await call(env, "/admin/app.js")).status, 200);
    assert.equal((await call(env, "/admin/app.css")).status, 200);
    const js = (await call(env, "/admin/app.js")).text;
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(js), "data is put on the page as text only");
  });
  it("wants the token for every API call", async () => {
    const env = makeEnv({ ADMIN_TOKEN: ADMIN });
    assert.equal((await call(env, "/admin/api/summary")).status, 401);
    assert.equal((await call(env, "/admin/api/summary", { token: ADMIN + "x" })).status, 401);
    assert.equal((await call(env, "/admin/api/summary", { token: ADMIN })).status, 200);
  });
  it("limits wrong guesses", async () => {
    const env = makeEnv({ ADMIN_TOKEN: ADMIN });
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await call(env, "/admin/api/summary", { token: "wrong" })).status;
    assert.equal(last, 429);
  });
  it("summarises the people and the computers", async () => {
    const env = makeEnv({ ADMIN_TOKEN: ADMIN });
    await register(env);
    await register(env, registerBody({ device: { ...DEVICE, id: "d".repeat(64), os: "windows", arch: "x86_64", ramGb: 8 } }), { cf: { country: "DE", region: "Bavaria", city: "Munich" } });
    await register(env, registerBody({ email: "bela@example.com", name: "Béla", device: { ...DEVICE, id: "e".repeat(64), os: "linux", ramGb: 16 } }), { ip: "198.51.100.2" });
    const s = (await call(env, "/admin/api/summary", authed)).body;
    assert.equal(s.users, 2);
    assert.equal(s.installs, 3);
    assert.equal(s.active_7d, 3);
    const by = (g) => Object.fromEntries(s.groups[g].map((r) => [r.k, r.n]));
    assert.deepEqual(by("os"), { macos: 1, windows: 1, linux: 1 });
    assert.deepEqual(by("country"), { HU: 2, DE: 1 });
    assert.deepEqual(by("computersPerUser"), { 1: 1, 2: 1 });
    assert.equal(by("ram")["< 8 GB"] ?? 0, 0);
    assert.equal(by("ram")["8-15 GB"], 1);
    assert.equal(by("ram")["32 GB +"], 1);
    assert.equal(by("newsletter").none, 2);
  });
  it("lists, searches and shows people, and deletes one with the provider's contact", async () => {
    brevo = fakeBrevo();
    const env = makeEnv({ ...BREVO_ENV, ADMIN_TOKEN: ADMIN });
    await register(env);
    await register(env, registerBody({ email: "bela@example.com", name: "Béla" }), { ip: "198.51.100.2" });
    const all = (await call(env, "/admin/api/users", authed)).body.users;
    assert.equal(all.length, 2);
    assert.equal((await call(env, "/admin/api/users?q=bela", authed)).body.users.length, 1);
    assert.equal((await call(env, "/admin/api/users?q=%25", authed)).body.users.length, 0, "% is not a wildcard");
    const bela = all.find((u) => u.email === "bela@example.com");
    const d = (await call(env, `/admin/api/users/${bela.id}`, authed)).body;
    assert.equal(d.user.name, "Béla");
    assert.equal(d.installs.length, 1);
    assert.equal((await call(env, "/admin/api/users/" + "0".repeat(32), authed)).status, 404);
    assert.equal((await call(env, `/admin/api/users/${bela.id}`, { ...authed, method: "DELETE" })).status, 200);
    assert.equal(count(env, "users"), 1);
    assert.equal(count(env, "installs"), 1);
    assert.deepEqual(brevo.calls.map((c) => [c.method, c.path]), [["DELETE", "/v3/contacts/bela%40example.com?identifierType=email_id"]]);
  });
  it("exports a CSV that a spreadsheet will not run as a formula", async () => {
    const env = makeEnv({ ADMIN_TOKEN: ADMIN });
    await register(env, registerBody({ name: '=HYPERLINK("http://evil","x")' }));
    const r = await call(env, "/admin/api/export.csv", authed);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /text\/csv/);
    const lines = r.text.trim().split("\r\n");
    assert.equal(lines.length, 2);
    assert.ok(lines[1].includes(`"'=HYPERLINK(""http://evil"",""x"")"`), lines[1]);
    assert.ok(!lines[1].includes(",=HYPERLINK"));
    assert.equal(csvCell("+1"), "'+1");
    assert.equal(csvCell("-1"), "'-1");
    assert.equal(csvCell("@x"), "'@x");
    assert.equal(csvCell("a,b"), '"a,b"');
    assert.equal(csvCell(null), "");
    assert.equal(toCsv([]).split("\r\n")[0].startsWith("user_id,email,name"), true);
  });
});

describe("routing", () => {
  it("answers health, 404 and 405 without detail", async () => {
    const env = makeEnv();
    assert.deepEqual((await call(env, "/v1/health")).body, { ok: true, notice: "2026-10-23" });
    assert.equal((await call(env, "/nope")).status, 404);
    const wrong = await call(env, "/v1/register");
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get("allow"), "POST");
  });
  it("hides internal errors", async () => {
    const env = makeEnv();
    env.DB = { prepare() { throw new Error("secret detail anna@example.com"); } };
    const r = await call(env, "/v1/register", { method: "POST", body: registerBody() });
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { ok: false, error: "server" });
  });
});

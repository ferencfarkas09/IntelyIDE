import { describe, expect, it } from "vitest";
import { createMockMongoWorld, MOCK_DB } from "./mongo";

const world = (o = {}) => createMockMongoWorld({ seeded: true, latencyMs: 0, ...o });
const find = (filter = "", extra: Record<string, unknown> = {}) => ({ cmd: "find" as const, db: MOCK_DB, collection: "orders", filter, ...extra });

describe("mongo mock gateway", () => {
  it("is off until the switch is on: the profile list is exempt, everything that opens a socket answers mongoDisabled", async () => {
    const w = createMockMongoWorld({ seeded: false, latencyMs: 0 });
    expect(await w.mongo.status()).toMatchObject({ compiled: true, enabled: false });
    expect(await w.mongo.profiles()).toEqual([]);
    await expect(w.mongo.connect("x")).rejects.toMatchObject({ code: "mongoDisabled" });
    await expect(w.mongo.uriParse("mongodb://127.0.0.1")).rejects.toMatchObject({ code: "mongoDisabled" });
    await expect(w.mongo.detectLocal()).rejects.toMatchObject({ code: "mongoDisabled" });
    await w.mongo.setEnabled(true);
    expect(await w.mongo.profiles()).toEqual([]);
  });

  it("reports a build without the feature as not compiled", async () => {
    expect(await world({ compiled: false }).mongo.status()).toMatchObject({ compiled: false });
  });

  it("serves 100,000 orders in windows without holding them: first window, then pages of the same cursor", async () => {
    const { mongo } = world();
    await mongo.connect("local-fixture");
    const first = await mongo.run({ tab: "t1", connection: "local-fixture", command: find(), pageSize: 50 });
    expect(first.docs).toHaveLength(50);
    expect(first.offset).toBe(0);
    expect(first.hasMore).toBe(true);
    const far = await mongo.window("t1", 950, 50);
    expect(far.docs).toHaveLength(50);
    expect(far.offset).toBe(950);
    expect(far.hasMore).toBe(false);
    const count = await mongo.run({ tab: "t1-n", connection: "local-fixture", command: { cmd: "count", db: MOCK_DB, collection: "orders", filter: "" } });
    expect(JSON.parse(count.docs[0])).toEqual({ count: 100_000, capped: true });
  });

  it("returns canonical Extended JSON with Int64-safe wrappers and typed dates", async () => {
    const { mongo } = world();
    await mongo.connect("local-fixture");
    const w = await mongo.run({ tab: "t2", connection: "local-fixture", command: find("", { limit: 3 }) });
    const doc = JSON.parse(w.docs[0]);
    expect(doc._id).toHaveProperty("$oid");
    expect(doc.createdAt.$date.$numberLong).toMatch(/^\d+$/);
    expect(doc.shopId).toHaveProperty("$oid");
    expect(doc.items[0].qty).toHaveProperty("$numberInt");
    expect(JSON.stringify(doc)).not.toMatch(/Kovács|Gulyás/);
  });

  it("filters, sorts and finds the late dates of a time-ordered collection", async () => {
    const { mongo } = world();
    await mongo.connect("local-fixture");
    const w = await mongo.run({ tab: "t3", connection: "local-fixture", command: find('{ status: "open", createdAt: { $gte: ISODate("2026-09-26T00:00:00+02:00") } }', { sort: "{ createdAt: -1 }", limit: 20 }) });
    expect(w.docs.length).toBeGreaterThan(0);
    const docs = w.docs.map((d) => JSON.parse(d));
    expect(docs.every((d) => d.status === "open")).toBe(true);
    const times = docs.map((d) => Number(d.createdAt.$date.$numberLong));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(Math.min(...times)).toBeGreaterThanOrEqual(Date.UTC(2026, 8, 25, 22));
  });

  it("rejects a bad literal with its position and a write-looking filter operator", async () => {
    const { mongo } = world();
    await mongo.connect("local-fixture");
    await expect(mongo.run({ tab: "t4", connection: "local-fixture", command: find("{ a: ") })).rejects.toMatchObject({ code: "mongoParse" });
    await expect(mongo.run({ tab: "t4", connection: "local-fixture", command: find("{ $where: 'x' }") })).rejects.toMatchObject({ code: "mongoRejected" });
  });

  it("cancels a slow collection", async () => {
    const { mongo } = world();
    await mongo.connect("local-fixture");
    const p = mongo.run({ tab: "slow", connection: "local-fixture", command: { cmd: "find", db: MOCK_DB, collection: "events", filter: "" } });
    await new Promise((r) => setTimeout(r, 150));
    expect(await mongo.cancel("slow")).toEqual({ cancelled: true, killed: true });
    await expect(p).rejects.toMatchObject({ code: "mongoCancelled" });
  });

  it("needs a connection first and a stored string to connect", async () => {
    const { mongo } = world();
    await expect(mongo.run({ tab: "t5", connection: "local-fixture", command: find() })).rejects.toMatchObject({ code: "mongoNotConnected" });
    await expect(mongo.profileSave({ name: "No string", environment: "local" })).rejects.toMatchObject({ code: "mongoNoUri" });
  });

  it("treats any non-loopback host as production-level whatever the tag says, and never returns the string", async () => {
    const { mongo } = world();
    const remote = await mongo.profileSave({ name: "Remote", environment: "local", uri: "mongodb://user:hunter2@db.example.com:27017/app" });
    expect(remote).toMatchObject({ effectiveLevel: "productionLevel", readPreference: "secondaryPreferred", hasUri: true, readOnly: true });
    // effective level is max(tag, host rule): a production tag raises a loopback host, a local tag never lowers a remote one
    const tagged = await mongo.profileSave({ name: "Loop", environment: "production", uri: "mongodb://127.0.0.1:27017" });
    expect(tagged).toMatchObject({ hostLevel: "local", effectiveLevel: "productionLevel" });
    const local = await mongo.profileSave({ name: "Loop2", environment: "local", uri: "mongodb://127.0.0.1:27017" });
    expect(local.effectiveLevel).toBe("local");
    expect(JSON.stringify([remote, await mongo.profiles(), await mongo.status()])).not.toContain("hunter2");
  });

  it("asks for the typed profile name before lowering a safety setting", async () => {
    const { mongo } = world();
    await expect(mongo.profileSave({ id: "sandbox-atlas", name: "Sandbox (Atlas)", environment: "sandbox", aiMode: "schemaOnly" })).rejects.toMatchObject({ code: "mongoConfirm" });
    // the value-list mode is a further step down in privacy: it needs the typed name too
    await expect(mongo.profileSave({ id: "local-fixture", name: "Local fixture", environment: "local", aiMode: "schemaEnums" })).rejects.toMatchObject({ code: "mongoConfirm" });
    expect(await mongo.profileSave({ id: "local-fixture", name: "Local fixture", environment: "local", aiMode: "schemaEnums", confirm: "Local fixture" })).toMatchObject({ aiMode: "schemaEnums" });
    expect(await mongo.profileSave({ id: "sandbox-atlas", name: "Sandbox (Atlas)", environment: "sandbox", aiMode: "schemaOnly", confirm: "Sandbox (Atlas)" })).toMatchObject({ aiMode: "schemaOnly" });
    await expect(mongo.profileSave({ id: "sandbox-atlas", name: "Sandbox (Atlas)", environment: "sandbox", levelOverrideHost: "wrong.example.com", confirm: "Sandbox (Atlas)" })).rejects.toMatchObject({ code: "mongoConfirm" });
  });

  it("enforces the tenant lock on a find", async () => {
    const { mongo } = world();
    await mongo.connect("production");
    await expect(mongo.run({ tab: "t6", connection: "production", command: find() })).rejects.toMatchObject({ code: "mongoRejected" });
    await expect(mongo.run({ tab: "t6", connection: "production", command: find('{ shopId: ObjectId("69f6e4600000000000000001") }') })).resolves.toBeTruthy();
    // the Happy profile locks on its own tenant field
    await mongo.connect("happy-production");
    await expect(mongo.run({ tab: "t7h", connection: "happy-production", command: find() })).rejects.toMatchObject({ code: "mongoRejected" });
    await expect(mongo.run({ tab: "t7h", connection: "happy-production", command: find('{ restaurant: ObjectId("69f6e4600000000000000001") }') })).resolves.toBeTruthy();
  });

  it("runs the role probe on every connection and reports it", async () => {
    const { mongo } = world();
    expect((await mongo.connect("local-fixture")).role).toEqual({ role: "readOnly" });
    const sandbox = await mongo.connect("sandbox-atlas");
    expect(sandbox.role.role).toBe("unknown");
    expect(sandbox.roleElevated).toBe(true);
    const t = await mongo.test({ name: "x", environment: "local", uri: "mongodb://127.0.0.1:27017" });
    expect(t.connection?.role).toMatchObject({ role: "canWrite", noAuth: true });
    expect(await mongo.test({ name: "x", environment: "local", uri: "mongodb://127.0.0.1/?badauth" })).toMatchObject({ ok: false, errorClass: "auth" });
  });

  it("explains a find with and without an index", async () => {
    const { mongo } = world();
    await mongo.connect("local-fixture");
    const scan = await mongo.run({ tab: "x1", connection: "local-fixture", command: { cmd: "explain", inner: find('{ status: "open" }') } });
    expect(scan.plan).toMatchObject({ collscan: true });
    expect(scan.plan?.warnings[0]).toMatch(/COLLSCAN/);
    const idx = await mongo.run({ tab: "x1", connection: "local-fixture", command: { cmd: "explain", inner: find('{ shopId: ObjectId("69f6e4600000000000000001") }') } });
    expect(idx.plan).toMatchObject({ collscan: false, indexNames: ["shopId_1_createdAt_-1"] });
  });

  it("turning the switch off drops every connection and cursor", async () => {
    const { mongo } = world();
    await mongo.connect("local-fixture");
    await mongo.run({ tab: "t7", connection: "local-fixture", command: find() });
    await mongo.setEnabled(false);
    expect((await mongo.status()).connections).toEqual([]);
    await expect(mongo.window("t7", 0, 10)).rejects.toMatchObject({ code: "mongoDisabled" });
  });
});

describe("mongo mock AI", () => {
  it("is refused while AI is off for the connection and while not connected", async () => {
    const w = world();
    const ask = { tab: "a", connection: "sandbox-atlas", db: MOCK_DB, collection: "orders", question: "open orders" };
    await expect(w.ai.generate(ask)).rejects.toMatchObject({ code: "mongoNotConnected" });
    await w.mongo.connect("sandbox-atlas");
    await expect(w.ai.generate(ask)).rejects.toMatchObject({ code: "mongoAiOff" });
  });

  it("builds a payload with names and types only, no documents and no literals of the question", async () => {
    const w = world();
    await w.mongo.connect("local-fixture");
    const p = await w.ai.payload({ tab: "a", connection: "local-fixture", db: MOCK_DB, collection: "orders", question: "orders of kovacs.anna@example.test with phone +36201234567" });
    expect(p.text).toContain("interface orders {");
    expect(p.text).toContain("<email>");
    expect(p.text).toContain("<number>");
    expect(p.text).not.toContain("kovacs.anna");
    expect(p.text).not.toContain("+3620123");
    expect(p.text).not.toContain("Kovács");
    expect(p.text).not.toContain("mongodb://");
    expect(p.maskedLiterals).toBe(2);
    expect(p.bytes).toBe(new TextEncoder().encode(p.text).length);
  });

  it("drafts an English find for a generic profile in the caller's own time zone, with no Hungarian anywhere", async () => {
    const w = world();
    await w.mongo.connect("local-fixture");
    const ask = { tab: "a", connection: "local-fixture", db: MOCK_DB, collection: "orders", question: "closed orders from the last 7 days over 100", tzName: "America/New_York", utcOffsetMin: -240 };
    const r = await w.ai.generate(ask);
    expect(r.status).toBe("ready");
    expect(r.draft?.filter).toContain("T00:00:00-04:00");
    const text = JSON.stringify(r.draft) + (await w.ai.payload(ask)).text;
    expect(text).toContain("America/New_York");
    expect(text).not.toMatch(/Budapest|rendel|státusz|lezárt|[áéíóöőúüű]/i);
  });

  it("drafts a Hungarian find for a Happy profile, explains it in Hungarian and warns about the string trap", async () => {
    const w = world();
    await w.mongo.connect("happy-local");
    const r = await w.ai.generate({ tab: "a", connection: "happy-local", db: MOCK_DB, collection: "orders", question: "Az elmúlt 7 nap lezárt rendelései 10 000 Ft felett" });
    expect(r.status).toBe("ready");
    expect(r.draft?.filter).toContain("$gte");
    expect(r.draft?.filter).toContain("total: { $gt: 10000 }");
    expect(r.draft?.explanation).toMatch(/rendelések|státusz/);
    expect(r.draft?.warnings.join(" ")).toMatch(/TRAP|szöveg/);
    expect(r.draft?.extraConfirm).toBe(false);
  });

  it("asks for clarification instead of guessing", async () => {
    const w = world();
    await w.mongo.connect("local-fixture");
    const r = await w.ai.generate({ tab: "a", connection: "local-fixture", db: MOCK_DB, collection: "orders", question: "mutasd" });
    expect(r.status).toBe("needsClarification");
    expect(r.clarification).toBeTruthy();
  });
});

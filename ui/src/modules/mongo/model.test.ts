import { createRoot } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hold = vi.hoisted(() => ({ world: undefined as undefined | import("../../ipc/mock/mongo").MockMongoWorld }));
vi.mock("../../ipc", async () => {
  const { createMockMongoWorld } = await import("../../ipc/mock/mongo");
  hold.world = createMockMongoWorld({ seeded: true, latencyMs: 0 });
  return { ipc: { mongo: hold.world.mongo, mongoAi: hold.world.ai } };
});

import { ipc } from "../../ipc";
import { MOCK_DB } from "../../ipc/mock/mongo";
import type { ProfileView } from "../../ipc/mongo";
import { setLocale } from "../../i18n";
import { createCollectionModel, describeError } from "./model";

const ref = { connectionId: "local-fixture", db: MOCK_DB, collection: "orders" };
let profile: ProfileView;

beforeEach(async () => {
  localStorage.clear();
  await ipc.mongo.connect("local-fixture");
  profile = (await ipc.mongo.profiles()).find((p) => p.id === "local-fixture")!;
});

const make = <T>(fn: (m: ReturnType<typeof createCollectionModel>) => Promise<T>) =>
  new Promise<T>((resolve, reject) => createRoot((dispose) => void fn(createCollectionModel(ref, () => profile)).then(resolve, reject).finally(dispose)));
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("collection model", () => {
  it("runs a find, shows the first window and the estimated total, and pages through the same cursor", () =>
    make(async (m) => {
      expect(await m.run()).toBe(true);
      expect(m.status()).toBe("ready");
      expect(m.docs()).toHaveLength(50);
      await settle();
      expect(m.total()).toEqual({ value: 100_000, exact: false });
      const firstId = JSON.stringify(m.docs()[0]._id);
      await m.goto(3);
      expect(m.page()).toBe(3);
      expect(JSON.stringify(m.docs()[0]._id)).not.toBe(firstId);
      expect(m.lastPage()).toBe(1999);
      m.setPageSize(100);
      await settle();
      expect(m.docs()).toHaveLength(100);
      expect(m.page()).toBe(0);
    }));

  it("keeps the footer on the result that is shown while a new limit is only typed", () =>
    make(async (m) => {
      await m.run();
      await settle();
      m.setField("limit", "10");
      expect(m.total()).toEqual({ value: 100_000, exact: false });
      expect(m.docs()).toHaveLength(50);
      m.setPageSize(100);
      expect(m.lastPage()).toBe(1999);
      await m.run();
      await settle();
      expect(m.total()).toEqual({ value: 10, exact: false });
    }));

  it("applies the user's skip and limit to the footer total and stops at the limit", () =>
    make(async (m) => {
      m.setField("limit", "70");
      m.setField("skip", "10");
      await m.run();
      await settle();
      expect(m.total()).toEqual({ value: 70, exact: false });
      expect(m.docs()).toHaveLength(50);
      await m.goto(1);
      expect(m.docs()).toHaveLength(20);
      expect(m.lastPage()).toBe(1);
    }));

  it("refuses to run a filter that does not parse and says where", () =>
    make(async (m) => {
      m.setField("filter", "{ status: ");
      expect(m.firstProblem()).toMatch(/Filter:.*line 1/);
      expect(await m.run()).toBe(false);
      expect(m.status()).toBe("error");
      expect(m.error()?.title).toBe("Fix the query first");
    }));

  it("writes the Sort editor from a header click and runs again", () =>
    make(async (m) => {
      await m.run();
      m.sortBy("createdAt", -1);
      await settle();
      expect(m.q().sort).toBe("{ createdAt: -1 }");
      const t = (d: unknown) => Number(((d as { createdAt: { $date: { $numberLong: string } } }).createdAt.$date.$numberLong));
      expect(t(m.docs()[0])).toBeGreaterThan(t(m.docs()[1]));
    }));

  it("builds a schema digest from the sample and keeps sensitive fields marked", () =>
    make(async (m) => {
      await m.loadDigest();
      const d = m.digest()!;
      expect(d.sampled).toBeGreaterThan(100);
      expect(d.fields.find((f) => f.path === "status")?.enumValues).toBe(5);
      expect(d.fields.find((f) => f.path === "customer.email")?.sensitive).toBe(true);
      expect(d.indexes.map((i) => i.name)).toContain("_id_");
    }));

  it("keeps the AI draft in the editors for review, never runs it, and restores the editors on discard", () =>
    make(async (m) => {
      m.setField("filter", "{ table: 5 }");
      m.ai.setQuestion("Nyitott rendelések");
      expect(await m.ai.ask()).toBe(true);
      expect(m.ai.status()).toBe("review");
      expect(m.ran()).toBe(false);
      expect(m.q().filter).toContain('status: "open"');
      expect(m.ai.changed().has("filter")).toBe(true);
      m.setField("filter", `${m.q().filter} `);
      expect(m.ai.edited()).toBe(true);
      m.ai.discardDraft();
      expect(m.q().filter).toBe("{ table: 5 }");
      expect(m.ai.draft()).toBeUndefined();
      expect(m.ran()).toBe(false);
    }));

  it("runs the draft only on request and then offers Explain and Fix", () =>
    make(async (m) => {
      m.ai.setQuestion("Open orders from the last 3 days");
      await m.ai.ask();
      expect(await m.ai.runDraft()).toBe(true);
      expect(m.ai.accepted()?.draft?.filter).toContain("createdAt");
      expect(m.ai.status()).toBe("idle");
      expect(m.docs().length).toBeGreaterThan(0);
    }));

  it("shows a clarification question and an AI-off error without touching the editors", () =>
    make(async (m) => {
      m.ai.setQuestion("mutasd");
      expect(await m.ai.ask()).toBe(false);
      expect(m.ai.status()).toBe("clarify");
      expect(m.ai.clarification()).toBeTruthy();
      expect(m.q().filter).toBe("");
    }));

  it("cancels a model call in flight without an error, and keeps the editors", () =>
    make(async (m) => {
      m.setField("filter", "{ table: 5 }");
      m.ai.setQuestion("slow-model open orders");
      const pending = m.ai.ask();
      await settle();
      expect(m.ai.status()).toBe("asking");
      m.ai.cancelAsk();
      expect(await pending).toBe(false);
      expect(m.ai.status()).toBe("idle");
      expect(m.ai.error()).toBeUndefined();
      expect(m.q().filter).toBe("{ table: 5 }");
    }));

  it("reports a model that did not finish as retryable, not as a missing provider", () =>
    make(async (m) => {
      m.ai.setQuestion("busy-model open orders");
      expect(await m.ai.ask()).toBe(false);
      expect(m.ai.status()).toBe("error");
      expect(m.ai.error()).toMatchObject({ code: "mongoModelBusy", title: "The model did not finish" });
    }));

  it("names the draft's collection and clears the previous 'generated query ran' state when a new ask starts", () =>
    make(async (m) => {
      m.ai.setQuestion("Open orders from the last 3 days");
      await m.ai.ask();
      expect(m.ai.draft()?.collection).toBe("orders");
      await m.ai.runDraft();
      expect(m.ai.accepted()).toBeDefined();
      m.ai.setQuestion("Nyitott rendelések");
      const pending = m.ai.ask();
      expect(m.ai.accepted()).toBeUndefined();
      await pending;
    }));

  it("allows the AI for the value-list mode as well as schema-only", () =>
    make(async (m) => {
      expect(m.ai.allowed()).toBe(true);
    }));

  it("explains a find with the plan from the gateway", () =>
    make(async (m) => {
      m.setField("filter", '{ status: "open" }');
      await m.explain(false);
      expect(m.explainStatus()).toBe("ready");
      expect(m.explainResult()?.plan.collscan).toBe(true);
    }));

  it("shows the engine's English Happy-switch refusal in the language of the UI", async () => {
    const refusal = { code: "mongoInvalid", message: "config.happyPresetOff: the Happy preset is switched off (Settings > Database)" };
    expect(describeError(refusal).detail).toBe("The Happy preset is switched off. Turn it on in Settings > Database first.");
    await setLocale("hu", { persist: false });
    try {
      expect(describeError(refusal).detail).toBe("A Happy-előbeállítás ki van kapcsolva. Előbb kapcsold be a Beállítások > Adatbázis részen.");
    } finally {
      await setLocale("en", { persist: false });
    }
    // any other detail is still the engine's own text
    expect(describeError({ code: "mongoInvalid", message: "config.other: x" }).detail).toBe("config.other: x");
  });
});

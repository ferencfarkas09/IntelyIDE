import { describe, expect, it, vi } from "vitest";
import { createMockHappy } from "./happy";

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const on = { enabled: true };

describe("mock happy", () => {
  it("starts switched off and refuses work with notConnected", async () => {
    const happy = createMockHappy({ preset: "off" });
    const status = await happy.status();
    expect([status.config.master, status.tokenSaved, status.providers.map((p) => p.state)]).toEqual([false, false, ["off", "off", "off", "off", "off"]]);
    await expect(happy.timer.trackables()).rejects.toMatchObject({ code: "notConnected" });
    await expect(happy.meet.list()).rejects.toMatchObject({ code: "notConnected" });
  });

  it("checks the token shape, then connects and reports the providers waiting or ready", async () => {
    const happy = createMockHappy({ preset: "off" });
    const states = vi.fn();
    happy.onState(states);
    await happy.setConfig({ master: true, timer: on });
    expect((await happy.status()).providers[0].state).toBe("waitingForToken");
    expect(await happy.saveToken("nope")).toMatchObject({ ok: false });
    const saved = await happy.saveToken(TOKEN);
    expect(saved).toMatchObject({ ok: true, user: { name: "Teszt Elek" } });
    expect((await happy.status()).providers[0].state).toBe("ready");
    expect(states).toHaveBeenCalled();
    expect((await happy.disconnect()).tokenSaved).toBe(false);
  });

  it("keeps the token in the shared secret key set, per environment", async () => {
    const secretKeys = new Set<string>();
    const happy = createMockHappy({ preset: "off", secretKeys });
    await happy.saveToken(TOKEN);
    expect([...secretKeys]).toEqual(["happy.token.sandbox"]);
    await happy.disconnect();
    expect(secretKeys.size).toBe(0);
  });

  it("runs the timer through start, pause, resume and stop with a deterministic clock", async () => {
    let now = 1_800_000_000_000;
    const happy = createMockHappy({ preset: "connected", now: () => now });
    const [receipts] = await happy.timer.trackables();
    const changes = vi.fn();
    happy.timer.onChange(changes);
    expect(await happy.timer.start(receipts)).toMatchObject({ phase: "running", title: "Receipts", project: "Shop POS" });
    now += 90_000;
    expect(await happy.timer.pause()).toMatchObject({ phase: "paused", accumulatedSec: 90 });
    now += 600_000;
    expect(await happy.timer.resume()).toMatchObject({ phase: "running", accumulatedSec: 0, startedAtMs: now });
    expect((await happy.timer.entries(now - 3_600_000, now + 3_600_000)).entries.find((e) => e.endedAtMs == null)).toMatchObject({ title: "Shop POS", startedAtMs: now });
    expect((await happy.timer.stop()).phase).toBe("idle");
    expect(changes).toHaveBeenCalledTimes(4);
  });

  it("lists the entries of any range, with a running one counting up and the totals of the current periods", async () => {
    const now = new Date(2026, 9, 7, 15, 0).getTime(); // a Wednesday
    const happy = createMockHappy({ preset: "connected", now: () => now });
    const day = await happy.timer.entries(new Date(2026, 9, 7).getTime(), new Date(2026, 9, 8).getTime());
    expect(day.entries.map((e) => e.title)).toEqual(["Forgotten timer", "Admin", "Shop POS"]);
    const week = await happy.timer.entries(new Date(2026, 9, 5).getTime(), new Date(2026, 9, 12).getTime());
    expect(week.entries.length).toBe(7);
    const empty = await happy.timer.entries(new Date(2026, 9, 3).getTime(), new Date(2026, 9, 5).getTime());
    expect(empty.entries).toEqual([]);
    expect(await happy.timer.totals(new Date(2026, 9, 7).getTime(), new Date(2026, 9, 5).getTime(), new Date(2026, 9, 1).getTime())).toEqual({ daySec: 8100, weekSec: 24300, monthSec: 8100 * 5 });
  });

  it("searches projects and tasks and creates a task that the search then finds", async () => {
    const happy = createMockHappy({ preset: "connected" });
    const found = await happy.timer.search("gastro");
    expect(found.projects.map((p) => p.id)).toEqual(["p_admin"]);
    expect(found.tasks.map((x) => x.title)).toEqual(["Localization", "Review the rounding fix"]);
    const backend = await happy.timer.search("backend");
    expect(backend.projects.map((p) => p.id)).toEqual(["p_backend"]);
    expect(backend.tasks.map((x) => x.title)).toEqual(["Orders endpoint pagination"]);
    expect((await happy.timer.search("shop")).projects.map((p) => p.id)).toEqual(["p_pos"]);
    expect((await happy.timer.search("shop")).tasks.map((x) => x.title)).toEqual(["Receipts", "Refunds"]);
    expect(await happy.timer.search("  ")).toEqual({ projects: [], tasks: [] });
    const made = await happy.timer.createTask("p_admin", " Quarterly report ");
    expect(made).toMatchObject({ kind: "project", id: "p_admin", title: "Quarterly report", project: "Admin" });
    expect((await happy.timer.search("quarterly")).tasks.map((x) => x.taskId)).toEqual([made.taskId]);
    await expect(happy.timer.createTask("p_nope", "x")).rejects.toMatchObject({ code: "notFound" });
    await expect(happy.timer.createTask("p_admin", " ")).rejects.toMatchObject({ code: "invalidTitle" });
    await happy.setConfig({ timer: { allowActions: false } });
    await expect(happy.timer.createTask("p_admin", "x")).rejects.toMatchObject({ code: "blocked" });
    expect((await happy.timer.search("rece")).tasks.length).toBe(1);
  });

  it("blocks actions while they are switched off, like the real allow-list", async () => {
    const happy = createMockHappy({ preset: "connected" });
    await happy.setConfig({ timer: { allowActions: false }, meet: { allowActions: false } });
    await expect(happy.timer.stop()).rejects.toMatchObject({ code: "blocked" });
    await expect(happy.meet.join("m_live_1")).rejects.toMatchObject({ code: "blocked" });
    await expect(createMockHappy({ preset: "connected" }).meet.join("../x")).rejects.toMatchObject({ code: "blocked" });
  });

  it("validates a custom URL and gives every environment its own token slot", async () => {
    const happy = createMockHappy({ preset: "connected" });
    await expect(happy.setConfig({ env: "custom", customBaseUrl: "http://evil.example.test" })).rejects.toMatchObject({ code: "invalidBaseUrl" });
    expect((await happy.setConfig({ env: "custom", customBaseUrl: "http://127.0.0.1:4010" })).tokenSaved).toBe(false);
  });

  it("lists a live meeting and two scheduled ones", async () => {
    const view = await createMockHappy({ preset: "connected" }).meet.list();
    expect(view.meetings.map((m) => m.status)).toEqual(["live", "scheduled", "scheduled"]);
  });
});

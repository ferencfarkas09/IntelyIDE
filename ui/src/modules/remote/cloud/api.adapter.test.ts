import { describe, expect, it } from "vitest";
import { limitsView, normalizeView, reduceRun } from "./api";

describe("Rust to UI adapters", () => {
  it("folds flat state events into a CloudRun with steps and an error", () => {
    const a = reduceRun({ runId: "r1", op: "deploy", status: "running" });
    expect(a.steps).toEqual([]);
    const b = reduceRun({ runId: "r1", op: "deploy", status: "running", step: "stage", stepStatus: "ok" });
    expect(b.steps).toHaveLength(8);
    expect(b.steps[0].status).toBe("ok");
    const c = reduceRun({ runId: "r1", op: "deploy", status: "running", step: "health", stepStatus: "failed", code: "healthTimeout" });
    expect(c.steps.find((s) => s.step === "health")).toMatchObject({ status: "failed", code: "healthTimeout" });
    const d = reduceRun({ runId: "r1", op: "deploy", status: "failed", code: "healthTimeout", detail: "line1\nline2" });
    expect(d.error).toEqual({ code: "healthTimeout", tail: ["line1", "line2"] });
    expect(d.steps[0].status).toBe("ok");
    expect(reduceRun({ runId: "r1", op: "deploy", status: "running" }).steps).toEqual([]);
  });

  it("keeps the sign-in url", () => {
    expect(reduceRun({ runId: "r2", op: "login", status: "running", loginUrl: "https://dash.cloudflare.com/x" }).loginUrl).toBe("https://dash.cloudflare.com/x");
    reduceRun({ runId: "r2", op: "login", status: "ok" });
  });

  it("fills the view fields Rust leaves out", () => {
    const v = normalizeView({ kit: { found: true }, limits: { checkedOn: "2026-10-04", rows: [] }, secretStore: { backend: "keychain", durable: false } } as never);
    expect(v.kit.dirtyFiles).toBe(0);
    expect(v.secretStoreDurable).toBe(false);
    expect(v.workersSubdomain).toBeNull();
    expect(v.updateAvailable).toBe(false);
    expect(v.interrupted).toBe(false);
  });

  it("groups the Rust limit rows into the notice rows", () => {
    const row = (id: string, free: number, paid: number) => ({ id, freePerDay: free, paidIncludedPerMonth: paid });
    const l = limitsView(
      {
        checkedOn: "2026-10-04",
        rows: [row("workerRequests", 100_000, 10_000_000), row("doRequests", 100_000, 1_000_000), row("doDuration", 13_000, 400_000), row("sqliteRowsWritten", 100_000, 50_000_000), row("sqliteRowsRead", 5_000_000, 25_000_000_000), row("sqliteStorage", 5, 10), row("staticAssetFiles", 20_000, 100_000), row("websocketIncomingRatio", 20, 20)],
      },
      Date.parse("2026-10-14"),
    );
    expect(l.rows.map((r) => r.key)).toEqual(["workerRequests", "doRequests", "doDuration", "sqlRows", "sqlStorage", "assets", "websocket"]);
    expect(l.rows[0].paid).toEqual([10]);
    expect(l.rows[3]).toEqual({ key: "sqlRows", free: [100_000, 5_000_000], paid: [50, 25_000] });
    expect(l.staleDays).toBe(10);
  });
});

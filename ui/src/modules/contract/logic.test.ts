import { describe, expect, it } from "vitest";
import { createMockContract } from "./api";
import { allFindings, badgeFor, countBy, curlFor, exampleOf, filterEndpoints, filterFindings, filterUnused } from "./logic";
import type { SchemaNode } from "./types";

const node = (type: string, extra: Partial<SchemaNode> = {}): SchemaNode => ({ type, format: null, description: null, required: false, enum: [], example: null, default: null, refName: null, props: [], items: null, additional: null, circular: false, truncated: false, ...extra });

describe("contract logic", () => {
  it("builds examples from schemas without real data", () => {
    const n = node("object", {
      props: [
        { name: "name", node: node("string", { example: "OTP" }) },
        { name: "at", node: node("string", { format: "date-time" }) },
        { name: "state", node: node("string", { enum: ["open", "paid"] }) },
        { name: "n", node: node("integer") },
        { name: "tags", node: node("array", { items: node("string") }) },
        { name: "loop", node: node("object", { circular: true }) },
      ],
    });
    expect(exampleOf(n)).toEqual({ name: "OTP", at: "2026-01-01T00:00:00Z", state: "open", n: 0, tags: ["string"], loop: {} });
    expect(exampleOf(node("object", { additional: node("number") }))).toEqual({ key: 0 });
  });

  it("filters findings by repo, severity, kind and text and counts severities", async () => {
    const r = await createMockContract().analyze();
    const all = allFindings(r);
    expect(all.length).toBe(8);
    expect(filterFindings(r, { repoId: "mobile" }).every((f) => f.repoId === "mobile")).toBe(true);
    expect(filterFindings(r, { severity: "error" }).length).toBe(countBy(all).error);
    expect(filterFindings(r, { kind: "renamed" }).length).toBe(2);
    expect(filterFindings(r, { text: "ghostfield" }).map((f) => f.kind)).toEqual(["responseField"]);
  });

  it("filters endpoints and unused endpoints, and caps the list", async () => {
    const r = await createMockContract().analyze();
    expect(filterEndpoints(r.endpoints, "banks", "", "").total).toBe(4);
    expect(filterEndpoints(r.endpoints, "", "DELETE", "").rows.map((e) => e.id)).toEqual(["DELETE /api/banks/{bankId}"]);
    expect(filterEndpoints(r.endpoints, "", "", "Order").total).toBe(2);
    expect(filterEndpoints(r.endpoints, "", "", "", 3).rows).toHaveLength(3);
    expect(filterUnused(r.unused, "thing").total).toBe(1);
  });

  it("gives a Changes tree badge only to files with API calls", async () => {
    const r = await createMockContract().analyze();
    expect(badgeFor(r, "admin", "src/networking/bankNetworking.js")).toEqual({ calls: 6, errors: 2, warnings: 3 });
    expect(badgeFor(r, "admin", "README.md")).toBeUndefined();
    expect(badgeFor(undefined, "admin", "x")).toBeUndefined();
  });

  it("copies as cURL with placeholders for token and ids, never a real value", async () => {
    const api = createMockContract();
    const r = await api.analyze();
    const d = await api.detail("POST /api/banks");
    const curl = curlFor(d, r.spec.host);
    expect(curl).toContain("curl -X POST 'https://api.example.test/api/banks'");
    expect(curl).toContain("Authorization: Bearer <TOKEN>");
    expect(curl).toContain("Content-Type: application/json");
    expect(curl).toContain('"name":"Example Bank"');
    const g = curlFor(await api.detail("GET /api/banks/{bankId}"), "");
    expect(g).toContain("<BASE_URL>/api/banks/<bankId>");
    const q = curlFor(await api.detail("GET /api/banks"), "https://h.test/");
    expect(q).toContain("'https://h.test/api/banks?restaurantId=<restaurantId>'");
  });
});

import { describe, expect, it } from "vitest";
import { buildDigest, isSensitiveName } from "./digest";
import { generic, happy, presetChoices, presetOf } from "./presets";
import type { Doc } from "./ejson";
import { completionsFor } from "./completion";

const int = (n: number) => ({ $numberInt: String(n) });
const docs: Doc[] = Array.from({ length: 200 }, (_, i) => ({
  _id: { $oid: i.toString(16).padStart(24, "0") },
  status: ["open", "paid", "void"][i % 3],
  total: i % 25 === 0 ? "12 990 Ft" : int(1000 + i),
  createdAt: { $date: { $numberLong: String(1_790_000_000_000 + i * 1000) } },
  restaurant: { $oid: "0".repeat(24) },
  customer: { name: "Kovács Anna", email: "a@example.test" },
  items: [{ sku: "A", qty: int(1) }],
}));

describe("schema digest from a sample", () => {
  const d = buildDigest(docs, [{ name: "_id_", key: { _id: 1 } }]);
  const f = (p: string) => d.fields.find((x) => x.path === p)!;

  it("keeps names, types and shares but never values", () => {
    expect(f("_id").types[0]).toEqual({ type: "ObjectId", pct: 100 });
    expect(f("status").enumValues).toBe(3);
    expect(JSON.stringify(d)).not.toContain("Kovács");
    expect(JSON.stringify(d)).not.toContain("example.test");
  });

  it("flags a numeric field that is a string in a few documents as a trap", () => {
    expect(f("total").trap).toBe("TRAP 4% strings");
  });

  it("walks arrays of sub-documents and flags the tenant field", () => {
    expect(f("items").array).toBe(true);
    expect(f("items.sku")).toBeDefined();
    expect(buildDigest(docs, [], happy.tenantCandidates).tenantField).toBe("restaurant");
  });

  it("reads the tenant hint from the profile's preset, not from a module constant", () => {
    const withTenant = [{ _id: 1, tenantId: "a", status: "open" }, { _id: 2, tenantId: "b", status: "open" }];
    expect(buildDigest(withTenant).tenantField).toBe("tenantId");
    expect(buildDigest(withTenant, [], generic.tenantCandidates).tenantField).toBe("tenantId");
    // the Generic list does not know the Happy fields, and the Happy list does
    expect(d.tenantField).toBeUndefined();
    expect(presetOf("happy")).toBe(happy);
    expect(presetOf(undefined)).toBe(generic);
    expect(presetChoices(false, "generic")).toEqual(["generic"]);
    expect(presetChoices(false, "happy")).toEqual(["generic", "happy"]);
    expect(presetChoices(true, "generic")).toEqual(["generic", "happy"]);
  });

  it("recognises Hungarian and English sensitive names with and without accents", () => {
    for (const n of ["email", "customer.name", "vevoNev", "adószám", "szamlaSorszam", "telefon", "password", "apiKey", "lakcim", "iban"]) expect(isSensitiveName(n), n).toBe(true);
    for (const n of ["status", "total", "createdAt", "restaurant", "table"]) expect(isSensitiveName(n), n).toBe(false);
    expect(f("customer.email").sensitive).toBe(true);
  });
});

describe("query-bar completion", () => {
  const d = buildDigest(docs);
  it("offers field names with their type at a key position", () => {
    const r = completionsFor(d, "filter", "{ st")!;
    expect(r.from).toBe(2);
    expect(r.options.map((o) => o.label)).toContain("status");
    expect(r.options.find((o) => o.label === "status")?.detail).toBe("String");
  });

  it("offers operators after a dollar sign and typed helpers after a colon", () => {
    expect(completionsFor(d, "filter", "{ total: { $g")!.options.map((o) => o.label)).toEqual(expect.arrayContaining(["$gt", "$gte"]));
    const v = completionsFor(d, "filter", "{ createdAt: ")!.options;
    expect(v[0].label).toBe('ISODate("…")');
    expect(completionsFor(d, "filter", "{ restaurant: ")!.options[0].label).toBe('ObjectId("…")');
  });

  it("offers 1 and -1 for a sort and nothing before the user types", () => {
    expect(completionsFor(d, "sort", "{ createdAt: ")!.options.map((o) => o.label)).toEqual(["1", "-1"]);
    expect(completionsFor(d, "filter", "{ a: 1 }", false)).toBeNull();
    expect(completionsFor(undefined, "filter", "{ ", true)!.options).toEqual(expect.arrayContaining([expect.objectContaining({ label: "$and" })]));
  });
});

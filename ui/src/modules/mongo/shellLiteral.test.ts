import { describe, expect, it } from "vitest";
import { lint, LiteralError, parseLiteral } from "./shellLiteral";

const NOW = Date.UTC(2026, 9, 3, 9, 30);

describe("mongosh literal reader", () => {
  it("accepts unquoted keys, single quotes, trailing commas and comments", () => {
    expect(parseLiteral("{ status: 'open', n: 5, /* c */ list: [1, 2,], }")).toEqual({ status: "open", n: 5, list: [1, 2] });
  });

  it("reads the BSON helpers as Extended JSON wrappers", () => {
    expect(parseLiteral('{ _id: ObjectId("69f6e4600000000000000001") }')).toEqual({ _id: { $oid: "69f6e4600000000000000001" } });
    expect(parseLiteral('ISODate("2026-10-03T00:00:00+02:00")')).toEqual({ $date: { $numberLong: String(Date.UTC(2026, 9, 2, 22)) } });
    expect(parseLiteral('new Date("2026-10-03")')).toEqual({ $date: { $numberLong: String(Date.UTC(2026, 9, 3)) } });
    expect(parseLiteral("new Date()", NOW)).toEqual({ $date: { $numberLong: String(NOW) } });
    expect(parseLiteral('NumberLong("9007199254740993")')).toEqual({ $numberLong: "9007199254740993" });
    expect(parseLiteral("/^ab/i")).toEqual({ $regularExpression: { pattern: "^ab", options: "i" } });
  });

  it("refuses anything that is not a literal", () => {
    for (const bad of ["{ a: foo }", "{ a: Math.max(1) }", "{ $where: 'x' } + 1", "function(){}", "{ a: ObjectId('zz') }", "{ a: 1 b: 2 }"]) {
      expect(() => parseLiteral(bad), bad).toThrow(LiteralError);
    }
  });

  it("reports line and column", () => {
    try {
      parseLiteral("{\n  a: 1,\n  b: ?\n}");
      throw new Error("should not parse");
    } catch (e) {
      expect(e).toBeInstanceOf(LiteralError);
      expect(e).toMatchObject({ line: 3, column: 6 });
    }
  });

  it("stops at a nesting depth instead of overflowing the stack", () => {
    expect(() => parseLiteral("[".repeat(500))).toThrow(LiteralError);
  });

  it("lints a query-bar field: empty is fine, an object is required", () => {
    expect(lint("")).toEqual({ ok: true, empty: true });
    expect(lint("{ a: 1 }")).toEqual({ ok: true, empty: false });
    expect(lint("[1]")).toMatchObject({ ok: false });
    expect(lint("{ a: ")).toMatchObject({ ok: false, line: 1 });
  });
});

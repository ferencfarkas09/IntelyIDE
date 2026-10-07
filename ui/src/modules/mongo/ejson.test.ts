import { describe, expect, it } from "vitest";
import { cellText, copyForms, getPath, inferColumns, isScalarObject, objectIdTime, relativeTime, scalarText, shellOf, typeOf, type Doc } from "./ejson";

const oid = { $oid: "69f6e4600000000000000001" };
const date = { $date: { $numberLong: "1790000000000" } };

describe("canonical Extended JSON helpers", () => {
  it("names the BSON type of every wrapper and keeps Int64 apart from numbers", () => {
    expect(typeOf(oid)).toBe("ObjectId");
    expect(typeOf(date)).toBe("Date");
    expect(typeOf({ $numberLong: "9007199254740993" })).toBe("Int64");
    expect(typeOf({ $numberInt: "5" })).toBe("Int32");
    expect(typeOf({ $numberDouble: "1.5" })).toBe("Double");
    expect(typeOf({ $numberDecimal: "1.50" })).toBe("Decimal128");
    expect(typeOf({ $binary: { base64: "AA==", subType: "04" } })).toBe("UUID");
    expect(typeOf({ a: 1 })).toBe("Object");
    expect(typeOf([1])).toBe("Array");
    expect(typeOf(null)).toBe("Null");
    expect(typeOf({ $oid: "x", extra: 1 })).toBe("Object");
  });

  it("never turns an Int64 into a JS number", () => {
    expect(scalarText({ $numberLong: "9007199254740993" })).toBe("9007199254740993");
    expect(shellOf({ $numberLong: "9007199254740993" })).toBe('NumberLong("9007199254740993")');
  });

  it("shows ObjectIds as 8 hex characters in a cell and the full value in the dialog", () => {
    expect(cellText(oid)).toBe("69f6e460");
    expect(scalarText(oid)).toBe("69f6e4600000000000000001");
    expect(cellText({ a: 1, b: 2 })).toBe("{…} 2");
    expect(cellText("x".repeat(500)).length).toBeLessThanOrEqual(161);
  });

  it("decodes the creation time from an ObjectId and rejects other strings", () => {
    expect(objectIdTime("69f6e4600000000000000001")?.getTime()).toBe(parseInt("69f6e460", 16) * 1000);
    expect(objectIdTime("nope")).toBeUndefined();
  });

  it("renders dates as ISO and offers the typed copy forms", () => {
    expect(scalarText(date)).toBe("2026-09-21T14:13:20.000Z");
    const forms = copyForms(date).map((f) => f.id);
    expect(forms).toEqual(["value", "shell", "ejson"]);
    expect(copyForms(oid)[1].text).toBe('ObjectId("69f6e4600000000000000001")');
    expect(copyForms("plain").map((f) => f.id)).toEqual(["value", "ejson"]);
  });

  it("writes mongosh syntax with quoted keys only when needed", () => {
    const text = shellOf({ _id: oid, "a-b": 1, nested: { d: date }, list: [1, "x"] });
    expect(text).toContain('_id: ObjectId("69f6e4600000000000000001")');
    expect(text).toContain('"a-b": 1');
    expect(text).toContain('d: ISODate("2026-09-21T14:13:20.000Z")');
  });

  it("walks paths through arrays and refuses to dive into wrappers", () => {
    const doc: Doc = { a: { b: [{ c: 7 }] }, id: oid };
    expect(getPath(doc, "a.b.0.c")).toBe(7);
    expect(getPath(doc, "id.$oid")).toBeUndefined();
    expect(isScalarObject(oid)).toBe(true);
  });

  it("puts _id first and orders other columns by how many documents have them", () => {
    const docs: Doc[] = [{ b: 1, _id: oid }, { a: 1, b: 2, _id: oid }, { b: 3, _id: oid }];
    expect(inferColumns(docs)).toEqual(["_id", "b", "a"]);
  });

  it("describes relative time in coarse steps", () => {
    const now = Date.UTC(2026, 9, 3);
    expect(relativeTime(now - 5 * 86_400_000, now)).toBe("5 days ago");
    expect(relativeTime(now + 3 * 3_600_000, now)).toBe("in 3 hours");
    expect(relativeTime(now - 1000, now)).toBe("now");
  });
});

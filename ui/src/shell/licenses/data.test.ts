import { beforeEach, describe, expect, it } from "vitest";
import { checkIndex, checkTexts, LicenseDataError, loadIndex, loadTexts, resetLicensesCache } from "./data";

beforeEach(() => resetLicensesCache());

describe("schema guards", () => {
  it("accepts schema 1 and rejects anything else", () => {
    expect(() => checkIndex({ schema: 2, project: {}, components: [], groups: [] })).toThrow(LicenseDataError);
    expect(() => checkIndex(null)).toThrow(LicenseDataError);
    expect(() => checkIndex({ schema: 1, project: {}, components: {}, groups: [] })).toThrow(LicenseDataError);
    expect(checkIndex({ schema: 1, project: {}, components: [], groups: [] }).schema).toBe(1);
    expect(() => checkTexts({ schema: 1 })).toThrow(LicenseDataError);
    expect(checkTexts({ schema: 1, texts: {} }).texts).toEqual({});
  });
  it("the error carries a stable kind", () => {
    try {
      checkIndex({});
    } catch (e) {
      expect((e as LicenseDataError).kind).toBe("schema");
    }
  });
});

describe("loading", () => {
  it("memoizes the promise and loads the committed bundle", async () => {
    const a = loadIndex();
    expect(loadIndex()).toBe(a);
    const idx = await a;
    expect(idx.project.license).toBe("GPL-3.0-or-later");
    expect(idx.components.length).toBeGreaterThan(0);
    const t = loadTexts();
    expect(loadTexts()).toBe(t);
    expect(Object.keys((await t).texts).length).toBeGreaterThan(0);
  });
  it("resetLicensesCache gives a new promise (retry path)", async () => {
    const a = loadIndex();
    await a;
    resetLicensesCache();
    expect(loadIndex()).not.toBe(a);
  });
});

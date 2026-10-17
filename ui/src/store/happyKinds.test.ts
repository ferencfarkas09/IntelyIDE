import { describe, expect, it } from "vitest";
import { categoryLabel, categoryRows, KNOWN_CATEGORIES, modeOf } from "./happyKinds";

describe("the category settings", () => {
  it("name the known categories and capitalise one the server made up", () => {
    expect(categoryLabel("order")).toBe("Orders");
    expect(categoryLabel("delivery")).toBe("Delivery");
    expect(categoryLabel("invoice")).toBe("Invoices");
    expect(categoryLabel("other")).toBe("Everything else");
    expect(categoryLabel("loyalty")).toBe("Loyalty");
    for (const key of KNOWN_CATEGORIES) expect(categoryLabel(key), key).not.toMatch(/^hn\.cat\./);
  });

  it("list the known rows first, then what has arrived or is set, by name, once", () => {
    expect(categoryRows([], undefined)).toEqual([...KNOWN_CATEGORIES]);
    const rows = categoryRows([{ category: "zeta" }, { category: "order" }, { category: "loyalty" }, { category: "zeta" }, {}], { alpha: "off", order: "quiet" });
    expect(rows).toEqual([...KNOWN_CATEGORIES, "alpha", "loyalty", "zeta"]);
  });

  it("read a category that is not set as alert", () => {
    expect(modeOf(undefined, "order")).toBe("alert");
    expect(modeOf({ order: "off" }, "order")).toBe("off");
    expect(modeOf({ order: "off" }, "delivery")).toBe("alert");
  });
});

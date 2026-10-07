import { describe, expect, it } from "vitest";
import { createRegistry } from "./registry";

interface Item {
  id: string;
  order: number;
  label?: string;
}

describe("createRegistry", () => {
  it("orders by `order`, keeping registration order for ties", () => {
    const r = createRegistry<Item>((i) => i.order);
    r.register({ id: "b", order: 20 });
    r.register({ id: "a", order: 10 });
    r.register({ id: "c", order: 20 });
    expect(r.items().map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("replaces an item with the same id in place of adding a second one", () => {
    const r = createRegistry<Item>((i) => i.order);
    r.register({ id: "x", order: 10, label: "old" });
    r.register({ id: "x", order: 5, label: "new" });
    expect(r.items()).toEqual([{ id: "x", order: 5, label: "new" }]);
    expect(r.get("x")?.label).toBe("new");
  });

  it("unregisters through the returned disposer, but not a newer registration of the same id", () => {
    const r = createRegistry<Item>();
    const off = r.register({ id: "x", order: 0, label: "first" });
    r.register({ id: "x", order: 0, label: "second" });
    off();
    expect(r.get("x")?.label).toBe("second");
  });
});

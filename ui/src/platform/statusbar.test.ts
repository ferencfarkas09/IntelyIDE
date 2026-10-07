import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { registerStatusItem, resetStatusItems, statusItems } from "./statusbar";

const component = () => null;
afterEach(resetStatusItems);

describe("status bar registry", () => {
  it("splits items by side and orders them", () => {
    registerStatusItem({ id: "b", align: "right", order: 20, component });
    registerStatusItem({ id: "a", align: "right", order: 10, component });
    registerStatusItem({ id: "l", align: "left", order: 1, component });
    expect(statusItems("right").map((i) => i.id)).toEqual(["a", "b"]);
    expect(statusItems("left").map((i) => i.id)).toEqual(["l"]);
  });

  it("hides an item while its `when` is false", () => {
    const [on, setOn] = createSignal(false);
    registerStatusItem({ id: "t", align: "left", order: 1, component, when: on });
    expect(statusItems("left")).toHaveLength(0);
    setOn(true);
    expect(statusItems("left")).toHaveLength(1);
  });
});

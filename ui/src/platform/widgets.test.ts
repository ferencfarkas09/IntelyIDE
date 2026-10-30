import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../ipc";
import {
  arrange,
  availableWidgets,
  EMPTY_LAYOUT,
  LAYOUT_KEY,
  moveBy,
  moveTo,
  nextSize,
  normalizeLayout,
  registerWidget,
  resetWidgetLayout,
  resetWidgets,
  setWidgetLayout,
  sizeOf,
  syncWidgetLayout,
  widgetLayout,
  widgets,
  withHidden,
  withSize,
  type Widget,
} from "./widgets";

const component = () => null;
const w = (id: string, order: number, extra: Partial<Widget> = {}): Widget => ({ id, title: id, category: "agents", order, defaultSize: "m", component, ...extra });

afterEach(() => {
  resetWidgets();
  localStorage.clear();
});

describe("widget registry", () => {
  it("orders widgets and hides the ones whose source is unavailable", () => {
    const [on, setOn] = createSignal(false);
    registerWidget(w("b", 20));
    registerWidget(w("a", 10));
    registerWidget(w("c", 30, { when: on }));
    expect(widgets().map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(availableWidgets().map((x) => x.id)).toEqual(["a", "b"]);
    setOn(true);
    expect(availableWidgets().map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
});

describe("layout logic", () => {
  const list = [w("a", 10), w("b", 20), w("c", 30, { sizes: ["s", "m"] })];

  it("drops anything that is not a layout", () => {
    expect(normalizeLayout(null)).toEqual(EMPTY_LAYOUT);
    expect(normalizeLayout([1, 2])).toEqual(EMPTY_LAYOUT);
    expect(normalizeLayout({ order: ["a", 3, "a", "../x", "b"], sizes: { a: "l", b: "xl", "<x>": "s" }, hidden: "c" })).toEqual({ order: ["a", "b"], sizes: { a: "l" }, hidden: [] });
  });

  it("arranges by the stored order, unknown widgets last, with sizes and hidden flags", () => {
    const placed = arrange(list, { order: ["c", "gone", "a"], sizes: { a: "l", c: "l" }, hidden: ["a"] });
    expect(placed.map((p) => [p.widget.id, p.size, p.hidden])).toEqual([
      ["c", "m", false],
      ["a", "l", true],
      ["b", "m", false],
    ]);
  });

  it("falls back to the default size when the chosen one is not offered", () => {
    expect(sizeOf(list[2], { ...EMPTY_LAYOUT, sizes: { c: "l" } })).toBe("m");
    expect(sizeOf(list[2], { ...EMPTY_LAYOUT, sizes: { c: "s" } })).toBe("s");
  });

  it("moves a widget to an index and by one step, keeping ids that are not shown", () => {
    const shown = ["a", "b", "c"];
    const base = { ...EMPTY_LAYOUT, order: ["a", "away", "b", "c"] };
    expect(moveTo(base, shown, "c", 0).order).toEqual(["c", "a", "b", "away"]);
    expect(moveBy(base, shown, "a", 1).order).toEqual(["b", "a", "c", "away"]);
    expect(moveBy(base, shown, "a", -1)).toBe(base);
    expect(moveBy(base, shown, "c", 5)).toBe(base);
    expect(moveTo(base, shown, "zzz", 0)).toBe(base);
  });

  it("sets sizes, hides and shows, and cycles through the offered sizes", () => {
    expect(withSize(EMPTY_LAYOUT, "a", "s").sizes).toEqual({ a: "s" });
    const hidden = withHidden(withHidden(EMPTY_LAYOUT, "a", true), "a", true);
    expect(hidden.hidden).toEqual(["a"]);
    expect(withHidden(hidden, "a", false).hidden).toEqual([]);
    expect(nextSize(list[0], "m")).toBe("l");
    expect(nextSize(list[0], "l")).toBe("s");
    expect(nextSize(list[2], "m")).toBe("s");
  });
});

describe("layout persistence", () => {
  it("writes the mirror and the settings namespace", async () => {
    const set = vi.spyOn(ipc.settings, "set");
    setWidgetLayout({ order: ["b", "a"], sizes: { a: "s" }, hidden: [] });
    expect(widgetLayout().order).toEqual(["b", "a"]);
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!).order).toEqual(["b", "a"]);
    expect(set).toHaveBeenCalledWith("widgets", { order: ["b", "a"], sizes: { a: "s" }, hidden: [] });
    resetWidgetLayout();
    expect(widgetLayout()).toEqual(EMPTY_LAYOUT);
    set.mockRestore();
  });

  it("adopts the durable copy unless the person already changed the layout", async () => {
    const get = vi.spyOn(ipc.settings, "get").mockResolvedValue({ order: ["x"], sizes: {}, hidden: ["y"] });
    await syncWidgetLayout();
    expect(widgetLayout()).toEqual({ order: ["x"], sizes: {}, hidden: ["y"] });
    setWidgetLayout({ order: ["z"], sizes: {}, hidden: [] });
    get.mockResolvedValue({ order: ["old"] });
    await syncWidgetLayout();
    expect(widgetLayout().order).toEqual(["z"]);
    get.mockRestore();
  });

  it("keeps the mirror when settings were never written", async () => {
    const get = vi.spyOn(ipc.settings, "get").mockResolvedValue({});
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ order: ["m"] }));
    await syncWidgetLayout();
    expect(widgetLayout()).toEqual(EMPTY_LAYOUT);
    get.mockRestore();
  });
});

import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerWidget, resetWidgets, widgetLayout, type WidgetProps } from "../../platform/widgets";
import { registerModeView, resetModes, setAppMode } from "../../platform/mode";
import { activateTab, openTab, registerTabType, resetTabs } from "../../platform/tabs";
import { installDomStubs } from "../../store/testing-u2";
import Dashboard from "./Dashboard";
import { Bot } from "../../ui-kit";

installDomStubs();

const [ticks, setTicks] = createSignal<Record<string, number>>({});
const body = (id: string) => (props: WidgetProps) => {
  // reading the tick records how often the dashboard asked this card to refresh
  const n = () => {
    const v = props.refreshTick();
    queueMicrotask(() => setTicks((all) => ({ ...all, [id]: v })));
    return v;
  };
  return <p data-testid={`body-${id}`}>{`${id} ${props.size} ${n()}`}</p>;
};

beforeEach(() => {
  registerWidget({ id: "one", title: "One", category: "agents", order: 10, defaultSize: "m", component: body("one") });
  registerWidget({ id: "two", title: "Two", category: "repos", order: 20, defaultSize: "s", sizes: ["s", "m"], component: body("two") });
  registerWidget({ id: "three", title: "Three", category: "tips", order: 30, defaultSize: "l", component: body("three") });
});

afterEach(() => {
  cleanup();
  resetWidgets();
  localStorage.clear();
  setTicks({});
});

const order = () => screen.getAllByTestId(/^widget-/).map((el) => el.dataset.widgetId);

describe("dashboard", () => {
  it("lays out the available cards in their order and sizes", async () => {
    render(() => <Dashboard />);
    expect(order()).toEqual(["one", "two", "three"]);
    expect((await screen.findByTestId("body-two")).textContent).toContain("two s");
    expect(screen.getByTestId("widget-three").dataset.size).toBe("l");
    expect(screen.queryByRole("button", { name: /^Move/ })).toBeNull();
  });

  it("leaves a card out while its source is unavailable", () => {
    const [on, setOn] = createSignal(false);
    registerWidget({ id: "maybe", title: "Maybe", category: "team", order: 5, defaultSize: "s", when: on, component: body("maybe") });
    render(() => <Dashboard />);
    expect(order()).not.toContain("maybe");
    setOn(true);
    expect(order()[0]).toBe("maybe");
  });

  it("moves cards with the keyboard in edit mode and keeps the order", async () => {
    render(() => <Dashboard />);
    fireEvent.click(screen.getByRole("button", { name: "Edit layout" }));
    const handle = screen.getByRole("button", { name: /Move One, card 1 of 3/ });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(order()).toEqual(["two", "one", "three"]);
    expect(widgetLayout().order).toEqual(["two", "one", "three"]);
    fireEvent.keyDown(screen.getByRole("button", { name: /Move Three/ }), { key: "Home" });
    expect(order()).toEqual(["three", "two", "one"]);
    fireEvent.keyDown(screen.getByRole("button", { name: /Move Three/ }), { key: "End" });
    expect(order()).toEqual(["two", "one", "three"]);
    // the first card cannot move further up
    fireEvent.keyDown(screen.getByRole("button", { name: /Move Two/ }), { key: "ArrowUp" });
    expect(order()).toEqual(["two", "one", "three"]);
    expect(JSON.parse(localStorage.getItem("intely.widgets.layout")!).order).toEqual(["two", "one", "three"]);
  });

  it("changes a card's size with S, M and L, offering only its sizes", async () => {
    render(() => <Dashboard />);
    fireEvent.click(screen.getByRole("button", { name: "Edit layout" }));
    const sizes = screen.getByRole("radiogroup", { name: "Size of Two" });
    expect(within(sizes).getAllByRole("radio")).toHaveLength(2);
    fireEvent.click(within(sizes).getByRole("radio", { name: "Medium" }));
    expect(screen.getByTestId("widget-two").dataset.size).toBe("m");
    expect(widgetLayout().sizes).toEqual({ two: "m" });
  });

  it("hides and shows cards, and Reset layout brings the default back", () => {
    render(() => <Dashboard />);
    fireEvent.click(screen.getByRole("button", { name: "Edit layout" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide One" }));
    expect(order()).toEqual(["two", "three"]);
    const hidden = screen.getByRole("region", { name: "Hidden cards" });
    expect(within(hidden).getByText("One")).toBeTruthy();
    fireEvent.click(within(hidden).getByRole("button", { name: "Show" }));
    expect(order()).toEqual(["one", "two", "three"]);
    fireEvent.keyDown(screen.getByRole("button", { name: /Move One/ }), { key: "End" });
    fireEvent.click(screen.getByRole("button", { name: "Reset layout" }));
    expect(order()).toEqual(["one", "two", "three"]);
    expect(widgetLayout()).toEqual({ order: [], sizes: {}, hidden: [] });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("button", { name: /^Move/ })).toBeNull();
  });

  it("drags a card onto another with the pointer, and Escape cancels a drag", () => {
    render(() => <Dashboard />);
    fireEvent.click(screen.getByRole("button", { name: "Edit layout" }));
    const target = screen.getByTestId("widget-three");
    const at = vi.fn(() => target);
    Object.defineProperty(document, "elementFromPoint", { value: at, configurable: true });
    const handle = screen.getByRole("button", { name: /Move One/ });
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 1, clientY: 1 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 900, clientY: 10 });
    expect(target.dataset.drop).toBe("");
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(order()).toEqual(["two", "three", "one"]);

    const again = screen.getByRole("button", { name: /Move Two/ });
    fireEvent.pointerDown(again, { button: 0, pointerId: 2 });
    fireEvent.pointerMove(again, { pointerId: 2, clientX: 900, clientY: 10 });
    fireEvent.keyDown(again, { key: "Escape" });
    fireEvent.pointerUp(again, { pointerId: 2 });
    expect(order()).toEqual(["two", "three", "one"]);
  });

  it("Refresh asks every card to reload", async () => {
    render(() => <Dashboard />);
    await screen.findByTestId("body-one");
    fireEvent.click(screen.getByRole("button", { name: "Refresh the cards" }));
    await vi.waitFor(() => expect(ticks().one).toBe(1));
    expect((screen.getByTestId("body-one")).textContent).toContain("one m 1");
  });

  it("refreshes a card on its clock only while the dashboard tab is on screen, and once when it is back", async () => {
    vi.useFakeTimers();
    registerTabType({ type: "dashboard", title: "Dashboard", icon: Bot, component: () => null, canClose: true });
    registerTabType({ type: "other", title: "Other", icon: Bot, component: () => null, canClose: true });
    registerWidget({ id: "poll", title: "Poll", category: "agents", order: 40, defaultSize: "s", refresh: { everyMs: 1_000 }, component: body("poll") });
    openTab({ type: "dashboard", id: "dashboard" });
    render(() => <Dashboard />);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ticks().poll).toBe(1);
    // another tab in front: the clock runs on but nothing is fetched
    openTab({ type: "other", id: "other" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(ticks().poll).toBe(1);
    // back on screen: one refresh for what was missed
    activateTab("dashboard");
    await vi.advanceTimersByTimeAsync(0);
    expect(ticks().poll).toBe(2);
    // Agent mode over the editor area hides it as well
    registerModeView({ id: "agent", title: "Agent", component: () => null });
    setAppMode("agent");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(ticks().poll).toBe(2);
    resetModes();
    resetTabs();
    vi.useRealTimers();
  });
});

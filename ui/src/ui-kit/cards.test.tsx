import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { Card } from "./Card";
import { KpiTile, deltaTone } from "./KpiTile";
import { Sparkline, sparkGeometry } from "./Sparkline";
import { Tabs } from "./Tabs";

afterEach(cleanup);

describe("sparkGeometry", () => {
  it("maps the lowest value to the bottom and the highest to the top, keeping the padding", () => {
    const g = sparkGeometry([0, 10, 5], 100, 20, 2);
    expect(g.line).toBe("0,18 50,2 100,10");
    expect(g.area).toBe("0,20 0,18 50,2 100,10 100,20");
    expect(g.last).toEqual({ x: 100, y: 10 });
  });

  it("draws a level line for one value or a flat series, and nothing without numbers", () => {
    expect(sparkGeometry([7], 100, 20).line).toBe("0,10 50,10 100,10");
    expect(sparkGeometry([3, 3, 3], 100, 20).line).toBe("0,10 50,10 100,10");
    expect(sparkGeometry([Number.NaN, Infinity], 100, 20)).toEqual({ line: "", area: "", last: null });
  });
});

describe("<Sparkline>", () => {
  it("is an image named by its trend (or by the given title)", () => {
    render(() => (
      <>
        <Sparkline values={[1, 2, 4]} format={(n) => `${n}k`} />
        <Sparkline values={[1, 2]} title="Cost this week" area={false} tone="ok" />
      </>
    ));
    const img = screen.getByRole("img", { name: "Trend: 1k to 4k" });
    expect(img.querySelector("polygon")).not.toBeNull();
    const plain = screen.getByRole("img", { name: "Cost this week" });
    expect(plain.querySelector("polygon")).toBeNull();
    expect(plain.getAttribute("data-tone")).toBe("ok");
  });
});

describe("<KpiTile>", () => {
  it("shows label, value, unit and a delta that is spoken in words, toned by whether the change is good", () => {
    render(() => <KpiTile label="Spend" value="$2.71" unit="USD" delta={{ value: "12%", direction: "down", upIsGood: false }} hint="last 7 days" sparkline={<Sparkline values={[3, 2, 1]} title="Spend trend" />} />);
    expect(screen.getByText("Spend")).toBeTruthy();
    expect(screen.getByText("$2.71")).toBeTruthy();
    expect(screen.getByText("USD")).toBeTruthy();
    expect(screen.getByText("down 12%")).toBeTruthy();
    expect(document.querySelector(".ui-kpi__delta")?.getAttribute("data-tone")).toBe("ok");
    expect(screen.getByRole("img", { name: "Spend trend" })).toBeTruthy();
  });

  it("delta tone: up is good unless told otherwise, flat is neutral", () => {
    expect(deltaTone({ value: "1", direction: "up" })).toBe("ok");
    expect(deltaTone({ value: "1", direction: "down" })).toBe("danger");
    expect(deltaTone({ value: "1", direction: "up", upIsGood: false })).toBe("danger");
    expect(deltaTone({ value: "0", direction: "flat" })).toBe("neutral");
  });
});

describe("<Card>", () => {
  it("is a region named by its title, with the actions in the header", () => {
    render(() => <Card title="Release" subtitle="3 of 5" actions={<button type="button">Refresh</button>}>body</Card>);
    const region = screen.getByRole("region", { name: "Release" });
    expect(region.textContent).toContain("3 of 5");
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });

  it("takes an aria-label when it has no title", () => {
    render(() => <Card aria-label="Summary">x</Card>);
    expect(screen.getByRole("region", { name: "Summary" })).toBeTruthy();
  });
});

describe("<Tabs>", () => {
  it("one tab stop; arrows, Home and End move and select; disabled tabs are skipped", async () => {
    const [v, setV] = createSignal<"a" | "b" | "c" | "d">("a");
    render(() => <Tabs aria-label="Range" value={v()} onChange={setV} items={[{ value: "a", label: "A" }, { value: "b", label: "B", disabled: true }, { value: "c", label: "C" }, { value: "d", label: "D" }]} />);
    const list = screen.getByRole("tablist", { name: "Range" });
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1, -1]);
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(v()).toBe("c");
    fireEvent.keyDown(list, { key: "End" });
    expect(v()).toBe("d");
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(v()).toBe("a");
    fireEvent.keyDown(list, { key: "ArrowLeft" });
    expect(v()).toBe("d");
    fireEvent.click(tabs[1]);
    expect(v()).toBe("d");
    fireEvent.click(tabs[2]);
    expect(v()).toBe("c");
    expect(tabs[2].getAttribute("aria-selected")).toBe("true");
  });
});

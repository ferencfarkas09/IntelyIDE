import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hold = vi.hoisted(() => ({ world: undefined as undefined | import("../../ipc/mock/mongo").MockMongoWorld }));
vi.mock("../../ipc", async () => {
  const { createMockMongoWorld } = await import("../../ipc/mock/mongo");
  hold.world = createMockMongoWorld({ seeded: true, latencyMs: 0 });
  return { ipc: { mongo: hold.world.mongo, mongoAi: hold.world.ai, settings: { get: async () => ({}), set: async () => ({}) }, secrets: { has: async () => false } } };
});

import { ipc } from "../../ipc";
import { DataGrid, type GridColumn } from "../../ui-kit/DataGrid";
import { JsonTree } from "../../ui-kit/JsonTree";
import { scalarView } from "./ejsonView";
import { PayloadDialog } from "./PayloadDialog";

beforeEach(() => {
  // The virtualiser measures its scroll element; jsdom has no layout, so give every element a size.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 800, height: 480, top: 0, left: 0, right: 800, bottom: 480, x: 0, y: 0, toJSON() {} });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 480 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 800 });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Row = { id: number; name: string };
const off = (b: HTMLElement) => (b as HTMLButtonElement).disabled || b.getAttribute("aria-disabled") === "true";

describe("DataGrid", () => {
  const cols: GridColumn<Row>[] = [
    { id: "id", title: "id", cell: (r) => <span>{r.id}</span>, text: (r) => String(r.id), sortable: true },
    { id: "name", title: "name", cell: (r) => <span>{r.name}</span> },
  ];
  const rows = Array.from({ length: 100_000 }, (_, i) => ({ id: i, name: `row ${i}` }));

  it("renders only the rows in view for 100,000 rows and announces the full size", async () => {
    render(() => <DataGrid label="Rows" columns={cols} rows={rows} />);
    const grid = screen.getByRole("grid", { name: "Rows" });
    expect(grid.getAttribute("aria-rowcount")).toBe("100001");
    await waitFor(() => expect(document.querySelectorAll(".ui-grid__row").length).toBeGreaterThan(5));
    expect(document.querySelectorAll(".ui-grid__row").length).toBeLessThan(80);
  });

  it("moves the cell cursor with the arrow keys and activates or copies the current cell", async () => {
    const onActivate = vi.fn();
    const onCopy = vi.fn();
    render(() => <DataGrid label="Rows" columns={cols} rows={rows} onActivate={onActivate} onCopy={onCopy} />);
    const grid = screen.getByRole("grid", { name: "Rows" });
    await waitFor(() => expect(document.querySelector(".ui-grid__row")).not.toBeNull());
    grid.focus();
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    const id = grid.getAttribute("aria-activedescendant")!;
    expect(id).toMatch(/-1-1$/);
    expect(document.getElementById(id)?.textContent).toBe("row 1");
    fireEvent.keyDown(grid, { key: "Enter" });
    expect(onActivate).toHaveBeenCalledWith({ id: 1, name: "row 1" }, 1, "name");
    fireEvent.keyDown(grid, { key: "c", metaKey: true });
    expect(onCopy).toHaveBeenCalledWith({ id: 1, name: "row 1" }, "name", false);
    fireEvent.keyDown(grid, { key: "C", metaKey: true, shiftKey: true });
    expect(onCopy).toHaveBeenLastCalledWith({ id: 1, name: "row 1" }, "name", true);
  });

  it("cycles a sortable header: ascending, descending, none", () => {
    const [sort, setSort] = createSignal<{ column: string; dir: 1 | -1 } | null>(null);
    render(() => <DataGrid label="Rows" columns={cols} rows={rows.slice(0, 5)} sort={sort()} onSort={setSort} />);
    const head = screen.getByRole("columnheader", { name: /id/ });
    fireEvent.click(head);
    expect(sort()).toEqual({ column: "id", dir: 1 });
    fireEvent.click(head);
    expect(sort()).toEqual({ column: "id", dir: -1 });
    fireEvent.click(head);
    expect(sort()).toBeNull();
  });
});

describe("JsonTree", () => {
  const value = { _id: { $oid: "69f6e4600000000000000001" }, name: "Kovács Anna", nested: { deep: { x: 1 } }, list: Array.from({ length: 250 }, (_, i) => i) };

  it("lists only the open levels and expands on the arrow key", () => {
    render(() => <JsonTree label="doc" value={value} scalar={scalarView} openDepth={1} />);
    expect(screen.queryByText("deep")).toBeNull();
    const tree = screen.getByRole("tree", { name: "doc" });
    // cursor starts on the root; move to "nested" (4th child of the root) and open it
    for (let i = 0; i < 3; i++) fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(screen.getByText("deep")).toBeTruthy();
  });

  it("shows an ObjectId as one typed value and pages long arrays 100 at a time", () => {
    render(() => <JsonTree label="doc" value={value} scalar={scalarView} openDepth={2} />);
    expect(screen.getByText("69f6e4600000000000000001")).toBeTruthy();
    expect(screen.getAllByText("ObjectId").length).toBeGreaterThan(0);
    expect(screen.getByText("Show 100 more (150 left)")).toBeTruthy();
  });

  it("hides masked values", () => {
    render(() => <JsonTree label="doc" value={value} scalar={scalarView} masked={(p) => p[0] === "name"} />);
    expect(screen.queryByText(/Kovács/)).toBeNull();
    expect(screen.getAllByText("••••••••").length).toBe(1);
  });
});

describe("PayloadDialog", () => {
  it("keeps Send this in its busy state, not the flat disabled grey, while the payload is built", async () => {
    let done!: (p: Awaited<ReturnType<typeof ipc.mongoAi.payload>>) => void;
    const slow = new Promise<Awaited<ReturnType<typeof ipc.mongoAi.payload>>>((r) => (done = r));
    await ipc.mongo.connect("local-fixture");
    render(() => <PayloadDialog load={() => slow} onClose={() => undefined} onAgree={() => undefined} />);
    const send = screen.getByRole("button", { name: "Send this" });
    expect(send.hasAttribute("disabled")).toBe(false);
    expect(send.getAttribute("aria-busy")).toBe("true");
    done(await ipc.mongoAi.payload({ tab: "p", connection: "local-fixture", db: "intely_test_shop", collection: "orders", question: "x" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send this" }).hasAttribute("aria-busy")).toBe(false));
  });

  it("shows the exact payload text, byte count included, and sends only after Send", async () => {
    await ipc.mongo.connect("local-fixture");
    const payload = await ipc.mongoAi.payload({ tab: "p", connection: "local-fixture", db: "intely_test_shop", collection: "orders", question: "open orders of a@b.example.test" });
    const agree = vi.fn();
    render(() => <PayloadDialog load={async () => payload} onClose={() => undefined} onAgree={agree} />);
    await waitFor(() => expect(screen.getByLabelText("The exact payload")).toBeTruthy());
    expect(screen.getByLabelText("The exact payload").textContent).toBe(payload.text);
    expect(screen.getByLabelText("The exact payload").textContent).not.toContain("a@b.example.test");
    expect(screen.getByText(`${payload.bytes.toLocaleString("en-US")} bytes`)).toBeTruthy();
    expect(agree).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send this" }));
    expect(agree).toHaveBeenCalledTimes(1);
  });
});

describe("mongoStudio strings", () => {
  it("renders the cell dialog and cells through t() in hu and back in en", async () => {
    const { setLocale } = await import("../../i18n");
    const { CellDialog } = await import("./CellDialog");
    const { ValueCell } = await import("./Cells");
    await setLocale("hu");
    render(() => <><CellDialog path="password" value="x" masked onClose={() => undefined} /><ValueCell v={undefined} /></>);
    expect(screen.getAllByRole("button", { name: "Bezárás" }).length).toBeGreaterThan(0);
    expect(screen.getByText(/rejtett marad/)).toBeTruthy();
    expect(screen.getByTitle("A mező hiányzik ebből a dokumentumból")).toBeTruthy();
    cleanup();
    await setLocale("en");
    render(() => <CellDialog path="password" value="x" masked onClose={() => undefined} />);
    expect(screen.getAllByRole("button", { name: "Close" }).length).toBeGreaterThan(0);
  });

  it("hu has exactly the en keys", async () => {
    const en = (await import("../../i18n/locales/en/mongoStudio.json")).default;
    const hu = (await import("../../i18n/locales/hu/mongoStudio.json")).default;
    expect(Object.keys(hu).sort()).toEqual(Object.keys(en).sort());
  });
});

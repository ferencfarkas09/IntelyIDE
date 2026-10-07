import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hold = vi.hoisted(() => ({ world: undefined as undefined | import("../../ipc/mock/mongo").MockMongoWorld }));
vi.mock("../../ipc", () => ({
  ipc: {
    get mongo() {
      return hold.world!.mongo;
    },
    mongoAi: {},
    settings: { get: async () => ({}), set: async () => ({}) },
    secrets: { has: async () => false },
  },
}));

import { createMockMongoWorld } from "../../ipc/mock/mongo";
import CollectionTab from "./CollectionTab";
import { applyStatus, clearLost, lostConnections, resetGate, studioSnapshot, type CollectionTabParams } from "./gate";
import { resetProductionConfirms } from "./loudChip";
import { resetStore } from "./store";

const stops: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  stops.splice(0).forEach((s) => s());
  resetStore();
  resetGate();
  resetProductionConfirms();
  vi.unstubAllGlobals();
  try {
    localStorage.clear();
  } catch {
    /* storage may be blocked */
  }
});

/** The tab connected and ran its first find (the header exists while it is still booting). */
const booted = async () => {
  await waitFor(() => expect(studioSnapshot()?.connections.map((c) => c.id)).toEqual(["local-fixture"]), { timeout: 4000 });
  await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull(), { timeout: 4000 });
  await new Promise((r) => setTimeout(r, 80));
};

const params: CollectionTabParams = { connectionId: "local-fixture", connectionName: "Local fixture", db: "shop", collection: "orders", environment: "local", dangerous: false };
const tab = { id: "mongo:local-fixture:shop.orders", type: "mongo-collection", title: "orders", params: params as unknown as Record<string, unknown> };

describe("a collection tab whose connection ended on its own", () => {
  it("shows the Disconnected banner with Reconnect and Dismiss, never reconnects by itself, and Reconnect brings the documents back", async () => {
    hold.world = createMockMongoWorld({ seeded: true, latencyMs: 0 });
    applyStatus(await hold.world.mongo.status());
    stops.push(hold.world.mongo.onState(applyStatus));
    render(() => <CollectionTab tab={tab} />);
    await booted();
    expect(screen.queryByText(/does not reconnect by itself/)).toBeNull();

    const connect = vi.spyOn(hold.world.mongo, "connect");
    await hold.world.mongo.disconnect("local-fixture"); // closed behind the UI's back: nobody clicked Disconnect here
    const banner = await screen.findByRole("alert", {}, { timeout: 4000 });
    expect(banner.textContent).toContain("Local fixture");
    expect(banner.textContent).toContain("does not reconnect by itself");
    await new Promise((r) => setTimeout(r, 40));
    expect(connect).not.toHaveBeenCalled();
    expect(Object.keys(lostConnections())).toEqual(["local-fixture"]);

    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1), { timeout: 4000 });
    await waitFor(() => expect(lostConnections()).toEqual({}), { timeout: 4000 });
    await waitFor(() => expect(screen.queryByText(/does not reconnect by itself/)).toBeNull());
  });

  it("Dismiss hides the banner and keeps the tab", async () => {
    hold.world = createMockMongoWorld({ seeded: true, latencyMs: 0 });
    applyStatus(await hold.world.mongo.status());
    stops.push(hold.world.mongo.onState(applyStatus));
    render(() => <CollectionTab tab={tab} />);
    await booted();
    await hold.world.mongo.disconnect("local-fixture");
    await screen.findByText(/does not reconnect by itself/, {}, { timeout: 4000 });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByText(/does not reconnect by itself/)).toBeNull());
    expect(screen.getByRole("radio", { name: "Documents" })).toBeTruthy();
    clearLost();
  });
});

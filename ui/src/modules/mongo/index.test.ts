import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioStatus } from "../../ipc/mongo";

const state = { status: { compiled: true, enabled: false, network: "full", connections: [], notices: [] } as StudioStatus, listeners: new Set<(s: StudioStatus) => void>() };
const calls = { profiles: 0, connect: 0, run: 0, onState: 0, status: 0, disconnected: [] as string[] };

vi.mock("../../ipc", () => ({
  ipc: {
    mongo: {
      status: async () => (calls.status++, state.status),
      setEnabled: async (enabled: boolean) => ((state.status = { ...state.status, enabled }), state.status),
      onState: (cb: (s: StudioStatus) => void) => (calls.onState++, state.listeners.add(cb), () => state.listeners.delete(cb)),
      profiles: async () => (calls.profiles++, []),
      connect: async () => (calls.connect++, undefined),
      disconnect: async (id: string) => void calls.disconnected.push(id),
      run: async () => (calls.run++, undefined),
    },
  },
}));

import { setLocale } from "../../i18n";
import { endSessions, resetUnsavedSources, sessionCopy, sessionTitles, unsavedTitles } from "../../platform/closeGuard";
import { availableCommands, resetCommands } from "../../platform/commands";
import { resetKeymap, shortcutConflicts } from "../../platform/keymap";
import { getRailItem, resetRail } from "../../platform/rail";
import { resetSettings, settingsSections } from "../../platform/settings";
import { resetStatusItems, statusItems } from "../../platform/statusbar";
import { getTabType, resetTabs } from "../../platform/tabs";
import { applyStatus, loadStatus, resetGate, setStudioEnabled, studioCompiled, studioEnabled } from "./gate";
import { register } from "./index";

const reset = () => {
  resetUnsavedSources();
  resetGate();
  resetCommands();
  resetKeymap();
  resetRail();
  resetSettings();
  resetStatusItems();
  resetTabs();
};

beforeEach(() => {
  state.status = { compiled: true, enabled: false, network: "full", connections: [], notices: [] };
  Object.assign(calls, { profiles: 0, connect: 0, run: 0, onState: 0, status: 0, disconnected: [] });
});
afterEach(reset);

const mongoCommands = () => availableCommands().filter((c) => c.id.startsWith("mongo.")).map((c) => c.id);

describe("MongoDB Studio module", () => {
  it("registers only the Settings section while the switch is off, and touches no database", async () => {
    register();
    await loadStatus();
    expect(settingsSections().find((s) => s.id === "database")).toMatchObject({ title: "Database" });
    expect(getRailItem("mongo")).toBeUndefined();
    expect(getTabType("mongo-collection")).toBeUndefined();
    expect(getTabType("mongo-connections")).toBeUndefined();
    expect(mongoCommands()).toEqual([]);
    expect(statusItems("left").some((i) => i.id === "mongo-danger")).toBe(false);
    expect(calls).toMatchObject({ profiles: 0, connect: 0, run: 0, onState: 0 });
    expect(studioEnabled()).toBe(false);
    expect(studioCompiled()).toBe(true);
  });

  it("adds the rail item, both tab types and the palette commands when the switch goes on, and removes them when it goes off", async () => {
    register();
    await loadStatus();
    await setStudioEnabled(true);
    expect(studioEnabled()).toBe(true);
    expect(getRailItem("mongo")).toMatchObject({ position: "left", title: "Database" });
    expect(getTabType("mongo-collection")).toMatchObject({ canClose: true });
    expect(getTabType("mongo-connections")).toBeDefined();
    expect(availableCommands().map((c) => c.id)).toEqual(expect.arrayContaining(["mongo.newConnection", "mongo.connections"]));
    expect(calls.onState).toBe(1);
    expect(shortcutConflicts()).toEqual([]);

    await setStudioEnabled(false);
    expect(getRailItem("mongo")).toBeUndefined();
    expect(getTabType("mongo-collection")).toBeUndefined();
    expect(mongoCommands()).toEqual([]);
  });

  it("starts enabled when the gateway says so, and stays dormant in a lean build", async () => {
    state.status = { ...state.status, enabled: true };
    await loadStatus();
    expect(getRailItem("mongo")).toBeDefined();
    reset();
    applyStatus({ compiled: false, enabled: false, network: "full", connections: [], notices: [] });
    expect(studioCompiled()).toBe(false);
    expect(getRailItem("mongo")).toBeUndefined();
  });

  it("offers the collection commands only while a collection tab is active", async () => {
    await loadStatus();
    await setStudioEnabled(true);
    expect(mongoCommands()).not.toContain("mongo.run");
    expect(mongoCommands()).not.toContain("mongo.ask");
  });

  it("does not collide with another rail item or chord", async () => {
    register();
    await setStudioEnabled(true);
    expect(shortcutConflicts().filter((c) => /mongo/.test(c))).toEqual([]);
  });

  it("palette command titles, groups and the rail title follow a live language switch", async () => {
    register();
    await setStudioEnabled(true);
    const title = (id: string) => availableCommands().find((c) => c.id === id)!.title;
    const group = (id: string) => availableCommands().find((c) => c.id === id)!.group;
    expect(title("mongo.connections")).toBe("Studio: Manage connections");
    expect(group("mongo.connections")).toBe("Database");
    await setLocale("hu", { persist: false });
    try {
      expect(title("mongo.connections")).not.toBe("Studio: Manage connections");
      expect(group("mongo.connections")).not.toBe("Database");
      expect(getRailItem("mongo")!.title).not.toBe("Database");
    } finally {
      await setLocale("en", { persist: false });
    }
    expect(title("mongo.connections")).toBe("Studio: Manage connections");
  });

  const view = (id: string, name: string, over: Record<string, unknown> = {}) => ({ id, name, serverVersion: "7.0.0", topology: "standalone", pingMs: 3, effectiveLevel: "local", environment: "local", readOnly: true, ...over });

  it("registers a close-guard session source that lists only the open production-level connections", async () => {
    register();
    await setStudioEnabled(true);
    expect(sessionTitles()).toEqual([]);
    applyStatus({ ...state.status, enabled: true, connections: [view("a", "Local one"), view("b", "Tagged prod", { environment: "production" }), view("c", "Remote host", { effectiveLevel: "productionLevel" })] } as StudioStatus);
    expect(sessionTitles()).toEqual(["Tagged prod", "Remote host"]);
    expect(unsavedTitles()).toEqual([]); // sessions are not unsaved work (the workspace switch guard has its own busy model)
    expect(sessionCopy()).toMatchObject({ title: "Quit with 2 production connections open?", confirm: "Disconnect and quit" });
    expect(sessionCopy()!.description).toContain("Tagged prod and Remote host");
    await endSessions();
    expect(calls.disconnected.sort()).toEqual(["b", "c"]);
  });

  it("drops the close-guard source with the switch", async () => {
    register();
    await setStudioEnabled(true);
    applyStatus({ ...state.status, enabled: true, connections: [view("b", "Tagged prod", { environment: "production" })] } as StudioStatus);
    expect(sessionTitles()).toEqual(["Tagged prod"]);
    await setStudioEnabled(false);
    expect(sessionTitles()).toEqual([]);
  });
});

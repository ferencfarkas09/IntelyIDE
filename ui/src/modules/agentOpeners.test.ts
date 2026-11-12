// The tabs of the newer extras open where the person is looking: in Agent mode in the middle of the Agent workspace (the
// editor area is hidden there), in Editor mode in the editor area. And "Generate a CLAUDE.md" picks the repository on screen.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMockIpc } from "../ipc/mock";
import { registerCommand, resetCommands } from "../platform/commands";
import { agentTabInstance, appMode, registerModeView, resetModes, setAppMode, showTabInAgent, visibleTab } from "../platform/mode";
import { newRunPrefill, takeNewRunPrefill } from "../platform/newRun";
import { activeTab, openTab, registerTabType, resetTabs } from "../platform/tabs";
import { loadWorkspace, repos } from "../store/workspace";
import { openDashboard } from "./dashboard/open";
import { openDoctor } from "./doctor/open";
import { openMobileHealth } from "./mobilehealth/open";
import { generateStarter } from "./projectnotes/index";
import { starterTarget } from "./projectnotes/logic";
import { openProjectNotes, setNotesRepo } from "./projectnotes/open";
import { openPrompts } from "./prompts/open";
import { openWebtools } from "./webtools/open";
import { Bot } from "../ui-kit";

const OPENERS: [string, () => string][] = [
  ["prompts", openPrompts],
  ["projectnotes", openProjectNotes],
  ["doctor", openDoctor],
  ["mobilehealth", openMobileHealth],
  ["webtools", () => openWebtools("deps")],
  ["dashboard", openDashboard],
];

beforeEach(() => {
  for (const type of [...OPENERS.map(([type]) => type), "file"]) registerTabType({ type, title: type, icon: Bot, component: () => null, canClose: true });
});

afterEach(() => {
  resetModes();
  resetTabs();
  resetCommands();
  setNotesRepo(undefined);
  takeNewRunPrefill();
});

describe("tab openers in Agent mode", () => {
  for (const [type, open] of OPENERS) {
    it(`${type}: shows in the Agent workspace without leaving Agent mode`, () => {
      registerModeView({ id: "agent", title: "Agent", component: () => null });
      setAppMode("agent");
      const id = open();
      expect(appMode()).toBe("agent");
      expect(agentTabInstance()?.id).toBe(id);
      expect(visibleTab()?.type).toBe(type);
    });

    it(`${type}: opens in the editor area in Editor mode`, () => {
      const id = open();
      expect(activeTab()?.id).toBe(id);
      expect(agentTabInstance()).toBeUndefined();
    });
  }

  it("Web & Node tools open on the section the command asked for", () => {
    openWebtools("env");
    expect(activeTab()?.params).toEqual({ section: "env" });
  });
});

describe("Generate a CLAUDE.md", () => {
  it("is for the repository Project notes shows, else the active file's, else the only one", () => {
    const ids = ["a", "b"];
    expect(starterTarget({ type: "projectnotes" }, "b", ids)).toBe("b");
    expect(starterTarget({ type: "file", params: { repoId: "b" } }, undefined, ids)).toBe("b");
    expect(starterTarget({ type: "file", params: { repoId: "gone" } }, undefined, ids)).toBeUndefined();
    expect(starterTarget({ type: "diff" }, "b", ids)).toBeUndefined();
    expect(starterTarget(undefined, undefined, ids)).toBeUndefined();
    expect(starterTarget(undefined, undefined, ["a"])).toBe("a");
  });

  it("fills the New Run dialog for the repository on screen, and opens Project notes to pick one when none is", async () => {
    registerCommand({ id: "runs.new", title: "New run", group: "Runs", run: () => {} });
    await loadWorkspace(createMockIpc("normal", { delayScale: 0 }));
    const ids = repos().map((r) => r.id);
    expect(ids.length).toBeGreaterThan(1);

    // nothing on screen names a repository: Project notes opens, in Agent mode in the Agent workspace
    registerModeView({ id: "agent", title: "Agent", component: () => null });
    setAppMode("agent");
    await generateStarter();
    expect(newRunPrefill()).toBeUndefined();
    expect(agentTabInstance()?.type).toBe("projectnotes");

    // Project notes shows the second repository
    setNotesRepo(ids[1]);
    await generateStarter();
    expect(newRunPrefill()?.repoIds).toEqual([ids[1]]);
    expect(newRunPrefill()?.permission).toBe("ask");
    takeNewRunPrefill();

    // a file of the second repository in front in Editor mode
    showTabInAgent(null);
    setAppMode("editor");
    openTab({ type: "file", id: "f", params: { repoId: ids[1], path: "a.ts" } });
    await generateStarter();
    expect(newRunPrefill()?.repoIds).toEqual([ids[1]]);
  });
});

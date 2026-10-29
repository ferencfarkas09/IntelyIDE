import { afterEach, describe, expect, it } from "vitest";
import { registerCommand, resetCommands } from "../../platform/commands";
import { newRunPrefill, takeNewRunPrefill } from "../../platform/newRun";
import { MOCK_PROJECT } from "./api";
import { buildPrompt, fixWithAgent } from "./agent";
import type { ErrorCard } from "./types";

const card: ErrorCard = { id: "x", kind: "unresolvedModule", source: "metro", snippet: "error: Unable to resolve module ./Missing from /a/App.js", context: ["at foo (App.js:1)"], count: 1 };

afterEach(() => {
  resetCommands();
  takeNewRunPrefill();
});

describe("fix with agent", () => {
  it("builds a prompt with the error, the app and the ground rules", () => {
    const p = buildPrompt(card, MOCK_PROJECT);
    expect(p).toContain('Expo app "Demo App" (react-native 0.76.3)');
    expect(p).toContain("the Metro bundler output");
    expect(p).toContain(card.snippet);
    expect(p).toContain("at foo (App.js:1)");
    expect(p).toMatch(/do not run builds or deploys/i);
    expect(buildPrompt(card, undefined)).toContain("React Native app");
  });

  it("only fills the New Run dialog (it starts nothing) for the repository of the project", async () => {
    registerCommand({ id: "runs.new", title: "New run", group: "Runs", run: () => {} });
    expect(await fixWithAgent(card, MOCK_PROJECT, "repo-1")).toBe(true);
    expect(newRunPrefill()).toMatchObject({ repoIds: ["repo-1"] });
    expect(newRunPrefill()?.prompt).toContain(card.snippet);
  });

  it("reports false when the dialog is not available", async () => {
    expect(await fixWithAgent(card, MOCK_PROJECT, "repo-1")).toBe(false);
    expect(newRunPrefill()).toBeUndefined();
  });
});

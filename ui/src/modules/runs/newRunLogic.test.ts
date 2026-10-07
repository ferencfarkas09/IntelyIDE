import { describe, expect, it } from "vitest";
import type { ProviderEnforcement } from "../../ipc/providers";
import type { PermissionMode } from "../../store/agent-types";
import { chosenProvider, clampMode, DEFAULT_MODE_UNTIL_AG1, defaultRepos, initialMode, providerBlocker, providerChoices, startBlocker, startErrorText, startRequest, toggleRepo } from "./newRunLogic";

const ROLES = [{ name: "developer" }, { name: "reviewer" }];

describe("startBlocker", () => {
  it("names the first thing missing", () => {
    expect(startBlocker({ role: undefined, repoIds: ["a"], prompt: "x" }, ROLES)).toBe("Pick a role");
    expect(startBlocker({ role: "ghost", repoIds: ["a"], prompt: "x" }, ROLES)).toBe("Pick a role");
    expect(startBlocker({ role: "developer", repoIds: [], prompt: "x" }, ROLES)).toBe("Pick at least one repository");
    expect(startBlocker({ role: "developer", repoIds: ["a"], prompt: "  " }, ROLES)).toBe("Write what the agent should do");
    expect(startBlocker({ role: "developer", repoIds: ["a"], prompt: "go" }, ROLES)).toBeUndefined();
  });
});

describe("repo scope", () => {
  it("toggles a repo in and out", () => {
    expect(toggleRepo(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleRepo(["a", "b"], "a")).toEqual(["b"]);
  });

  it("proposes only the role's default repos that exist", () => {
    expect(defaultRepos({ defaultRepoIds: ["admin", "gone"] }, ["admin", "backend"])).toEqual(["admin"]);
    expect(defaultRepos(undefined, ["admin"])).toEqual([]);
  });
});

describe("provider picker", () => {
  const providers = [
    { id: "claude", name: "Claude", enabled: true, state: "ready" as const },
    { id: "codex", name: "Codex", enabled: true, state: "ready" as const },
    { id: "gemini", name: "Gemini", enabled: false, state: "off" as const },
    { id: "copilot", name: "GitHub Copilot", enabled: true, state: "needsLogin" as const },
  ];
  const runnable = new Set(["claude", "codex", "gemini", "copilot"]);
  const none: ProviderEnforcement[] = [];
  const reviewer = { provider: "claude", permission: "readOnly" as const };
  const developer = { provider: "claude", permission: "edit" as const };

  it("lists the role's own provider and the enabled, runnable ones; off providers stay out", () => {
    expect(providerChoices(reviewer, providers, runnable, none).map((c) => c.id)).toEqual(["claude", "codex", "copilot"]);
    expect(providerChoices(undefined, providers, runnable, none)).toEqual([]);
  });

  it("allows a read-only role on a weak provider and a write role only on Claude", () => {
    const ro = providerChoices(reviewer, providers, runnable, none);
    expect(ro.find((c) => c.id === "codex")).toMatchObject({ ok: true, tier: "weak" });
    const rw = providerChoices(developer, providers, runnable, none);
    expect(rw.find((c) => c.id === "claude")?.ok).toBe(true);
    expect(rw.find((c) => c.id === "codex")).toMatchObject({ ok: false });
    expect(rw.find((c) => c.id === "codex")?.note).toMatch(/read-only roles/);
  });

  it("the user's per-provider override lets a write role run on a weak provider, with a caution; the tier is unchanged", () => {
    const allowed = providers.map((p) => (p.id === "codex" ? { ...p, allowWeakWriter: true } : p));
    const rw = providerChoices(developer, allowed, runnable, none);
    expect(rw.find((c) => c.id === "codex")).toMatchObject({ ok: true, tier: "weak" });
    expect(rw.find((c) => c.id === "codex")?.note).toMatch(/allowed Codex to change files/);
    // the override is per provider: another weak provider stays refused
    expect(providerChoices(developer, allowed, runnable, none).find((c) => c.id === "copilot")?.ok).toBe(false);
  });

  it("a provider that needs a login or is not runnable cannot be picked, and says why", () => {
    const ro = providerChoices(reviewer, providers, runnable, none);
    expect(ro.find((c) => c.id === "copilot")).toMatchObject({ ok: false });
    expect(ro.find((c) => c.id === "copilot")?.note).toMatch(/needs login/);
    expect(providerChoices(reviewer, providers, new Set(["claude"]), none).find((c) => c.id === "claude")?.ok).toBe(true);
    expect(providerChoices({ provider: "gemini", permission: "readOnly" }, providers, runnable, none).find((c) => c.id === "gemini")?.note).toMatch(/is off/);
  });

  it("falls back to the role's provider when the picked one is not a valid choice", () => {
    const rw = providerChoices(developer, providers, runnable, none);
    expect(chosenProvider("codex", developer, rw)).toBe("claude");
    expect(chosenProvider(undefined, developer, rw)).toBe("claude");
    expect(chosenProvider("codex", reviewer, providerChoices(reviewer, providers, runnable, none))).toBe("codex");
  });

  it("sends the provider only when it differs from the role's", () => {
    const draft = { role: "reviewer", repoIds: ["a"], prompt: "x" };
    expect(startRequest(draft, reviewer, "claude")).toEqual({ role: "reviewer", repoIds: ["a"], prompt: "x" });
    expect(startRequest(draft, reviewer, "codex")).toEqual({ role: "reviewer", repoIds: ["a"], prompt: "x", provider: "codex" });
  });

  it("blocks the start while the chosen provider cannot take the role", () => {
    const choices = providerChoices({ provider: "gemini", permission: "readOnly" }, providers, runnable, none);
    expect(providerBlocker("gemini", choices)).toMatch(/is off/);
    expect(providerBlocker("codex", choices)).toBeUndefined();
  });
});

describe("Auto", () => {
  it("needs repositories and a prompt only: no role blocker in auto mode, today's blocker otherwise", async () => {
    const { startBlocker } = await import("./newRunLogic");
    expect(startBlocker({ role: undefined, repoIds: ["a"], prompt: "x", mode: "auto" }, [])).toBeUndefined();
    expect(startBlocker({ role: undefined, repoIds: [], prompt: "x", mode: "auto" }, [])).toBe("Pick at least one repository");
    expect(startBlocker({ role: undefined, repoIds: ["a"], prompt: " ", mode: "auto" }, [])).toBe("Write what the agent should do");
    expect(startBlocker({ role: undefined, repoIds: ["a"], prompt: "x" }, [])).toBe("Pick a role");
    expect(startBlocker({ role: undefined, repoIds: ["a"], prompt: "x", mode: "role" }, [{ name: "developer" }])).toBe("Pick a role");
  });

  it("sends role auto and no provider, whatever provider a stale pick left behind", async () => {
    const { startRequest } = await import("./newRunLogic");
    expect(startRequest({ role: undefined, repoIds: ["a"], prompt: "p", mode: "auto" }, undefined, "codex")).toEqual({ role: "auto", repoIds: ["a"], prompt: "p" });
    expect(startRequest({ role: "reviewer", repoIds: ["a"], prompt: "p" }, { provider: "claude" }, "claude")).toEqual({ role: "reviewer", repoIds: ["a"], prompt: "p" });
  });

  it("the neutral role of another provider is the read-only researcher, else any read-only role", async () => {
    const { neutralRole } = await import("./newRunLogic");
    expect(neutralRole([{ name: "developer", permission: "edit" }, { name: "researcher", permission: "readOnly" }, { name: "reviewer", permission: "readOnly" }])?.name).toBe("researcher");
    expect(neutralRole([{ name: "developer", permission: "edit" }, { name: "reviewer", permission: "readOnly" }])?.name).toBe("reviewer");
    expect(neutralRole([{ name: "developer", permission: "edit" }])).toBeUndefined();
  });

  it("words a delegate in one plain term and the reasons Auto is unavailable", async () => {
    const { autoReasonText, delegateKind, derivationSummary } = await import("./newRunLogic");
    expect(delegateKind({ permission: "readOnly", tools: ["Read"] })).toBe("readOnly");
    expect(delegateKind({ permission: "edit", tools: ["Read", "Bash"] })).toBe("runsCommands");
    expect(delegateKind({ permission: "edit", tools: ["Read", "Edit"] })).toBe("edits");
    expect(delegateKind({ permission: "edit", tools: [] })).toBe("edits");
    expect(delegateKind({ permission: "ask", tools: ["Read"] })).toBe("asks");
    expect(derivationSummary([{ name: "researcher", permission: "readOnly", tools: [] }, { name: "dev", permission: "edit", tools: ["Edit"] }])).toBe("researcher (read-only), dev (edits)");
    expect(autoReasonText("cliTooOld")).toMatch(/too old/);
    expect(autoReasonText("novel")).toBe("novel");
    expect(autoReasonText(undefined)).toBe("");
  });
});

const ALL: PermissionMode[] = ["readOnly", "ask", "edit", "automatic", "bypass"];
const THREE: PermissionMode[] = ["readOnly", "ask", "edit"];

describe("run mode", () => {
  it("starts in Automatic until acceptance gate AG-1 says otherwise (one constant)", () => {
    expect(DEFAULT_MODE_UNTIL_AG1).toBe("automatic");
    expect(initialMode(undefined, ALL)).toBe("automatic");
  });

  it("defaults to the mode used last", () => {
    for (const last of ["readOnly", "ask", "edit", "automatic"] as const) expect(initialMode(last, ALL)).toBe(last);
  });

  it("never defaults to Bypass: a remembered Bypass becomes the initial default", () => {
    expect(initialMode("bypass", ALL)).toBe("automatic");
  });

  it("ignores a remembered value that is not a mode", () => {
    expect(initialMode("turbo" as PermissionMode, ALL)).toBe("automatic");
  });

  it("clamps to the nearest mode the provider supports, never a looser one", () => {
    expect(clampMode("automatic", THREE)).toBe("edit");
    expect(clampMode("bypass", THREE)).toBe("edit");
    expect(clampMode("edit", ["readOnly", "ask"])).toBe("ask");
    expect(clampMode("ask", ["readOnly", "edit"])).toBe("readOnly");
    expect(clampMode("readOnly", ["ask", "edit"])).toBe("ask");
    expect(clampMode("ask", ALL)).toBe("ask");
    expect(initialMode("automatic", THREE)).toBe("edit");
    expect(initialMode(undefined, ["readOnly"])).toBe("readOnly");
  });

  it("lets a read-only role ask for Plan, whatever was used last", () => {
    expect(initialMode("automatic", ALL, { permission: "readOnly" })).toBe("readOnly");
    expect(initialMode("edit", ALL, { permission: "edit" })).toBe("edit");
    expect(initialMode(undefined, ALL, { permission: "ask" })).toBe("automatic");
  });

  it("does not decide before the provider's modes are known", () => {
    expect(initialMode("ask", [])).toBe("ask");
    expect(initialMode(undefined, [])).toBe("automatic");
  });

  it("puts the chosen mode and the picked MCP servers in the request, and nothing when none were chosen", () => {
    const draft = { role: "developer", repoIds: ["a"], prompt: "x" };
    expect(startRequest(draft, { provider: "claude" }, "claude")).toEqual({ role: "developer", repoIds: ["a"], prompt: "x" });
    expect(startRequest({ ...draft, permission: "ask", mcpServers: ["m1"] }, { provider: "claude" }, "claude")).toEqual({ role: "developer", repoIds: ["a"], prompt: "x", mode: "ask", mcpServers: ["m1"] });
    // An explicit empty list is a choice (no MCP); an absent one is "the picker is not there".
    expect(startRequest({ ...draft, permission: "readOnly", mcpServers: [] }, { provider: "claude" }, "claude")).toMatchObject({ mcpServers: [] });
    expect(startRequest({ role: undefined, repoIds: ["a"], prompt: "x", mode: "auto", permission: "automatic" }, undefined, undefined)).toEqual({ role: "auto", repoIds: ["a"], prompt: "x", mode: "automatic" });
    expect(startRequest({ ...draft, permission: "readOnly" }, { provider: "claude" }, "codex")).toEqual({ role: "developer", repoIds: ["a"], prompt: "x", mode: "readOnly", provider: "codex" });
  });
});

describe("start errors", () => {
  it("words the host's mode refusals", () => {
    expect(startErrorText({ code: "writeLease", message: "x" })).toBe("Another run is writing to this repository. Wait for it, or pick Ask.");
    expect(startErrorText({ code: "noSlot" })).toBe("All writer slots are busy right now.");
    expect(startErrorText({ code: "modeNotSupported" })).toBe("This provider cannot run in that mode.");
    expect(startErrorText({ code: "modeDisabled" })).toBe("Automatic and Bypass are switched off in this build.");
    expect(startErrorText({ code: "bypassNotConfirmed" })).toBe("Bypass needs your confirmation.");
  });

  it("shows the host's own message for any other refusal, and the value itself when it is no error object", () => {
    expect(startErrorText({ code: "noSafetyNet", message: "Rewind cannot snapshot admin" })).toBe("Rewind cannot snapshot admin");
    expect(startErrorText(new Error("boom"))).toBe("boom");
    expect(startErrorText("plain")).toBe("plain");
  });

  it("words the refusals caused by the selected MCP servers from the MCP catalog", () => {
    expect(startErrorText({ code: "mcpSecretMissing", message: "raw" })).not.toBe("raw");
    expect(startErrorText({ code: "confirmationRequired", message: "raw" })).not.toBe("raw");
    expect(startErrorText({ code: "mcpSecretMissing" })).not.toMatch(/^mcp\./);
  });
});

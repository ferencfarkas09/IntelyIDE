import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", async () => ({ ipc: (await import("../../store/testing-u2")).normal.ipc }));
vi.mock("../../store/selection", async () => (await import("../../store/testing-u2")).selectionModule);
vi.mock("../../store/snapshots", async () => (await import("../../store/testing-u2")).snapshotsModule);
vi.mock("../../store/workspace", async () => (await import("../../store/testing-u2")).workspaceModule);

import { ipc } from "../../ipc";
import { availableCommands, resetCommands } from "../../platform/commands";
import { commitPanelSlots, registerCommitGuard, resetCommitGuards, resetCommitPanelSlots, runCommitGuards } from "../../platform/commitSlots";
import { overlays, resetOverlays } from "../../platform/overlay";
import { resetSettings, settingsSections } from "../../platform/settings";
import { resetTabs, tabTypes } from "../../platform/tabs";
import { installDomStubs, normal, seedStores } from "../../store/testing-u2";
import { toast } from "../../ui-kit";
import { createMockChecks, setChecksApi, type ChecksApi } from "./api";
import ChecksPanel from "./ChecksPanel";
import { register } from "./index";
import { applyChunk, countRuns, formatDuration, summaryText } from "./logic";
import EnvTab from "./EnvTab";
import SecretDialog from "./SecretDialog";
import { answerSecretAsk, secretAsk, secretGuard } from "./secretGuard";
import { resetChecksStore, runBeforeCommit } from "./store";
import { setBeforeCommit, setChecksEnabled, setSecretGuardEnabled } from "./toggle";
import type { CheckRun } from "./types";

installDomStubs();

beforeEach(async () => {
  localStorage.clear();
  normal.reset();
  await seedStores(ipc, { services: ["src/orders/create.js", "locales/en.json"], backend: ["src/api/routes/index.js"] });
  setSecretGuardEnabled(true);
});
afterEach(() => {
  cleanup();
  resetChecksStore();
  setChecksApi(undefined);
  vi.restoreAllMocks();
});

const run = (status: CheckRun["status"]): CheckRun => ({ id: `r:${status}`, repoId: "r", checkId: "c", label: "L", runner: "x", status, exitCode: null, startedAt: 0, durationMs: 0 });

describe("checks logic", () => {
  it("counts and words the results", () => {
    const c = countRuns([run("passed"), run("failed"), run("failed"), run("running"), run("stopped")]);
    expect(c).toEqual({ passed: 1, failed: 2, running: 1 });
    expect(summaryText(c)).toBe("1 running, 2 failed, 1 passed");
    expect(summaryText({ passed: 0, failed: 0, running: 0 })).toBe("");
  });

  it("formats durations", () => {
    expect([formatDuration(420), formatDuration(1400), formatDuration(83_000)]).toEqual(["420 ms", "1.4 s", "1 min 23 s"]);
  });

  it("places streamed chunks by sequence and drops everything on a reset", () => {
    expect(applyChunk(["a", "b"], { startSeq: 2, lines: ["c"], reset: false })).toEqual(["a", "b", "c"]);
    expect(applyChunk(["a", "b", "c"], { startSeq: 1, lines: ["B"], reset: false })).toEqual(["a", "B"]);
    expect(applyChunk(["a"], { startSeq: 0, lines: ["z"], reset: true })).toEqual(["z"]);
    expect(applyChunk([], { startSeq: 0, lines: ["1", "2", "3"], reset: false }, 2)).toEqual(["2", "3"]);
  });
});

describe("commit guards (platform)", () => {
  afterEach(() => resetCommitGuards());
  it("the first no stops the commit, a guard that throws never blocks it", async () => {
    const ctx = { repos: [{ repoId: "a", paths: ["x"] }] };
    expect(await runCommitGuards(ctx)).toBe(true);
    registerCommitGuard({ id: "boom", check: async () => { throw new Error("x"); } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runCommitGuards(ctx)).toBe(true);
    registerCommitGuard({ id: "no", check: async () => false });
    expect(await runCommitGuards(ctx)).toBe(false);
  });
});

describe("checks module toggle", () => {
  beforeAll(() => {
    resetSettings();
    resetTabs();
    resetCommands();
    resetOverlays();
    resetCommitPanelSlots();
    resetCommitGuards();
    register();
  });

  it("registers only the Settings section while it is off", () => {
    expect(settingsSections().map((s) => s.id)).toContain("checks");
    expect(tabTypes().map((t) => t.type)).not.toContain("env");
    expect(commitPanelSlots()).toHaveLength(0);
    expect(overlays().map((o) => o.id)).not.toContain("checks.secrets");
  });

  it("adds the panel, guards, dialog, tab and command when switched on, and removes them again", async () => {
    setChecksEnabled(true);
    expect(commitPanelSlots().map((s) => s.id)).toEqual(["checks"]);
    expect(overlays().map((o) => o.id)).toContain("checks.secrets");
    expect(tabTypes().map((t) => t.type)).toContain("env");
    expect(availableCommands().map((c) => c.id)).toContain("checks.env");
    setChecksEnabled(false);
    expect(commitPanelSlots()).toHaveLength(0);
    expect(tabTypes().map((t) => t.type)).not.toContain("env");
    expect(await runCommitGuards({ repos: [] })).toBe(true);
  });
});

const expand = () => fireEvent.click(screen.getByRole("button", { name: /^Checks/ }));

describe("<ChecksPanel>", () => {
  it("offers the checks of every ticked repo and runs one on click, streaming its output", async () => {
    setChecksApi(createMockChecks());
    render(() => <ChecksPanel />);
    expect(screen.queryByText("Lint changed files")).toBeNull();
    expand();
    await waitFor(() => expect(screen.getAllByText("Lint changed files").length).toBe(2));
    expect(screen.getAllByText("Tests for the changed files")).toHaveLength(2);
    // The script name is shown, never a body.
    expect(document.body.textContent).toContain("npm run lint:changed");
    fireEvent.click(screen.getAllByRole("button", { name: "Run Lint changed files" })[0]);
    await waitFor(() => expect(screen.getAllByText(/^Passed/)).toHaveLength(1));
    await waitFor(() => expect(document.querySelector(".chk__out")!.textContent).toContain("no problems"));
  });

  it("shows a failed run with its output and the repo summary chip", async () => {
    setChecksApi(createMockChecks());
    render(() => <ChecksPanel />);
    expand();
    const row = (await waitFor(() => {
      const el = document.querySelector('[data-check="tests:related"]');
      if (!el) throw new Error("not yet");
      return el;
    })) as HTMLElement;
    fireEvent.click(row.querySelector("button[aria-label^='Run']")!);
    await waitFor(() => expect(row.getAttribute("data-status")).toBe("failed"));
    await waitFor(() => expect(row.querySelector(".chk__out")!.textContent).toContain("Expected: 1290"));
    expect(screen.getAllByText("1 failed").length).toBeGreaterThan(0);
  });

  it("disables Run and says why when the jail does not allow processes", async () => {
    setChecksApi(createMockChecks({ startable: false }));
    render(() => <ChecksPanel />);
    expand();
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Allow processes"));
    for (const b of screen.getAllByRole("button", { name: /^Run / })) expect((b as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables a check that has no matching files and renders nothing when no file is ticked", async () => {
    await seedStores(ipc, { services: ["README.md"] });
    setChecksApi(createMockChecks());
    const view = render(() => <ChecksPanel />);
    expand();
    await waitFor(() => expect(screen.getByText("Tick changed JavaScript or TypeScript files first")).toBeTruthy());
    expect((screen.getByRole("button", { name: "Run Tests for the changed files" }) as HTMLButtonElement).disabled).toBe(true);
    view.unmount();
    await seedStores(ipc, {});
    render(() => <ChecksPanel />);
    expect(document.querySelector(".chk")).toBeNull();
  });
});

describe("run before commit", () => {
  it("runs the quick checks, warns about failures and returns (never blocks)", async () => {
    setChecksApi(createMockChecks());
    const warn = vi.spyOn(toast, "warn").mockImplementation(() => "" as never);
    await runBeforeCommit([{ repoId: "services", paths: ["src/orders/create.js"] }], (id) => id, 5000);
    expect(warn).toHaveBeenCalledWith("Checks found problems", expect.stringContaining("tests:related"));
    expect(warn.mock.calls[0][1]).toContain("The commit continues");
  });

  it("skips quietly with a notice when processes are not allowed", async () => {
    setChecksApi(createMockChecks({ startable: false }));
    const warn = vi.spyOn(toast, "warn").mockImplementation(() => "" as never);
    const start = vi.fn();
    const api: ChecksApi = { ...createMockChecks({ startable: false }), start };
    setChecksApi(api);
    await runBeforeCommit([{ repoId: "services", paths: ["a.js"] }], (id) => id, 100);
    expect(start).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("Checks skipped", expect.stringContaining("Allow processes"));
  });
});

describe("secret confirmation", () => {
  const ctx = (paths: string[]) => ({ repos: [{ repoId: "services", paths }] });

  it("lets a clean commit through without a dialog", async () => {
    setChecksApi(createMockChecks());
    expect(await secretGuard(ctx(["src/a.js"]))).toBe(true);
    expect(secretAsk()).toBeNull();
  });

  it("blocks on a finding until the user answers: cancel stops the commit, commit anyway lets it go", async () => {
    setChecksApi(createMockChecks());
    render(() => <SecretDialog />);
    const pending = secretGuard(ctx(["src/config/keys.js"]));
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeTruthy());
    const text = screen.getByRole("alertdialog").textContent!;
    expect(text).toContain("src/config/keys.js");
    expect(text).toContain("GitHub token");
    expect(text).toContain("[redacted: GitHub token]");
    fireEvent.click(screen.getByRole("button", { name: "Cancel the commit" }));
    expect(await pending).toBe(false);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    const second = secretGuard(ctx(["src/config/keys.js"]));
    await waitFor(() => expect(secretAsk()).not.toBeNull());
    answerSecretAsk(true);
    expect(await second).toBe(true);
  });

  it("follows the Settings switch and never blocks when the scan itself fails", async () => {
    setChecksApi(createMockChecks());
    setSecretGuardEnabled(false);
    expect(await secretGuard(ctx(["src/config/keys.js"]))).toBe(true);
    setSecretGuardEnabled(true);
    vi.spyOn(toast, "warn").mockImplementation(() => "" as never);
    setChecksApi({ ...createMockChecks(), scan: async () => Promise.reject({ code: "io", message: "git failed" }) });
    expect(await secretGuard(ctx(["src/a.js"]))).toBe(true);
  });

  it("does not scan .env files: the fixture reports them as skipped, with no finding", async () => {
    const scan = await createMockChecks().scan("services", [".env", "src/config/keys.js"]);
    expect(scan.skipped).toEqual([".env"]);
  });
});

describe("<EnvTab>", () => {
  it("shows names only: declared files, a lock on the real .env, missing names and the matrix", async () => {
    setChecksApi(createMockChecks());
    render(() => <EnvTab />);
    await waitFor(() => expect(screen.getAllByText(".env.example").length).toBe(2));
    expect(screen.getByText(".env", { selector: ".env__file[data-kind='real'] .ui-mono" })).toBeTruthy();
    expect(screen.getByText(/never read/i)).toBeTruthy();
    const missing = screen.getByLabelText("Used in code but not declared");
    expect(missing.textContent).toContain("SENTRY_DSN");
    expect(missing.textContent).toContain("src/lib/sentry.js");
    const row = screen.getByText("MONGO_URI", { selector: "th" }).closest("tr")!;
    expect(Array.from(row.querySelectorAll("td")).map((td) => td.getAttribute("title"))).toEqual(["declared and used", "not present"]);
    expect(screen.getByText("SENTRY_DSN", { selector: "th" }).closest("tr")!.querySelector("td")!.getAttribute("title")).toBe("used in code, not declared");
  });
});

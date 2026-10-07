import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc", async () => ({ ipc: (await import("./testing-u2")).normal.ipc }));
vi.mock("./selection", async () => (await import("./testing-u2")).selectionModule);
vi.mock("./snapshots", async () => (await import("./testing-u2")).snapshotsModule);
vi.mock("./workspace", async () => (await import("./testing-u2")).workspaceModule);

import { invalidFields, messageHistory, resetMessageState, setAmend, setSharedMessage, sharedMessage, SHARED_FIELD } from "../components/commit/messageState";
import { setPreviewNonProtected } from "../components/push/settings";
import { buildPushRequest } from "../components/push/logic";
import { ipc } from "../ipc";
import * as actions from "./actions";
import { normal, seedStores } from "./testing-u2";

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  localStorage.clear();
  actions.resetActions();
  resetMessageState();
  setPreviewNonProtected(true);
  normal.reset();
  await seedStores(ipc, { services: ["locales/hu.json", "locales/en.json"], backend: ["src/api/routes/index.js"] });
});

afterEach(() => vi.restoreAllMocks());

describe("commit (mock scenario normal)", () => {
  it("builds the request from the ticked files, tracks the run and records the message", async () => {
    const start = vi.spyOn(ipc, "commitStart");
    setSharedMessage("fix(i18n): translate booking labels");
    await actions.commitRepo("services");

    expect(start).toHaveBeenCalledOnce();
    const req = start.mock.calls[0][0];
    expect(req.noVerify).toBe(false);
    expect(req.repos).toEqual([
      {
        repoId: "services",
        message: "fix(i18n): translate booking labels",
        amend: false,
        files: [
          { mode: "whole", path: "locales/hu.json" },
          { mode: "whole", path: "locales/en.json" },
        ],
      },
    ]);
    const result = actions.lastResults();
    expect(result?.kind).toBe("commit");
    expect(result?.repos[0].status).toBe("done");
    const row = actions.sheetRows()[0];
    expect(row.kind).toBe("commit");
    expect(actions.rowState(row)?.status).toBe("done");
    // The run streamed its hook output, and the message moved from the draft into the history.
    expect(actions.rowState(row)?.lines.map((l) => l.text)).toContain("husky - pre-commit");
    expect(messageHistory()).toEqual(["fix(i18n): translate booking labels"]);
    expect(sharedMessage()).toBe("");
    expect(actions.committedNotPushed("services")).toBeTruthy();
  });

  it("does not start a run without a message, and marks the field", async () => {
    const start = vi.spyOn(ipc, "commitStart");
    await actions.commitAll();
    expect(start).not.toHaveBeenCalled();
    expect(invalidFields().has(SHARED_FIELD)).toBe(true);
    expect(actions.sheetRows()).toHaveLength(0);
  });

  it("does not start a run without selected files", async () => {
    await seedStores(ipc, {});
    const start = vi.spyOn(ipc, "commitStart");
    setSharedMessage("feat: x");
    await actions.commitAll();
    expect(start).not.toHaveBeenCalled();
  });

  it("commits several repos in one request without the amend flag", async () => {
    const start = vi.spyOn(ipc, "commitStart");
    setSharedMessage("chore: sync");
    await actions.commitAll();
    const req = start.mock.calls[0][0];
    expect(req.repos.map((r) => [r.repoId, r.amend])).toEqual([
      ["backend", false],
      ["services", false],
    ]);
    expect(actions.sheetRows().map((r) => r.repoId)).toEqual(["backend", "services"]);
  });

  it("refuses to amend across several repos and sends nothing", async () => {
    const start = vi.spyOn(ipc, "commitStart");
    setSharedMessage("chore: sync");
    setAmend(true);
    await actions.commitAll();
    expect(start).not.toHaveBeenCalled();
  });
});

describe("commit and push", () => {
  it("opens the push dialog for the committed repos when it must preview", async () => {
    await seedStores(ipc, { services: ["locales/hu.json"] });
    setSharedMessage("feat: booking");
    await actions.commitAndPush();
    // services is on main, a protected branch, so the dialog opens even with the toggle off.
    expect(actions.pushDialogRequest()).toEqual({ preselected: ["services"] });
  });

  it("pushes straight away for non-protected branches when the preview toggle is off", async () => {
    await seedStores(ipc, { backend: ["src/api/routes/index.js"] });
    setPreviewNonProtected(false);
    const push = vi.spyOn(ipc, "pushStart");
    setSharedMessage("feat: routes");
    await actions.commitAndPush();
    expect(actions.pushDialogRequest()).toBeNull();
    expect(push).toHaveBeenCalledOnce();
    expect(push.mock.calls[0][0].targets.map((t) => [t.repoId, t.remoteBranch])).toEqual([["backend", "sandbox"]]);
    expect(actions.lastResults()?.kind).toBe("push");
    expect(actions.committedNotPushed("backend")).toBeUndefined();
  });

  it("opens the dialog for non-protected branches while the toggle is on", async () => {
    await seedStores(ipc, { admin: ["src/theme/light.css"] });
    setSharedMessage("feat: light");
    await actions.commitAndPush();
    expect(actions.pushDialogRequest()).toEqual({ preselected: ["admin"] });
  });
});

describe("push, pull, fetch and cancel", () => {
  it("tracks a push run through its events", async () => {
    const [plan] = await ipc.pushPlan(["backend"], false);
    const request = buildPushRequest({ runId: "push-1", plans: [plan], checks: { backend: true }, tags: "none", runHooks: true });
    const result = await actions.runPush(request, { fresh: true });
    expect(result.repos[0].status).toBe("done");
    expect(actions.getRun("push-1")?.repos.backend.percent).toBeUndefined();
    expect(actions.getRun("push-1")?.repos.backend.lines.map((l) => l.text)).toContain("Writing objects: 90%");
  });

  it("cancels a running push", async () => {
    const [plan] = await ipc.pushPlan(["backend"], false);
    const request = buildPushRequest({ runId: "push-2", plans: [plan], checks: { backend: true }, tags: "none", runHooks: true });
    const done = actions.runPush(request, { fresh: true });
    await actions.cancelRun("push-2");
    const result = await done;
    expect(result.repos[0].status).toBe("cancelled");
    expect(actions.getRun("push-2")?.cancelling).toBe(true);
  });

  it("runs pull and fetch and tracks them without touching the results sheet", async () => {
    const pull = vi.spyOn(ipc, "pull");
    await actions.pullRepo("pos");
    await actions.fetchRepo("pos");
    expect(pull).toHaveBeenCalledWith("pos", "ffOnly");
    expect(actions.sheetRows()).toHaveLength(0);
    expect(actions.lastResults()).toBeNull();
  });

  it("replays events that arrive before the run is registered", async () => {
    // Pull learns its run id from the command reply; simulate the engine answering after the first event.
    const real = ipc.fetch.bind(ipc);
    vi.spyOn(ipc, "fetch").mockImplementation(async (id) => {
      const started = await real(id);
      await tick();
      return started;
    });
    await expect(actions.fetchRepo("pos")).resolves.toBeUndefined();
  });
});

describe("amend prefill", () => {
  it("fills an empty shared message with the last message of the first repo and clears it again", async () => {
    await actions.setAmendMode(true);
    expect(sharedMessage()).not.toBe("");
    await actions.setAmendMode(false);
    expect(sharedMessage()).toBe("");
  });

  it("keeps what the user typed", async () => {
    setSharedMessage("my own text");
    await actions.setAmendMode(true);
    expect(sharedMessage()).toBe("my own text");
    await actions.setAmendMode(false);
    expect(sharedMessage()).toBe("my own text");
  });

  it("replaces its own prefill when another repo becomes the amend target, but not user text", async () => {
    await seedStores(ipc, { services: ["locales/hu.json"] });
    await actions.setAmendMode(true);
    const services = sharedMessage();
    expect(services).toBe(await ipc.commitMessageLast("services"));
    await seedStores(ipc, { backend: ["src/api/routes/index.js"] });
    await actions.refreshAmendPrefill();
    expect(sharedMessage()).toBe(await ipc.commitMessageLast("backend"));
    expect(sharedMessage()).not.toBe(services);
    setSharedMessage("edited by hand");
    await seedStores(ipc, { services: ["locales/hu.json"] });
    await actions.refreshAmendPrefill();
    expect(sharedMessage()).toBe("edited by hand");
  });
});

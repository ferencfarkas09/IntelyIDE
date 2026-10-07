import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", async () => ({ ipc: (await import("../../store/testing-u2")).normal.ipc }));
vi.mock("../../store/selection", async () => (await import("../../store/testing-u2")).selectionModule);
vi.mock("../../store/snapshots", async () => (await import("../../store/testing-u2")).snapshotsModule);
vi.mock("../../store/workspace", async () => (await import("../../store/testing-u2")).workspaceModule);

import { ipc } from "../../ipc";
import { availableCommands, execute, resetCommands } from "../../platform/commands";
import { resetSettings, settingsSections } from "../../platform/settings";
import { resetTabs, tabTypes } from "../../platform/tabs";
import { installDomStubs, normal, seedStores } from "../../store/testing-u2";
import { createMockPr, setPrApi, type PrApi } from "./api";
import { register } from "./index";
import { bucketTone, ciTone, confirmed, isHttps, isJail, reasonText, reviewTone } from "./logic";
import PrTab from "./PrTab";
import { setCreateRequests } from "./store";
import { setPrEnabled } from "./toggle";

installDomStubs();

beforeEach(async () => {
  localStorage.clear();
  normal.reset();
  await seedStores(ipc, {});
});
afterEach(() => {
  cleanup();
  setPrApi(undefined);
  setCreateRequests(0);
});

const spy = (scenario = "normal", over: Partial<PrApi> = {}) => {
  const api = createMockPr(scenario);
  const calls = { create: [] as unknown[], open: [] as string[] };
  const wrapped: PrApi = {
    ...api,
    create: async (r, req) => (calls.create.push(req), api.create(r, req)),
    openUrl: async (u) => void calls.open.push(u),
    ...over,
  };
  setPrApi(wrapped);
  return calls;
};

describe("pr logic", () => {
  it("accepts only the exact typed text", () => {
    expect(confirmed("feature/x", "feature/x")).toBe(true);
    expect(confirmed("Feature/x", "feature/x")).toBe(false);
    expect(confirmed("feature/x ", "feature/x")).toBe(false);
    expect(confirmed("", "")).toBe(false);
  });
  it("hands only https links to the browser", () => {
    expect(isHttps("https://github.com/a/b/pull/1")).toBe(true);
    for (const u of ["http://github.com/x", "javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "github.com", "", null, undefined]) expect(isHttps(u)).toBe(false);
  });
  it("maps states to tones and codes to translated reasons", () => {
    expect([ciTone("passing"), ciTone("failing"), ciTone("pending"), ciTone("none")]).toEqual(["ok", "danger", "warn", "neutral"]);
    expect([reviewTone("approved"), reviewTone("changesRequested"), reviewTone("reviewRequired")]).toEqual(["ok", "danger", "warn"]);
    expect([bucketTone("pass"), bucketTone("fail"), bucketTone("pending"), bucketTone("skipping")]).toEqual(["ok", "danger", "warn", "neutral"]);
    expect(reasonText({ code: "noUpstream", message: "x" })).toContain("Push dialog");
    expect(reasonText({ code: "somethingNew", message: "engine text" })).toBe("engine text");
    expect([isJail("readOnly"), isJail("testJail"), isJail(null)]).toEqual([true, true, false]);
  });
});

describe("pr module toggle", () => {
  beforeAll(() => {
    resetSettings();
    resetTabs();
    resetCommands();
    register();
  });
  it("registers only the Settings section while off, the tab and commands when on", () => {
    expect(settingsSections().map((s) => s.id)).toContain("pr");
    expect(tabTypes().map((x) => x.type)).not.toContain("pr");
    setPrEnabled(true);
    expect(tabTypes().map((x) => x.type)).toContain("pr");
    expect(availableCommands().map((c) => c.id)).toEqual(expect.arrayContaining(["pr.open", "pr.create"]));
    setPrEnabled(false);
    expect(tabTypes().map((x) => x.type)).not.toContain("pr");
    expect(availableCommands().map((c) => c.id)).not.toContain("pr.open");
    void execute;
  });
});

describe("<PrTab>", () => {
  it("lists the pull requests of the branch and of the user with CI and review state", async () => {
    spy();
    render(() => <PrTab />);
    await waitFor(() => expect(document.querySelector('[data-pr="412"]')).toBeTruthy());
    const row = (n: number) => document.querySelector(`[data-pr="${n}"]`) as HTMLElement;
    expect(row(412).textContent).toContain("Draft");
    expect(row(412).textContent).toContain("CI running");
    expect(row(409).textContent).toContain("CI passing");
    expect(row(409).textContent).toContain("Approved");
    expect(row(398).textContent).toContain("CI failing");
    expect(row(398).textContent).toContain("Changes requested");
    expect(screen.getByLabelText("Pull requests of the current branch").querySelectorAll("li")).toHaveLength(1);
    expect(screen.getByLabelText("Your open pull requests").querySelectorAll("li")).toHaveLength(2);
  });

  it("shows the description as plain text, the checks, and opens only https links", async () => {
    const calls = spy("normal", {
      view: async (r, n) => {
        const d = await createMockPr().view(r, n);
        d.body = "Adds invoices.\n<script>window.pwned = 1</script>";
        d.checks.push({ name: "evil", workflow: "CI", state: "SUCCESS", bucket: "pass", link: "javascript:alert(1)" });
        return d;
      },
    });
    render(() => <PrTab />);
    await waitFor(() => expect(document.querySelector('[data-pr-detail="412"]')).toBeTruthy());
    const body = document.querySelector(".pr__body")!;
    expect(body.textContent).toContain("<script>window.pwned = 1</script>");
    expect(body.querySelector("script")).toBeNull();
    expect(document.querySelectorAll(".pr__check")).toHaveLength(5);
    expect(screen.getByRole("button", { name: "Open check lint in the browser" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open check evil in the browser" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open check e2e in the browser" }));
    fireEvent.click(screen.getByRole("button", { name: "Open on GitHub" }));
    expect(calls.open).toEqual(["https://github.com/example-org/repo/actions/runs/104", "https://github.com/example-org/repo/pull/412"]);
    fireEvent.click(document.querySelector('[data-pr="409"]')!);
    await waitFor(() => expect(document.querySelector('[data-pr-detail="409"]')).toBeTruthy());
  });

  it.each([
    ["noGh", "GitHub CLI not found"],
    ["noAuth", "gh is not signed in"],
    ["readOnly", "No GitHub calls in this mode"],
  ])("explains the %s state instead of listing", async (scenario, title) => {
    spy(scenario);
    render(() => <PrTab />);
    await screen.findByText(title);
    expect(document.querySelector("[data-pr]")).toBeNull();
  });
});

describe("<CreatePrDialog> via the tab", () => {
  const openDialog = async () => {
    render(() => <PrTab />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Create PR" }).getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Create PR" }));
    return (await screen.findByRole("button", { name: "Create draft PR" })) as HTMLButtonElement;
  };
  const repoNameOf = () => (document.querySelector("select") as HTMLSelectElement).selectedOptions[0].textContent!;

  it("is a draft, shows the exact command, and needs the repo name and the head branch typed", async () => {
    const calls = spy();
    const create = await openDialog();
    await waitFor(() => expect((screen.getByLabelText("Pull request title") as HTMLInputElement).value).toBe("feat(billing): invoice PDF export"));
    const cmd = () => screen.getByLabelText("The gh command").textContent!;
    await waitFor(() => expect(cmd()).toContain("gh pr create --draft --base=main --head=feature/invoice-pdf --title="));
    expect((screen.getByLabelText("Pull request description") as HTMLTextAreaElement).value).toMatch(/^Extended English:/);
    expect(create.disabled).toBe(true);
    const repo = screen.getByLabelText("Type the repository name to confirm");
    const head = screen.getByLabelText("Type the head branch to confirm");
    fireEvent.input(repo, { target: { value: repoNameOf() } });
    expect(create.disabled).toBe(true);
    fireEvent.input(head, { target: { value: "feature/invoice" } });
    expect(create.disabled).toBe(true);
    fireEvent.input(head, { target: { value: "feature/invoice-pdf " } });
    expect(create.disabled).toBe(true);
    fireEvent.input(head, { target: { value: "feature/invoice-pdf" } });
    fireEvent.input(repo, { target: { value: repoNameOf().toUpperCase() } });
    expect(create.disabled).toBe(true);
    fireEvent.input(repo, { target: { value: repoNameOf() } });
    expect(create.disabled).toBe(false);
    expect(calls.create).toHaveLength(0);
    fireEvent.click(create);
    await waitFor(() => expect(calls.create).toHaveLength(1));
    expect(calls.create[0]).toMatchObject({ draft: true, base: "main", confirmRepo: repoNameOf(), confirmHead: "feature/invoice-pdf" });
  });

  it("shows the edited title in the command and a note when it is not a draft", async () => {
    spy();
    await openDialog();
    const title = await waitFor(() => {
      const el = screen.getByLabelText("Pull request title") as HTMLInputElement;
      expect(el.value).not.toBe("");
      return el;
    });
    fireEvent.input(title, { target: { value: "fix: it's ready" } });
    await waitFor(() => expect(screen.getByLabelText("The gh command").textContent).toContain("--title='fix: it'\\''s ready'"));
    fireEvent.click(screen.getByRole("switch", { name: "Create as a draft" }));
    await waitFor(() => expect(screen.getByLabelText("The gh command").textContent).not.toContain("--draft"));
    expect(screen.getByText(/reviewers are notified/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Create PR" })).toHaveLength(2);
  });

  it.each([
    ["noUpstream", "Push dialog"],
    ["liveHead", "never the head"],
    ["readOnly", "Read-only mode"],
  ])("keeps Create off for %s and says why", async (scenario, text) => {
    const calls = spy(scenario);
    const create = await openDialog();
    await waitFor(() => expect(screen.getAllByRole("alert").some((a) => a.textContent!.includes(text))).toBe(true));
    fireEvent.input(screen.getByLabelText("Type the repository name to confirm"), { target: { value: repoNameOf() } });
    fireEvent.input(screen.getByLabelText("Type the head branch to confirm"), { target: { value: scenario === "noUpstream" ? "wip/invoice" : scenario === "liveHead" ? "main" : "feature/invoice-pdf" } });
    expect(create.disabled).toBe(true);
    fireEvent.click(create);
    expect(calls.create).toHaveLength(0);
  });

  it("opens from the pr.create command", async () => {
    spy();
    render(() => <PrTab />);
    await waitFor(() => expect(document.querySelector('[data-pr="412"]')).toBeTruthy());
    setCreateRequests(1);
    expect(await screen.findByRole("button", { name: "Create draft PR" })).toBeTruthy();
  });
});

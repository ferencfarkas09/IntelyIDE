import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../store/workspace", () => {
  const repos = [
    { id: "backend", name: "shop-backend" },
    { id: "admin", name: "shop-admin" },
    { id: "pos", name: "shop-pos" },
  ];
  return { repos: () => repos, repoConfig: (id: string) => repos.find((r) => r.id === id), workspace: () => ({ repos }) };
});

import { installDomStubs } from "../../store/testing-u2";
import { createMockSentry, setSentryApi } from "../sentry/api";
import { resetSentry, setConfigStatus } from "../sentry/store";
import IntelyFixSection from "./IntelyFixSection";
import { fixPrefs, resetFixPrefs, saveFixPrefs, DEFAULT_PREFS } from "./prefs";

installDomStubs();

beforeEach(async () => {
  resetSentry();
  resetFixPrefs();
  await saveFixPrefs(DEFAULT_PREFS);
  resetFixPrefs();
  setSentryApi(createMockSentry(Date.now()));
  setConfigStatus({ baseUrl: "https://sentry.io", org: "acme", hasToken: true, configured: true });
});
afterEach(() => {
  cleanup();
  setSentryApi(undefined);
  vi.restoreAllMocks();
});

async function mount() {
  render(() => <IntelyFixSection />);
  await screen.findByText("Prompt template");
}

describe("Settings > IntelyFIX", () => {
  it("starts with the defaults: start at once, give the issue to me, the developer role, accept edits", async () => {
    await mount();
    expect(screen.getByRole("radio", { name: "Start the run at once" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByLabelText("Give the issue to") as HTMLSelectElement).value).toBe("me");
    expect((screen.getByLabelText("Role") as HTMLSelectElement).value).toBe("developer");
    expect((screen.getByLabelText("Mode") as HTMLSelectElement).value).toBe("edit");
  });

  it("keeps what is chosen: review first, the mode, the role", async () => {
    await mount();
    fireEvent.click(screen.getByRole("radio", { name: "Open the New run dialog, filled in" }));
    await waitFor(() => expect(fixPrefs().start).toBe("review"));
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "ask" } });
    await waitFor(() => expect(fixPrefs().permission).toBe("ask"));
  });

  it("offers the people and the teams of Sentry as the one who gets the issue", async () => {
    await mount();
    const pick = screen.getByLabelText("Give the issue to") as HTMLSelectElement;
    await waitFor(() => expect([...pick.options].some((o) => o.textContent === "#backend")).toBe(true));
    fireEvent.change(pick, { target: { value: "team:7" } });
    await waitFor(() => expect(fixPrefs().assignee).toEqual({ mode: "pick", kind: "team", id: "7", name: "#backend" }));
    fireEvent.change(pick, { target: { value: "none" } });
    await waitFor(() => expect(fixPrefs().assignee).toEqual({ mode: "none" }));
  });

  it("maps a Sentry project to the repository to work in, and to the ones that may change with it", async () => {
    await mount();
    const work = await screen.findByLabelText("Work in: shop-admin");
    fireEvent.change(work, { target: { value: "shop-admin" } });
    await waitFor(() => expect(fixPrefs().repoMap["shop-admin"]).toEqual(["shop-admin"]));
    const also = await screen.findByRole("group", { name: "Also in scope: shop-admin" });
    expect(within(also).queryByRole("checkbox", { name: "shop-admin" })).toBeNull();
    fireEvent.click(within(also).getByRole("checkbox", { name: "shop-backend" }));
    await waitFor(() => expect(fixPrefs().repoMap["shop-admin"]).toEqual(["shop-admin", "shop-backend"]));
    // another repository to work in replaces the first one and keeps the ones that may change with it; none removes the project's entry
    fireEvent.change(work, { target: { value: "shop-pos" } });
    await waitFor(() => expect(fixPrefs().repoMap["shop-admin"]).toEqual(["shop-pos", "shop-backend"]));
    fireEvent.change(work, { target: { value: "" } });
    await waitFor(() => expect(fixPrefs().repoMap["shop-admin"]).toBeUndefined());
  });

  it("shows the built-in prompt, warns about a name that is no placeholder, and goes back to the built-in one", async () => {
    await mount();
    const box = screen.getByLabelText("Prompt template") as HTMLTextAreaElement;
    expect(box.value).toContain("Fix the Sentry issue {{ID}}: {{TITLE}}");
    expect(screen.getByRole("button", { name: "Use the built-in prompt" }).hasAttribute("disabled")).toBe(true);
    fireEvent.input(box, { target: { value: "Fix {{ID}} in {{WHERE}}. {{title}}" } });
    expect(await screen.findByText("Not a placeholder: WHERE")).toBeTruthy();
    fireEvent.change(box);
    await waitFor(() => expect(fixPrefs().template).toBe("Fix {{ID}} in {{WHERE}}. {{title}}"));
    const reset = screen.getByRole("button", { name: "Use the built-in prompt" });
    expect(reset.hasAttribute("disabled")).toBe(false);
    fireEvent.click(reset);
    await waitFor(() => expect(fixPrefs().template).toBe(""));
    expect(box.value).toContain("How to work:");
  });

  it("previews the prompt with a sample issue", async () => {
    await mount();
    expect(document.querySelector(".ifx__previewText")?.textContent).toContain("Fix the Sentry issue SHOP-1A: TypeError");
    expect(document.querySelector(".ifx__previewText")?.textContent).toContain("Work in shop-backend.");
  });
});

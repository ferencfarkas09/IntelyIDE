import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetSettings, settingsSections } from "../../platform/settings";
import { resetCommands, availableCommands } from "../../platform/commands";
import { changeBadgeSlots, resetChangeBadges } from "../../platform/changeBadges";
import { resetTabs, tabTypes } from "../../platform/tabs";
import { resetOverlays, overlays } from "../../platform/overlay";
import { installDomStubs } from "../../store/testing-u2";
import { createMockL10n, setL10nApi } from "./api";
import ChangeBadge from "./ChangeBadge";
import { register } from "./index";
import L10nSection from "./L10nSection";
import L10nTab from "./L10nTab";
import { clearReports, refresh } from "./store";
import { setL10nEnabled } from "./toggle";

installDomStubs();

afterEach(() => {
  cleanup();
  clearReports();
  setL10nApi(undefined);
});

const tab = { id: "l10n", type: "l10n", title: "Localization" };

describe("l10n module toggle", () => {
  beforeAll(() => {
    resetSettings();
    resetTabs();
    resetCommands();
    resetOverlays();
    resetChangeBadges();
    register();
  });

  it("registers only the Settings section while it is off", () => {
    expect(settingsSections().map((s) => s.id)).toContain("l10n");
    expect(tabTypes().map((t) => t.type)).not.toContain("l10n");
    expect(changeBadgeSlots()).toHaveLength(0);
    expect(overlays().map((o) => o.id)).not.toContain("l10n.watcher");
  });

  it("adds the tab, badge, watcher and commands when switched on, and removes them again", () => {
    setL10nEnabled(true);
    expect(tabTypes().map((t) => t.type)).toContain("l10n");
    expect(changeBadgeSlots().map((s) => s.id)).toEqual(["l10n"]);
    expect(overlays().map((o) => o.id)).toContain("l10n.watcher");
    expect(availableCommands().map((c) => c.id)).toContain("l10n.open");
    setL10nEnabled(false);
    expect(tabTypes().map((t) => t.type)).not.toContain("l10n");
    expect(changeBadgeSlots()).toHaveLength(0);
    expect(availableCommands().map((c) => c.id)).not.toContain("l10n.open");
  });
});

describe("<L10nTab>", () => {
  it("shows the matrix: one row per changed key, one column per language, a state per cell", async () => {
    setL10nApi(createMockL10n());
    render(() => <L10nTab tab={{ ...tab, params: { repoId: "r" } }} />);
    await waitFor(() => expect(screen.getByText("welcome")).toBeTruthy());
    expect(screen.getByText("items")).toBeTruthy();
    expect(document.querySelectorAll("thead th.l10n__lang")).toHaveLength(11);
    const welcome = screen.getByText("welcome").closest("tr")!;
    expect(welcome.querySelectorAll('td[data-state="ok"]')).toHaveLength(1);
    expect(welcome.querySelectorAll('td[data-state="missing"]')).toHaveLength(9);
    expect(welcome.querySelectorAll('td[data-state="placeholder"]')).toHaveLength(1);
    expect(screen.getByText(/dashboard_subtitle/)).toBeTruthy();
    expect(screen.getByText(/19 missing|9 missing/)).toBeTruthy();
  });

  it("drafts into a review list, writes only accepted keys, then re-checks", async () => {
    const api = createMockL10n();
    const applied: unknown[] = [];
    setL10nApi({ ...api, apply: async (repo, edits) => (applied.push(edits), api.apply(repo, edits)) });
    render(() => <L10nTab tab={{ ...tab, params: { repoId: "r" } }} />);
    await waitFor(() => expect(screen.getByText("welcome")).toBeTruthy());
    fireEvent.click(screen.getByText(/Translate missing/));
    await waitFor(() => expect(screen.getByLabelText("Review drafted translations")).toBeTruthy());
    expect(applied).toHaveLength(0);
    // Write is disabled until something is accepted.
    const write = () => screen.getByText(/^Write \d+ accepted/).closest("button")!;
    expect(write().disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Accept de welcome"));
    fireEvent.click(screen.getByLabelText("Reject fr welcome"));
    expect(write().textContent).toBe("Write 1 accepted");
    fireEvent.click(write());
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(applied[0]).toEqual([{ rel: "src/localization/modules/crm/de.json", path: ["welcome"], value: "[de] Welcome back, {{name}}" }]);
    // The accepted line is gone, the rejected one stays visible.
    await waitFor(() => expect(screen.queryByLabelText("Accept de welcome")).toBeNull());
    expect(screen.getByLabelText("Accept fr welcome")).toBeTruthy();
  });

  it("flags an edited draft that lost a placeholder and blocks a blind accept", async () => {
    setL10nApi(createMockL10n());
    render(() => <L10nTab tab={{ ...tab, params: { repoId: "r" } }} />);
    await waitFor(() => expect(screen.getByText("welcome")).toBeTruthy());
    fireEvent.click(screen.getByText(/Translate missing/));
    const box = (await screen.findByLabelText("de text for welcome")) as HTMLTextAreaElement;
    fireEvent.input(box, { target: { value: "Willkommen" } });
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("Accept all valid"));
    expect(screen.getByLabelText("Accept de welcome").getAttribute("aria-pressed")).toBe("false");
  });

  it("shows a refused check as text", async () => {
    setL10nApi({ ...createMockL10n(), analyze: async () => Promise.reject({ code: "readOnly", message: "read-only mode" }) });
    render(() => <L10nTab tab={{ ...tab, params: { repoId: "r" } }} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("read-only"));
  });
});

describe("<ChangeBadge>", () => {
  it("shows the open work of a changed file and nothing for other files", async () => {
    setL10nApi(createMockL10n());
    await refresh("r");
    render(() => (
      <>
        <ChangeBadge repoId="r" path="src/pages/Dashboard.jsx" />
        <ChangeBadge repoId="r" path="src/other.js" />
      </>
    ));
    const badges = document.querySelectorAll(".l10n-badge");
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toBe("19");
    expect(badges[0].getAttribute("title")).toContain("9 missing translations");
  });
});

describe("<L10nSection>", () => {
  it("flips the toggle that loads the extra", async () => {
    setL10nEnabled(false);
    render(() => <L10nSection />);
    const sw = screen.getByLabelText("Enable the localization checker");
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));
    expect(localStorage.getItem("intely.extra.l10n")).toBe("1");
    setL10nEnabled(false);
  });
});

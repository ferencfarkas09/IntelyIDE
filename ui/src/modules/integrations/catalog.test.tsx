import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import type { HappyStatus } from "../../ipc/happy";
import { activeSettingsSection, resetSettings } from "../../platform/settings";
import { currentIntegration, integrations, openIntegration, resetIntegrations } from "../../platform/integrations";
import { resetCommands } from "../../platform/commands";
import { resetOverlays } from "../../platform/overlay";
import { resetStatusItems } from "../../platform/statusbar";
import { resetTabs } from "../../platform/tabs";
import { ipc } from "../../ipc";
import { installDomStubs } from "../../store/testing-u2";
import { disconnectHappyForTest } from "../../store/happyTestKit";
import { register as registerMcp } from "../mcp";
import { register as registerSentry } from "../sentry";
import { happyCardStatus } from "./catalog";
import { register } from "./index";
import IntegrationsSection from "./IntegrationsSection";

installDomStubs();

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const prefs = (enabled: boolean) => ({ enabled, showInStatusBar: true, allowActions: true });
const status = (over: Partial<HappyStatus> = {}, master = true, on: string[] = []): HappyStatus => ({
  config: { master, env: "sandbox", timer: prefs(on.includes("timer")), meet: prefs(on.includes("meet")), chat: prefs(on.includes("chat")), notifications: prefs(on.includes("notifications")), tasks: prefs(on.includes("tasks")) },
  tokenSaved: true,
  providers: [],
  ...over,
});
const user = { id: "u", name: "Teszt Elek", roles: [] };

afterEach(async () => {
  cleanup();
  resetCommands();
  resetOverlays();
  resetSettings();
  resetStatusItems();
  resetTabs();
  resetIntegrations();
  await disconnectHappyForTest();
});

const registerAll = () => {
  register();
  registerMcp();
  registerSentry();
};

describe("the chip on the Happy card", () => {
  it("is calm while the status is loading", () => {
    expect(happyCardStatus(undefined)).toEqual({ tone: "neutral", label: "Loading" });
  });
  it("shows an expired session above everything else", () => {
    expect(happyCardStatus(status({ user, signedOut: { code: "DEVICE_LOGGED_OUT", message: "x", atMs: 1 } }))).toEqual({ tone: "danger", label: "Signed out" });
  });
  it("says so when there is no token", () => {
    expect(happyCardStatus(status({ tokenSaved: false }))).toEqual({ tone: "neutral", label: "Not connected" });
  });
  it("says a token is saved before it has been checked", () => {
    expect(happyCardStatus(status())).toEqual({ tone: "info", label: "Token saved" });
  });
  it("counts the tools that are on, and none when the master switch is off", () => {
    expect(happyCardStatus(status({ user }, true, ["timer", "chat", "tasks"]))).toEqual({ tone: "ok", label: "Connected · 3 on" });
    expect(happyCardStatus(status({ user }, false, ["timer", "chat"]))).toEqual({ tone: "ok", label: "Connected" });
    expect(happyCardStatus(status({ user }, true, []))).toEqual({ tone: "ok", label: "Connected" });
  });
});

describe("<IntegrationsSection> catalog", () => {
  it("lists Happy, MCP, Sentry and the planned DeepPattern, in that order", async () => {
    registerAll();
    render(() => <IntegrationsSection />);
    const rows = await screen.findAllByRole("listitem");
    expect(rows.map((r) => r.querySelector(".intc__name")?.textContent)).toEqual(["Happy", "MCP", "Sentry", "DeepPattern"]);
    expect(integrations().map((i) => i.id)).toEqual(["happy", "mcp", "sentry", "deeppattern"]);
  });

  it("shows a planned integration as a row that opens nothing", async () => {
    registerAll();
    render(() => <IntegrationsSection />);
    const row = (await screen.findByText("DeepPattern")).closest("li")!;
    expect(within(row).getByText("Planned")).toBeTruthy();
    expect(within(row).queryByRole("button")).toBeNull();
    expect(row.querySelector("[data-planned]")).not.toBeNull();
  });

  it("follows the connection of Happy on its card", async () => {
    registerAll();
    render(() => <IntegrationsSection />);
    const card = () => screen.getByRole("button", { name: /^Happy/ });
    await waitFor(() => expect(within(card()).getByText("Not connected")).toBeTruthy());
    await ipc.happy.saveToken(TOKEN);
    await ipc.happy.testConnection();
    // the card reads the status again when the catalog is shown
    cleanup();
    render(() => <IntegrationsSection />);
    await waitFor(() => expect(within(screen.getByRole("button", { name: /^Happy/ })).getByText(/^Connected|Token saved/)).toBeTruthy());
  });

  it("opens the settings of Happy inside the tab, with a way back to the catalog", async () => {
    registerAll();
    render(() => <IntegrationsSection />);
    fireEvent.click(await screen.findByRole("button", { name: /^Happy/ }));
    expect(await screen.findByRole("heading", { name: "Happy" })).toBeTruthy();
    expect(await screen.findByLabelText("Token")).toBeTruthy();
    expect(currentIntegration()?.id).toBe("happy");
    fireEvent.click(screen.getByRole("button", { name: "All integrations" }));
    expect(await screen.findByText("DeepPattern")).toBeTruthy();
    expect(screen.queryByLabelText("Token")).toBeNull();
  });

  it("opens straight on Happy when a gate sends the person there", async () => {
    registerAll();
    openIntegration("happy");
    render(() => <IntegrationsSection />);
    expect(await screen.findByLabelText("Token")).toBeTruthy();
  });

  it("sends the cards of MCP and Sentry to their own sections", async () => {
    registerAll();
    render(() => <IntegrationsSection />);
    fireEvent.click(await screen.findByRole("button", { name: /^MCP/ }));
    expect(activeSettingsSection()?.id).toBe("mcp");
    fireEvent.click(screen.getByRole("button", { name: /^Sentry/ }));
    expect(activeSettingsSection()?.id).toBe("sentry");
  });

  it("shows what a module adds later without a change here", async () => {
    register();
    render(() => <IntegrationsSection />);
    await screen.findByText("Happy");
    expect(screen.queryByText("Sentry")).toBeNull();
    registerSentry();
    expect(await screen.findByText("Sentry")).toBeTruthy();
  });
});

import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../ipc";
import { availableCommands, resetCommands } from "../../platform/commands";
import { overlays, resetOverlays } from "../../platform/overlay";
import { resetSettings, settingsSections } from "../../platform/settings";
import { resetStatusItems, statusItems } from "../../platform/statusbar";
import { applyHappyStatus } from "../../store/happy";
import { installDomStubs } from "../../store/testing-u2";
import { disconnectHappyForTest } from "../../store/happyTestKit";
import { connectNtForTest, disconnectNtForTest } from "../../store/happyNtTestKit";
import { register } from "./index";
import HappyIntegration from "./HappyIntegration";

installDomStubs();

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";

afterEach(async () => {
  cleanup();
  resetCommands();
  resetOverlays();
  resetSettings();
  resetStatusItems();
  vi.restoreAllMocks();
  await disconnectHappyForTest();
});

describe("integrations register()", () => {
  it("registers the Settings section, the watcher overlay, the sign-out notice and a command without any IPC", async () => {
    const calls = [vi.spyOn(ipc.happy, "status"), vi.spyOn(ipc.settings, "get")];
    register();
    expect(settingsSections().map((s) => s.id)).toContain("integrations");
    expect(overlays().map((o) => o.id)).toContain("happy-watch");
    expect(availableCommands().map((c) => c.id)).toContain("integrations.open");
    expect(statusItems("left").map((i) => i.id)).not.toContain("happy-signedout");
    calls.forEach((c) => expect(c).not.toHaveBeenCalled());
  });

  it("shows the notice only after a 401", () => {
    register();
    applyHappyStatus({ config: { master: true, env: "sandbox", timer: { enabled: true, showInStatusBar: true, allowActions: true }, meet: { enabled: false, showInStatusBar: true, allowActions: true }, chat: { enabled: false, showInStatusBar: true, allowActions: true }, notifications: { enabled: false, showInStatusBar: true, allowActions: true }, tasks: { enabled: false, showInStatusBar: true, allowActions: true } }, tokenSaved: true, providers: [], signedOut: { code: "DEVICE_LOGGED_OUT", message: "x", atMs: 1 } });
    expect(statusItems("left").map((i) => i.id)).toContain("happy-signedout");
  });
});

describe("<HappyIntegration>", () => {
  it("walks from no token to connected: the token field validates, saving shows the user and the providers wake up", async () => {
    render(() => <HappyIntegration />);
    expect(await screen.findByText("No token saved. Switched-on integrations wait for one.")).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save token" });
    expect(save.getAttribute("disabled")).not.toBeNull();
    const field = screen.getByLabelText("Token") as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.input(field, { target: { value: "not a token" } });
    expect(save.getAttribute("disabled")).not.toBeNull();

    fireEvent.click(screen.getByRole("switch", { name: "Happy integrations" }));
    fireEvent.click(screen.getByRole("switch", { name: "Time Tracer on or off" }));
    await waitFor(() => expect(screen.getByText("Waiting for token")).toBeTruthy());

    fireEvent.input(field, { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));
    expect(await screen.findByText(/Connected as Teszt Elek/)).toBeTruthy();
    expect((screen.getByLabelText("Token") as HTMLInputElement).value).toBe("");
    await waitFor(() => expect(screen.getByText("Connected")).toBeTruthy());
  });

  it("a setConfig reply that is older than the state already pushed does not hide it (the first poll's 403 can beat the reply)", async () => {
    render(() => <HappyIntegration />);
    await screen.findByText("No token saved. Switched-on integrations wait for one.");
    const base = await ipc.happy.status();
    const withMeet = (state: "probing" | "notPermitted") => ({
      ...base,
      config: { ...base.config, master: true, meet: { ...base.config.meet, enabled: true } },
      providers: base.providers.map((p) => (p.id === "meet" ? { ...p, state } : p)),
    });
    vi.spyOn(ipc.happy, "setConfig").mockResolvedValue(withMeet("probing"));
    vi.spyOn(ipc.happy, "status").mockResolvedValue(withMeet("notPermitted"));
    fireEvent.click(screen.getByRole("switch", { name: "Meet on or off" }));
    await waitFor(() => expect(screen.getByText("Not permitted")).toBeTruthy());
  });

  it("tests the connection and lists what the token may use", async () => {
    await ipc.happy.saveToken(TOKEN);
    render(() => <HappyIntegration />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Test connection" }).getAttribute("disabled")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Teszt Elek", { selector: "dd" })).toBeTruthy();
    expect(screen.getAllByText("Allowed")).toHaveLength(5);
  });

  it("asks for a base URL under Custom and refuses a plain http host", async () => {
    render(() => <HappyIntegration />);
    fireEvent.click(await screen.findByRole("radio", { name: "Custom" }));
    const url = await screen.findByLabelText("Base URL");
    fireEvent.input(url, { target: { value: "http://evil.example.test" } });
    fireEvent.change(url);
    expect(await screen.findByText(/must be https/)).toBeTruthy();
    fireEvent.input(url, { target: { value: "https://happy.example.test" } });
    expect(screen.getByText("The token will be sent to happy.example.test.")).toBeTruthy();
  });

  it("disconnect removes the token", async () => {
    await ipc.happy.saveToken(TOKEN);
    render(() => <HappyIntegration />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Disconnect" }).getAttribute("disabled")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(screen.getByText("No token saved. Switched-on integrations wait for one.")).toBeTruthy());
  });
});

describe("<HappyIntegration> notification categories", () => {
  const radio = (row: string, label: string) => within(screen.getByRole("radiogroup", { name: `${row}: how it reaches you` })).getByRole("radio", { name: label });

  afterEach(async () => {
    cleanup();
    await disconnectNtForTest();
  });

  it("is not there while Notifications is off", async () => {
    render(() => <HappyIntegration />);
    await screen.findByText("Happy tools");
    expect(screen.queryByText("Notification categories")).toBeNull();
  });

  it("lists orders, delivery and invoices first, and changes one category at a time", async () => {
    const stop = await connectNtForTest();
    render(() => <HappyIntegration />);
    await screen.findByText("Notification categories");
    const labels = screen.getAllByRole("radiogroup", { name: /: how it reaches you$/ }).map((g) => g.getAttribute("aria-label"));
    expect(labels.slice(0, 4)).toEqual(["Orders: how it reaches you", "Delivery: how it reaches you", "Invoices: how it reaches you", "Chat: how it reaches you"]);
    expect(radio("Orders", "Alert").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(radio("Orders", "Quiet"));
    await waitFor(() => expect(radio("Orders", "Quiet").getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(radio("Invoices", "Off"));
    await waitFor(() => expect(radio("Invoices", "Off").getAttribute("aria-checked")).toBe("true"));
    expect((await ipc.happy.status()).config.notificationKinds).toEqual({ order: "quiet", invoice: "off" });
    expect(radio("Delivery", "Alert").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(radio("Orders", "Alert"));
    await waitFor(() => expect(radio("Orders", "Alert").getAttribute("aria-checked")).toBe("true"));
    expect((await ipc.happy.status()).config.notificationKinds).toEqual({ invoice: "off" });
    stop();
  });

  it("lists a kind that is set but not known, so that it can be switched back", async () => {
    const stop = await connectNtForTest();
    render(() => <HappyIntegration />);
    await screen.findByText("Notification categories");
    expect(screen.queryByText("Loyalty")).toBeNull();
    await ipc.happy.setConfig({ notificationKind: { kind: "loyalty", mode: "off" } });
    expect(await screen.findByText("Loyalty")).toBeTruthy();
    expect(radio("Loyalty", "Off").getAttribute("aria-checked")).toBe("true");
    // Back to alert is the default, nothing arrived of this kind, so the row goes.
    fireEvent.click(radio("Loyalty", "Alert"));
    await waitFor(() => expect(screen.queryByText("Loyalty")).toBeNull());
    stop();
  });

  it("shows the reason when the hub refuses", async () => {
    const stop = await connectNtForTest();
    render(() => <HappyIntegration />);
    await screen.findByText("Notification categories");
    vi.spyOn(ipc.happy, "setConfig").mockRejectedValueOnce({ code: "tooManyCategories", message: "Too many notification categories are set; turn some back to alert first" });
    fireEvent.click(radio("Orders", "Off"));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/Too many notification categories/)).toBeTruthy();
    expect(radio("Orders", "Alert").getAttribute("aria-checked")).toBe("true");
    stop();
  });
});

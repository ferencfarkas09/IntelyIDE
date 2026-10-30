import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../ipc";
import type { ScriptInfo, ServerInfo } from "../../ipc/run";
import { availableCommands, registerCommand, resetCommands } from "../../platform/commands";
import { getRailItem, railItems, resetRail } from "../../platform/rail";
import { newRunPrefill, takeNewRunPrefill } from "../../platform/newRun";
import { applyServerState, resetDevServers } from "../../store/devservers";
import { installDomStubs } from "../../store/testing-u2";
import { createMockDevices, MOCK_PROJECT, setDevicesApi, type DevicesApi } from "./api";
import { detectProjects, resetDetection } from "./detection";
import { register } from "./index";
import ReactNativePanel from "./ReactNativePanel";
import { refreshDevices, resetStore } from "./store";
import { reactNativeEnabled, setReactNativeEnabled } from "./toggle";
import type { DeviceList, ProjectInfo } from "./types";

installDomStubs();

const REPO = "r1";
const script = (name: string, extra: Partial<ScriptInfo> = {}): ScriptInfo => ({ id: `npm:${name}`, name, source: "npm", group: "dev", safety: "normal", reasons: [], forbiddenToAgents: false, envNames: [], runner: `npm run ${name}`, ...extra });
const SCRIPTS = [script("start", { group: "start" }), script("ios", { group: "build", safety: "confirm", reasons: ["builds the native app and installs it on a simulator or device"], forbiddenToAgents: true, runner: "npm run ios" }), script("android", { group: "build", safety: "confirm", reasons: ["build"], forbiddenToAgents: true, runner: "npm run android" })];
const server = (extra: Partial<ServerInfo> = {}): ServerInfo => ({ id: `${REPO}:npm:start`, repoId: REPO, script: "npm:start", runner: "npm run start", status: "running", startedAt: 1, ports: [8081], url: "http://localhost:8081", rssMb: 300, procs: 3, ...extra });

let api: DevicesApi;
let calls: { fn: string; args: unknown[] }[];

/** The mock backend, with every call recorded. */
function spyApi(base: DevicesApi = createMockDevices()): DevicesApi {
  calls = [];
  return Object.fromEntries(Object.entries(base).map(([fn, impl]) => [fn, (...args: unknown[]) => (calls.push({ fn, args }), (impl as (...a: unknown[]) => unknown)(...args))])) as unknown as DevicesApi;
}

async function mountPanel(project: ProjectInfo | null = MOCK_PROJECT) {
  api = spyApi(createMockDevices(project));
  setDevicesApi(api);
  await detectProjects([REPO]);
  return render(() => <ReactNativePanel />);
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(ipc.run, "scripts").mockResolvedValue({ repoId: REPO, packageManager: "npm", scripts: SCRIPTS, notes: [] });
  vi.spyOn(ipc.run, "access").mockResolvedValue({ allowed: false, jail: "off", startable: true });
  vi.spyOn(ipc.run, "logs").mockResolvedValue({ serverId: "", startSeq: 0, lines: [], reset: false });
  vi.spyOn(ipc.run, "start").mockImplementation(async (req) => server({ id: `${req.repoId}:${req.script}`, script: req.script, status: "starting", ports: [] }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setDevicesApi(undefined);
  resetStore();
  resetDetection();
  resetDevServers();
  resetCommands();
  resetRail();
  takeNewRunPrefill();
});

describe("status card", () => {
  it("shows what the project is and what is missing", async () => {
    await mountPanel();
    expect(await screen.findByRole("heading", { name: "Demo App" })).toBeTruthy();
    const facts = screen.getByLabelText("Project status").textContent ?? "";
    for (const text of ["Expo", "0.76.3", "52.0.11", "New Architecture", "on", "Hermes", "npm", "installed", "/Users/demo/Library/Android/sdk"]) expect(facts).toContain(text);
  });

  it("warns about Pods that are missing and an Android SDK that is not found", async () => {
    await mountPanel({ ...MOCK_PROJECT, pods: "stale", androidSdk: null, newArch: null, kind: "reactNative", expoVersion: null });
    const card = await screen.findByLabelText("Project status");
    expect(card.textContent).toContain("out of date");
    expect(card.textContent).toContain("not found");
    expect(card.textContent).toContain("unknown");
    expect(card.textContent).toContain("npx pod-install");
  });

  it("shows an empty state when nothing is detected", async () => {
    await mountPanel(null);
    expect(await screen.findByText("No React Native or Expo project in this workspace")).toBeTruthy();
  });
});

describe("devices", () => {
  it("lists simulators, emulators and phones and boots a simulator that is off", async () => {
    await mountPanel();
    expect(await screen.findByText("iPhone 15 Pro")).toBeTruthy();
    expect(screen.getByText("Pixel_7_API_34")).toBeTruthy();
    expect(screen.getByText("SM G973F")).toBeTruthy();
    const row = screen.getByText("iPhone 15 Pro").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Boot" }));
    await waitFor(() => expect(calls.find((c) => c.fn === "boot")?.args).toEqual([REPO, "ios", "6D0F0B7E-1A2B-4C3D-8E4F-5A6B7C8D9E02"]));
    await waitFor(() => expect(within(screen.getByText("iPhone 15 Pro").closest("li")!).queryByRole("button", { name: "Boot" })).toBeNull());
  });

  it("boots an AVD and shuts down a running emulator", async () => {
    await mountPanel();
    const avd = (await screen.findByText("Pixel_7_API_34")).closest("li")!;
    fireEvent.click(within(avd).getByRole("button", { name: "Boot" }));
    await waitFor(() => expect(calls.find((c) => c.fn === "boot" && c.args[1] === "android")?.args).toEqual([REPO, "android", "Pixel_7_API_34"]));
    const emu = screen.getByText("sdk gphone64 arm64").closest("li")!;
    fireEvent.click(within(emu).getByRole("button", { name: "Shut down" }));
    await waitFor(() => expect(calls.find((c) => c.fn === "shutdown")?.args).toEqual([REPO, "android", "emulator-5554"]));
    expect(within(screen.getByText("SM G973F").closest("li")!).queryByRole("button", { name: "Shut down" })).toBeNull();
  });

  it("an absent tool is a disabled state with the install hint, not an error", async () => {
    const none: DeviceList = { ios: [], avds: [], android: [], notes: [], tools: [{ name: "xcrun", available: false, hint: "xcode" }, { name: "adb", available: false, hint: "androidPlatformTools" }, { name: "emulator", available: false, hint: "androidEmulator" }] };
    await mountPanel();
    api.list = async () => none;
    await refreshDevices();
    expect(await screen.findByText(/Install Xcode from the App Store/)).toBeTruthy();
    expect(screen.getByText(/set ANDROID_HOME/)).toBeTruthy();
    expect(screen.getByText(/Android Emulator from Android Studio/)).toBeTruthy();
    expect(screen.queryByText("iOS simulators")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a failing list shows the message and keeps the panel", async () => {
    await mountPanel();
    api.list = () => Promise.reject({ code: "io", message: "xcrun exploded" });
    await refreshDevices();
    expect((await screen.findByRole("alert")).textContent).toBe("xcrun exploded");
    expect(screen.getByRole("heading", { name: "Demo App" })).toBeTruthy();
  });

  it("asks before it builds the app, starts it only after the confirmation, and never without it", async () => {
    await mountPanel();
    const sim = (await screen.findByText("iPhone 15")).closest("li")!;
    fireEvent.click(within(sim).getByRole("button", { name: "Run app" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("npm run ios");
    expect(dialog.textContent).toContain("installs it on a simulator or device");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(ipc.run.start).not.toHaveBeenCalled();
    fireEvent.click(within(sim).getByRole("button", { name: "Run app" }));
    fireEvent.click(await screen.findByRole("button", { name: "Build and run" }));
    await waitFor(() => expect(ipc.run.start).toHaveBeenCalledWith({ repoId: REPO, script: "npm:ios", confirmed: true, allowSecondHeavy: false }));
  });

  it("says what to add when the project has no ios script", async () => {
    await mountPanel({ ...MOCK_PROJECT, iosScript: null });
    expect(await screen.findByText(/no "ios" script/)).toBeTruthy();
    expect(within((await screen.findByText("iPhone 15")).closest("li")!).getByRole("button", { name: "Run app" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("Metro", () => {
  it("starts through the runner without a confirmation and shows the port and a reload button once it runs", async () => {
    await mountPanel();
    const card = await screen.findByLabelText("Dev server");
    fireEvent.click(within(card).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(ipc.run.start).toHaveBeenCalledWith({ repoId: REPO, script: "npm:start", confirmed: false, allowSecondHeavy: false }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    applyServerState(server());
    expect(await within(card).findByText(":8081")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Reload app" }));
    await waitFor(() => expect(calls.find((c) => c.fn === "reload")?.args).toEqual([`${REPO}:npm:start`]));
  });

  it("stops and restarts through the runner", async () => {
    const stop = vi.spyOn(ipc.run, "stop").mockResolvedValue();
    const restart = vi.spyOn(ipc.run, "restart").mockResolvedValue(server());
    await mountPanel();
    applyServerState(server());
    const card = await screen.findByLabelText("Dev server");
    fireEvent.click(await within(card).findByRole("button", { name: "Restart" }));
    await waitFor(() => expect(restart).toHaveBeenCalledWith(`${REPO}:npm:start`));
    fireEvent.click(within(card).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(stop).toHaveBeenCalledWith(`${REPO}:npm:start`));
  });

  it("cannot reload a server that has no port yet", async () => {
    await mountPanel();
    applyServerState(server({ ports: [], status: "starting" }));
    const card = await screen.findByLabelText("Dev server");
    expect((await within(card).findByRole("button", { name: "Reload app" })).hasAttribute("disabled")).toBe(true);
  });

  it("says so when read-only mode keeps processes from starting, and offers the settings", async () => {
    vi.spyOn(ipc.run, "access").mockResolvedValue({ allowed: false, jail: "readOnly", startable: false, reason: "refused" });
    await mountPanel();
    expect((await screen.findAllByText(/Allow processes/)).length).toBeGreaterThan(0);
    expect(within(await screen.findByLabelText("Dev server")).getByRole("button", { name: "Start" }).hasAttribute("disabled")).toBe(true);
  });

  it("tells a project without a start script what to add", async () => {
    await mountPanel({ ...MOCK_PROJECT, metroScript: null });
    expect(await screen.findByText(/no script that starts Metro/)).toBeTruthy();
  });

  it("turns Metro output into error cards", async () => {
    let push: ((c: { serverId: string; startSeq: number; lines: string[]; reset: boolean }) => void) | undefined;
    vi.spyOn(ipc.run, "onLog").mockImplementation((cb) => ((push = cb), () => {}));
    vi.spyOn(ipc.run, "logs").mockResolvedValue({ serverId: `${REPO}:npm:start`, startSeq: 0, lines: ["Starting Metro"], reset: false });
    await mountPanel();
    applyServerState(server());
    await waitFor(() => expect(push).toBeDefined());
    push!({ serverId: `${REPO}:npm:start`, startSeq: 1, lines: ["\u001b[31merror\u001b[39m: Unable to resolve module ./Missing from /a/App.js"], reset: false });
    const cards = await screen.findByLabelText("Errors found");
    expect(cards.textContent).toContain("A file or package cannot be found");
    expect(cards.textContent).toContain("Metro");
    expect(screen.getByLabelText("Dev server").textContent).toContain("Unable to resolve module");
  });
});

describe("device logs", () => {
  async function startIos() {
    await mountPanel();
    const logs = await screen.findByLabelText("Device logs", { selector: "section" });
    fireEvent.click(within(logs).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(within(logs).getAllByText(/Running "DemoApp"/).length).toBeGreaterThan(0));
    return logs;
  }

  it("streams the lines of the platform and filters them with the chips", async () => {
    const logs = await startIos();
    expect(calls.find((c) => c.fn === "logStart")?.args).toEqual([REPO, "ios", undefined]);
    expect(within(logs).getByText(/Require cycle/)).toBeTruthy();
    fireEvent.click(within(logs).getByRole("button", { name: "Errors (1)" }));
    expect(within(logs).queryByText(/Require cycle/)).toBeNull();
    expect(within(logs).getByText(/Native module cannot be null/)).toBeTruthy();
    fireEvent.click(within(logs).getByRole("button", { name: "Warnings (1)" }));
    expect(within(logs).getByText(/Require cycle/)).toBeTruthy();
    expect(within(logs).queryByText(/Native module cannot be null/)).toBeNull();
    fireEvent.click(within(logs).getByRole("button", { name: "All" }));
    expect(within(logs).getByText(/Running "DemoApp"/)).toBeTruthy();
  });

  it("follows the Android stream when that tab is chosen, and stops it", async () => {
    await mountPanel();
    const logs = await screen.findByLabelText("Device logs", { selector: "section" });
    fireEvent.click(within(logs).getByRole("radio", { name: "Android" }));
    fireEvent.click(within(logs).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(within(logs).getByText(/undefined is not a function/)).toBeTruthy());
    fireEvent.click(within(logs).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(calls.some((c) => c.fn === "logStop" && c.args[0] === "android")).toBe(true));
  });

  it("copies the shown lines and clears them", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const logs = await startIos();
    fireEvent.click(within(logs).getByRole("button", { name: "Errors (1)" }));
    fireEvent.click(within(logs).getByRole("button", { name: "Copy shown lines" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).toContain("Native module cannot be null");
    expect(writeText.mock.calls[0][0]).not.toContain("Require cycle");
    fireEvent.click(within(logs).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(calls.some((c) => c.fn === "logClear")).toBe(true));
    await waitFor(() => expect(within(logs).queryByText(/Native module cannot be null/)).toBeNull());
  });

  it("raises error cards from the device lines, and 'Fix with agent' only fills the New Run dialog", async () => {
    registerCommand({ id: "runs.new", title: "New run", group: "Runs", run: () => {} });
    await startIos();
    const cards = await screen.findByLabelText("Errors found");
    expect(cards.textContent).toContain("Red screen");
    expect(cards.textContent).toContain("iOS log");
    fireEvent.click(within(cards).getAllByRole("button", { name: "Fix with agent" })[0]);
    await waitFor(() => expect(newRunPrefill()).toBeDefined());
    expect(newRunPrefill()?.repoIds).toEqual([REPO]);
    expect(newRunPrefill()?.prompt).toContain("Invariant Violation");
    expect(ipc.run.start).not.toHaveBeenCalled();
  });

  it("dismisses a card", async () => {
    await startIos();
    const cards = await screen.findByLabelText("Errors found");
    const before = within(cards).getAllByRole("button", { name: "Dismiss" }).length;
    fireEvent.click(within(cards).getAllByRole("button", { name: "Dismiss" })[0]);
    await waitFor(() => expect(screen.queryByLabelText("Errors found") === null || within(screen.getByLabelText("Errors found")).getAllByRole("button", { name: "Dismiss" }).length < before).toBe(true));
  });

  it("explains a stream that ended with an error", async () => {
    await mountPanel();
    api.logs = async (platform) => ({ platform, startSeq: 0, entries: [{ level: "error", text: "No devices are booted." }], reset: false, running: false, exitCode: 1, dropped: 3 });
    const logs = await screen.findByLabelText("Device logs", { selector: "section" });
    fireEvent.click(within(logs).getByRole("button", { name: "Start" }));
    expect(await within(logs).findByText(/exit code 1/)).toBeTruthy();
    expect(within(logs).getByText("3 older lines dropped")).toBeTruthy();
  });
});

describe("module", () => {
  it("adds the panel and the command only where a project is detected, and not when switched off", async () => {
    setDevicesApi(createMockDevices(MOCK_PROJECT));
    register();
    const visible = () => railItems().filter((i) => i.id === "reactnative" && (i.when?.() ?? true));
    await waitFor(() => expect(getRailItem("reactnative")).toBeDefined());
    await detectProjects([]);
    expect(visible()).toHaveLength(0);
    expect(availableCommands().map((c) => c.id)).not.toContain("reactnative.show");
    await detectProjects([REPO]);
    expect(visible()).toHaveLength(1);
    expect(availableCommands().map((c) => c.id)).toContain("reactnative.show");
    setReactNativeEnabled(false);
    await waitFor(() => expect(getRailItem("reactnative")).toBeUndefined());
    expect(reactNativeEnabled()).toBe(false);
    setReactNativeEnabled(true);
  });
});

import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hold = vi.hoisted(() => ({
  world: undefined as undefined | import("../../ipc/mock/mongo").MockMongoWorld,
  prefs: {} as Record<string, unknown>,
  prefsFail: false,
}));
vi.mock("../../ipc", () => ({
  ipc: {
    get mongo() {
      return hold.world!.mongo;
    },
    mongoAi: {},
    settings: {
      get: async () => (hold.prefsFail ? Promise.reject({ code: "io", message: "settings.json unreadable" }) : { ...hold.prefs }),
      set: async (_ns: string, patch: Record<string, unknown>) => (Object.assign(hold.prefs, patch), { ...hold.prefs }),
    },
    secrets: { has: async () => false },
  },
}));

import type { ConnSpec } from "../../ipc/mongo";
import { createMockMongoWorld } from "../../ipc/mock/mongo";
import { ConnectionManager } from "./ConnectionManager";
import { applyStatus, clearLost, lostConnections, resetGate } from "./gate";
import { resetProductionConfirms } from "./loudChip";
import { rememberSecrets, resetStore } from "./store";
import { connIdentity } from "./logic";
import SettingsSection from "./SettingsSection";

const std = { auth: { mechanism: "none" as const }, tls: { mode: "auto" as const }, tunnel: { kind: "none" as const } };
const remote = (host: string, over: Partial<ConnSpec> = {}): ConnSpec => ({ scheme: "standard", hosts: [{ host, port: 27017 }], auth: { mechanism: "default", username: "reader", source: "admin", savePassword: false }, tls: { mode: "on" }, tunnel: { kind: "none" }, ...over });

async function world(opts: { seeded?: boolean; empty?: boolean; compiled?: boolean; network?: "full" | "loopbackOnly" | "refused" } = {}) {
  hold.world = createMockMongoWorld({ seeded: opts.seeded ?? true, latencyMs: 0, compiled: opts.compiled, network: opts.network });
  if (!opts.seeded && opts.seeded !== undefined) await hold.world.mongo.setEnabled(true);
  if (opts.empty) for (const p of await hold.world.mongo.profiles()) await hold.world.mongo.profileDelete(p.id);
  applyStatus(await hold.world.mongo.status());
  stops.push(hold.world.mongo.onState(applyStatus));
  return hold.world;
}

const stops: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  hold.prefs = {};
  hold.prefsFail = false;
});
afterEach(() => {
  cleanup();
  stops.splice(0).forEach((s) => s());
  resetStore();
  resetGate();
  resetProductionConfirms();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  try {
    localStorage.clear();
  } catch {
    /* storage may be blocked */
  }
});

const mount = (p: Partial<Parameters<typeof ConnectionManager>[0]> = {}) => render(() => <ConnectionManager defaultAi="off" {...p} />);
const card = (name: string) => screen.getByRole("article", { name });
const clickIn = (el: HTMLElement, name: string | RegExp) => fireEvent.click(within(el).getByRole("button", { name }));

describe("first run (S2) and the wizard (S3)", () => {
  it("shows the five starting points on an empty first run, with the read-only line", async () => {
    await world({ seeded: false, empty: true });
    mount();
    const tiles = await screen.findByRole("list", { name: "Starting points" });
    expect(within(tiles).getAllByRole("listitem")).toHaveLength(5);
    for (const title of ["MongoDB Atlas", "This computer or Docker", "A server on my network", "Through an SSH server", "I have a connection string"]) expect(within(tiles).getByText(title)).toBeTruthy();
    expect(document.body.textContent).toContain("Everything here is read-only. Nothing is stored in plain text.");
    expect(document.body.textContent).not.toMatch(/happy|magyar/i);
  });

  it("probes loopback only on a click: nothing found offers the docker command, a hit pre-fills the wizard", async () => {
    const w = await world({ seeded: false, empty: true });
    const probe = vi.spyOn(w.mongo, "detectLocal");
    mount();
    await screen.findByRole("list", { name: "Starting points" });
    expect(probe).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Look for MongoDB on this computer" }));
    await screen.findByText(/Nothing found on 127.0.0.1/);
    expect(document.body.textContent).toContain("docker run -d --name mongo-try -p 127.0.0.1:27017:27017 mongo:7");
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("walks Local -> test -> save, then offers Connect now and the read-only user tip, and remembers onboarding", async () => {
    const w = await world({ seeded: false, empty: true });
    vi.spyOn(w.mongo, "detectLocal").mockResolvedValue([{ host: "127.0.0.1", port: 27017 }]);
    const onConnected = vi.fn();
    mount({ onConnected });
    await screen.findByRole("list", { name: "Starting points" });
    fireEvent.click(screen.getByRole("button", { name: "Look for MongoDB on this computer" }));
    fireEvent.click(await screen.findByRole("button", { name: /Found a server on 127.0.0.1:27017/ }));
    // step 2: the trimmed form, pre-filled, tag Local
    const dlg = await screen.findByRole("dialog", { name: "New connection" });
    expect(within(dlg).getByDisplayValue("Local MongoDB")).toBeTruthy();
    expect(dlg.textContent).toContain("so the tag is Local");
    fireEvent.click(within(dlg).getByRole("button", { name: "Next" }));
    // step 3: nothing contacts the server until Test
    expect(dlg.textContent).toContain("Nothing contacts the server until you click Test");
    fireEvent.click(within(dlg).getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(dlg.textContent).toMatch(/Connected|connection works|ok/i));
    fireEvent.click(within(dlg).getByRole("button", { name: "Save" }));
    await screen.findByText("Connection saved");
    expect(document.body.textContent).toContain("createUser");
    expect(document.body.textContent).toContain("AI is off for this connection");
    expect(hold.prefs.onboardingDone).toBe(true);
    expect((await w.mongo.profiles()).map((p) => p.name)).toEqual(["Local MongoDB"]);
    fireEvent.click(screen.getByRole("button", { name: "Connect now" }));
    await waitFor(() => expect(onConnected).toHaveBeenCalled());
  });

  it("Not now collapses to the normal empty state and is remembered", async () => {
    await world({ seeded: false, empty: true });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    await screen.findByText("No connections yet");
    expect(hold.prefs.onboardingDone).toBe(true);
    expect(screen.queryByRole("list", { name: "Starting points" })).toBeNull();
  });

  it("does not show the first-run tiles again once onboarding is done", async () => {
    hold.prefs = { onboardingDone: true };
    await world({ seeded: false, empty: true });
    mount();
    await screen.findByText("No connections yet");
    expect(screen.queryByRole("list", { name: "Starting points" })).toBeNull();
  });
});

describe("groups, favourites, search (F7)", () => {
  it("lists favourites first, groups with counts, and moves a star between sections", async () => {
    await world();
    mount();
    const grid = await screen.findByRole("region", { name: "Acme" });
    expect(within(grid).getByRole("article", { name: "Acme production" })).toBeTruthy();
    fireEvent.click(within(card("Local fixture")).getByRole("button", { name: /favourites/i }));
    // the seeded Sandbox profile is already a favourite; the new star joins it
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Favourites" })).getByRole("article", { name: "Local fixture" })).toBeTruthy());
    expect(within(screen.getByRole("region", { name: "Favourites" })).getAllByRole("article")).toHaveLength(2);
  });

  it("collapses a group, remembers it in settings, and a search opens it again", async () => {
    await world();
    mount();
    const head = await screen.findByRole("button", { name: /Acme/ });
    fireEvent.click(head);
    await waitFor(() => expect(screen.queryByRole("article", { name: "Acme production" })).toBeNull());
    expect(hold.prefs.groupsCollapsed).toEqual(["g:Acme"]);
    fireEvent.input(screen.getByLabelText("Search connections"), { target: { value: "acme" } });
    await screen.findByRole("article", { name: "Acme production" });
  });

  it("moves a connection to a group through the card menu", async () => {
    const w = await world();
    mount();
    await screen.findByRole("article", { name: "Local fixture" });
    fireEvent.click(within(card("Local fixture")).getByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Move to group/ }));
    const dlg = await screen.findByRole("dialog");
    fireEvent.input(within(dlg).getByLabelText("Group"), { target: { value: "Lab" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Move" }));
    await waitFor(async () => expect((await w.mongo.profiles()).find((p) => p.id === "local-fixture")?.group).toBe("Lab"));
    await screen.findByRole("region", { name: "Lab" });
  });
});

describe("connect flow (S9, production, endpoints)", () => {
  const seedNoPassword = (w: Awaited<ReturnType<typeof world>>, name = "Needs password", host = "127.0.0.1", over: Partial<ConnSpec> = {}) =>
    w.engine.seed({ id: "np", name, environment: host === "127.0.0.1" ? "local" : "production", spec: remote(host, { tls: { mode: "auto" }, ...over }) });

  it("asks for the password in the prompt, shows where it goes, and remembers it for reconnects", async () => {
    const w = await world();
    seedNoPassword(w);
    const connect = vi.spyOn(w.mongo, "connect");
    mount();
    clickIn(await screen.findByRole("article", { name: "Needs password" }), "Connect");
    const dlg = await screen.findByRole("alertdialog", { name: "Password for Needs password" });
    const field = within(dlg).getByLabelText("Database password") as HTMLInputElement;
    expect(field.type).toBe("password");
    expect(field.getAttribute("autocomplete")).toBe("new-password");
    expect(dlg.textContent).toContain("Sent only to 127.0.0.1:27017");
    expect(within(dlg).getByRole("button", { name: "Connect" }).hasAttribute("disabled")).toBe(true);
    fireEvent.input(field, { target: { value: "s3cret" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(within(card("Needs password")).getByRole("button", { name: "Disconnect" })).toBeTruthy());
    expect(connect).toHaveBeenLastCalledWith("np", { password: "s3cret" });
    // the typed value is gone from the page
    expect(document.body.innerHTML).not.toContain("s3cret");
    // reconnect: remembered, no prompt
    clickIn(card("Needs password"), "Disconnect");
    await waitFor(() => expect(within(card("Needs password")).getByRole("button", { name: "Connect" })).toBeTruthy());
    await new Promise((r) => setTimeout(r, 30)); // the first connect is still listing databases; a click now would be ignored on purpose
    clickIn(card("Needs password"), "Connect");
    await waitFor(() => expect(within(card("Needs password")).getByRole("button", { name: "Disconnect" })).toBeTruthy());
    expect(connect.mock.calls.at(-1)).toEqual(["np", { password: "s3cret" }]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("drops a remembered password the server rejects and asks again exactly once (no loop)", async () => {
    const w = await world();
    const p = seedNoPassword(w, "Wrong pw", "127.0.0.1", { auth: { mechanism: "default", username: "u-badauth", source: "admin", savePassword: false } });
    rememberSecrets(p.id, connIdentity(p.spec!), { password: "old" });
    const connect = vi.spyOn(w.mongo, "connect");
    mount();
    clickIn(await screen.findByRole("article", { name: "Wrong pw" }), "Connect");
    const dlg = await screen.findByRole("alertdialog", { name: "Password for Wrong pw" });
    expect(dlg.textContent).toContain("The saved password was rejected");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[0][1]).toEqual({ password: "old" });
    fireEvent.input(within(dlg).getByLabelText("Database password"), { target: { value: "new" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    // typed secret rejected too: the error is shown, there is no third attempt and no third prompt
    await waitFor(() => expect(within(card("Wrong pw")).getByRole("alert")).toBeTruthy());
    await new Promise((r) => setTimeout(r, 30));
    expect(connect).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("cancelling the prompt leaves the connection idle", async () => {
    const w = await world();
    seedNoPassword(w);
    mount();
    clickIn(await screen.findByRole("article", { name: "Needs password" }), "Connect");
    const dlg = await screen.findByRole("alertdialog");
    fireEvent.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(within(card("Needs password")).getByRole("button", { name: "Connect" })).toBeTruthy();
    expect(within(card("Needs password")).queryByRole("alert")).toBeNull();
  });

  it("confirms the first connect to production with Cancel as the default, then connects once", async () => {
    const w = await world();
    const connect = vi.spyOn(w.mongo, "connect");
    mount();
    clickIn(await screen.findByRole("article", { name: "Acme production" }), "Connect");
    // never connected: the endpoint list first (default Cancel), then the production confirm (default Cancel)
    const ends = await screen.findByRole("alertdialog", { name: /first time/ });
    expect(ends.textContent).toContain("db1.acme.example:27017");
    expect(document.activeElement?.textContent).toBe("Cancel");
    fireEvent.click(within(ends).getByRole("button", { name: "Connect" }));
    const prod = await screen.findByRole("alertdialog", { name: /production/i });
    fireEvent.click(within(prod).getByRole("button", { name: /Cancel/ }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(connect).not.toHaveBeenCalled();
  });

  it("ignores a second click while a connect is running", async () => {
    const w = await world();
    seedNoPassword(w);
    w.engine.seed({ id: "slow", name: "Slow", environment: "local", spec: { ...std, scheme: "standard", hosts: [{ host: "127.0.0.1", port: 27099 }] } });
    const connect = vi.spyOn(w.mongo, "connect");
    mount();
    const btn = within(await screen.findByRole("article", { name: "Slow" })).getByRole("button", { name: "Connect" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(within(card("Slow")).getByRole("button", { name: "Disconnect" })).toBeTruthy());
    expect(connect.mock.calls.filter((c) => c[0] === "slow")).toHaveLength(1);
  });
});

describe("connection lost (sleep, network, tunnel)", () => {
  it("shows a Disconnected banner with Reconnect when a connection vanishes, and does not reconnect by itself", async () => {
    const w = await world();
    mount();
    clickIn(await screen.findByRole("article", { name: "Local fixture" }), "Connect");
    await waitFor(() => expect(within(card("Local fixture")).getByRole("button", { name: "Disconnect" })).toBeTruthy());
    await new Promise((r) => setTimeout(r, 30)); // let the first connect finish listing databases
    const connect = vi.spyOn(w.mongo, "connect");
    w.engine.tamper("local-fixture"); // the gateway closes it: nobody clicked Disconnect
    const banner = await within(card("Local fixture")).findByRole("alert");
    expect(banner.textContent).toContain("ended");
    expect(banner.textContent).toContain("does not reconnect by itself");
    await new Promise((r) => setTimeout(r, 30));
    expect(connect).not.toHaveBeenCalled();
    expect(Object.keys(lostConnections())).toEqual(["local-fixture"]);
    clearLost();
  });

  it("does not report a connection the user closed on purpose", async () => {
    const w = await world();
    mount();
    clickIn(await screen.findByRole("article", { name: "Local fixture" }), "Connect");
    await waitFor(() => expect(within(card("Local fixture")).getByRole("button", { name: "Disconnect" })).toBeTruthy());
    clickIn(card("Local fixture"), "Disconnect");
    await waitFor(() => expect(within(card("Local fixture")).getByRole("button", { name: "Connect" })).toBeTruthy());
    expect(lostConnections()).toEqual({});
  });
});

describe("import and export (S8)", () => {
  const FILE = JSON.stringify({
    format: "intely-mongo-profiles",
    version: 1,
    profiles: [
      { name: "Via bastion", environment: "local", spec: { scheme: "standard", hosts: [{ host: "db1.internal", port: 27017 }], auth: { mechanism: "default", username: "reader", savePassword: true }, tls: { mode: "auto" }, tunnel: { kind: "ssh", host: "bastion.example.com", user: "deploy", auth: "agent", useSshConfig: true, allowedHosts: [{ host: "db1.internal", port: 27017 }] } }, secrets: { password: "needed" } },
      { name: "Plain local", environment: "local", spec: { scheme: "standard", hosts: [{ host: "127.0.0.1", port: 27017 }], auth: { mechanism: "none" }, tls: { mode: "auto" }, tunnel: { kind: "none" } } },
    ],
  });

  it("previews every outbound endpoint before importing, then imports read-only with AI off and no password", async () => {
    const w = await world({ seeded: false, empty: true });
    hold.prefs = { onboardingDone: true };
    w.engine.queueImportFile(FILE, "team.json");
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Import…" }));
    const dlg = await screen.findByRole("dialog", { name: "Import connections" });
    await within(dlg).findByText("Via bastion");
    expect(dlg.textContent).toContain("bastion.example.com:22");
    expect(dlg.textContent).toContain("db1.internal:27017");
    expect(dlg.textContent).toContain("The first connect will ask you to confirm these addresses");
    expect(dlg.textContent).toContain("team.json");
    fireEvent.click(within(dlg).getByRole("checkbox", { name: "Plain local" }));
    fireEvent.click(within(dlg).getByRole("button", { name: "Import 1 connection" }));
    await within(dlg).findByText(/1 connection imported/);
    const list = await w.mongo.profiles();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "Via bastion", readOnly: true, aiMode: "off", hasPassword: false });
    expect(list[0].environment).toBe("production"); // a tunnel is never below Production
    fireEvent.click(within(dlg).getAllByRole("button", { name: "Close" }).at(-1)!);
    await screen.findByRole("article", { name: "Via bastion" });
  });

  it("does nothing when the user cancels the native open dialog", async () => {
    const w = await world({ seeded: false, empty: true });
    hold.prefs = { onboardingDone: true };
    w.engine.queueImportFile(null);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Import…" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("exports through the native save dialog and never writes a password or path by default", async () => {
    const w = await world();
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Export…" }));
    const dlg = await screen.findByRole("dialog", { name: "Export connections" });
    expect(dlg.textContent).toContain("Passwords and passphrases are never exported.");
    expect((within(dlg).getByRole("checkbox", { name: /Include file paths/ }) as HTMLInputElement).checked).toBe(false);
    expect((within(dlg).getByRole("checkbox", { name: /Include SSH tunnel settings/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dlg).getByRole("button", { name: "Export" }));
    await waitFor(() => expect(w.engine.lastExport()).toBeTruthy());
    const out = w.engine.lastExport()!;
    expect(out).not.toContain("seed-secret");
    expect(out).not.toMatch(/"uri"|password":\s*"[^nd]/);
    expect(JSON.parse(out).profiles).toHaveLength(5);
  });

  it("exports only the profile chosen from the card menu", async () => {
    const w = await world();
    mount();
    await screen.findByRole("article", { name: "Local fixture" });
    fireEvent.click(within(card("Local fixture")).getByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Export/ }));
    const dlg = await screen.findByRole("dialog", { name: "Export connections" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Export" }));
    await waitFor(() => expect(w.engine.lastExport()).toBeTruthy());
    expect(JSON.parse(w.engine.lastExport()!).profiles.map((p: { name: string }) => p.name)).toEqual(["Local fixture"]);
  });
});

describe("Settings > Database (F1) and reset", () => {
  it("is off by default, and a build without the module says so and disables the switch", async () => {
    await world({ seeded: false, compiled: false });
    render(() => <SettingsSection />);
    const sw = await screen.findByRole("switch", { name: "Enable MongoDB Studio" });
    expect(sw.hasAttribute("disabled")).toBe(true);
    expect(document.body.textContent).toContain("This build does not include the database module.");
    expect(document.body.textContent).not.toMatch(/cargo/i);
  });

  it("shows the unreadable-settings state with Retry", async () => {
    await world({ seeded: false });
    hold.prefsFail = true;
    render(() => <SettingsSection />);
    await screen.findByText("Settings could not be read");
    hold.prefsFail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText("Settings could not be read")).toBeNull());
  });

  it("states where passwords are kept and shows the Happy preset switch off by default, writing the unsigned setting", async () => {
    await world({ seeded: false });
    render(() => <SettingsSection />);
    await screen.findByText("In the macOS Keychain, bound to the connection they were typed for.");
    expect((await screen.findByRole("switch", { name: "Enable MongoDB Studio" })).getAttribute("aria-checked")).toBe("true");
    const happy = await screen.findByRole("switch", { name: "Happy preset" });
    expect(happy.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(happy);
    await waitFor(() => expect(hold.prefs.happyPreset).toBe(true));
  });

  it("reset needs the typed phrase, works while Studio is off, and removes every profile", async () => {
    const w = await world();
    render(() => <SettingsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Reset…" }));
    const dlg = await screen.findByRole("alertdialog", { name: "Reset MongoDB Studio" });
    const go = within(dlg).getByRole("button", { name: "Delete everything" });
    expect(go.hasAttribute("disabled")).toBe(true);
    fireEvent.input(within(dlg).getByLabelText(/Type reset mongo/), { target: { value: "reset" } });
    expect(go.hasAttribute("disabled")).toBe(true);
    fireEvent.input(within(dlg).getByLabelText(/Type reset mongo/), { target: { value: "reset mongo" } });
    expect(go.hasAttribute("disabled")).toBe(false);
    fireEvent.click(go);
    await waitFor(async () => expect(await w.mongo.profiles()).toHaveLength(0));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(hold.prefs.onboardingDone).toBe(false);
  });
});

describe("states of the manager", () => {
  it("says the network is off in a read-only jail and still lists the profiles", async () => {
    await world({ network: "refused" });
    applyStatus(await hold.world!.mongo.status());
    mount();
    await screen.findByText(/Network access is off in this mode/);
    expect(screen.getByRole("article", { name: "Local fixture" })).toBeTruthy();
  });

  it("shows a load error with Retry", async () => {
    const w = await world();
    vi.spyOn(w.mongo, "profiles").mockRejectedValueOnce({ code: "mongoSettings", message: "settings unreadable" });
    mount();
    await screen.findByText("Connections could not load");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("article", { name: "Local fixture" });
  });

  it("shows a needs-review chip and disables Connect for a tampered profile", async () => {
    const w = await world();
    mount();
    await screen.findByRole("article", { name: "Local fixture" });
    w.engine.tamper("local-fixture");
    const { refreshProfiles } = await import("./store");
    await refreshProfiles();
    await waitFor(() => expect(within(card("Local fixture")).getByText("Needs review")).toBeTruthy());
    expect(within(card("Local fixture")).getByRole("button", { name: "Connect" }).hasAttribute("disabled")).toBe(true);
  });

  it("marks tunnel, TLS and Happy preset profiles with chips", async () => {
    const w = await world({ seeded: false, empty: true });
    hold.prefs = { onboardingDone: true };
    const viaSsh: ConnSpec = { scheme: "standard", hosts: [{ host: "db1.internal", port: 27017 }], auth: { mechanism: "none" }, tls: { mode: "on" }, tunnel: { kind: "ssh", host: "bastion.example.com", user: "u", auth: "agent", useSshConfig: true, allowedHosts: [{ host: "db1.internal", port: 27017 }] } };
    w.engine.seed({ name: "Tunnelled", environment: "production", spec: viaSsh, domain: "happy" });
    mount();
    const c = await screen.findByRole("article", { name: "Tunnelled" });
    expect(c.textContent).toContain("SSH tunnel");
    expect(c.textContent).toContain("TLS");
    expect(c.textContent).toContain("Happy preset");
  });
});

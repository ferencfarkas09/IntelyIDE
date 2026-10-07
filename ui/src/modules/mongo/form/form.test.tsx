import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hold = vi.hoisted(() => ({ world: undefined as undefined | import("../../../ipc/mock/mongo").MockMongoWorld, picker: undefined as undefined | import("../../../ipc/mock/picker").MockPicker }));
vi.mock("../../../ipc", async () => {
  const { createMockMongoWorld } = await import("../../../ipc/mock/mongo");
  hold.world = createMockMongoWorld({ seeded: true, latencyMs: 0 });
  const { createMockPicker } = await import("../../../ipc/mock/picker");
  hold.picker = createMockPicker({ delayScale: 0, native: true });
  return { ipc: { picker: hold.picker, mongo: hold.world.mongo, mongoAi: hold.world.ai, settings: { get: async () => ({}), set: async () => ({}) }, secrets: { has: async () => false } } };
});

import { ipc } from "../../../ipc";
import { ConnectionForm } from "../ConnectionForm";
import { refreshProfiles } from "../store";
import type { ProfileView } from "../../../ipc/mongo";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    /* jsdom storage may be blocked */
  }
});

const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const type = (label: string, value: string) => fireEvent.input(input(label), { target: { value } });
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const tab = (name: string) => fireEvent.click(screen.getByRole("tab", { name: new RegExp(`^${name}`) }));
const off = (b: HTMLElement) => (b as HTMLButtonElement).disabled || b.getAttribute("aria-disabled") === "true";
const paste = (el: HTMLElement, text: string) => fireEvent.paste(el, { clipboardData: { getData: () => text } });

describe("ConnectionForm structure and accessibility", () => {
  it("names every colour swatch in words, never by its hex code", () => {
    render(() => <ConnectionForm defaultAi="off" onClose={() => undefined} />);
    const names = screen.getAllByRole("radio").filter((r) => r.classList.contains("mgf-swatch")).map((r) => r.getAttribute("aria-label"));
    expect(names).toHaveLength(7);
    for (const n of names) expect(n).toMatch(/^[A-Za-z]+$/);
    expect(new Set(names).size).toBe(7);
  });

  it("has the seven tabs as a tablist, moves with the arrow keys and keeps every panel mounted", () => {
    render(() => <ConnectionForm defaultAi="off" onClose={() => undefined} />);
    const names = screen.getAllByRole("tab").map((x) => x.textContent?.trim());
    expect(names).toEqual(["Connection", "Authentication", "TLS", "Tunnel", "Advanced", "Safety", "AI"]);
    const first = screen.getByRole("tab", { name: /^Connection/ });
    expect(first.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /^Authentication/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getByRole("tab", { name: /^Authentication/ }), { key: "End" });
    expect(screen.getByRole("tab", { name: "AI" }).getAttribute("aria-selected")).toBe("true");
    // hidden panels stay in the DOM so what was typed survives a tab change
    expect(document.querySelectorAll('[role="tabpanel"]').length).toBe(7);
  });

  it("offers no control to skip only the host name check, and relaxing is a separate, warned switch", () => {
    render(() => <ConnectionForm defaultAi="off" initial={{ spec: { scheme: "standard", hosts: [{ host: "127.0.0.1", port: 27017 }], auth: { mechanism: "none" } }, environment: "local" }} onClose={() => undefined} />);
    tab("TLS");
    expect(screen.queryByRole("switch", { name: /host ?name/i })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /host ?name/i })).toBeNull();
    expect(document.body.textContent).toMatch(/no option to skip only the host name check/i);
    expect(screen.getByRole("switch", { name: "Skip all certificate checks" })).toBeTruthy();
  });

  it("password fields are write-only: no autofill, no spellcheck, a reveal toggle, and they name the destination", () => {
    render(() => <ConnectionForm defaultAi="off" initial={{ spec: { scheme: "standard", hosts: [{ host: "db.example.com", port: 27017 }], auth: { mechanism: "default", username: "reader" }, tls: { mode: "on" } } }} onClose={() => undefined} />);
    tab("Authentication");
    const pw = input("Password");
    expect(pw.type).toBe("password");
    expect(pw.getAttribute("autocomplete")).toBe("new-password");
    expect(pw.getAttribute("spellcheck")).toBe("false");
    const dest = document.getElementById(`${pw.id}-dest`)!;
    expect(dest.textContent).toContain("db.example.com:27017");
    expect(dest.textContent).toContain("Default (SCRAM)");
    expect(dest.textContent).toMatch(/TLS: on/);
    const reveal = screen.getAllByRole("button", { name: "Show the typed text" })[0];
    expect(reveal.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(reveal);
    expect(pw.type).toBe("text");
    expect(screen.getAllByRole("button", { name: "Hide the typed text" })[0].getAttribute("aria-pressed")).toBe("true");
  });

  it("host, path and option fields are left-to-right monospace even in an RTL page", () => {
    render(() => <ConnectionForm defaultAi="off" onClose={() => undefined} />);
    for (const label of ["Host", "Default database", "CA file (PEM)"]) {
      const el = input(label);
      expect(el.getAttribute("dir")).toBe("ltr");
      expect(el.className).toContain("mgf-code");
    }
  });

  it("refuses a password over a connection without TLS to a remote host, inline, and blocks Save", async () => {
    const save = vi.spyOn(ipc.mongo, "profileSave");
    render(() => <ConnectionForm defaultAi="off" initial={{ spec: { scheme: "standard", hosts: [{ host: "db.example.com", port: 27017 }], auth: { mechanism: "plain", username: "u" }, tls: { mode: "off" } } }} onClose={() => undefined} />);
    type("Name", "Plain");
    click("Save");
    await waitFor(() => expect(document.body.textContent).toMatch(/refused\. Turn TLS on/));
    expect(save).not.toHaveBeenCalled();
    // the summary links to the field
    expect(screen.getByRole("alert", { name: /problem/ })).toBeTruthy();
  });
});

describe("ConnectionForm: connection string", () => {
  it("fills the fields from a pasted string, keeps the password out of the page and clears the pasted text", async () => {
    render(() => <ConnectionForm defaultAi="off" onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("radio", { name: "Connection string" }));
    const box = input("Connection string");
    expect(box.type).toBe("password");
    paste(box, "mongodb+srv://reader:S3cr%40t@cluster0.abcde.mongodb.net/shop?retryWrites=true&w=majority");
    await waitFor(() => expect(box.value).toBe(""));
    await waitFor(() => expect(document.body.textContent).toContain("reader:***@"));
    expect(document.body.textContent).not.toContain("S3cr");
    fireEvent.click(screen.getByRole("radio", { name: "Fields" }));
    expect((input("Host") as HTMLInputElement).value).toBe("cluster0.abcde.mongodb.net");
    expect(input("Default database").value).toBe("shop");
    tab("Authentication");
    expect(input("User name").value).toBe("reader");
    expect(input("Password").value).toBe("");
    expect(document.body.textContent).toContain("From the pasted string");
    // a normal Atlas paste shows no warning wall: the read-only options are collapsed
    expect(document.querySelector(".mgf-notes")).toBeNull();
  });

  it("round-trips: the masked rendering of the filled form parses back to the same hosts and user", async () => {
    render(() => <ConnectionForm defaultAi="off" onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("radio", { name: "Connection string" }));
    paste(input("Connection string"), "mongodb://app:pw@a.example.com:27017,b.example.com:27018/orders?replicaSet=rs0");
    await waitFor(() => expect(document.body.textContent).toContain("app:***@a.example.com:27017,b.example.com:27018"));
    const masked = document.querySelector<HTMLElement>(".mgf-masked__value")!.textContent!;
    const again = await ipc.mongo.uriParse(masked.replace("***", "x"));
    expect(again.spec.hosts?.map((h) => `${h.host}:${h.port}`)).toEqual(["a.example.com:27017", "b.example.com:27018"]);
    expect(again.spec.auth?.username).toBe("app");
    expect(again.spec.topology?.replicaSet).toBe("rs0");
  });

  it("an Atlas placeholder password moves focus to the password field and says so", async () => {
    render(() => <ConnectionForm defaultAi="off" onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("radio", { name: "Connection string" }));
    paste(input("Connection string"), "mongodb+srv://reader:<password>@cluster0.abcde.mongodb.net/");
    await waitFor(() => expect(document.activeElement?.id).toBe("mgf-auth-password"));
    expect(screen.getByRole("tab", { name: /^Authentication/ }).getAttribute("aria-selected")).toBe("true");
    expect(input("Password").value).toBe("");
  });

  it("lists unsupported options with the reason instead of dropping them silently", async () => {
    render(() => <ConnectionForm defaultAi="off" onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("radio", { name: "Connection string" }));
    paste(input("Connection string"), "mongodb://a.example.com/?authMechanism=MONGODB-AWS&proxyHost=p.example.com&tlsAllowInvalidHostnames=true");
    await waitFor(() => expect(document.querySelector(".mgf-notes")).not.toBeNull());
    expect(document.querySelector(".mgf-notes")!.textContent).toMatch(/proxyHost/);
    tab("Advanced");
    expect(document.querySelector(".mgf-ignored")!.textContent).toMatch(/authMechanism|MONGODB-AWS/);
  });

  it("text that is not a MongoDB string is refused with a hint and nothing is filled", async () => {
    render(() => <ConnectionForm defaultAi="off" onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("radio", { name: "Connection string" }));
    type("Connection string", "https://example.com");
    click("Fill the form");
    await waitFor(() => expect(document.body.textContent).toMatch(/starts with mongodb:\/\//));
  });
});

describe("ConnectionForm: save", () => {
  it("sends spec instead of uri, the typed password once, read-only, and forgets the password afterwards", async () => {
    const save = vi.spyOn(ipc.mongo, "profileSave");
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(() => <ConnectionForm defaultAi="off" initial={{ spec: { scheme: "standard", hosts: [{ host: "db.example.com", port: 27017 }], auth: { mechanism: "default", username: "reader" }, tls: { mode: "on" } } }} onClose={onClose} onSaved={onSaved} />);
    type("Name", "Shop");
    tab("Authentication");
    type("Password", "CANARY-pw-1");
    click("Save");
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(save).toHaveBeenCalledTimes(1);
    const sent = save.mock.calls[0][0];
    expect(sent).toMatchObject({ name: "Shop", environment: "production", readOnly: true, password: "CANARY-pw-1", aiMode: "off" });
    expect(sent.uri).toBeUndefined();
    expect(sent.spec?.hosts).toEqual([{ host: "db.example.com", port: 27017 }]);
    expect(JSON.stringify(onSaved.mock.calls[0][0])).not.toContain("CANARY");
    expect(onClose).toHaveBeenCalled();
    expect(input("Password").value).toBe("");
  });

  it("needs the typed connection name before AI can be turned on, and only then enables the save", async () => {
    const save = vi.spyOn(ipc.mongo, "profileSave");
    render(() => <ConnectionForm defaultAi="off" initial={{ spec: { scheme: "standard", hosts: [{ host: "127.0.0.1", port: 27017 }], auth: { mechanism: "none" } }, environment: "local" }} onClose={() => undefined} onSaved={() => undefined} />);
    type("Name", "My fixture");
    tab("AI");
    fireEvent.click(screen.getByRole("radio", { name: /P1 · Schema only/ }));
    expect(screen.getByLabelText("Type the connection name to confirm")).toBeTruthy();
    click("Save");
    await waitFor(() => expect(document.activeElement?.id).toBe("mgf-confirm"));
    expect(save).not.toHaveBeenCalled();
    type("Type the connection name to confirm", "My fixture");
    click("Save");
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]).toMatchObject({ aiMode: "schemaOnly", confirm: "My fixture" });
  });

  it("keeps secrets out of localStorage, sessionStorage and the URL", async () => {
    render(() => <ConnectionForm defaultAi="off" initial={{ spec: { scheme: "standard", hosts: [{ host: "db.example.com", port: 27017 }], auth: { mechanism: "default", username: "reader" } } }} onClose={() => undefined} onSaved={() => undefined} />);
    type("Name", "Shop");
    tab("Authentication");
    type("Password", "CANARY-pw-2");
    click("Test connection");
    await waitFor(() => expect(document.querySelector(".mgs")).not.toBeNull());
    const dump = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href;
    expect(dump).not.toContain("CANARY");
    expect(dump).not.toContain("db.example.com");
  });

  it("a saved profile shows Saved and Forget, and a changed host warns that the secret will be dropped", async () => {
    await refreshProfiles();
    const prod = (await ipc.mongo.profiles()).find((p) => p.id === "production") as ProfileView;
    render(() => <ConnectionForm defaultAi="off" profile={prod} onClose={() => undefined} />);
    tab("Authentication");
    expect(document.body.textContent).toContain("Saved in the Keychain");
    expect(screen.getByRole("button", { name: "Forget" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/saved secrets of this connection are removed/);
    fireEvent.input(input("Host"), { target: { value: "other.example.com" } });
    await waitFor(() => expect(document.body.textContent).toMatch(/saved secrets are removed when you save/));
  });
});

describe("ConnectionForm: test connection", () => {
  const open = () =>
    render(() => <ConnectionForm defaultAi="off" initial={{ spec: { scheme: "standard", hosts: [{ host: "db.example.com", port: 27017 }], auth: { mechanism: "none" } } }} onClose={() => undefined} />);

  it("runs the staged test and shows the steps and the role chip on success", async () => {
    open();
    type("Name", "Shop");
    click("Test connection");
    await waitFor(() => expect(screen.getByText(/Connected in|Verbunden|Connection OK/i)).toBeTruthy(), { timeout: 3000 });
    expect(document.querySelector(".mgs")).not.toBeNull();
    expect(document.querySelectorAll(".mgs-step").length).toBeGreaterThanOrEqual(5);
  });

  it("shows the diagnosis of a failure with the failed step, and a retry", async () => {
    render(() => <ConnectionForm defaultAi="off" initial={{ spec: { scheme: "standard", hosts: [{ host: "inject-net-timeout.example.com", port: 27017 }], auth: { mechanism: "none" } } }} onClose={() => undefined} />);
    type("Name", "Slow");
    click("Test connection");
    await waitFor(() => expect(document.querySelector(".mgd")).not.toBeNull(), { timeout: 3000 });
    expect(document.querySelector(".mgd")!.getAttribute("data-code")).toBe("net.timeout");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("asks for the missing password instead of failing silently and moves focus to the field", async () => {
    render(() => <ConnectionForm defaultAi="off" initial={{ spec: { scheme: "standard", hosts: [{ host: "db.example.com", port: 27017 }], auth: { mechanism: "default", username: "reader", savePassword: false } } }} onClose={() => undefined} />);
    type("Name", "NoPw");
    click("Test connection");
    await waitFor(() => expect(document.body.textContent).toMatch(/password is needed/i));
    await waitFor(() => expect(document.activeElement?.id).toBe("mgf-auth-password"));
  });

  it("needs the typed name before a test may send credentials over relaxed TLS", async () => {
    render(() => <ConnectionForm defaultAi="off" initial={{ spec: { scheme: "standard", hosts: [{ host: "127.0.0.1", port: 27017 }], auth: { mechanism: "none" } }, environment: "local" }} onClose={() => undefined} />);
    type("Name", "Lab");
    tab("TLS");
    fireEvent.click(screen.getByRole("switch", { name: "Skip all certificate checks" }));
    await waitFor(() => expect(off(screen.getByRole("button", { name: "Test connection" }))).toBe(true));
    type("Type the connection name to confirm", "Lab");
    await waitFor(() => expect(off(screen.getByRole("button", { name: "Test connection" }))).toBe(false));
  });

  it("does not offer to skip certificate checks at the production level", () => {
    open();
    tab("TLS");
    expect(screen.queryByRole("switch", { name: "Skip all certificate checks" })).toBeNull();
    expect(document.body.textContent).toMatch(/Not available at the production level/);
  });
});

describe("ConnectionForm: tunnel", () => {
  const ssh = (host = "bastion.example.com") => ({ scheme: "standard" as const, hosts: [{ host: "db.internal", port: 27017 }], auth: { mechanism: "none" as const }, tunnel: { kind: "ssh" as const, host, user: "me", auth: "agent" as const, useSshConfig: true, allowedHosts: [] } });

  it("the SSH tab asks for the bastion, lists allowed hosts and says that a tunnel is production-level", () => {
    render(() => <ConnectionForm defaultAi="off" initial={{ spec: ssh() }} onClose={() => undefined} />);
    tab("Tunnel");
    expect(input("SSH host or alias").value).toBe("bastion.example.com");
    expect(document.body.textContent).toMatch(/makes the connection production-level/);
    expect(document.body.textContent).toMatch(/Put ProxyJump in ~\/\.ssh\/config/);
    click("Use the database hosts");
    expect((input("Allowed host 1") as HTMLInputElement).value).toBe("db.internal:27017");
  });

  it("checks the host key and offers Trust for an unknown key, then trusts only the shown fingerprint", async () => {
    const trust = vi.spyOn(ipc.mongo, "sshTrust");
    render(() => <ConnectionForm defaultAi="off" initial={{ spec: ssh("inject-tunnel-hostkeyunknown.example.com") }} onClose={() => undefined} />);
    tab("Tunnel");
    click("Check host key");
    const trustBtn = await screen.findByRole("button", { name: /Trust/ });
    expect(document.body.textContent).toMatch(/SHA256:/);
    fireEvent.click(trustBtn);
    await waitFor(() => expect(trust).toHaveBeenCalledTimes(1));
    expect(trust.mock.calls[0][2]).toMatch(/^SHA256:/);
  });

  it("an unscannable bastion gets the manual fallback, not a trust button", async () => {
    render(() => <ConnectionForm defaultAi="off" initial={{ spec: ssh("inject-tunnel-hostkeyunscannable.example.com") }} onClose={() => undefined} />);
    tab("Tunnel");
    click("Check host key");
    await waitFor(() => expect(document.body.textContent).toMatch(/ssh inject-tunnel-hostkeyunscannable/));
    expect(screen.queryByRole("button", { name: /^Trust/ })).toBeNull();
  });

  it("the tunnel makes the level production and the typed host is the tunnel host", async () => {
    render(() => <ConnectionForm defaultAi="off" initial={{ spec: { ...ssh(), hosts: [{ host: "127.0.0.1", port: 27017 }] }, environment: "sandbox" }} onClose={() => undefined} />);
    tab("Safety");
    expect(document.body.textContent).toMatch(/Every tunnel counts as production-level/);
    expect(input("Treat as non-production").placeholder).toBe("bastion.example.com");
  });
});

describe("ConnectionForm: legacy profile", () => {
  it("shows the convert banner, hides the fields, and converts on request without saving anything", async () => {
    const old = hold.world!.engine.seedLegacy("Old string", "mongodb://old:pw@legacy.example.com:27017/app?retryWrites=true") as ProfileView;
    await refreshProfiles();
    expect(old.legacyUri).toBe(true);
    const save = vi.spyOn(ipc.mongo, "profileSave");
    render(() => <ConnectionForm defaultAi="off" profile={old} onClose={() => undefined} />);
    expect(document.body.textContent).toMatch(/Saved as a connection string/);
    expect(screen.queryByLabelText("Host")).toBeNull();
    click("Convert to fields");
    await waitFor(() => expect(screen.getByLabelText("Host")).toBeTruthy());
    expect((screen.getByLabelText("Host") as HTMLInputElement).value).toBe("legacy.example.com");
    expect(save).not.toHaveBeenCalled();
  });
});

describe("Browse buttons on the file fields (path picker)", () => {
  const browse = (field: string) => screen.getByRole("button", { name: `Browse for ${field}` });

  it("fills the CA file with the canonical path of the chosen file, and typing still works", async () => {
    const { PathPickerHost } = await import("../../../platform/pathpicker");
    render(() => (
      <>
        <ConnectionForm defaultAi="off" onClose={() => undefined} />
        <PathPickerHost />
      </>
    ));
    tab("TLS");
    type("CA file (PEM)", "/typed/ca.pem");
    expect(input("CA file (PEM)").value).toBe("/typed/ca.pem");
    hold.picker!.script({ paths: ["/Users/example/certs/ca.pem"] });
    fireEvent.click(browse("CA file (PEM)"));
    fireEvent.click(await screen.findByRole("button", { name: "Choose in Finder..." }));
    await waitFor(() => expect(input("CA file (PEM)").value).toBe("/Users/example/certs/ca.pem"));
  });

  it("leaves the field alone when the dialog is cancelled and offers the other two file fields", async () => {
    const { PathPickerHost } = await import("../../../platform/pathpicker");
    render(() => (
      <>
        <ConnectionForm defaultAi="off" onClose={() => undefined} />
        <PathPickerHost />
      </>
    ));
    tab("TLS");
    type("Client certificate and key (PEM)", "/typed/client.pem");
    expect(browse("Client certificate and key (PEM)")).toBeTruthy();
    fireEvent.click(browse("Client certificate and key (PEM)"));
    fireEvent.click(await screen.findByRole("button", { name: "Choose in Finder..." }));
    const picker = await screen.findByRole("dialog", { name: /^Browse for/ });
    fireEvent.click(within(picker).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /^Browse for/ })).toBeNull());
    expect(input("Client certificate and key (PEM)").value).toBe("/typed/client.pem");
  });
});

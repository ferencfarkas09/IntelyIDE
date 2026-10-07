import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hold = vi.hoisted(() => ({ profiles: [] as unknown[], open: [] as { id: string }[] }));
vi.mock("./store", () => ({ profiles: () => hold.profiles }));
vi.mock("./gate", () => ({ studioSnapshot: () => ({ connections: hold.open }) }));

import type { ProfileView } from "../../ipc/mongo";
import { createProductionGate, loudness, LoudChip, ProductionBar, resetProductionConfirms, TlsChips, WriterBanner, type LoudProfile } from "./loudChip";

const prof = (o: Partial<ProfileView> & { hosts?: string[] } = {}): ProfileView & LoudProfile => {
  const { hosts, ...rest } = o;
  return {
    id: "p1", name: "Acme", environment: "local", color: "", readOnly: true, aiMode: "off", tenantLock: null, levelOverride: false, host: "127.0.0.1:27017", hasUri: true,
    hostLevel: "local", effectiveLevel: "local", readPreference: "primaryPreferred", maxTimeMs: 15000, legacyUri: false, needsReview: false,
    hasPassword: false, hasKeyPassword: false, hasSshSecret: false, hasProxyPassword: false, favorite: false, tlsRelax: "none", uriMasked: "",
    spec: { hosts: (hosts ?? ["127.0.0.1"]).map((h) => ({ host: h, port: 27017 })), tls: { mode: "auto" }, tunnel: { kind: "none" } },
    ...rest,
  } as unknown as ProfileView & LoudProfile;
};

beforeEach(() => {
  hold.profiles = [];
  hold.open = [];
  resetProductionConfirms();
});
afterEach(cleanup);

describe("loudness", () => {
  it("is quiet for a plain local connection", () => {
    expect(loudness(prof())).toMatchObject({ production: false, reason: undefined, plainTls: false, relaxed: false });
  });
  it("explains why it is production: tag, host rule, tunnel", () => {
    expect(loudness(prof({ environment: "production" })).reason).toBe("tag");
    expect(loudness(prof({ effectiveLevel: "productionLevel", host: "db.example.com" })).reason).toBe("host");
    expect(loudness(prof({ effectiveLevel: "productionLevel", spec: { hosts: [{ host: "127.0.0.1" }], tunnel: { kind: "socks5", host: "127.0.0.1", port: 1080 } } as never })).reason).toBe("tunnel");
  });
  it("flags plain TLS only for remote hosts, and relaxed certificate checks", () => {
    expect(loudness(prof({ spec: { hosts: [{ host: "127.0.0.1" }], tls: { mode: "off" } } as never })).plainTls).toBe(false);
    expect(loudness(prof({ spec: { hosts: [{ host: "db.example.com" }], tls: { mode: "off" } } as never })).plainTls).toBe(true);
    expect(loudness(prof({ tlsRelax: "certificates" }))).toMatchObject({ relaxed: true, tls: "relaxed" });
  });
});

describe("production bar", () => {
  it("is words plus an icon, role=status, with the host", () => {
    render(() => <ProductionBar profile={prof({ environment: "production", host: "db.example.com:27017" })} />);
    const bar = screen.getByRole("status");
    expect(bar.textContent).toContain("PRODUCTION");
    expect(bar.textContent).toContain("read-only");
    expect(bar.textContent).toContain("db.example.com:27017");
    expect(bar.querySelector("svg")).toBeTruthy();
    expect(bar.getAttribute("data-loud")).toBe("production");
  });
  it("renders for a production-level host even when the tag says Local", () => {
    render(() => <ProductionBar profile={prof({ effectiveLevel: "productionLevel", host: "db.example.com" })} />);
    expect(screen.getByRole("status").getAttribute("title")).toMatch(/not on this machine/);
  });
  it("renders nothing for a local connection", () => {
    render(() => <ProductionBar profile={prof()} />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("tls chips", () => {
  it("shows the plain-TLS warning with text", () => {
    render(() => <TlsChips profile={prof({ spec: { hosts: [{ host: "db.example.com" }], tls: { mode: "off" } } as never })} />);
    expect(screen.getByText("Unencrypted")).toBeTruthy();
    expect(screen.queryByText("Certificate checks relaxed")).toBeNull();
  });
  it("shows the relaxed chip", () => {
    render(() => <TlsChips profile={prof({ tlsRelax: "certificates" })} />);
    expect(screen.getByText("Certificate checks relaxed")).toBeTruthy();
  });
  it("shows nothing when TLS is fine", () => {
    const { container } = render(() => <TlsChips profile={prof({ environment: "production" })} />);
    expect(container.textContent).toBe("");
  });
});

describe("writer banner", () => {
  it("says in words that the account can write", () => {
    render(() => <WriterBanner role={{ role: "canWrite", actions: ["insert", "update"], noAuth: false }} />);
    const a = screen.getByRole("alert");
    expect(a.textContent).toContain("This account can change data.");
    expect(a.textContent).toContain("insert, update");
  });
  it("has its own wording for a server without sign-in", () => {
    render(() => <WriterBanner role={{ role: "canWrite", actions: [], noAuth: true }} />);
    expect(screen.getByRole("alert").textContent).toContain("needs no sign-in");
  });
  it("is absent for a read-only user and while unknown", () => {
    const a = render(() => <WriterBanner role={{ role: "readOnly" }} />);
    expect(a.container.textContent).toBe("");
    const b = render(() => <WriterBanner role={undefined} />);
    expect(b.container.textContent).toBe("");
  });
});

describe("title-bar chip", () => {
  it("shows while a production connection is open, with a count in its label", () => {
    hold.profiles = [prof({ id: "a", environment: "production" }), prof({ id: "b" })];
    hold.open = [{ id: "a" }, { id: "b" }];
    render(() => <LoudChip />);
    const c = screen.getByRole("status");
    expect(c.textContent).toContain("PRODUCTION");
    expect(c.getAttribute("aria-label")).toBe("1 production connection open");
  });
  it("is absent when only local connections are open or none", () => {
    hold.profiles = [prof({ id: "b" })];
    hold.open = [{ id: "b" }];
    const { container } = render(() => <LoudChip />);
    expect(container.textContent).toBe("");
  });
  it("becomes a button when given a click handler", () => {
    hold.profiles = [prof({ id: "a", environment: "production" })];
    hold.open = [{ id: "a" }];
    const onClick = vi.fn();
    render(() => <LoudChip onClick={onClick} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalled();
  });
});

describe("production connect confirmation", () => {
  function Host(props: { p: ProfileView; out: (g: ReturnType<typeof createProductionGate>) => void }) {
    const g = createProductionGate();
    props.out(g);
    return <>{g.dialog()}</>;
  }
  const setup = (p: ProfileView) => {
    let g!: ReturnType<typeof createProductionGate>;
    render(() => <Host p={p} out={(x) => (g = x)} />);
    return g;
  };

  it("lets a local profile through at once", async () => {
    const g = setup(prof());
    await expect(g.guard(prof())).resolves.toBe(true);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
  it("asks for production with Cancel focused, and Cancel refuses", async () => {
    const p = prof({ environment: "production", host: "db.example.com:27017" });
    const g = setup(p);
    const answer = g.guard(p);
    const dlg = await screen.findByRole("alertdialog");
    expect(dlg.textContent).toContain("db.example.com:27017");
    expect(dlg.textContent).toContain("Read-only");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Cancel"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(answer).resolves.toBe(false);
  });
  it("asks once per session: Connect is remembered, a second guard passes without a dialog", async () => {
    const p = prof({ environment: "production" });
    const g = setup(p);
    const first = g.guard(p);
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await expect(first).resolves.toBe(true);
    await expect(g.guard(p)).resolves.toBe(true);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
  it("Escape refuses and asks again next time", async () => {
    const p = prof({ environment: "production" });
    const g = setup(p);
    const first = g.guard(p);
    await screen.findByRole("alertdialog");
    fireEvent.keyDown(document, { key: "Escape" });
    await expect(first).resolves.toBe(false);
    void g.guard(p);
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
  });
  it("shows the TLS state in the dialog", async () => {
    const p = prof({ environment: "production", tlsRelax: "certificates" });
    const g = setup(p);
    void g.guard(p);
    const dlg = await screen.findByRole("alertdialog");
    expect(dlg.textContent).toContain("certificates not checked");
  });
});

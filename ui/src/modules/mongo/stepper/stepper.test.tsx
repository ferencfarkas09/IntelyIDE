import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../../../i18n/locales/en/mongoDiag.json";
import hu from "../../../i18n/locales/hu/mongoDiag.json";
import type { Diagnosis, HostKeyView, TestReport, TestStep } from "../../../ipc/mongo";
import rustDiagnose from "../../../../../crates/mongo/src/diagnose.rs?raw";
import { AllowHostsDialog } from "./AllowHostsDialog";
import { DiagnosisView } from "./DiagnosisView";
import { HostKeyDialog } from "./HostKeyDialog";
import { TestStepper } from "./TestStepper";
import { allowProblem, ATLAS_HINTS, DIAG_CODES, DIAG_FIXES, diagCodeOf, diagParams, fingerprintGroups, forgetConfirmed, hostKeyMode, manualSshCommand, overall, visibleSteps, warningKey } from "./logic";

afterEach(cleanup);

const step = (id: TestStep["id"], state: TestStep["state"], ms = 0): TestStep => ({ id, state, ms });
const diag = (code: string, extra: Partial<Diagnosis> = {}): Diagnosis => ({ class: "other", code, params: [], detail: "raw detail", retryable: false, ...extra });
const view = (status: HostKeyView["status"] = "unknown"): HostKeyView => ({ host: "bastion.example.com", port: 22, keyType: "ssh-ed25519", fingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG", status });

describe("catalogs (Appendix B2)", () => {
  const cat = { en: en as Record<string, string>, hu: hu as Record<string, string> };
  for (const lang of ["en", "hu"] as const) {
    it(`${lang}: every code has a title, a cause and exactly its fixes`, () => {
      for (const code of DIAG_CODES) {
        expect(cat[lang][`mongoDiag.${code}.title`], `${code} title`).toBeTruthy();
        expect(cat[lang][`mongoDiag.${code}.cause`], `${code} cause`).toBeTruthy();
        for (let i = 1; i <= DIAG_FIXES[code]; i++) expect(cat[lang][`mongoDiag.${code}.fix${i}`], `${code} fix${i}`).toBeTruthy();
        expect(cat[lang][`mongoDiag.${code}.fix${DIAG_FIXES[code] + 1}`], `${code} has an unlisted fix`).toBeUndefined();
      }
    });
    it(`${lang}: Atlas hints and every UI key exist`, () => {
      for (const h of ATLAS_HINTS) expect(cat[lang][`mongoDiag.hint.${h}`]).toBeTruthy();
      for (const id of ["config", "tunnel", "dns", "connect", "tls", "auth", "permissions"]) expect(cat[lang][`mongoDiag.step.${id}`]).toBeTruthy();
      for (const s of ["pending", "running", "ok", "warn", "failed", "skipped"]) expect(cat[lang][`mongoDiag.state.${s}`]).toBeTruthy();
    });
  }
  it("hu has exactly the keys of en", () => {
    expect(Object.keys(hu).sort()).toEqual(Object.keys(en).sort());
  });
  it("every code the Rust classifier can produce is covered", () => {
    const rs = rustDiagnose;
    const block = /pub const ALL_CODES[^=]*=\s*&\[([\s\S]*?)\];/.exec(rs)?.[1] ?? "";
    const codes = [...block.matchAll(/"([A-Za-z0-9.]+)"/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThan(40);
    expect(codes.filter((c) => !(c in DIAG_FIXES))).toEqual([]);
    expect(DIAG_CODES.filter((c) => !codes.includes(c))).toEqual([]);
  });
  it("the Hungarian text has accents and is not the English text", () => {
    const same = DIAG_CODES.filter((c) => hu[`mongoDiag.${c}.title` as keyof typeof hu] === en[`mongoDiag.${c}.title` as keyof typeof en]);
    expect(same).toEqual([]);
  });
});

describe("logic", () => {
  it("lists every step, hides Tunnel without a tunnel, and shows missing steps as pending", () => {
    expect(visibleSteps(undefined, { tunnel: false }).map((r) => r.id)).toEqual(["config", "dns", "connect", "tls", "auth", "permissions"]);
    const withTunnel = visibleSteps([step("config", "ok", 3), step("tunnel", "running")], { tunnel: true });
    expect(withTunnel.map((r) => r.state)).toEqual(["ok", "running", "pending", "pending", "pending", "pending", "pending"]);
  });
  it("never shows a step after the failed one as ok or running", () => {
    const rows = visibleSteps([step("config", "ok"), step("dns", "ok"), step("connect", "failed"), step("tls", "ok"), step("auth", "running")], { tunnel: false });
    expect(rows.map((r) => r.state)).toEqual(["ok", "ok", "failed", "skipped", "skipped", "skipped"]);
  });
  it("derives the overall state", () => {
    const pending = visibleSteps(undefined, { tunnel: false });
    expect(overall(pending, { running: false })).toBe("idle");
    expect(overall(pending, { running: true })).toBe("running");
    expect(overall(pending, { running: false, cancelled: true })).toBe("cancelled");
    expect(overall(visibleSteps([step("auth", "failed")], { tunnel: false }), { running: false, ok: false })).toBe("failed");
    expect(overall(visibleSteps([step("permissions", "warn")], { tunnel: false }), { running: false, ok: true })).toBe("warn");
    expect(overall(pending.map((r) => ({ ...r, state: "ok" as const })), { running: false, ok: true })).toBe("ok");
  });
  it("unknown codes fall back to other and params are parsed", () => {
    expect(diagCodeOf("future.thing")).toBe("other");
    expect(diagCodeOf("tls.hostname")).toBe("tls.hostname");
    expect(diagParams({ params: [["host", "a:1"], ["host", "b:2"], ["hint", "atlas.paused"], ["hint", "atlas.paused"], ["hint", "evil"], ["x", "y"]] })).toEqual({ host: "a:1", hints: ["atlas.paused"] });
  });
  it("maps warning codes", () => {
    expect(warningKey("config.plainRemote").key).toBe("mongoDiag.warning.plainRemote");
    expect(warningKey("tlsRelaxed").key).toBe("mongoDiag.warning.relaxed");
    expect(warningKey("roleElevated").key).toBe("mongoDiag.warning.writer");
    expect(warningKey("zzz")).toEqual({ key: "mongoDiag.warning.other", params: { code: "zzz" } });
  });
  it("groups a fingerprint and checks the typed host exactly", () => {
    expect(fingerprintGroups("SHA256:abcdefghij")).toEqual({ prefix: "SHA256:", groups: ["abcd", "efgh", "ij"] });
    expect(forgetConfirmed("bastion.example.com", "bastion.example.com")).toBe(true);
    expect(forgetConfirmed("Bastion.example.com", "bastion.example.com")).toBe(false);
    expect(forgetConfirmed("bastion.example.com ", "bastion.example.com")).toBe(false);
    expect(forgetConfirmed("", "")).toBe(false);
  });
  it("host key mode: unscannable wins, changed has its own mode", () => {
    expect(hostKeyMode(view("unknown"))).toBe("unknown");
    expect(hostKeyMode(view("changed"))).toBe("changed");
    expect(hostKeyMode(view("changed"), true)).toBe("unscannable");
  });
  it("only builds the manual ssh command for a safe host", () => {
    expect(manualSshCommand("bastion.example.com")).toBe("ssh bastion.example.com");
    for (const bad of ["-oProxyCommand=x", "a b", "a;b", "$(x)", "", "a\nb"]) expect(manualSshCommand(bad)).toBeUndefined();
  });
  it("allow-list check: format, link-local and metadata addresses, odd spellings", () => {
    expect(allowProblem("db1.example.com:27017")).toBeUndefined();
    expect(allowProblem("10.0.0.5:27017")).toBeUndefined();
    expect(allowProblem("db1:27017")).toBeUndefined();
    expect(allowProblem("169.254.169.254:80")).toBe("linkLocal");
    expect(allowProblem("169.254.0.1:27017")).toBe("linkLocal");
    expect(allowProblem("2852039166:80")).toBe("linkLocal");
    expect(allowProblem("0xA9FEA9FE:80")).toBe("linkLocal");
    expect(allowProblem("0251.0376.0251.0376:80")).toBe("linkLocal");
    expect(allowProblem("fe80::1:27017")).toBe("linkLocal");
    expect(allowProblem("metadata.google.internal:80")).toBe("linkLocal");
    for (const bad of ["nohost", "host:0", "host:70000", "host:abc", "-x:1", "a b:1", "[::1]:27017", ""]) expect(allowProblem(bad), bad).toBe("format");
  });
});

describe("TestStepper", () => {
  it("shows an icon-free text state for every step and a live status line", () => {
    render(() => <TestStepper tunnel={false} running steps={[step("config", "ok", 4), step("dns", "running")]} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(6);
    expect(items[0].textContent).toContain("OK");
    expect(items[1].textContent).toContain("Running");
    expect(items[2].textContent).toContain("Waiting");
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toContain("Name lookup");
  });
  it("marks the failed step and skips the rest", () => {
    render(() => <TestStepper tunnel={false} running={false} report={{ ok: false, elapsedMs: 900 }} steps={[step("config", "ok"), step("dns", "ok"), step("connect", "ok"), step("tls", "failed"), step("auth", "ok")]} />);
    expect(screen.getByRole("status").textContent).toContain("Secure connection");
    const states = screen.getAllByRole("listitem").map((li) => li.getAttribute("data-state"));
    expect(states).toEqual(["ok", "ok", "ok", "failed", "skipped", "skipped"]);
  });
  it("shows the success summary and warnings, and offers a cancel while running", () => {
    const cancel = vi.fn();
    const report = {
      ok: true,
      elapsedMs: 1234,
      warnings: ["config.plainRemote"],
      connection: { id: "a", name: "A", serverVersion: "7.0.5", topology: "replicaSet", pingMs: 12, effectiveLevel: "local", environment: "local", readOnly: true, readPreference: "primaryPreferred", role: { role: "readOnly" }, roleElevated: false, tls: true, tlsRelax: "none" },
    } as unknown as TestReport;
    const { unmount } = render(() => <TestStepper tunnel={false} running={false} report={report} steps={visibleSteps(undefined, { tunnel: false }).map((r) => ({ id: r.id, state: "ok" as const, ms: 1 }))} />);
    expect(screen.getByText("Server 7.0.5")).toBeTruthy();
    expect(screen.getByText("Replica set")).toBeTruthy();
    expect(screen.getByText("TLS on")).toBeTruthy();
    expect(screen.getByText("Read-only account")).toBeTruthy();
    expect(screen.getByText(/not encrypted/)).toBeTruthy();
    expect(screen.getAllByRole("status").length).toBe(2);
    unmount();
    render(() => <TestStepper tunnel running onCancel={cancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel test" }));
    expect(cancel).toHaveBeenCalled();
    expect(screen.getAllByRole("listitem")).toHaveLength(7);
  });
  it("offers the allow-members button only with a handler and members", () => {
    const allow = vi.fn();
    render(() => <TestStepper tunnel running={false} unallowedMembers={["a:1", "b:2"]} onAllowMembers={allow} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow these 2 hosts" }));
    expect(allow).toHaveBeenCalledWith(["a:1", "b:2"]);
  });
});

describe("DiagnosisView", () => {
  it("renders title, cause, fixes and the technical details for every code", () => {
    for (const code of DIAG_CODES) {
      const { unmount } = render(() => <DiagnosisView diagnosis={diag(code, { params: [["host", "db1:27017"]] })} />);
      expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(en[`mongoDiag.${code}.title` as keyof typeof en].replace("{host}", "db1:27017"));
      expect(document.querySelectorAll(".mgd__fixes li").length).toBe(DIAG_FIXES[code]);
      expect(screen.getByText("raw detail")).toBeTruthy();
      unmount();
    }
  });
  it("substitutes the host in tunnel.notAllowed and offers the button naming host:port", () => {
    const allow = vi.fn();
    render(() => <DiagnosisView diagnosis={diag("tunnel.notAllowed", { params: [["host", "rs2.internal:27018"]] })} onAllowHost={allow} />);
    expect(screen.getByText(/rs2\.internal:27018 is not one of them/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow rs2.internal:27018" }));
    expect(allow).toHaveBeenCalledWith("rs2.internal:27018");
  });
  it("shows Atlas hints, retry for retryable codes and host-key review only for host-key codes", () => {
    const retry = vi.fn();
    const review = vi.fn();
    const { unmount } = render(() => <DiagnosisView diagnosis={diag("net.timeout", { retryable: true, params: [["hint", "atlas.networkAccess"]] })} onRetry={retry} onReviewHostKey={review} />);
    expect(screen.getByText(/Network Access/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Review the host key" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalled();
    unmount();
    render(() => <DiagnosisView diagnosis={diag("tunnel.hostKeyChanged")} onReviewHostKey={review} />);
    fireEvent.click(screen.getByRole("button", { name: "Review the host key" }));
    expect(review).toHaveBeenCalled();
  });
  it("treats authz.listDatabases as a warning and unknown codes as other", () => {
    const { unmount } = render(() => <DiagnosisView diagnosis={diag("authz.listDatabases")} />);
    expect(document.querySelector(".mgd")?.getAttribute("data-severity")).toBe("warning");
    unmount();
    render(() => <DiagnosisView diagnosis={diag("from.the.future")} />);
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Could not connect");
  });
  it("copies the technical details", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(() => <DiagnosisView diagnosis={diag("other", { detail: "scrubbed text" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
    expect(writeText).toHaveBeenCalledWith("scrubbed text");
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy());
    vi.unstubAllGlobals();
  });
});

describe("HostKeyDialog", () => {
  const noop = () => {};
  it("unknown key: shows the fingerprint in groups and trusts the scanned view", async () => {
    const trust = vi.fn();
    render(() => <HostKeyDialog open view={view()} onTrust={trust} onForget={noop} onClose={noop} />);
    expect(screen.getByText("Trust this SSH server?")).toBeTruthy();
    expect(screen.getByText("abcd")).toBeTruthy();
    expect(screen.getByText(/Compare this with the fingerprint/)).toBeTruthy();
    expect(screen.getByText(/Only the SSH server itself is verified/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Trust and connect" }));
    await waitFor(() => expect(trust).toHaveBeenCalledWith(view()));
  });
  it("changed key: no trust button, forget needs the exact typed host", async () => {
    const trust = vi.fn();
    const forget = vi.fn().mockResolvedValue(undefined);
    render(() => <HostKeyDialog open view={view("changed")} expectedFingerprint="SHA256:OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDO" onTrust={trust} onForget={forget} onClose={noop} />);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Trust and connect" })).toBeNull();
    expect(screen.getByText("Saved fingerprint")).toBeTruthy();
    expect(screen.getByText("Fingerprint now offered")).toBeTruthy();
    const btn = screen.getByRole("button", { name: "Forget the saved key" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    const input = screen.getByLabelText("Type bastion.example.com to confirm") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "bastion.example.co" } });
    expect(btn.disabled).toBe(true);
    fireEvent.input(input, { target: { value: "bastion.example.com" } });
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => expect(forget).toHaveBeenCalledWith("bastion.example.com"));
    await waitFor(() => expect(screen.getByText(/saved key was removed/)).toBeTruthy());
    expect(trust).not.toHaveBeenCalled();
  });
  it("shows an error when trusting fails", async () => {
    render(() => <HostKeyDialog open view={view()} onTrust={() => Promise.reject(new Error("mismatch"))} onForget={noop} onClose={noop} />);
    fireEvent.click(screen.getByRole("button", { name: "Trust and connect" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("could not be trusted"));
  });
  it("unscannable: manual fallback with a copyable command and no trust button", () => {
    render(() => <HostKeyDialog open unscannable host="bastion.example.com" onTrust={noop} onForget={noop} onClose={noop} />);
    expect(screen.getByText("The host key cannot be scanned")).toBeTruthy();
    expect(screen.getByText("ssh bastion.example.com")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Trust and connect" })).toBeNull();
  });
  it("unscannable with a hostile host name shows no command", () => {
    render(() => <HostKeyDialog open unscannable host="-oProxyCommand=evil" onTrust={noop} onForget={noop} onClose={noop} />);
    expect(screen.queryByText(/^ssh /)).toBeNull();
  });
});

describe("AllowHostsDialog", () => {
  it("names the single host and confirms it", async () => {
    const ok = vi.fn();
    render(() => <AllowHostsDialog open hosts={["rs1.internal:27017"]} onConfirm={ok} onClose={() => {}} />);
    expect(screen.getByText("Allow this host?")).toBeTruthy();
    expect(screen.getByText("rs1.internal:27017")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(ok).toHaveBeenCalledWith(["rs1.internal:27017"]));
  });
  it("lists several hosts with a plural title", () => {
    render(() => <AllowHostsDialog open hosts={["a:1", "b:2", "c:3"]} onConfirm={() => {}} onClose={() => {}} />);
    expect(screen.getByText("Allow these 3 hosts?")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });
  it("cannot confirm a metadata address", () => {
    render(() => <AllowHostsDialog open hosts={["rs1.internal:27017", "169.254.169.254:80"]} onConfirm={() => {}} onClose={() => {}} />);
    expect((screen.getByRole("button", { name: "Allow" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/never allowed/)).toBeTruthy();
  });
});

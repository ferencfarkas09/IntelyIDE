import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../../ipc";
import type { MockRemoteSim } from "../../../ipc/mock/remote";
import type { RemoteIpc } from "../../../ipc/remote";
import { setLocale } from "../../../i18n";
import { installDomStubs } from "../../../store/testing-u2";
import { refreshRemote, resetRemoteState } from "../state";
import { createMockCloud, setCloudApi, type MockCloudOptions } from "./api";
import { applyLogChunk, customUrlProblem, deployBlock, emptyLog, errorText, hostChanges, nameProblem, overwritePhrase, ringAppend, safeLoginUrl } from "./logic";
import RelayGroup from "./RelayGroup";
import { resourceText } from "./steps";
import { currentRun, resetCloudState } from "./store";
import { ERROR_CODES } from "./types";

installDomStubs();
const remote = ipc.remote as RemoteIpc;

function setup(opts: MockCloudOptions = {}) {
  const api = createMockCloud(opts);
  setCloudApi(api);
  return api;
}
afterEach(async () => {
  cleanup();
  setCloudApi(undefined);
  resetCloudState();
  vi.restoreAllMocks();
  await remote.disable().catch(() => {});
  resetRemoteState();
});

const click = (el: HTMLElement) => fireEvent.click(el);
const byId = (id: string) => screen.getByTestId(id) as HTMLElement;
const ariaDisabled = (el: HTMLElement) => el.getAttribute("aria-disabled") === "true";
const typeInto = (el: HTMLElement, value: string) => fireEvent.input(el, { target: { value } });

/** Opens the wizard from the empty Cloudflare panel and walks to the review step. */
async function toReview(api: ReturnType<typeof setup>) {
  render(() => <RelayGroup onPair={() => {}} />);
  click(await screen.findByRole("radio", { name: "My Cloudflare" }));
  click(await screen.findByTestId("setup"));
  await screen.findByTestId("login"); // all prerequisites ok: the wizard starts at sign-in
  click(byId("login"));
  await waitFor(() => expect(byId("signed-in")).toBeTruthy());
  await waitFor(() => expect(ariaDisabled(byId("wiz-next"))).toBe(false));
  click(byId("wiz-next"));
  await screen.findByTestId("worker-name");
  click(byId("wiz-next"));
  await screen.findByTestId("deploy");
  await screen.findByTestId("review-cmd");
  void api;
}

describe("logic", () => {
  it("validates worker names, typed confirmation and overwrite phrases exactly", () => {
    expect(nameProblem("intely-relay-3f9a1c7e5b20")).toBeNull();
    expect(nameProblem("")).toBe("empty");
    expect(nameProblem("Upper")).toBe("chars");
    expect(nameProblem("-a")).toBe("dash");
    expect(nameProblem("a-")).toBe("dash");
    expect(nameProblem("a".repeat(64))).toBe("length");
    expect(nameProblem("é")).toBe("chars");
    const base = { ack: true, typed: "relay-x", typedOverwrite: "", workerName: "relay-x", nameCheck: "free" as const, kitDirtyFiles: 0 };
    expect(deployBlock(base)).toBeNull();
    expect(deployBlock({ ...base, ack: false })).toBe("ack");
    expect(deployBlock({ ...base, typed: "Relay-x" })).toBe("name");
    expect(deployBlock({ ...base, typed: "relay-x " })).toBe("name");
    expect(deployBlock({ ...base, nameCheck: "mine" })).toBeNull();
    for (const nameCheck of ["foreign", "unknown"] as const) {
      expect(deployBlock({ ...base, nameCheck })).toBe("overwrite");
      expect(deployBlock({ ...base, nameCheck, typedOverwrite: "overwrite relay-x" })).toBeNull();
      expect(deployBlock({ ...base, nameCheck, typedOverwrite: "Overwrite relay-x" })).toBe("overwrite");
    }
    expect(deployBlock({ ...base, kitDirtyFiles: 2 })).toBe("overwrite");
    expect(overwritePhrase("a")).toBe("overwrite a");
  });

  it("maps every error code to a real sentence (no key leaks) and unknown codes to a fallback", () => {
    for (const c of ERROR_CODES) {
      const text = errorText(c);
      expect(text, c).not.toContain("remote.cloud.err.");
      expect(text.length).toBeGreaterThan(5);
    }
    expect(errorText("surprise")).toContain("surprise");
  });

  it("accepts only an https dash.cloudflare.com sign-in address", () => {
    expect(safeLoginUrl("https://dash.cloudflare.com/oauth2/auth?x=1")).not.toBeNull();
    expect(safeLoginUrl("http://dash.cloudflare.com/x")).toBeNull();
    expect(safeLoginUrl("https://dash.cloudflare.com.evil.example/x")).toBeNull();
    expect(safeLoginUrl("https://evil.example/?u=dash.cloudflare.com")).toBeNull();
    expect(safeLoginUrl("javascript:alert(1)")).toBeNull();
    expect(safeLoginUrl(null)).toBeNull();
  });

  it("checks bring-your-own URLs early (wss only, no IP, no extras) and detects host changes", () => {
    expect(customUrlProblem("wss://relay.example.com")).toBeNull();
    expect(customUrlProblem("ws://127.0.0.1:8787")).toBeNull();
    expect(customUrlProblem("ws://relay.example.com")).toBe("scheme");
    expect(customUrlProblem("https://relay.example.com")).toBe("scheme");
    expect(customUrlProblem("wss://10.0.0.5")).toBe("ip");
    expect(customUrlProblem("wss://user:pw@relay.example.com")).toBe("extra");
    expect(customUrlProblem("wss://relay.example.com/x")).toBe("extra");
    expect(customUrlProblem("wss://relay.example.com/?a=1")).toBe("extra");
    expect(customUrlProblem("")).toBe("empty");
    expect(customUrlProblem("not a url")).toBe("syntax");
    expect(hostChanges("ws://127.0.0.1:8787", "wss://a.workers.dev")).toBe(true);
    expect(hostChanges("wss://A.workers.dev", "wss://a.workers.dev/")).toBe(false);
  });

  it("keeps the log ring bounded and applies chunks idempotently", () => {
    let s = emptyLog();
    s = applyLogChunk(s, { startSeq: 0, lines: ["a", "b"], reset: false });
    s = applyLogChunk(s, { startSeq: 0, lines: ["a", "b"], reset: false });
    s = applyLogChunk(s, { startSeq: 1, lines: ["b", "c"], reset: false });
    expect(s.lines).toEqual(["a", "b", "c"]);
    expect(applyLogChunk(s, { startSeq: 9, lines: ["gap"], reset: false })).toEqual(s);
    expect(applyLogChunk(s, { startSeq: 0, lines: ["z"], reset: true }).lines).toEqual(["z"]);
    expect(ringAppend([], Array.from({ length: 3500 }, (_, i) => String(i))).length).toBe(3000);
    expect(ringAppend([], ["x".repeat(400_000), "y".repeat(400_000)]).length).toBe(1);
  });
});

describe("<RelayGroup>", () => {
  it("opening the page calls status only; switching the mode does nothing outward", async () => {
    const api = setup({ deployed: true, mode: "cloudflare" });
    const spies = [vi.spyOn(remote, "enable"), vi.spyOn(remote, "applyLocalRelay")];
    render(() => <RelayGroup onPair={() => {}} />);
    await screen.findByTestId("cloud-url");
    click(screen.getByRole("radio", { name: "Custom URL" }));
    await screen.findByTestId("custom-panel");
    click(screen.getByRole("radio", { name: "This Mac only" }));
    click(screen.getByRole("radio", { name: "My Cloudflare" }));
    expect(api.sim.calls).toEqual(["status"]);
    spies.forEach((s) => expect(s).not.toHaveBeenCalled());
  });

  it("shows the deployed profile: address, status, signed bundle, last deploy, update badge, costs", async () => {
    setup({ deployed: true, mode: "cloudflare", updateAvailable: true });
    render(() => <RelayGroup onPair={() => {}} />);
    expect((await screen.findByTestId("cloud-url")).textContent).toContain("workers.dev");
    expect(byId("cloud-status").textContent).toContain("Reachable");
    expect(byId("bundle-hash").textContent).toBe("a1b2 c3d4 e5f6 0718");
    expect(byId("update-badge").textContent).toBe("Update available");
    expect(screen.getByText("Signed and matching")).toBeTruthy();
    expect(byId("costs").textContent).toContain("Worker requests");
  });

  it("read-only mode shows the banner that names INTELY_CLOUD and disables every outward button", async () => {
    setup({ deployed: true, mode: "cloudflare", jail: "readOnly" });
    render(() => <RelayGroup onPair={() => {}} />);
    const banner = await screen.findByTestId("cloud-readonly");
    expect(banner.textContent).toContain("INTELY_CLOUD=1");
    expect((byId("check-now") as HTMLButtonElement).disabled).toBe(true);
    expect((byId("update") as HTMLButtonElement).disabled).toBe(true);
    expect((byId("manage") as HTMLButtonElement).disabled).toBe(true);
  });

  it("Remove from Cloudflare is hidden unless removeEnabled", async () => {
    setup({ deployed: true, mode: "cloudflare" });
    render(() => <RelayGroup onPair={() => {}} />);
    click(await screen.findByTestId("manage"));
    await screen.findByRole("menuitem", { name: /Forget this relay/ });
    expect(screen.queryByRole("menuitem", { name: /Remove from Cloudflare/ })).toBeNull();
    cleanup();
    setup({ deployed: true, mode: "cloudflare", removeEnabled: true });
    render(() => <RelayGroup onPair={() => {}} />);
    click(await screen.findByTestId("manage"));
    expect(await screen.findByRole("menuitem", { name: /Remove from Cloudflare/ })).toBeTruthy();
  });

  it("Rollback shows the command of its plan and runs only with that plan's nonce", async () => {
    const api = setup({ deployed: true, mode: "cloudflare" });
    render(() => <RelayGroup onPair={() => {}} />);
    click(await screen.findByTestId("manage"));
    click(await screen.findByRole("menuitem", { name: /Roll back/ }));
    const cmd = await screen.findByTestId("plan-cmd");
    expect(cmd.textContent).toContain("rollback --name intely-relay-");
    expect(api.sim.args.plan![0]).toEqual(["rollback", undefined]);
    typeInto(byId("typed-input"), "intely-relay-3f9a1c7e5b20");
    click(byId("typed-confirm"));
    await waitFor(() => expect(api.sim.calls).toContain("rollback"));
    const sent = api.sim.args.rollback![0] as [string, string];
    expect(sent[0]).toBe("intely-relay-3f9a1c7e5b20");
    expect(sent[1]).toMatch(/^plan1/);
  });

  it("a pending key rotation can be rolled back from the menu", async () => {
    const api = setup({ deployed: true, mode: "cloudflare", rotationPending: true });
    render(() => <RelayGroup onPair={() => {}} />);
    click(await screen.findByTestId("manage"));
    click(await screen.findByRole("menuitem", { name: /Roll back the signing key rotation/ }));
    typeInto(await screen.findByTestId("typed-input"), "rotate");
    click(byId("typed-confirm"));
    await waitFor(() => expect(api.sim.calls).toContain("rotate"));
    expect(api.sim.args.rotate![0]).toEqual(["signingCancel", "rotate"]);
    await waitFor(() => expect(api.sim.view.keys.signingRotationPending).toBe(false));
  });

  it("Remove runs from a plan too", async () => {
    const api = setup({ deployed: true, mode: "cloudflare", removeEnabled: true });
    render(() => <RelayGroup onPair={() => {}} />);
    click(await screen.findByTestId("manage"));
    click(await screen.findByRole("menuitem", { name: /Remove from Cloudflare/ }));
    expect((await screen.findByTestId("plan-cmd")).textContent).toContain("delete --name");
    typeInto(byId("typed-input"), "intely-relay-3f9a1c7e5b20");
    click(byId("typed-confirm"));
    await waitFor(() => expect(api.sim.calls).toContain("remove"));
    expect((api.sim.args.remove![0] as string[])[1]).toMatch(/^plan/);
  });

  it("Forget needs the typed word and does not touch Cloudflare", async () => {
    const api = setup({ deployed: true, mode: "cloudflare" });
    render(() => <RelayGroup onPair={() => {}} />);
    click(await screen.findByTestId("manage"));
    click(await screen.findByRole("menuitem", { name: /Forget this relay/ }));
    const confirm = await screen.findByTestId("typed-confirm");
    expect(ariaDisabled(confirm)).toBe(true);
    // focus lands in the typed field; the blocked button stays focusable and points at the reason
    await waitFor(() => expect(document.activeElement).toBe(byId("typed-input")));
    const reason = document.getElementById(confirm.getAttribute("aria-describedby")!);
    expect(reason?.textContent).toContain("Type exactly: forget");
    typeInto(byId("typed-input"), "Forget");
    expect(ariaDisabled(confirm)).toBe(true);
    typeInto(byId("typed-input"), "forget");
    expect(ariaDisabled(confirm)).toBe(false);
    click(confirm);
    await waitFor(() => expect(api.sim.calls).toContain("forget"));
    expect(api.sim.calls.filter((c) => ["deploy", "remove", "logout", "login"].includes(c))).toEqual([]);
  });

  it("the not-set-up panel shows the trust paragraph before the first deploy, and a missing kit says so", async () => {
    setup({ kitFound: false, durable: false });
    render(() => <RelayGroup onPair={() => {}} />);
    click(await screen.findByRole("radio", { name: "My Cloudflare" }));
    expect(await screen.findByTestId("trust-note")).toBeTruthy();
    expect(screen.getByText(/relay serves the phone app's JavaScript|also serves the phone app's JavaScript/)).toBeTruthy();
    click(byId("setup"));
    expect((await screen.findByTestId("kit-missing")).textContent).toContain("cannot deploy");
  });

  it("missing node or pnpm is said as such: a hint naming the tools, a Check again button, and Prepare does not claim the kit is missing", async () => {
    const api = setup({ toolsOk: false });
    render(() => <RelayGroup onPair={() => {}} />);
    click(await screen.findByRole("radio", { name: "My Cloudflare" }));
    click(await screen.findByTestId("setup"));
    await screen.findByTestId("prepare");
    expect(screen.getByText(/Not found: node, pnpm\./).textContent).toContain("corepack enable pnpm");
    expect(ariaDisabled(byId("wiz-next"))).toBe(true);
    const statusCalls = () => api.sim.calls.filter((c) => c === "status").length;
    const before = statusCalls();
    click(byId("recheck"));
    await waitFor(() => expect(statusCalls()).toBeGreaterThan(before));
    await waitFor(() => expect(byId("prepare").hasAttribute("data-loading")).toBe(false), { timeout: 3000 }); // the check is over (busy again off)
    click(byId("prepare"));
    const alert = await screen.findByTestId("cloud-error", {}, { timeout: 4000 });
    expect(alert.textContent).toContain("node or pnpm was not found");
    expect(alert.textContent).not.toContain("relay kit was not found");
  });
});

describe("review text in the UI language", () => {
  afterEach(async () => {
    await setLocale("en");
  });

  it("the resource list is built from kinds and bare values in English and in Hungarian (no English sentence from Rust)", async () => {
    const rows = [
      { kind: "worker", label: "intely-relay-x" },
      { kind: "durableObject", label: "Room", detail: "v1" },
      { kind: "assets", label: "" },
      { kind: "routeWorkersDev", label: "" },
      { kind: "route", label: "relay.example.com" },
      { kind: "secret", label: "VAPID_PRIVATE_KEY" },
    ];
    const en = rows.map(resourceText);
    expect(en[1]).toBe("Durable Object class Room (SQLite, migration v1)");
    expect(en[3]).toBe("Address on workers.dev");
    await setLocale("hu");
    const hu = rows.map(resourceText);
    for (const [i, line] of hu.entries()) {
      expect(line, rows[i].kind).not.toContain("remote.cloud.res.");
      expect(line, rows[i].kind).not.toBe(en[i]);
      expect(line, rows[i].kind).not.toMatch(/Durable Object class|migration|Static assets|Address|Worker script|Secret /);
    }
    expect(hu[1]).toContain("v1 migráció");
    expect(hu[2]).toContain("Statikus fájlok");
    expect(hu[3]).toBe("Cím a workers.dev-en");
    expect(hu[1]).toContain("Room");
  });

  it("the new error and review texts exist in Hungarian", async () => {
    await setLocale("hu");
    for (const c of ["moduleUnverified", "rotationPending", "previewStale"]) {
      expect(errorText(c)).not.toContain("remote.cloud.err.");
      expect(errorText(c)).not.toMatch(/^[A-Z][a-z]+ [a-z]+ [a-z]+ (could|expired|is) /);
    }
    expect(errorText("moduleUnverified")).toContain("modullist");
  });
});

describe("wizard", () => {
  it("walks sign-in, name, review and deploys only after the checkbox and the exact name; the token never reaches argv", async () => {
    const api = setup({ distBuilt: true });
    await toReview(api);
    const deploy = byId("deploy");
    expect(ariaDisabled(deploy)).toBe(true);
    expect(byId("deploy-reason").textContent).toContain("Tick the box");
    click(deploy);
    expect(api.sim.calls).not.toContain("deploy");
    fireEvent.click(screen.getByRole("checkbox", { name: /I understand this creates or replaces/ }));
    expect(byId("deploy-reason").textContent).toContain("Type exactly: intely-relay-");
    const name = (api.sim.args.preview![0] as [string])[0];
    typeInto(byId("confirm-name"), name.toUpperCase());
    expect(ariaDisabled(deploy)).toBe(true);
    typeInto(byId("confirm-name"), name);
    expect(ariaDisabled(deploy)).toBe(false);
    expect(byId("review-cmd").textContent).toContain(`--name ${name}`);
    expect(byId("review-cmd").textContent).not.toMatch(/token|secret/i);
    expect(byId("review-cmd").getAttribute("dir")).toBe("ltr"); // an LTR island inside RTL text
    click(deploy);
    await waitFor(() => expect(byId("deploy-continue")).toBeTruthy(), { timeout: 3000 });
    expect(api.sim.calls).toContain("deploy");
    click(byId("deploy-continue"));
    await screen.findByTestId("verify-result");
    click(byId("use-relay"));
    await waitFor(() => expect(api.sim.calls).toContain("apply"));
    expect(api.sim.args.apply![0]).toEqual(["cloudflare", false]);
    await screen.findByTestId("wiz-close");
  });

  it("the review shows the command and directory of the plan Rust holds, and the deploy sends the plan's nonce", async () => {
    const api = setup();
    await toReview(api);
    expect(api.sim.calls.indexOf("plan")).toBeGreaterThan(api.sim.calls.indexOf("preview"));
    expect(api.sim.args.plan![0]).toEqual(["deploy", "preview1"]);
    expect(byId("review-dir").textContent).toContain("relay-deploy/");
    const name = (api.sim.args.preview![0] as [string])[0];
    fireEvent.click(screen.getByRole("checkbox", { name: /I understand this creates or replaces/ }));
    typeInto(byId("confirm-name"), name);
    click(byId("deploy"));
    await waitFor(() => expect(byId("deploy-continue")).toBeTruthy(), { timeout: 3000 });
    const sent = api.sim.args.deploy![0] as [string, string, string | undefined, string, boolean | undefined];
    expect(sent[3]).toMatch(/^plan1/);
    expect(sent[4]).toBeFalsy();
  });

  it("asks for a new plan when the plan ran out while the review was open", async () => {
    const api = setup();
    await toReview(api);
    const name = (api.sim.args.preview![0] as [string])[0];
    fireEvent.click(screen.getByRole("checkbox", { name: /I understand this creates or replaces/ }));
    typeInto(byId("confirm-name"), name);
    const real = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(real + 6 * 60_000); // past the five minutes of the plan, inside the fifteen of the preview
    click(byId("deploy"));
    await waitFor(() => expect(byId("deploy-continue")).toBeTruthy(), { timeout: 3000 });
    expect(api.sim.args.plan!.length).toBe(2);
    expect((api.sim.args.deploy![0] as string[])[3]).toMatch(/^plan2/);
  });

  it("an unverified module list needs its own acknowledgement and is sent along", async () => {
    const api = setup({ unverifiedModules: true });
    await toReview(api);
    expect(byId("modules-unverified").textContent).toContain("could not list the modules");
    const name = (api.sim.args.preview![0] as [string])[0];
    fireEvent.click(screen.getByRole("checkbox", { name: /creates or replaces/ }));
    typeInto(byId("confirm-name"), name);
    const deploy = byId("deploy");
    expect(ariaDisabled(deploy)).toBe(true);
    expect(byId("deploy-reason").textContent).toContain("unverified module list");
    click(deploy);
    expect(api.sim.calls).not.toContain("deploy");
    fireEvent.click(screen.getByRole("checkbox", { name: /module list is unverified/ }));
    expect(ariaDisabled(deploy)).toBe(false);
    click(deploy);
    await waitFor(() => expect(byId("deploy-continue")).toBeTruthy(), { timeout: 3000 });
    expect((api.sim.args.deploy![0] as unknown[])[4]).toBe(true);
  });

  it("a verified module list shows no extra acknowledgement", async () => {
    const api = setup();
    await toReview(api);
    expect(screen.queryByTestId("modules-unverified")).toBeNull();
    expect(screen.queryByTestId("ack-unverified")).toBeNull();
  });

  it("a foreign or unknown name (or a dirty kit) needs the second typed phrase", async () => {
    const api = setup({ nameCheck: "foreign", dirtyFiles: 3 });
    await toReview(api);
    expect(byId("kit-dirty").textContent).toContain("3 files");
    const name = (api.sim.args.preview![0] as [string])[0];
    fireEvent.click(screen.getByRole("checkbox", { name: /I understand/ }));
    typeInto(byId("confirm-name"), name);
    const deploy = byId("deploy");
    expect(ariaDisabled(deploy)).toBe(true);
    expect(byId("deploy-reason").textContent).toContain(`overwrite ${name}`);
    typeInto(byId("confirm-overwrite"), `overwrite ${name}`);
    expect(ariaDisabled(deploy)).toBe(false);
  });

  it("a failed deploy stops at the failing step, shows the classified error and offers a retry", async () => {
    const api = setup({ failAt: { step: "deploy", code: "permission" } });
    await toReview(api);
    const name = (api.sim.args.preview![0] as [string])[0];
    fireEvent.click(screen.getByRole("checkbox", { name: /I understand/ }));
    typeInto(byId("confirm-name"), name);
    click(byId("deploy"));
    const err = await screen.findByTestId("cloud-error", undefined, { timeout: 3000 });
    expect(err.textContent).toContain("lacks a permission");
    expect(screen.getByTestId("retry")).toBeTruthy();
    expect(screen.queryByTestId("deploy-continue")).toBeNull();
    expect(byId("cloud-log").textContent).toContain("wrangler deploy");
  });

  it("shows the sign-in address as selectable text only, never as a link, and rejects other hosts", async () => {
    setup({ holdLogin: true });
    render(() => <RelayGroup onPair={() => {}} />);
    click(await screen.findByRole("radio", { name: "My Cloudflare" }));
    click(await screen.findByTestId("setup"));
    click(await screen.findByTestId("login"));
    const url = await screen.findByTestId("login-url");
    expect(url.tagName).toBe("CODE");
    expect(url.textContent).toMatch(/^https:\/\/dash\.cloudflare\.com\//);
    expect(document.querySelector("a[href*='cloudflare']")).toBeNull();
    click(byId("login-cancel"));
    await waitFor(() => expect(currentRun()?.status).toBe("cancelled"));
  });

  it("closing during a running step asks first, and keeping it returns focus", async () => {
    const api = setup({ holdLogin: true });
    render(() => <RelayGroup onPair={() => {}} />);
    click(await screen.findByRole("radio", { name: "My Cloudflare" }));
    click(await screen.findByTestId("setup"));
    click(await screen.findByTestId("login"));
    await screen.findByTestId("login-url");
    byId("wiz-cancel").focus(); // a real click focuses the button first
    click(byId("wiz-cancel"));
    const keep = await screen.findByTestId("stop-keep").catch((e) => { throw new Error(document.body.textContent?.slice(-700) + String(e).slice(0, 80)); });
    expect(screen.getByText("Stop the running step?")).toBeTruthy();
    click(keep);
    await waitFor(() => expect(screen.queryByText("Stop the running step?")).toBeNull());
    expect(document.activeElement).toBe(byId("wiz-cancel")); // focus returns to what opened the question
    expect(byId("login")).toBeTruthy(); // the wizard is still open
    click(byId("wiz-cancel"));
    click(await screen.findByTestId("stop-close"));
    await waitFor(() => expect(api.sim.calls).toContain("stop"));
    await waitFor(() => expect(currentRun()?.status).toBe("cancelled"));
  });

  it("the token is cleared from the field at once and sent to the Keychain only", async () => {
    const api = setup({ distBuilt: true });
    render(() => <RelayGroup onPair={() => {}} />);
    click(await screen.findByRole("radio", { name: "My Cloudflare" }));
    click(await screen.findByTestId("setup"));
    await screen.findByTestId("login");
    fireEvent.click(screen.getByRole("radio", { name: "Use an API token" }));
    const input = (await screen.findByTestId("token-input")) as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.getAttribute("autocomplete")).toBe("off");
    typeInto(input, "cfut_0123456789012345678901234567890123456789");
    click(byId("token-save"));
    await waitFor(() => expect(api.sim.calls).toContain("tokenSet"));
    await waitFor(() => expect(input.value).toBe(""));
    expect(JSON.stringify(api.sim.args)).not.toContain("cfut_");
  });
});

describe("unpair confirmation", () => {
  it("switching to another host with paired phones asks first and only then applies with confirmUnpair", async () => {
    const api = setup({ deployed: true, mode: "local" });
    await remote.enable();
    await remote.pairStart();
    (remote as unknown as { sim: MockRemoteSim }).sim.phoneArrives("iPhone");
    await remote.pairConfirm(true, { name: "iPhone" });
    await refreshRemote();
    render(() => <RelayGroup onPair={() => {}} />);
    click(await screen.findByRole("radio", { name: "My Cloudflare" }));
    click(await screen.findByTestId("use-cloud"));
    const confirm = await screen.findByTestId("unpair-confirm");
    expect(screen.getByText(/1 phone holds the old address/)).toBeTruthy();
    expect(api.sim.calls).not.toContain("apply");
    click(confirm);
    await waitFor(() => expect(api.sim.args.apply?.[0]).toEqual(["cloudflare", true]));
  });
});

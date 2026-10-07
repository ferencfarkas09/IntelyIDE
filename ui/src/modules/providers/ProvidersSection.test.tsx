import { cleanup, configure, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", async (orig) => {
  const mod = await orig<typeof import("../../ipc")>();
  const { createMockIpc } = await import("../../ipc/mock");
  return { ...mod, ipc: createMockIpc("normal", { delayScale: 0 }) };
});

import { ipc } from "../../ipc";
import { installDomStubs } from "../../store/testing-u2";
import ProvidersSection from "./ProvidersSection";

// The shared dev machine is heavily loaded; a lazy chunk may take seconds to arrive.
configure({ asyncUtilTimeout: 15000 });
vi.setConfig({ testTimeout: 30000 });

installDomStubs();
afterEach(cleanup);

const card = async (name: string) => (await screen.findByRole("article", { name })) as HTMLElement;
const experimentalSwitch = () => screen.findByRole("switch", { name: "Experimental providers" });

/** The mock backend is shared by the tests of this file: wait for the section to read its state, then set the switch as wanted. */
async function setExperimental(want: boolean) {
  const sw = (await experimentalSwitch()) as HTMLInputElement;
  const now = await ipc.providers.experimental();
  await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe(String(now)));
  if (now !== want) fireEvent.click(sw);
  await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe(String(want)));
  await waitFor(() => expect(sw.disabled).toBe(false));
}
const turnExperimentalOn = () => setExperimental(true);

describe("<ProvidersSection>", () => {
  it("starts with Claude only: the experimental providers are off, named in one line, and cost nothing", async () => {
    render(() => <ProvidersSection />);
    expect(await screen.findAllByRole("article")).toHaveLength(1);
    const claude = await card("Claude");
    await waitFor(() => expect(within(claude).getByText("Ready")).toBeTruthy());
    expect(within(claude).getByText("2.1.284")).toBeTruthy();
    // Claude ran suites S0 to S2 in the mock: best effort. The tier comes from the recorded run, not from the card.
    await waitFor(() => expect(within(claude).getByText("Enforcement: Best effort")).toBeTruthy());
    expect((await experimentalSwitch()).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/7 more providers are available once this is on: Codex, Gemini/)).toBeTruthy();
    expect(screen.queryByRole("article", { name: "Codex" })).toBeNull();
  });

  it("switching Experimental providers on lists the 8 real providers: Codex, Gemini, Copilot and the generic ACP ones, all off", async () => {
    render(() => <ProvidersSection />);
    await turnExperimentalOn();
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(8));
    for (const name of ["Codex", "Gemini", "GitHub Copilot", "OpenCode", "Goose", "Qwen Code", "ACP agent"]) {
      const c = await card(name);
      expect(within(c).getByRole("switch", { name: `Enable ${name}` }).getAttribute("aria-checked")).toBe("false");
    }
    // installed (the dev Mac has Codex): the zero-cost note; not installed: the reason it cannot be switched on
    expect(within(await card("Codex")).getByText(/no process, no timer, no network/)).toBeTruthy();
    expect(within(await card("Goose")).getByText(/Goose is not installed on this machine/)).toBeTruthy();
    expect(within(await card("OpenCode")).getByText("Generic ACP agent")).toBeTruthy();
    expect(screen.queryByRole("article", { name: "Ollama" })).toBeNull();
  });

  it("a provider whose program is not installed cannot be switched on and says so", async () => {
    render(() => <ProvidersSection />);
    await turnExperimentalOn();
    const gemini = await card("Gemini");
    const sw = within(gemini).getByRole("switch", { name: "Enable Gemini" });
    await waitFor(() => expect((sw as HTMLInputElement).disabled || sw.getAttribute("aria-disabled") === "true").toBe(true));
    expect(within(gemini).getByText(/Gemini is not installed on this machine/)).toBeTruthy();
  });

  it("Codex: switch on, review and confirm the exact command line, it becomes Ready and stays confirmed", async () => {
    render(() => <ProvidersSection />);
    await turnExperimentalOn();
    const codex = await card("Codex");
    await waitFor(() => expect((within(codex).getByRole("switch", { name: "Enable Codex" }) as HTMLInputElement).disabled).toBeFalsy());
    fireEvent.click(within(codex).getByRole("switch", { name: "Enable Codex" }));
    await waitFor(() => expect(within(codex).getByText("Confirm command")).toBeTruthy());
    // the full line is shown before anything is confirmed
    expect((await within(codex).findByLabelText("Full command")).textContent).toBe("/usr/local/bin/codex app-server");
    expect(within(codex).getByText("Not confirmed")).toBeTruthy();
    expect(within(codex).getByText(/measured against the installed Codex/)).toBeTruthy();
    fireEvent.click(within(codex).getByRole("button", { name: "Review and confirm…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Start Codex with this command?")).toBeTruthy();
    expect(within(dialog).getAllByText("/usr/local/bin/codex app-server").length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm and use this command" }));
    await waitFor(() => expect(within(codex).getByText("Ready")).toBeTruthy());
    expect(within(codex).getByText("Confirmed")).toBeTruthy();
    expect(within(codex).getByText(/Fingerprint [0-9a-f]{8}/)).toBeTruthy();
    // the chip stays honest: nothing was proven, and the read-only rule is stated
    expect(within(codex).getByText("Enforcement: Weak")).toBeTruthy();
    expect(within(codex).getByText("Read-only roles only until proven")).toBeTruthy();
  });

  it("the Test run negotiates capabilities without a prompt, and the matrix then says they were negotiated", async () => {
    render(() => <ProvidersSection />);
    await turnExperimentalOn();
    const codex = await card("Codex");
    await waitFor(() => expect(within(codex).getByText("Ready")).toBeTruthy());
    fireEvent.click(within(codex).getByRole("button", { name: "Capabilities of Codex" }));
    expect(await screen.findByText("Documented defaults, refined when a session starts")).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    fireEvent.click(within(codex).getByRole("button", { name: "Test run" }));
    await waitFor(() => expect(within(codex).getByRole("status", { name: "" }).textContent ?? "").toContain("Capabilities negotiated with the running agent"));
    fireEvent.click(within(codex).getByRole("button", { name: "Capabilities of Codex" }));
    expect(await screen.findByText("Negotiated by a session of this provider")).toBeTruthy();
  });

  it("the custom ACP agent takes a typed absolute command line; a relative one is refused in the dialog", async () => {
    render(() => <ProvidersSection />);
    await turnExperimentalOn();
    const acp = await card("ACP agent");
    fireEvent.click(within(acp).getByRole("switch", { name: "Enable ACP agent" }));
    await waitFor(() => expect(within(acp).getByText("Confirm command")).toBeTruthy());
    fireEvent.click(await within(acp).findByRole("button", { name: "Review and confirm…" }));
    const dialog = await screen.findByRole("alertdialog");
    const program = within(dialog).getByLabelText("Program (absolute path)");
    fireEvent.input(program, { target: { value: "my-agent" } });
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Confirm and use this command" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.input(program, { target: { value: "/opt/agents/my-agent" } });
    fireEvent.input(within(dialog).getByLabelText("Arguments (one per line)"), { target: { value: "--stdio\n--acp" } });
    expect(within(dialog).getByLabelText("Full command").textContent).toBe("/opt/agents/my-agent --stdio --acp");
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm and use this command" }));
    await waitFor(() => expect(within(acp).getByText("Ready")).toBeTruthy());
  });

  it("a key is typed once: stored, masked, never shown again; replace and remove only (Claude, API key mode)", async () => {
    render(() => <ProvidersSection />);
    const claude = await card("Claude");
    await waitFor(() => expect(within(claude).getByText("Ready")).toBeTruthy());
    fireEvent.change(within(claude).getByRole("combobox", { name: "Claude sign-in" }), { target: { value: "apiKey" } });
    const field = (await within(claude).findByLabelText("API key")) as HTMLInputElement;
    expect(field.type).toBe("password");
    expect(within(claude).getByText("Needs key")).toBeTruthy();
    fireEvent.input(field, { target: { value: "sk-canary-123" } });
    fireEvent.click(within(claude).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(claude).getByText("Stored")).toBeTruthy());
    expect(within(claude).getByText("Ready")).toBeTruthy();
    expect(within(claude).queryByLabelText("API key")).toBeNull();
    expect(document.body.innerHTML).not.toContain("sk-canary-123");
    expect([...document.querySelectorAll("input")].every((i) => !i.value.includes("sk-canary"))).toBe(true);

    fireEvent.click(within(claude).getByRole("button", { name: "Replace" }));
    const replacement = within(claude).getByLabelText("New API key") as HTMLInputElement;
    expect(replacement.value).toBe("");
    fireEvent.click(within(claude).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(claude).getByRole("button", { name: "Remove" }));
    // The save is still settling for a moment after the badge flips; a busy button ignores clicks.
    await waitFor(() => expect(within(claude).getByRole("button", { name: "Remove API key" }).getAttribute("aria-busy")).toBeNull());
    fireEvent.click(within(claude).getByRole("button", { name: "Remove API key" }));
    await waitFor(() => expect(within(claude).getByText("Needs key")).toBeTruthy());
    expect(within(claude).getByLabelText("API key")).toBeTruthy();
    // the mock backend is shared by the tests of this file: back to the subscription
    fireEvent.change(within(claude).getByRole("combobox", { name: "Claude sign-in" }), { target: { value: "subscription" } });
    await waitFor(() => expect(within(claude).getByText("Ready")).toBeTruthy());
  });

  it("a provider that is off asks for nothing: no capabilities are read until a matrix is opened", async () => {
    const caps = vi.spyOn(ipc.providers, "caps");
    render(() => <ProvidersSection />);
    await card("Claude");
    await waitFor(() => expect(within(screen.getAllByRole("article")[0]).getByText("Ready")).toBeTruthy());
    expect(caps).not.toHaveBeenCalled();
    caps.mockRestore();
  });

  it("Claude's chip comes from the recorded suites and lists which passed", async () => {
    render(() => <ProvidersSection />);
    const claude = await card("Claude");
    fireEvent.click(await within(claude).findByRole("button", { name: /Enforcement Best effort for Claude/ }));
    expect((await screen.findAllByText(/S0 About 30 bypass strings/)).length).toBe(2);
    expect(screen.getAllByText("Passed").length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText("Not run").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/Weak means no attempt suite/)).toBeNull();
    expect(screen.getByText(/This chip covers roles that change files/)).toBeTruthy();
  });

  it("switching Experimental providers off again hides the cards (zero cost when off)", async () => {
    render(() => <ProvidersSection />);
    await setExperimental(true);
    await waitFor(() => expect(screen.getAllByRole("article").length).toBeGreaterThan(1));
    await setExperimental(false);
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(1));
  });
});

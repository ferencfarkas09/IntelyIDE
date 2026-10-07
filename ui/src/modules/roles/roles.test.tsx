import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../ipc";
import { resetSettings, settingsSections } from "../../platform/settings";
import { installDomStubs } from "../../store/testing-u2";
import { register } from "./index";
import RolesSection from "./RolesSection";

installDomStubs();
afterEach(() => {
  cleanup();
  resetSettings();
});

const row = (name: string) => [...document.querySelectorAll<HTMLInputElement>('input[aria-label="Role name"]')].find((i) => i.value === name)!.closest("tbody")!;
const field = (tbody: Element, label: string) => tbody.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;

describe("roles module", () => {
  it("adds the Roles section to Settings", () => {
    register();
    expect(settingsSections().map((s) => s.id)).toEqual(["roles"]);
  });
});

describe("<RolesSection>", () => {
  it("builds the dropdowns from the provider and turns effort into n/a for a model without it", async () => {
    render(() => <RolesSection />);
    await waitFor(() => expect(document.querySelectorAll("tbody.roles__role")).toHaveLength(5));
    const dev = row("developer");
    expect([...field(dev, "Model").options].map((o) => o.textContent)).toEqual(["Haiku 4.5", "Sonnet 5.5", "Opus 5.5"]);
    expect([...field(dev, "Effort").options].map((o) => o.value)).toEqual(["low", "medium", "high"]);
    fireEvent.change(field(dev, "Model"), { target: { value: "claude-haiku-4-5-20251001" } });
    await waitFor(() => expect(field(row("developer"), "Effort").disabled).toBe(true));
    expect(field(row("developer"), "Effort").selectedOptions[0].textContent).toBe("n/a");
  });

  it("blocks saving a read-only role that still holds writing tools, and says why", async () => {
    render(() => <RolesSection />);
    await waitFor(() => expect(document.querySelectorAll("tbody.roles__role")).toHaveLength(5));
    fireEvent.change(field(row("developer"), "Permission mode"), { target: { value: "readOnly" } });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/read-only role cannot use Edit, Write, Bash/));
    expect(screen.getByText("1 unsaved change")).toBeTruthy();
    expect(within(row("developer")).getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  });

  it("saves an edited role through ipc.roles", async () => {
    render(() => <RolesSection />);
    await waitFor(() => expect(document.querySelectorAll("tbody.roles__role")).toHaveLength(5));
    fireEvent.change(field(row("architect"), "Effort"), { target: { value: "max" } });
    fireEvent.click(document.querySelector<HTMLButtonElement>(".roles__foot button")!);
    await waitFor(() => expect(screen.getByText("All changes saved")).toBeTruthy());
    expect((await ipc.roles.list()).find((r) => r.id === "architect")?.effort).toBe("max");
  });

  it("asks before a save changes a role file, then saves with the confirmation (the engine refuses without it)", async () => {
    const save = vi.spyOn(ipc.roles, "save").mockImplementation(async (role, opts) => {
      if (!opts?.confirmWrite) throw { code: "confirmWrite", message: "saving changes /x/architect.md; confirm the write first" };
      return role;
    });
    render(() => <RolesSection />);
    await waitFor(() => expect(document.querySelectorAll("tbody.roles__role")).toHaveLength(5));
    fireEvent.change(field(row("architect"), "Effort"), { target: { value: "low" } });
    fireEvent.click(document.querySelector<HTMLButtonElement>(".roles__foot button")!);
    fireEvent.click(await screen.findByRole("button", { name: "Write the file" }));
    await waitFor(() => expect(screen.getByText("All changes saved")).toBeTruthy());
    expect(save.mock.calls.map((c) => c[1]?.confirmWrite ?? false)).toEqual([false, true]);
    save.mockRestore();
  });

  it("lists every provider: off ones and ones without models are greyed out with the reason", async () => {
    render(() => <RolesSection />);
    await waitFor(() => expect(document.querySelectorAll("tbody.roles__role")).toHaveLength(5));
    await waitFor(() => expect([...field(row("developer"), "Provider").options].length).toBeGreaterThan(1));
    const options = [...field(row("developer"), "Provider").options];
    const byText = (t: string) => options.find((o) => o.textContent === t)!;
    expect(byText("Claude").disabled).toBe(false);
    expect(byText("Codex (enable in Settings)").disabled).toBe(true);
    expect(byText("OpenCode (no models yet)").disabled).toBe(true);
  });

  it("blocks a role that changes files on a provider whose enforcement is Weak, and allows read-only there", async () => {
    await ipc.providers.setEnabled("codex", true);
    render(() => <RolesSection />);
    await waitFor(() => expect(document.querySelectorAll("tbody.roles__role")).toHaveLength(5));
    await waitFor(() => expect(field(row("developer"), "Provider").querySelector('option[value="codex"]')?.textContent).toBe("Codex"));
    fireEvent.change(field(row("developer"), "Provider"), { target: { value: "codex" } });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Codex is Weak so far: only read-only roles run on it/));
    expect(row("developer").querySelector<HTMLButtonElement>("button.ui-btn.ui-btn--primary, button[data-variant='primary']")?.disabled ?? true).toBe(true);
    const permission = field(row("developer"), "Permission mode");
    expect([...permission.options].find((o) => o.value === "ask")?.textContent).toBe("Ask (needs Strong)");
    expect([...permission.options].find((o) => o.value === "readOnly")?.disabled).toBe(false);
  });

  it("shows what the mode means for the provider and the honest chip in the role details", async () => {
    render(() => <RolesSection />);
    await waitFor(() => expect(document.querySelectorAll("tbody.roles__role")).toHaveLength(5));
    fireEvent.click(screen.getByRole("button", { name: "Show details of researcher" }));
    expect((await screen.findByLabelText("Provider safety")).textContent).toMatch(/Read-only means Claude plan mode/);
    expect(await screen.findByRole("button", { name: /Enforcement Best effort for Claude/ })).toBeTruthy();
  });

  it("flags effort as may-not-apply on Gemini and shows n/a for a model without levels", async () => {
    await ipc.providers.setEnabled("gemini", true);
    render(() => <RolesSection />);
    await waitFor(() => expect(document.querySelectorAll("tbody.roles__role")).toHaveLength(5));
    await waitFor(() => expect(field(row("architect"), "Provider").querySelector('option[value="gemini"]')?.textContent).toBe("Gemini"));
    fireEvent.change(field(row("architect"), "Provider"), { target: { value: "gemini" } });
    await waitFor(() => expect(row("architect").textContent).toContain("may not apply"));
    fireEvent.change(field(row("architect"), "Model"), { target: { value: "gemini-flash" } });
    await waitFor(() => expect(field(row("architect"), "Effort").disabled).toBe(true));
    expect(field(row("architect"), "Effort").selectedOptions[0].textContent).toBe("n/a");
  });
});

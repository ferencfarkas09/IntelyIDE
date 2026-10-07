import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetSettings, settingsSections } from "../../platform/settings";
import { resetCommands, availableCommands } from "../../platform/commands";
import { changeBadgeSlots, resetChangeBadges } from "../../platform/changeBadges";
import { resetTabs, tabTypes } from "../../platform/tabs";
import { resetOverlays, overlays } from "../../platform/overlay";
import { installDomStubs } from "../../store/testing-u2";
import { createMockContract, setContractApi } from "./api";
import ChangeBadge from "./ChangeBadge";
import ContractSection from "./ContractSection";
import ContractTab from "./ContractTab";
import { register } from "./index";
import { clearReport, refresh } from "./store";
import { setContractEnabled } from "./toggle";

installDomStubs();

afterEach(() => {
  cleanup();
  clearReport();
  setContractApi(undefined);
});

const tab = { id: "contract", type: "contract", title: "API contract" };

describe("contract module toggle", () => {
  beforeAll(() => {
    resetSettings();
    resetTabs();
    resetCommands();
    resetOverlays();
    resetChangeBadges();
    register();
  });

  it("registers only the Settings section while it is off", () => {
    expect(settingsSections().map((s) => s.id)).toContain("contract");
    expect(tabTypes().map((t) => t.type)).not.toContain("contract");
    expect(changeBadgeSlots()).toHaveLength(0);
    expect(overlays().map((o) => o.id)).not.toContain("contract.watcher");
  });

  it("adds the tab, badge, watcher and commands when switched on, and removes them again", () => {
    setContractEnabled(true);
    expect(tabTypes().map((t) => t.type)).toContain("contract");
    expect(changeBadgeSlots().map((s) => s.id)).toEqual(["contract"]);
    expect(overlays().map((o) => o.id)).toContain("contract.watcher");
    expect(availableCommands().map((c) => c.id)).toEqual(expect.arrayContaining(["contract.open", "contract.explorer"]));
    setContractEnabled(false);
    expect(tabTypes().map((t) => t.type)).not.toContain("contract");
    expect(changeBadgeSlots()).toHaveLength(0);
    expect(availableCommands().map((c) => c.id)).not.toContain("contract.open");
  });
});

describe("<ContractSection>", () => {
  it("shows the switch", () => {
    render(() => <ContractSection />);
    expect(screen.getByRole("switch", { name: "Enable the API contract tab" })).toBeTruthy();
  });
});

describe("<ContractTab>", () => {
  it("lists findings and filters them per repository and severity", async () => {
    render(() => <ContractTab tab={tab} />);
    await waitFor(() => expect(screen.getAllByTestId("contract-finding")).toHaveLength(8));
    expect(screen.getByText(/Heuristic check/)).toBeTruthy();
    expect(screen.getAllByText("Heuristic").length).toBe(1);
    fireEvent.click(screen.getByRole("radio", { name: "mobile" }));
    expect(screen.getAllByTestId("contract-finding")).toHaveLength(3);
    fireEvent.click(screen.getByRole("radio", { name: "Errors" }));
    expect(screen.getAllByTestId("contract-finding")).toHaveLength(2);
  });

  it("opens the call site and the swagger path through the editor command", async () => {
    const ran: unknown[] = [];
    const { registerCommand } = await import("../../platform/commands");
    const off = registerCommand({ id: "editor.openFile", title: "open", group: "test", run: (a: unknown) => void ran.push(a) });
    render(() => <ContractTab tab={tab} />);
    await waitFor(() => expect(screen.getAllByTestId("contract-finding").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole("button", { name: "Open at call site" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "Open swagger path" })[0]);
    await waitFor(() => expect(ran).toHaveLength(2));
    expect(ran[0]).toMatchObject({ repoId: "admin", path: "src/networking/bankNetworking.js" });
    expect(ran[1]).toMatchObject({ repoId: "backend" });
    off();
  });

  it("explorer: search, schema viewer, generated example and copy as cURL (no request is sent)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(() => <ContractTab tab={{ ...tab, params: { view: "explorer" } }} />);
    const search = await screen.findByPlaceholderText("Search paths, operations or tags");
    fireEvent.input(search, { target: { value: "banks" } });
    fireEvent.click(await screen.findByRole("option", { name: /GET\s*\/api\/banks\/\{bankId\}/ }));
    await screen.findByText("Responses");
    expect(await screen.findAllByText("Example")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy as cURL" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String((writeText.mock.calls[0] as unknown[])[0])).toContain("Bearer <TOKEN>");
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("lists the endpoints no client calls", async () => {
    render(() => <ContractTab tab={{ ...tab, params: { view: "unused" } }} />);
    await waitFor(() => expect(screen.getAllByTestId("contract-unused")).toHaveLength(2));
  });

  it("shows an error from the backend as text", async () => {
    setContractApi({ ...createMockContract(), analyze: async () => Promise.reject(new Error("no swagger")) });
    render(() => <ContractTab tab={tab} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("no swagger"));
  });
});

describe("<ChangeBadge>", () => {
  it("renders for a file with API calls only", async () => {
    await refresh();
    render(() => <ChangeBadge repoId="admin" path="src/networking/bankNetworking.js" />);
    expect(screen.getByTitle("6 API calls, 5 problems")).toBeTruthy();
    cleanup();
    render(() => <ChangeBadge repoId="admin" path="README.md" />);
    expect(document.querySelector(".contract-badge")).toBeNull();
  });
});

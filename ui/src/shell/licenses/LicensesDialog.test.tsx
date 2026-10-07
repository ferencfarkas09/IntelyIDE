import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Component, LicenseIndex, LicenseTexts } from "./types";

const h = vi.hoisted(() => ({ loadIndex: vi.fn(), loadTexts: vi.fn() }));
vi.mock("./data", async (orig) => ({ ...(await orig<typeof import("./data")>()), loadIndex: h.loadIndex, loadTexts: h.loadTexts }));

import { setLocale } from "../../i18n";
import { dispatchKey, registerShortcut, resetKeymap } from "../../platform/keymap";
import { LicenseDataError } from "./data";
import LicensesDialog from "./LicensesDialog";
import { closeLicenses, openLicenses } from "./open";

const XSS = '<script>window.__pwned=1</script><img src=x onerror="window.__pwned=1">';

function makeIndex(n = 900): LicenseIndex {
  const components: Component[] = [];
  for (let i = 0; i < n; i++) {
    const kind = i % 10 === 0 ? "font" : i % 3 === 0 ? "npm" : "cargo";
    const chosen = i % 7 === 0 ? ["Apache-2.0"] : ["MIT"];
    components.push({
      id: `${kind}:pkg-${String(i).padStart(4, "0")}@1.${i}.0`,
      kind,
      name: `pkg-${String(i).padStart(4, "0")}`,
      version: `1.${i}.0`,
      expression: i % 7 === 0 ? "MIT OR Apache-2.0" : "MIT",
      chosen,
      copyright: [`Copyright ${2000 + (i % 25)} Author ${i}`],
      textIds: [chosen[0] === "MIT" ? "mit" : "apache"],
      shippedIn: ["app"],
      distributed: true,
      verdict: "ok",
      sourceUrl: i % 2 === 0 ? `https://crates.io/crates/pkg-${i}` : `https://example.org/pkg-${i}`,
      ...(i === 5 ? { optional: true as const } : {}),
    });
  }
  components[1] = { ...components[1], name: "evil", id: "npm:evil@1.0.0", copyright: [XSS], textIds: ["xss"], note: XSS };
  components[2] = { ...components[2], name: "claude-agent-sdk", id: "manual:claude-agent-sdk", kind: "manual", distributed: false, textIds: [], chosen: ["LicenseRef-Anthropic-Commercial"], expression: "LicenseRef-Anthropic-Commercial" };
  const groups = [
    { id: "MIT", count: components.filter((c) => c.chosen.includes("MIT")).length },
    { id: "Apache-2.0", count: components.filter((c) => c.chosen.includes("Apache-2.0")).length },
  ];
  return {
    schema: 1,
    generator: { tool: "scripts/licenses/gen.mjs", cargoLockSha256: "x", pnpmLockSha256: {}, platforms: [], features: "all" },
    project: { name: "IntelyIDE", license: "GPL-3.0-or-later", copyright: "(c) 2026 Test Holder", textIds: ["gpl"] },
    groups,
    components,
  };
}

const TEXTS: LicenseTexts = {
  schema: 1,
  texts: {
    gpl: { title: "GNU General Public License, version 3", kind: "license", body: "GPL BODY TEXT" },
    mit: { title: "MIT License", kind: "license", body: "MIT BODY TEXT" },
    apache: { title: "Apache License 2.0", kind: "license", body: "APACHE BODY TEXT" },
    xss: { title: "Odd", kind: "license", body: XSS },
  },
};

// jsdom has no layout and no ResizeObserver: give the virtualizer a 300x480 scroll element.
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", RO);
Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 480 });
Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 300 });

const mountOpts = { initialRect: { width: 300, height: 480 }, overscan: 4 };
const open = (o?: Parameters<typeof openLicenses>[0]) => openLicenses(o);
const view = () => render(() => <LicensesDialog {...mountOpts} />);

beforeEach(async () => {
  await setLocale("en");
  resetKeymap();
  closeLicenses();
  h.loadIndex.mockReset().mockResolvedValue(makeIndex());
  h.loadTexts.mockReset().mockResolvedValue(TEXTS);
  (window as unknown as { __pwned?: number }).__pwned = undefined;
});
afterEach(() => {
  cleanup();
  closeLicenses();
});

const options = () => {
  const list = screen.queryByRole("listbox");
  return list ? within(list).queryAllByRole("option") : [];
};

describe("LicensesDialog", () => {
  it("loads nothing before it is opened and shows skeleton rows while loading", async () => {
    let release!: (v: LicenseIndex) => void;
    h.loadIndex.mockReturnValue(new Promise((r) => (release = r)));
    open();
    view();
    expect(h.loadTexts).not.toHaveBeenCalled();
    const loading = await screen.findByText("Loading licenses");
    expect(loading.closest("[aria-busy='true']")).toBeTruthy();
    release(makeIndex(5));
    await screen.findByRole("listbox");
    expect(screen.queryByText("Loading licenses")).toBeNull();
  });

  it("pins the project first, virtualizes ~900 rows and exposes setsize/posinset", async () => {
    open();
    view();
    const list = await screen.findByRole("listbox");
    const opts = options();
    expect(opts.length).toBeGreaterThan(3);
    expect(opts.length).toBeLessThan(60);
    expect(opts[0].textContent).toContain("IntelyIDE (this program)");
    expect(opts[0].getAttribute("aria-posinset")).toBe("1");
    expect(opts[0].getAttribute("aria-setsize")).toBe("901");
    expect(opts[0].getAttribute("aria-selected")).toBe("true");
    expect(list.getAttribute("aria-activedescendant")).toBe(opts[0].id);
    // The pinned entry shows the 5(d) notice and the GPL text from the bundle.
    const region = screen.getByRole("region", { name: "License details" });
    expect(within(region).getByText(/any later version/)).toBeTruthy();
    expect(await within(region).findByText("GPL BODY TEXT")).toBeTruthy();
  });

  it("selects the project entry or a given component when opened with a target", async () => {
    open({ select: "npm:pkg-0003@1.3.0" });
    view();
    await screen.findByRole("listbox");
    const region = screen.getByRole("region", { name: "License details" });
    expect(within(region).getByRole("heading", { level: 3 }).textContent).toContain("pkg-0003");
    expect(await within(region).findByText("MIT BODY TEXT")).toBeTruthy();
  });

  it("searches (tokens are AND-ed) and announces a plural count", async () => {
    open();
    view();
    await screen.findByRole("listbox");
    const box = screen.getByRole("searchbox", { name: "Search open-source components" });
    fireEvent.input(box, { target: { value: "pkg-0010 1.10.0" } });
    await waitFor(() => expect(options().length).toBe(1));
    await waitFor(() => expect(document.querySelector(".lic__count")!.textContent).toBe("1 component"));
    fireEvent.input(box, { target: { value: "pkg-001" } });
    await waitFor(() => expect(document.querySelector(".lic__count")!.textContent).toBe("10 components"));
  });

  it("filters by license and by kind", async () => {
    open();
    view();
    await screen.findByRole("listbox");
    const select = screen.getByRole("combobox", { name: "Filter by license" }) as HTMLSelectElement;
    expect(select.options[0].textContent).toBe("All licenses (900)");
    fireEvent.change(select, { target: { value: "Apache-2.0" } });
    await waitFor(() => expect(document.querySelector(".lic__count")!.textContent).toMatch(/^\d+ components$/));
    expect(options().every((o) => o.textContent!.includes("Apache-2.0"))).toBe(true);
    fireEvent.change(select, { target: { value: "" } });
    fireEvent.click(screen.getByRole("radio", { name: "Fonts" }));
    await waitFor(() => expect(options().every((o) => o.textContent!.includes("pkg-"))).toBe(true));
    await waitFor(() => expect(document.querySelector(".lic__count")!.textContent).toBe("90 components"));
  });

  it("the unfiltered count equals the components in the license filter label (the project entry is not counted)", async () => {
    open();
    view();
    await screen.findByRole("listbox");
    const select = screen.getByRole("combobox", { name: "Filter by license" }) as HTMLSelectElement;
    expect(select.options[0].textContent).toBe("All licenses (900)");
    await waitFor(() => expect(document.querySelector(".lic__count")!.textContent).toBe("900 components"));
  });

  it("shows the empty state and Clear restores the list", async () => {
    open();
    view();
    await screen.findByRole("listbox");
    fireEvent.input(screen.getByRole("searchbox"), { target: { value: "zzzz-nothing" } });
    expect(await screen.findByText("No dependency matches zzzz-nothing")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await screen.findByRole("listbox");
    expect(options().length).toBeGreaterThan(3);
  });

  it("keeps markup in license data as text (no elements, no script run)", async () => {
    open({ select: "npm:evil@1.0.0" });
    view();
    await screen.findByRole("listbox");
    const region = screen.getByRole("region", { name: "License details" });
    await waitFor(() => expect(region.querySelector("pre")?.textContent).toBe(XSS));
    expect(region.querySelector("script, img")).toBeNull();
    expect(region.textContent).toContain("<script>");
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("marks optional and not-bundled components with readable badges", async () => {
    open({ select: "manual:claude-agent-sdk" });
    view();
    await screen.findByRole("listbox");
    const region = screen.getByRole("region", { name: "License details" });
    expect(within(region).getByText("Not bundled")).toBeTruthy();
    expect(within(region).getByText(/Not distributed with IntelyIDE/)).toBeTruthy();
    cleanup();
    closeLicenses();
    open({ select: "cargo:pkg-0005@1.5.0" });
    view();
    await screen.findByRole("listbox");
    expect(within(screen.getByRole("region", { name: "License details" })).getByText("Optional feature")).toBeTruthy();
  });

  it("alternatives of an OR are muted next to the chosen license", async () => {
    open({ select: "cargo:pkg-0007@1.7.0" });
    view();
    await screen.findByRole("listbox");
    const region = screen.getByRole("region", { name: "License details" });
    expect(within(region).getByTitle("License relied on").textContent).toBe("Apache-2.0");
    expect(within(region).getByTitle("Alternative").textContent).toBe("MIT");
  });

  it("only allowlisted hosts open; others are copy-only text with the hostname", async () => {
    const win = vi.spyOn(window, "open").mockReturnValue(null);
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
    open({ select: "cargo:pkg-0008@1.8.0" }); // crates.io
    view();
    await screen.findByRole("listbox");
    let region = screen.getByRole("region", { name: "License details" });
    fireEvent.click(within(region).getByRole("button", { name: /crates\.io/ }));
    expect(win).toHaveBeenCalledWith("https://crates.io/crates/pkg-8", "_blank", "noopener,noreferrer");
    cleanup();
    closeLicenses();
    open({ select: "npm:pkg-0009@1.9.0" }); // example.org
    view();
    await screen.findByRole("listbox");
    region = screen.getByRole("region", { name: "License details" });
    expect(within(region).getAllByText("example.org").length).toBeGreaterThan(0);
    expect(within(region).queryByRole("button", { name: /example\.org/ })).toBeNull();
    fireEvent.click(within(region).getAllByRole("button", { name: "Copy" })[0]);
    await waitFor(() => expect(write).toHaveBeenCalledWith("https://example.org/pkg-9"));
    expect(win).toHaveBeenCalledTimes(1);
    win.mockRestore();
  });

  it("copies a license text and says so", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
    open();
    view();
    await screen.findByRole("listbox");
    await screen.findByText("GPL BODY TEXT");
    const region = screen.getByRole("region", { name: "License details" });
    fireEvent.click(within(region).getAllByRole("button", { name: "Copy" }).at(-1)!);
    await waitFor(() => expect(write).toHaveBeenCalledWith("GPL BODY TEXT"));
    expect(await within(region).findByText("Copied")).toBeTruthy();
  });

  it("shows an error state with Retry, and a failed load is retried", async () => {
    h.loadIndex.mockRejectedValueOnce(new LicenseDataError("load")).mockResolvedValue(makeIndex(20));
    open();
    view();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The license data could not be loaded.");
    expect(alert.textContent).toContain("legal/THIRD_PARTY_LICENSES.md");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("listbox");
    expect(h.loadIndex).toHaveBeenCalledTimes(2);
  });

  it("reports a schema mismatch as an incompatible build", async () => {
    h.loadIndex.mockRejectedValue(new LicenseDataError("schema"));
    open();
    view();
    expect((await screen.findByRole("alert")).textContent).toContain("incompatible build");
  });

  it("keeps the list working when only the texts fail, with an inline Retry", async () => {
    h.loadTexts.mockRejectedValueOnce(new LicenseDataError("load")).mockResolvedValue(TEXTS);
    open();
    view();
    await screen.findByRole("listbox");
    const region = screen.getByRole("region", { name: "License details" });
    expect((await within(region).findByRole("alert")).textContent).toContain("The license texts could not be loaded.");
    fireEvent.click(within(region).getByRole("button", { name: "Retry" }));
    expect(await within(region).findByText("GPL BODY TEXT")).toBeTruthy();
  });

  it("keyboard: arrows move the selection, End/Home jump and the active row stays mounted", async () => {
    open();
    view();
    const list = await screen.findByRole("listbox");
    list.focus();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(options().find((o) => o.getAttribute("aria-selected") === "true")!.textContent).toContain("pkg-");
    const second = list.getAttribute("aria-activedescendant")!;
    expect(document.getElementById(second)?.getAttribute("aria-posinset")).toBe("2");
    fireEvent.keyDown(list, { key: "End" });
    const last = list.getAttribute("aria-activedescendant")!;
    await waitFor(() => expect(document.getElementById(last)).toBeTruthy()); // still mounted although scrolled away from the window
    expect(document.getElementById(last)!.getAttribute("aria-posinset")).toBe("901");
    fireEvent.keyDown(list, { key: "Home" });
    expect(document.getElementById(list.getAttribute("aria-activedescendant")!)!.getAttribute("aria-posinset")).toBe("1");
    fireEvent.keyDown(list, { key: "PageDown" });
    expect(Number(document.getElementById(list.getAttribute("aria-activedescendant")!)!.getAttribute("aria-posinset"))).toBeGreaterThan(2);
  });

  it("keyboard: Enter moves focus to the detail, '/' focuses the search and never reaches the global keymap", async () => {
    const run = vi.fn();
    // A bare "/" cannot be registered (chordProblem); even a Mod chord must not see our slash.
    expect(() => registerShortcut({ keys: "/", run })).toThrow();
    registerShortcut({ keys: "Mod+/", run });
    open();
    view();
    const list = await screen.findByRole("listbox");
    list.focus();
    fireEvent.keyDown(list, { key: "Enter" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("region", { name: "License details" })));
    const slash = new KeyboardEvent("keydown", { key: "/", code: "Slash", bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(slash);
    expect(document.activeElement).toBe(screen.getByRole("searchbox"));
    expect(slash.defaultPrevented).toBe(true);
    expect(dispatchKey(slash, run)).toBe(false);
    expect(run).not.toHaveBeenCalled();
    // Typing a slash into the search box stays a normal character.
    const typed = new KeyboardEvent("keydown", { key: "/", code: "Slash", bubbles: true, cancelable: true });
    screen.getByRole("searchbox").dispatchEvent(typed);
    expect(typed.defaultPrevented).toBe(false);
  });

  it("ArrowDown in the search box moves into the list", async () => {
    open();
    view();
    await screen.findByRole("listbox");
    const box = screen.getByRole("searchbox");
    box.focus();
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("listbox"));
  });

  it("narrow layout: one column, selecting opens the detail, Back returns to the list", async () => {
    open();
    render(() => <LicensesDialog {...mountOpts} narrow />);
    await screen.findByRole("listbox");
    expect(screen.queryByRole("region", { name: "License details" })).toBeNull();
    fireEvent.click(options()[1]);
    const region = await screen.findByRole("region", { name: "License details" });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(within(region).getByRole("button", { name: "Back to the list" }));
    await screen.findByRole("listbox");
    expect(screen.queryByRole("region", { name: "License details" })).toBeNull();
  });

  it("is Hungarian when the language is hu (plural count and labels)", async () => {
    await setLocale("hu");
    open();
    view();
    await screen.findByRole("listbox");
    expect(screen.getByRole("searchbox", { name: "Nyílt forráskódú összetevők keresése" })).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Nyílt forráskódú licencek" })).toBeTruthy();
    expect(document.querySelector(".lic__count")!.textContent).toBe("900 összetevő");
    expect(screen.getByRole("listbox", { name: "Összetevők" })).toBeTruthy();
  });

  it("closes on Escape and the license text pane is ltr", async () => {
    open();
    view();
    await screen.findByRole("listbox");
    await screen.findByText("GPL BODY TEXT");
    expect(screen.getByText("GPL BODY TEXT").getAttribute("dir")).toBe("ltr");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

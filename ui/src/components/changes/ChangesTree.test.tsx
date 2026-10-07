import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { App } from "../../app/App";
import { installLayoutStubs } from "../../app/testLayout";
import { clearSelectedFile, selectedFile } from "../../store/selection";
import { resetTreeState } from "./treeState";

beforeAll(installLayoutStubs);

afterEach(() => {
  cleanup();
  clearSelectedFile();
  resetTreeState();
  localStorage.clear();
});

const tree = () => screen.getByRole("tree", { name: "Changes" });
const row = (name: string) => screen.getByText(name).closest<HTMLElement>('[role="treeitem"]')!;
const press = (key: string) => fireEvent.keyDown(tree(), { key });

async function mountLoaded() {
  render(() => <App />);
  await screen.findByText("shop-backend", {}, { timeout: 3000 });
  await screen.findByText("orderController.js", {}, { timeout: 3000 });
}

describe("ChangesTree", () => {
  it("shows skeletons first, then repos with files, ARIA tree semantics and derived tri-state", async () => {
    render(() => <App />);
    expect(document.querySelector('[aria-label="Loading repositories"]')).not.toBeNull();
    await screen.findByText("orderController.js", {}, { timeout: 3000 });

    expect(tree().getAttribute("aria-multiselectable")).toBe("true");
    const backend = row("shop-backend");
    expect(backend.getAttribute("aria-level")).toBe("1");
    expect(backend.getAttribute("aria-expanded")).toBe("true");
    expect(backend.getAttribute("aria-checked")).toBe("true");
    expect(row("orderController.js").getAttribute("aria-level")).toBe("2");
    expect(row("Unversioned files").getAttribute("aria-expanded")).toBe("false");
  });

  it("toggles a file with Space on the keyboard cursor and turns the repo checkbox mixed", async () => {
    await mountLoaded();
    tree().focus();
    expect(document.activeElement).toBe(tree());
    press("ArrowDown"); // first row after focus puts the cursor on the first repo; this moves to its first file
    press(" ");
    await waitFor(() => expect(row("shop-backend").getAttribute("aria-checked")).toBe("mixed"));
    expect(tree().getAttribute("aria-activedescendant")).toBeTruthy();
    press(" ");
    await waitFor(() => expect(row("shop-backend").getAttribute("aria-checked")).toBe("true"));
  });

  it("leaves Space on a repo action button to the button instead of toggling the tree", async () => {
    await mountLoaded();
    const button = await screen.findByRole("button", { name: /^Commit shop-backend/ });
    expect(row("shop-backend").getAttribute("aria-checked")).toBe("true");
    const notPrevented = fireEvent.keyDown(button, { key: " " });
    expect(notPrevented).toBe(true);
    expect(row("shop-backend").getAttribute("aria-checked")).toBe("true");
  });

  it("opens the first change in the diff at startup", async () => {
    await mountLoaded();
    await waitFor(() => expect(selectedFile()).toEqual({ repoId: "backend", path: "src/api/routes/index.js" }));
  });

  it("opens a file in the diff with Enter and a click", async () => {
    await mountLoaded();
    fireEvent.click(row("orderController.js"));
    expect(selectedFile()).toEqual({ repoId: "backend", path: "src/api/controllers/orderController.js" });
    clearSelectedFile();
    tree().focus();
    press("ArrowDown");
    press("Enter");
    expect(selectedFile()?.repoId).toBe("backend");
  });

  it("collapses and expands a repo with the arrow keys", async () => {
    await mountLoaded();
    clearSelectedFile(); // the shell opens the first change at startup; the cursor would start on that file
    tree().focus();
    press("ArrowLeft");
    await waitFor(() => expect(screen.queryByText("orderController.js")).toBeNull());
    expect(row("shop-backend").getAttribute("aria-expanded")).toBe("false");
    press("ArrowRight");
    await screen.findByText("orderController.js");
  });

  it("shows guarded files with a lock and a disabled checkbox", async () => {
    await mountLoaded();
    const guarded = row("google-services.json");
    expect(guarded.getAttribute("aria-disabled")).toBe("true");
    expect(guarded.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(true);
    expect(guarded.querySelector('[role="img"][aria-label^="Guarded: "]')).not.toBeNull();
    expect(guarded.querySelector('input[type="checkbox"]')!.getAttribute("aria-label")).toContain("cannot be committed");
  });

  it("keeps the per-repo action buttons out of the tab order", async () => {
    await mountLoaded();
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-row="repo"] .chg-actions button')];
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((b) => b.tabIndex === -1)).toBe(true);
  });

  it("puts the action buttons of the repo under the keyboard cursor into the tab order", async () => {
    await mountLoaded();
    tree().focus();
    press("Home");
    await waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-row="repo"][data-cursor] .chg-actions button')?.tabIndex).toBe(0));
    const others = [...document.querySelectorAll<HTMLButtonElement>('[data-row="repo"]:not([data-cursor]) .chg-actions button')];
    expect(others.every((b) => b.tabIndex === -1)).toBe(true);
  });

  it("registers the per-repo message rows with the virtualizer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await mountLoaded();
    fireEvent.click(screen.getByRole("radio", { name: "Per repo" }));
    await waitFor(() => expect(document.querySelector(".chg-message")).not.toBeNull());
    const messages = [...document.querySelectorAll<HTMLElement>(".chg-message")];
    expect(messages.every((m) => m.getAttribute("data-index") !== null)).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("data-index"))).toBe(false);
    warn.mockRestore();
    fireEvent.click(screen.getByRole("radio", { name: "Shared" })); // the mode is module state: do not leak it into the next test
  });

  it("expands Unversioned lazily and lists a folder's files only when it is opened", async () => {
    await mountLoaded();
    fireEvent.click(screen.getAllByText("Unversioned files")[1]);
    await screen.findByText("light-design.md");
    expect(screen.queryByText("tiers.json")).toBeNull();
    fireEvent.click(screen.getAllByText("loyalty")[1]);
    await waitFor(() => expect(screen.getAllByText("tiers.json")).toHaveLength(3), { timeout: 3000 });
  });
});

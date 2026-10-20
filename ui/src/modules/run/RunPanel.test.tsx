import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWorkspace } from "../../store/workspace";
import { resetDevServers, unwireDevServers } from "../../store/devservers";
import { ipc } from "../../ipc";
import { FAVORITES_KEY, resetRunStore } from "./store";
import RunPanel from "./RunPanel";

beforeEach(async () => {
  localStorage.clear();
  resetRunStore();
  await loadWorkspace();
});

/** The mock keeps a stopped server around: forget them all so the next test starts from fresh rows (a stopped one shows Re-run). */
async function forgetServers(): Promise<void> {
  await ipc.run.stopAll();
  for (let i = 0; i < 60 && (await ipc.run.list()).some((s) => s.status === "starting" || s.status === "running" || s.status === "stopping"); i++) await new Promise((r) => setTimeout(r, 50));
  for (const s of await ipc.run.list()) await ipc.run.dismiss(s.id);
}

afterEach(async () => {
  cleanup();
  await forgetServers();
  unwireDevServers();
  resetDevServers();
  resetRunStore();
});

const tab = (name: string) => screen.findByRole("tab", { name: new RegExp(`^${name}`, "i") });

describe("<RunPanel>", () => {
  it("lists the scripts of the first repo in groups, with the body hidden", async () => {
    render(() => <RunPanel />);
    expect(await screen.findByRole("button", { name: "Run npm run dev-local" })).toBeTruthy();
    expect(screen.getByText("Start")).toBeTruthy();
    expect(screen.queryByText(/nodemon src/)).toBeNull();
    // collapsed by default: Build and Other
    expect(screen.queryByText("migrate:task-hours-rates")).toBeNull();
  });

  it("asks before it runs a confirm script, and nothing starts if the answer is Cancel", async () => {
    render(() => <RunPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Run npm run dev-local" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Forbidden to agents");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(await ipc.run.list()).toEqual([]);
  });

  it("starts a plain script, shows its port chip, log and a stop button", async () => {
    render(() => <RunPanel />);
    fireEvent.click(await tab("admin"));
    fireEvent.click(await screen.findByRole("button", { name: "Run npm run start" }));
    expect(await screen.findByRole("button", { name: "Stop npm run start" })).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText(":8082").length).toBeGreaterThan(0), { timeout: 3000 });
    expect(screen.getByRole("log").textContent).toContain("Compiled successfully");
    expect(screen.getByRole("log").textContent).toContain("GH_TOKEN=***");
    fireEvent.click(screen.getByRole("button", { name: "Stop npm run start" }));
    await waitFor(() => expect(screen.getByRole("log").textContent).toContain("exited"), { timeout: 3000 });
  });

  it("warns before a second heavy server and starts it only on Start anyway", async () => {
    render(() => <RunPanel />);
    fireEvent.click(await tab("admin"));
    fireEvent.click(await screen.findByRole("button", { name: "Run npm run start" }));
    await screen.findByRole("button", { name: "Stop npm run start" });
    fireEvent.click(screen.getByRole("button", { name: "Run npm run start-local-web" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("heavy server");
    fireEvent.click(screen.getByRole("button", { name: "Start anyway" }));
    expect(await screen.findByRole("button", { name: "Stop npm run start-local-web" })).toBeTruthy();
  });

  it("reveals the masked command only on request", async () => {
    render(() => <RunPanel />);
    fireEvent.click(await tab("shop-pos"));
    fireEvent.click(await screen.findByRole("button", { name: /^Other/ }));
    const show = await screen.findByRole("button", { name: "Show command of login:github" });
    expect(screen.queryByText(/GH_TOKEN=…/)).toBeNull();
    fireEvent.click(show);
    expect((await screen.findByText(/GH_TOKEN=…/)).textContent).not.toMatch(/ghp_/);
    expect(screen.getByText("env GH_TOKEN")).toBeTruthy();
  });

  it("pins a starred script into Favorites at the top, once, and remembers it", async () => {
    render(() => <RunPanel />);
    fireEvent.click(await tab("admin"));
    await screen.findByRole("button", { name: "Run npm run start" });
    expect(screen.queryByRole("button", { name: /^Favorites/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add test to the favorites" }));
    const head = await screen.findByRole("button", { name: /^Favorites/ });
    const all = [...document.querySelectorAll(".run-group__head")];
    expect(all[0]).toBe(head);
    expect(screen.getAllByRole("button", { name: "Run npm run test" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Remove test from the favorites" }).getAttribute("aria-pressed")).toBe("true");
    expect(JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "{}")).toEqual({ admin: ["npm:test"] });
    // a fresh session reads it back
    cleanup();
    resetRunStore();
    render(() => <RunPanel />);
    fireEvent.click(await tab("admin"));
    expect(await screen.findByRole("button", { name: /^Favorites/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove test from the favorites" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Favorites/ })).toBeNull());
    expect(localStorage.getItem(FAVORITES_KEY)).toBe("{}");
  });

  it("keeps the favorites of one repo out of another", async () => {
    render(() => <RunPanel />);
    fireEvent.click(await tab("admin"));
    fireEvent.click(await screen.findByRole("button", { name: "Add start to the favorites" }));
    await screen.findByRole("button", { name: /^Favorites/ });
    fireEvent.click(await tab("shop-pos"));
    await screen.findByRole("button", { name: "Run npm run dev" });
    expect(screen.queryByRole("button", { name: /^Favorites/ })).toBeNull();
  });

  it("starts a favorite with one click and offers Re-run once it has stopped", async () => {
    render(() => <RunPanel />);
    fireEvent.click(await tab("admin"));
    fireEvent.click(await screen.findByRole("button", { name: "Add lint to the favorites" }));
    fireEvent.click(await screen.findByRole("button", { name: "Run npm run lint" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop npm run lint" }));
    // stopped: the row's button and the log bar both say Re-run
    expect(await screen.findByRole("button", { name: "Re-run npm run lint" }, { timeout: 3000 })).toBeTruthy();
    const logBar = await screen.findByRole("button", { name: "Re-run" });
    fireEvent.click(logBar);
    expect(await screen.findByRole("button", { name: "Stop npm run lint" })).toBeTruthy();
  });

  it("asks again before it re-runs a script that needs a confirmation", async () => {
    render(() => <RunPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Run npm run dev-local" }));
    fireEvent.click(await screen.findByRole("button", { name: "Run anyway" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop npm run dev-local" }));
    fireEvent.click(await screen.findByRole("button", { name: "Re-run npm run dev-local" }, { timeout: 3000 }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Forbidden to agents");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByRole("button", { name: "Re-run npm run dev-local" })).toBeTruthy();
  });

  it("starts the first match with Enter, the favorites first", async () => {
    render(() => <RunPanel />);
    fireEvent.click(await tab("admin"));
    fireEvent.click(await screen.findByRole("button", { name: "Add test:e2e to the favorites" }));
    const filter = await screen.findByRole("textbox", { name: "Filter scripts" });
    fireEvent.input(filter, { target: { value: "test" } });
    fireEvent.keyDown(filter, { key: "Enter" });
    // "test" comes before "test:e2e" in the Test group, but the favorite is listed first
    expect(await screen.findByRole("button", { name: "Stop npm run test:e2e" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop npm run test" })).toBeNull();
  });

  it("filters the scripts", async () => {
    render(() => <RunPanel />);
    fireEvent.input(await screen.findByRole("textbox", { name: "Filter scripts" }), { target: { value: "lint" } });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Run npm run dev-local" })).toBeNull());
    expect(screen.getByRole("button", { name: "Run npm run lint" })).toBeTruthy();
  });
});

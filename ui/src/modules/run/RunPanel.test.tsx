import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWorkspace } from "../../store/workspace";
import { resetDevServers, unwireDevServers } from "../../store/devservers";
import { ipc } from "../../ipc";
import { resetRunStore } from "./store";
import RunPanel from "./RunPanel";

beforeEach(async () => {
  await loadWorkspace();
});

afterEach(async () => {
  cleanup();
  await ipc.run.stopAll();
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

  it("filters the scripts", async () => {
    render(() => <RunPanel />);
    fireEvent.input(await screen.findByRole("textbox", { name: "Filter scripts" }), { target: { value: "lint" } });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Run npm run dev-local" })).toBeNull());
    expect(screen.getByRole("button", { name: "Run npm run lint" })).toBeTruthy();
  });
});

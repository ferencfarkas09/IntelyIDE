import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", async (orig) => {
  const mod = await orig<typeof import("../../ipc")>();
  const { createMockIpc } = await import("../../ipc/mock");
  return { ...mod, ipc: createMockIpc("normal", { delayScale: 0 }) };
});

import { ipc } from "../../ipc";
import { createMockTeam } from "../../ipc/mock/team";
import { installDomStubs } from "../../store/testing-u2";
import MemoryPane from "./MemoryPane";

installDomStubs();
vi.setConfig({ testTimeout: 30000 });

afterEach(cleanup);

describe("shared memory pane", () => {
  it("lists the synced files with their author and resolves a conflict", async () => {
    (ipc as { team: unknown }).team = createMockTeam({ preset: "on" });
    render(() => <MemoryPane />);
    expect(await screen.findByText("memory/MEMORY.md")).toBeTruthy();
    expect(screen.getAllByText("CLAUDE.md").length).toBeGreaterThan(0);
    expect(screen.getByText(/Riley, version 12/)).toBeTruthy();
    const conflict = await screen.findByTestId("memory-conflict");
    expect(conflict.textContent).toContain("Jo");
    fireEvent.click(screen.getByRole("button", { name: "Keep theirs" }));
    await waitFor(() => expect(screen.queryByTestId("memory-conflict")).toBeNull());
  });

  it("use mine bumps the version and clears the conflict", async () => {
    (ipc as { team: unknown }).team = createMockTeam({ preset: "on" });
    render(() => <MemoryPane />);
    fireEvent.click(await screen.findByRole("button", { name: "Use mine" }));
    await waitFor(() => expect(screen.queryByTestId("memory-conflict")).toBeNull());
    expect(await screen.findByText(/You, version 7/)).toBeTruthy();
  });

  it("holds a teammate's CLAUDE.md until it is applied, with a diff first", async () => {
    (ipc as { team: unknown }).team = createMockTeam({ preset: "on" });
    render(() => <MemoryPane />);
    const card = await screen.findByTestId("memory-pending");
    expect(card.textContent).toContain("Jordan changed CLAUDE.md");
    fireEvent.click(screen.getByRole("button", { name: "View diff" }));
    const diff = await screen.findByTestId("memory-diff");
    expect(diff.textContent).toContain("Never force-push.");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.queryByTestId("memory-pending")).toBeNull());
  });

  it("ignore drops the card without touching the file list", async () => {
    (ipc as { team: unknown }).team = createMockTeam({ preset: "on" });
    render(() => <MemoryPane />);
    fireEvent.click(await screen.findByRole("button", { name: "Ignore" }));
    await waitFor(() => expect(screen.queryByTestId("memory-pending")).toBeNull());
  });
});

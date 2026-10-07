import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", async (orig) => {
  const mod = await orig<typeof import("../../ipc")>();
  const { createMockIpc } = await import("../../ipc/mock");
  return { ...mod, ipc: createMockIpc("normal", { delayScale: 0 }) };
});
const agents = vi.hoisted(() => ({ rows: [] as unknown[], listeners: new Set<() => void>() }));
vi.mock("../../store/agents", async (orig) => {
  const mod = await orig<typeof import("../../store/agents")>();
  return { ...mod, agentRows: () => agents.rows as never[] };
});

import { ipc } from "../../ipc";
import { RunHeader } from "../../components/chat/RunHeader";
import { capsOfProvider } from "../../ipc/providerCaps";
import { setShowOtherWorkspaces } from "../../store/agentScope";
import { enterEmptyState, loadWorkspace, workspaceState } from "../../store/workspace";
import { resetWorkspacesForTest, startWorkspaces, workspaces } from "../../store/workspaces";
import { installDomStubs } from "../../store/testing-u2";
import { defaultRepos } from "./newRunLogic";
import { SessionsSidebar } from "./SessionsSidebar";
import { row } from "./testing";

installDomStubs();
let stop: (() => void) | undefined;

beforeEach(async () => {
  localStorage.clear();
  resetWorkspacesForTest();
  enterEmptyState();
  setShowOtherWorkspaces(false);
  agents.rows = [
    row({ agentId: "mine", title: "Fix the order list", repoIds: ["admin"] }),
    row({ agentId: "foreign", title: "Client X crm work", status: "done", repoIds: ["crm-9f8e7d6c5b"] }),
    row({ agentId: "mixed", title: "Across both", status: "done", repoIds: ["admin", "crm-9f8e7d6c5b"] }),
  ];
  stop = startWorkspaces(ipc as never);
  await waitFor(() => expect(workspaceState()).toBe("ready"));
  await waitFor(() => expect(workspaces().length).toBe(3));
  await loadWorkspace();
});
afterEach(() => {
  cleanup();
  stop?.();
  vi.restoreAllMocks();
});

describe("sessions of other workspaces", () => {
  it("are hidden by default, with a count and the toggle; the toggle shows them read-only with the way forward", async () => {
    const { container } = render(() => <SessionsSidebar />);
    const titles = () => [...container.querySelectorAll(".run-card__title")].map((n) => n.textContent);
    expect(titles()).toEqual(["Fix the order list"]);
    expect(screen.getByRole("status").textContent).toBe("2 runs from other workspaces are hidden");
    fireEvent.click(screen.getByRole("checkbox", { name: "Show other workspaces" }));
    await waitFor(() => expect(titles()).toHaveLength(3));
    const cards = container.querySelectorAll<HTMLElement>(".run-card[data-foreign]");
    expect(cards).toHaveLength(2);
    expect([...cards].map((c) => c.querySelector(".run-card__foreign")?.textContent)).toEqual(['Open workspace "Client X" to continue', "This run belongs to another workspace."]);
    expect(container.querySelector(".sessions__hidden")).toBeNull();
  });

  it("the role filter choices only offer repositories of the shown runs", async () => {
    const { container } = render(() => <SessionsSidebar />);
    const repoSelect = screen.getByLabelText("Filter by repository") as HTMLSelectElement;
    expect([...repoSelect.options].map((o) => o.value)).toEqual(["", "admin"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Show other workspaces" }));
    await waitFor(() => expect([...repoSelect.options].length).toBeGreaterThan(2));
    void container;
  });
});

describe("Rewind of a run of another workspace", () => {
  const header = (repoIds: string[], status: "done" | "running" = "done") => render(() => <RunHeader agent={row({ agentId: "a", status, repoIds, caps: capsOfProvider("claude") })} stopping={false} onInterrupt={() => undefined} onRewind={() => undefined} />);

  it("is off with a reason; a run of the open workspace can still be rewound", async () => {
    const view = header(["crm-9f8e7d6c5b"]);
    const rewind = view.container.querySelector<HTMLButtonElement>('button[aria-label="Rewind"]')!;
    expect(rewind.getAttribute("aria-disabled") === "true" || rewind.disabled).toBe(true);
    expect(view.container.querySelector(".run-header__scope")?.textContent).toBe('Open workspace "Client X" to continue');
    cleanup();
    const mine = header(["admin"]);
    const own = mine.container.querySelector<HTMLButtonElement>('button[aria-label="Rewind"]')!;
    expect(own.getAttribute("aria-disabled")).not.toBe("true");
    expect(mine.container.querySelector(".run-header__scope")).toBeNull();
  });
});

describe("role default repositories", () => {
  it("are filtered to the repositories of the open workspace when a run is prepared", () => {
    const known = ["admin", "backend"];
    expect(defaultRepos({ defaultRepoIds: ["admin", "crm-9f8e7d6c5b", "backend"] }, known)).toEqual(["admin", "backend"]);
  });
});

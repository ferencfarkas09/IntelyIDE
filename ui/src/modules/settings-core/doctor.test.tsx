import { cleanup, configure, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", async (orig) => {
  const mod = await orig<typeof import("../../ipc")>();
  const { createMockIpc } = await import("../../ipc/mock");
  return { ...mod, ipc: createMockIpc("normal", { delayScale: 0 }) };
});

import { loadWorkspace } from "../../store/workspace";
import DoctorChecks from "./DoctorChecks";
import { createMockDoctor, setDoctorApi } from "./doctorApi";
import { counts, formatAge, formatBytes, groupChecks, itemText, messageOf, summaryText } from "./doctorLogic";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
configure({ asyncUtilTimeout: 15000 });
vi.setConfig({ testTimeout: 30000 });

beforeEach(async () => {
  await loadWorkspace();
});
afterEach(() => {
  cleanup();
  setDoctorApi(undefined);
});

const name = (id: string) => id;

describe("doctor logic", () => {
  it("formats sizes and ages", () => {
    expect([formatBytes(512), formatBytes(2048), formatBytes(5 * 1024 ** 3), formatBytes(96 * 1024 ** 2)]).toEqual(["512 B", "2.0 KB", "5.0 GB", "96.0 MB"]);
    expect([formatAge(5), formatAge(180), formatAge(4000)]).toEqual(["5 min", "3 h", "3 d"]);
  });

  it("groups in the fixed order and counts levels", async () => {
    const { checks } = await createMockDoctor().run();
    expect(groupChecks(checks).map((g) => g.group)).toEqual(["tools", "credentials", "path", "disk", "repo", "leftovers"]);
    expect(counts(checks)).toMatchObject({ error: 0, warn: 3 });
  });

  it("writes translated lines with sizes and ages, and the summary carries names only", async () => {
    const { checks } = await createMockDoctor().run();
    const lock = checks.find((c) => c.code === "lock.stale")!;
    expect(messageOf(lock, name)).toBe("admin: lock files older than 10 min (nothing is deleted; remove them yourself if no git command is running)");
    expect(itemText(lock.items[0])).toBe("index.lock (3 h)");
    expect(itemText(checks.find((c) => c.code === "untracked.large")!.items[0])).toBe("crm-export/ (1,840 files, 58.0 MB)");
    expect(messageOf(checks.find((c) => c.code === "disk.ok")!, name)).toContain("212 GB free");
    const text = summaryText(checks, name, [{ level: "warn", text: "claude: not signed in" }], new Date("2026-10-04T10:00:00Z"));
    expect(text.split("\n")[0]).toBe("IntelyIDE Doctor, 2026-10-04T10:00:00.000Z");
    expect(text).toContain("[WARN] claude: not signed in");
    expect(text).toContain("[OK] git 2.50.1");
    expect(text).toContain("    - /usr/bin/git");
    expect(text).toContain("[WARN] admin: lock files");
    expect(text).not.toMatch(/token|password|secret/i);
  });
});

describe("<DoctorChecks>", () => {
  it("lists the checks by group with levels, names and the safe fix", async () => {
    setDoctorApi(createMockDoctor());
    render(() => <DoctorChecks />);
    await waitFor(() => expect(document.querySelector('[data-code="lock.stale"]')).toBeTruthy());
    for (const g of ["Tools", "Credentials", "PATH", "Disk space", "Repositories", "IDE leftovers"]) expect(screen.getByRole("region", { name: g })).toBeTruthy();
    expect(document.querySelector('[data-code="lock.stale"]')!.getAttribute("data-level")).toBe("warn");
    expect(document.querySelector('[data-code="lock.stale"]')!.textContent).toContain("index.lock (3 h)");
    expect(document.querySelector('[data-code="tool.missing"]')!.textContent).toContain("codex was not found");
    expect(screen.getByRole("status").textContent).toBe("0 problems, 3 warnings, 8 OK");
    expect(screen.getAllByRole("button", { name: "Refresh environment" })).toHaveLength(1);
  });

  it("refreshes the environment from the Fix button and re-runs the report", async () => {
    const api = createMockDoctor();
    const refresh = vi.fn(api.refreshEnv);
    setDoctorApi({ ...api, refreshEnv: refresh });
    render(() => <DoctorChecks />);
    fireEvent.click(await screen.findByRole("button", { name: "Refresh environment" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    await waitFor(() => expect(document.querySelector('[data-code="path.guiMinimal"]')).toBeNull());
    expect(document.querySelector('[data-code="path.guiOk"]')).toBeTruthy();
  });

  it("copies the summary to the clipboard", async () => {
    setDoctorApi(createMockDoctor());
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(() => <DoctorChecks extra={[{ provider: "claude", level: "warn", code: "x", message: "needs sign-in" }]} />);
    await screen.findByRole("status");
    fireEvent.click(screen.getByRole("button", { name: "Copy summary" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0][0]).toContain("[WARN] claude: needs sign-in");
    expect(writeText.mock.calls[0][0]).toContain("[WARN]");
  });

  it("says so when the checks cannot run", async () => {
    setDoctorApi({ run: () => Promise.reject(new Error("no")), refreshEnv: async () => {} });
    render(() => <DoctorChecks />);
    expect(await screen.findByText("The system checks could not run.")).toBeTruthy();
  });

  it("an all-green machine has no fix button", async () => {
    setDoctorApi(createMockDoctor("clean"));
    render(() => <DoctorChecks />);
    await screen.findByRole("status");
    expect(screen.queryByRole("button", { name: "Refresh environment" })).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/^0 problems, 0 warnings/);
  });
});

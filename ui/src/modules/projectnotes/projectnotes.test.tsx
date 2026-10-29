import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import sidecarNotes from "../../../../sidecar/src/adapters/claude-sdk/project-notes.ts?raw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockIpc } from "../../ipc/mock";
import { setVibeIpc, type NotesPlan } from "../../ipc/vibe";
import { maskLocally } from "../../ipc/mock/vibe";
import { installDomStubs } from "../../store/testing-u2";
import { loadWorkspace } from "../../store/workspace";
import { byteLength, FILE_MAX, hasImports, planWarnings, sizeLevel, starterPrompt } from "./logic";
import NotesTab from "./NotesTab";

installDomStubs();
afterEach(() => {
  cleanup();
  setVibeIpc(undefined);
});

const plan = (o: Partial<NotesPlan> = {}): NotesPlan => ({ files: [], total: 0, fileMax: 32768, totalMax: 98304, userMax: 32768, leftOut: [], ...o });
const file = (o: Partial<NotesPlan["files"][number]>) => ({ scope: "project" as const, dirIndex: 0, rel: "CLAUDE.md", path: "/r/CLAUDE.md", size: 10, text: "x", length: 10, shortened: false, ...o });

describe("limits and warnings", () => {
  it("uses the per-file cap of the sidecar", () => {
    expect(sidecarNotes).toContain(`PROJECT_FILE_MAX_BYTES = ${FILE_MAX / 1024} * 1024`);
  });

  it("measures in bytes and grades the size", () => {
    expect(byteLength("é")).toBe(2);
    expect(sizeLevel(100)).toBe("ok");
    expect(sizeLevel(20 * 1024)).toBe("large");
    expect(sizeLevel(40 * 1024)).toBe("over");
  });

  it("warns about cut files, the total, files left out and imports", () => {
    const w = planWarnings(plan({ files: [file({ size: 40_000, shortened: true }), file({ text: "intro\n@docs/rules.md\n" })], total: 98304, leftOut: ["/r/CLAUDE.local.md"] }));
    expect(w.map((x) => x.code)).toEqual(["overFile", "overTotal", "leftOut", "imports"]);
    expect(hasImports("email me @ home")).toBe(false);
  });

  it("asks the agent for CLAUDE.md only, without secrets and without committing", () => {
    const p = starterPrompt("shop-app", false);
    expect(p).toContain("shop-app");
    expect(p).toContain("Only create or edit CLAUDE.md. Do not commit or push");
    expect(p).toContain("Never put secrets");
    expect(starterPrompt("shop-app", true)).toMatch(/^Improve the CLAUDE.md/);
  });
});

describe("the panel", () => {
  it("shows what a run is told and warns about a secret in the file being edited", async () => {
    const projectNotes = vi.fn(async () => plan({ files: [file({ scope: "user", dirIndex: null, path: "~/.claude/CLAUDE.md", text: "Be brief." }), file({ text: "Use pnpm." })], total: 20 }));
    setVibeIpc({ maskText: async (t) => maskLocally(t), setupChecks: async () => [], projectNotes });
    await loadWorkspace(createMockIpc("normal", { delayScale: 0 }));
    render(() => <NotesTab />);
    await waitFor(() => expect(projectNotes).toHaveBeenCalled());
    expect(await screen.findByText("~/.claude/CLAUDE.md")).toBeTruthy();
    fireEvent.click(screen.getByText("~/.claude/CLAUDE.md"));
    expect(screen.getByText("Be brief.")).toBeTruthy();
    // the mock repository has no CLAUDE.md: it can be created from a skeleton
    fireEvent.click(await screen.findByRole("button", { name: "Create CLAUDE.md" }));
    const box = screen.getByRole("textbox", { name: "CLAUDE.md of this repository" }) as HTMLTextAreaElement;
    fireEvent.input(box, { target: { value: "API_TOKEN=abcdef1234567890" } });
    expect(await screen.findByText(/looks like it contains a secret/)).toBeTruthy();
  });
});

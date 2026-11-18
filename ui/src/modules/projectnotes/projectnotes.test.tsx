import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import sidecarNotes from "../../../../sidecar/src/adapters/claude-sdk/project-notes.ts?raw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../ipc";
import type { FileRead } from "../../ipc/files";
import { createMockIpc } from "../../ipc/mock";
import { setVibeIpc, type NotesPlan } from "../../ipc/vibe";
import { maskLocally } from "../../ipc/mock/vibe";
import { installDomStubs } from "../../store/testing-u2";
import { loadWorkspace } from "../../store/workspace";
import { byteLength, editableReason, FILE_MAX, fromDisk, hasImports, planWarnings, sizeLevel, starterPrompt, toDiskText } from "./logic";
import NotesTab from "./NotesTab";

installDomStubs();
afterEach(() => {
  cleanup();
  setVibeIpc(undefined);
  vi.restoreAllMocks();
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
    fireEvent.input(box, { target: { value: ["API_TOKEN", "abcdef1234567890"].join("=") } });
    expect(await screen.findByText(/looks like it contains a secret/)).toBeTruthy();
  });

  it("lists the token-saving habits after the files only while Settings > Token saver switched them on", async () => {
    setVibeIpc({ maskText: async (t) => maskLocally(t), setupChecks: async () => [], projectNotes: async () => plan({ files: [file({ text: "Use pnpm." })], total: 9 }) });
    await loadWorkspace(createMockIpc("normal", { delayScale: 0 }));
    await ipc.settings.set("agents", { tokenHabits: false });
    const first = render(() => <NotesTab />);
    expect(await screen.findByText("/r/CLAUDE.md")).toBeTruthy();
    expect(screen.queryByTestId("pnotes-habits")).toBeNull();
    first.unmount();
    await ipc.settings.set("agents", { tokenHabits: true });
    render(() => <NotesTab />);
    const entry = await screen.findByTestId("pnotes-habits");
    fireEvent.click(entry.querySelector("button")!);
    expect(entry.textContent).toContain("Token-saving habits. The user switched these on");
  });
});

describe("saving keeps the file's line endings and encoding", () => {
  it("converts CRLF only for the text box and back on save, and refuses what a text box cannot keep", () => {
    expect(fromDisk("a\r\nb\r\n", "crlf")).toBe("a\nb\n");
    expect(toDiskText("a\nb\nc", "crlf")).toBe("a\r\nb\r\nc");
    expect(toDiskText("a\nb", "lf")).toBe("a\nb");
    expect(editableReason("crlf", "utf8Bom")).toBeUndefined();
    expect(editableReason("mixed", "utf8")).toBe("mixed");
    expect(editableReason("lf", "utf16le")).toBe("encoding");
    expect(editableReason("lf", "latin2")).toBe("encoding");
  });

  const disk = (o: Partial<FileRead> & { text: string }): FileRead => ({ binary: false, tooLarge: false, size: o.text.length, mtimeMs: 1000, eol: "lf", encoding: "utf8", guard: "ok", ...o });

  async function openWith(file: FileRead) {
    setVibeIpc({ maskText: async (t) => t, setupChecks: async () => [], projectNotes: async () => ({ files: [], total: 0, fileMax: 32768, totalMax: 98304, userMax: 32768, leftOut: [] }) });
    await loadWorkspace(createMockIpc("normal", { delayScale: 0 }));
    vi.spyOn(ipc.files, "listDir").mockResolvedValue([{ name: "CLAUDE.md", kind: "file" }]);
    const read = vi.spyOn(ipc.files, "readFile").mockResolvedValue(file);
    const write = vi.spyOn(ipc.files, "writeFile").mockResolvedValue({ mtimeMs: 2000 });
    render(() => <NotesTab />);
    const box = (await screen.findByRole("textbox", { name: "CLAUDE.md of this repository" })) as HTMLTextAreaElement;
    return { box, read, write };
  }

  it("writes a CRLF file with BOM back as CRLF with BOM", async () => {
    const { box, write } = await openWith(disk({ text: "# Notes\r\n- pnpm\r\n", eol: "crlf", encoding: "utf8Bom" }));
    expect(box.value).toBe("# Notes\n- pnpm\n");
    fireEvent.input(box, { target: { value: "# Notes\n- pnpm\n- tests\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(write).toHaveBeenCalled());
    expect(write.mock.calls[0][2]).toBe("# Notes\r\n- pnpm\r\n- tests\r\n");
    expect(write.mock.calls[0][4]).toEqual({ encoding: "utf8Bom" });
  });

  it("shows a file with mixed line endings read-only", async () => {
    const { box, write } = await openWith(disk({ text: "a\r\nb\n", eol: "mixed" }));
    expect(box.readOnly).toBe(true);
    expect(screen.getByText(/mixes Windows and Unix line endings/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses to save over a file that changed on disk, even within the same millisecond", async () => {
    const { box, read, write } = await openWith(disk({ text: "one\n" }));
    read.mockResolvedValue(disk({ text: "someone else\n" }));
    fireEvent.input(box, { target: { value: "mine\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(1));
    expect(write).not.toHaveBeenCalled();
  });

  it("asks before unsaved changes are dropped by a refresh", async () => {
    const { box, read } = await openWith(disk({ text: "one\n" }));
    fireEvent.input(box, { target: { value: "changed\n" } });
    const before = read.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("CLAUDE.md has changes that are not saved.")).toBeTruthy();
    expect(read.mock.calls.length).toBe(before);
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(box.value).toBe("changed\n");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(before));
  });
});

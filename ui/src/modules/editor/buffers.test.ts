import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { cleanup, fireEvent, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerTabType, resetTabs, tabs } from "../../platform/tabs";
import { FileText, toast } from "../../ui-kit";
import { attachView, beforeCloseFile, buffers, currentText, keepMine, noteEdited, openFile, overwrite, recentFiles, reopenWithEncoding, resetBuffers, revealSecret, saveBuffer, savedDoc, useDiskVersion } from "./buffers";
import { fileTabId } from "./logic";

const mock = () => (window as unknown as { __mockFiles: { tree: Map<string, string>; savedAs: Map<string, string | undefined>; external(path: string, text: string | null, repoId?: string): void } }).__mockFiles;
const REPO = "backend";

beforeEach(() => registerTabType({ type: "file", title: "File", icon: FileText, canClose: true, beforeClose: beforeCloseFile, component: () => null }));
afterEach(() => {
  cleanup();
  resetBuffers();
  resetTabs();
  localStorage.clear();
});

/** A stand-in for the CodeMirror view: the buffer store only reads `state`. */
function edit(id: string, text: string): void {
  const view = { state: EditorState.create({ doc: text }), destroy() {}, dispatch() {} } as unknown as EditorView;
  attachView(id, view);
  noteEdited(id, view.state);
}

async function open(path: string) {
  const id = openFile(REPO, path) && fileTabId(REPO, path);
  await waitFor(() => expect(buffers[id].status).not.toBe("loading"));
  return id;
}

describe("file buffers", () => {
  it("loads a file into a tab, detects its indentation and remembers it as recent", async () => {
    const id = await open("src/api/controllers/orderController.js");
    expect(buffers[id]).toMatchObject({ status: "ready", eol: "lf", dirty: false });
    expect(buffers[id].indent.label).toBe("Tabs");
    expect(tabs().map((t) => t.id)).toContain(id);
    expect(recentFiles()[0]).toEqual({ repoId: REPO, path: "src/api/controllers/orderController.js" });
  });

  it("marks a buffer dirty when the text differs and clean again when it is back to the saved text", async () => {
    const id = await open("src/index.ts");
    edit(id, "changed\n");
    expect(buffers[id].dirty).toBe(true);
    expect(tabs().find((t) => t.id === id)?.dirty).toBe(true);
    edit(id, savedDoc(id)!.toString());
    expect(buffers[id].dirty).toBe(false);
  });

  it("saves with the loaded mtime, restores CRLF line breaks and clears the dirty flag", async () => {
    const id = await open("docs/windows.txt");
    edit(id, "one\ntwo\n");
    expect(currentText(id)).toBe("one\r\ntwo\r\n");
    expect(await saveBuffer(id)).toBe(true);
    expect(mock().tree.get("docs/windows.txt")).toBe("one\r\ntwo\r\n");
    expect(buffers[id].dirty).toBe(false);
    expect(tabs().find((t) => t.id === id)?.dirty).toBe(false);
  });

  it("reloads a clean buffer when the file changes on disk", async () => {
    const id = await open("README.md");
    mock().external("README.md", "# Edited elsewhere\n");
    await waitFor(() => expect(savedDoc(id)!.toString()).toBe("# Edited elsewhere\n"));
    expect(buffers[id].dirty).toBe(false);
    expect(buffers[id].conflict).toBeUndefined();
  });

  it("keeps a dirty buffer and offers a choice; a refused save becomes a stale conflict that Overwrite resolves", async () => {
    const id = await open("package.json");
    edit(id, "mine\n");
    mock().external("package.json", "theirs\n");
    await waitFor(() => expect(buffers[id].conflict?.kind).toBe("external"));
    expect(buffers[id].conflict?.disk?.text).toBe("theirs\n");
    expect(savedDoc(id)!.toString()).not.toBe("theirs\n");

    expect(await saveBuffer(id)).toBe(false);
    expect(buffers[id].conflict?.kind).toBe("stale");
    expect(mock().tree.get("package.json")).toBe("theirs\n");

    await overwrite(id);
    expect(mock().tree.get("package.json")).toBe("mine\n");
    expect(buffers[id].dirty).toBe(false);
    expect(buffers[id].conflict).toBeUndefined();
  });

  it("lets the user take the disk version instead", async () => {
    const id = await open("src/util/format.ts");
    edit(id, "mine\n");
    mock().external("src/util/format.ts", "theirs\n");
    await waitFor(() => expect(buffers[id].conflict).toBeDefined());
    useDiskVersion(id);
    expect(buffers[id].dirty).toBe(false);
    expect(buffers[id].conflict).toBeUndefined();
    expect(savedDoc(id)!.toString()).toBe("theirs\n");
  });

  it("flags a file deleted on disk and recreates it when the user keeps editing", async () => {
    const id = await open("docs/notes.txt");
    mock().external("docs/notes.txt", null);
    await waitFor(() => expect(buffers[id].conflict?.kind).toBe("deleted"));
    keepMine(id);
    expect(buffers[id]).toMatchObject({ dirty: true, mtimeMs: 0 });
    expect(buffers[id].conflict).toBeUndefined();
    edit(id, "back\n");
    expect(await saveBuffer(id)).toBe(true);
    expect(mock().tree.get("docs/notes.txt")).toBe("back\n");
  });

  it("keeps secret files behind a placeholder until they are revealed", async () => {
    const id = await open(".env");
    expect(buffers[id].status).toBe("secret");
    expect(savedDoc(id)).toBeUndefined();
    await revealSecret(id);
    expect(buffers[id].status).toBe("ready");
    expect(savedDoc(id)!.toString()).toBe("SECRET=1\n");
  });

  it("reports binary and too large files without text", async () => {
    expect(buffers[await open("assets/logo.png")].status).toBe("binary");
    expect(buffers[await open("data/export.json")].status).toBe("tooLarge");
  });

  it("asks before closing a dirty tab and closes after Don't save", async () => {
    const id = await open("src/index.ts");
    expect(beforeCloseFile({ id, title: "index.ts" })).toBe(true);
    edit(id, "dirty\n");
    expect(beforeCloseFile({ id, title: "index.ts" })).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "Don't save" }));
    await waitFor(() => expect(tabs().some((t) => t.id === id)).toBe(false));
  });

  it("reopens a closed file from disk instead of the old buffer", async () => {
    const id = await open("README.md");
    resetTabs();
    registerTabType({ type: "file", title: "File", icon: FileText, canClose: true, component: () => null });
    mock().tree.set("README.md", "# Fresh\n");
    const again = await open("README.md");
    expect(again).toBe(id);
    expect(savedDoc(again)!.toString()).toBe("# Fresh\n");
  });
});

describe("encodings and files over 5 MiB", () => {
  it("shows the encoding the backend detected and saves the file back in it", async () => {
    const id = await open("docs/hu-latin2.txt");
    expect(buffers[id]).toMatchObject({ status: "ready", encoding: "latin2", partial: false });
    expect(savedDoc(id)!.toString()).toContain("árvíztűrő");
    edit(id, "árvíztűrő változott\n");
    expect(await saveBuffer(id)).toBe(true);
    expect(mock().savedAs.get("docs/hu-latin2.txt")).toBe("latin2");
  });

  it("reopens with another encoding and keeps writing in it", async () => {
    const id = await open("docs/hu-latin2.txt");
    await reopenWithEncoding(id, "latin1");
    expect(buffers[id].encoding).toBe("latin1");
    expect(savedDoc(id)!.toString()).toContain("õ");
    edit(id, "õ\n");
    await saveBuffer(id);
    expect(mock().savedAs.get("docs/hu-latin2.txt")).toBe("latin1");
    // Reopening reads the file again (the mock keeps text, so put the original back).
    mock().tree.set("docs/hu-latin2.txt", "árvíztűrő tükörfúrógép\n");
    await reopenWithEncoding(id, "windows1250");
    expect(buffers[id]).toMatchObject({ encoding: "windows1250", dirty: false });
    expect(savedDoc(id)!.toString()).toContain("árvíztűrő");
    mock().savedAs.clear();
    edit(id, "árvíztűrő!\n");
    await saveBuffer(id);
    expect(mock().savedAs.get("docs/hu-latin2.txt")).toBe("windows1250");
  });

  it("keeps the current encoding when the bytes do not fit the one picked", async () => {
    const id = await open("docs/hu-latin2.txt");
    await reopenWithEncoding(id, "utf8");
    expect(buffers[id]).toMatchObject({ status: "ready", encoding: "latin2" });
    expect(toast.toasts().some((t) => t.title === "Could not reopen as UTF-8")).toBe(true);
  });

  it("asks before reopening drops unsaved edits", async () => {
    const id = await open("docs/hu-latin2.txt");
    edit(id, "mine\n");
    const reopening = reopenWithEncoding(id, "windows1250");
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await reopening;
    expect(buffers[id]).toMatchObject({ encoding: "latin2", dirty: true });
  });

  it("opens a file over 5 MiB as a read-only prefix and never saves it", async () => {
    const id = await open("data/huge.log");
    expect(buffers[id]).toMatchObject({ status: "ready", partial: true });
    expect(savedDoc(id)!.toString()).toContain("order 1 accepted");
    edit(id, "overwritten\n");
    expect(await saveBuffer(id)).toBe(false);
    expect(mock().tree.get("data/huge.log")).toContain("order 1 accepted");
  });
});

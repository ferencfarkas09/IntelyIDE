import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi, setAttachApi, type AttachApi } from "./api";
import { AttachmentChips, MessageAttachments } from "./Chips";
import { capRefusal } from "./composer";
import { guardForContent, guardForPath } from "./guards";
import type { Decoded, ImageDeps } from "./imagePipeline";
import { closeLightbox, lightboxImage } from "./lightbox";
import { promptWithAttachments } from "./newRunPrompt";
import { createAttachmentStore, repoForPath } from "./store";
import { shellEscapePath } from "./targets";
import { itemFromPath } from "../../platform/dropzone";

let api: ReturnType<typeof createMockApi>;
const okImages: ImageDeps = {
  decode: async () => ({ width: 100, height: 100 }) as Decoded,
  encode: async (_s, _w, _h, mime) => new Blob([new Uint8Array(500)], { type: mime }),
};
const mk = (extra: Partial<Parameters<typeof createAttachmentStore>[0]> = {}) => createAttachmentStore({ key: "t", draftId: "draft1", imageDeps: okImages, ...extra });
const file = (name: string, body: string | Uint8Array, type = "text/plain") => new File([body as BlobPart], name, { type });

beforeEach(() => {
  api = createMockApi();
  setAttachApi(api);
  globalThis.URL.createObjectURL ??= () => "blob:x";
  globalThis.URL.revokeObjectURL ??= () => {};
});
afterEach(() => setAttachApi(undefined));

describe("guards", () => {
  it("flags secret, never-add and credential paths but not templates", () => {
    expect(guardForPath("/p/.env")?.reason).toBe("secret");
    expect(guardForPath("/p/server.pem")?.reason).toBe("secret");
    expect(guardForPath("/p/id_rsa")?.reason).toBe("secret");
    expect(guardForPath("/p/.env.example")).toBeNull();
    expect(guardForPath("/p/dump_2024/a.txt")?.reason).toBe("neverAdd");
    expect(guardForPath("/Users/me/.ssh/config")?.reason).toBe("neverRead");
    expect(guardForPath("/p/readme.md")).toBeNull();
    expect(guardForContent("x\n-----BEGIN RSA PRIVATE KEY-----")?.reason).toBe("key");
  });
});

describe("capability gate", () => {
  const f = itemFromPath("/a/doc.pdf");
  const i = itemFromPath("/a/pic.png");
  const t = itemFromPath("/a/code.ts");
  it("refuses everything when the provider takes no attachments", () => {
    expect(capRefusal("none", [i], "Codex")).toBe("Codex does not take attachments");
  });
  it("images-only and images+pdf", () => {
    expect(capRefusal("images", [i], "X")).toBeUndefined();
    expect(capRefusal("images", [i, t], "X")).toBe("X accepts images only");
    expect(capRefusal("imagesPdf", [i, f], "X")).toBeUndefined();
    expect(capRefusal("imagesPdf", [t], "X")).toBe("X accepts images and PDFs only");
    expect(capRefusal("files", [t, f, i], "X")).toBeUndefined();
    expect(capRefusal(undefined, [t], "X")).toBeUndefined();
  });
  it("ignores dropped text and URLs", () => {
    expect(capRefusal("files", [{ kind: "text", name: "t", mime: "text/plain", size: 1 }], "X")).toBe("Only files and images can be attached");
  });
});

describe("shell escape", () => {
  it("escapes like Terminal.app", () => {
    expect(shellEscapePath("/Users/me/My Files/a (1).png")).toBe("/Users/me/My\\ Files/a\\ \\(1\\).png");
    expect(shellEscapePath("/tmp/it's.txt")).toBe("/tmp/it\\'s.txt");
    expect(shellEscapePath("/plain/path-1.2_x")).toBe("/plain/path-1.2_x");
  });
});

describe("repoForPath", () => {
  const repos = [{ id: "admin", path: "/w/admin" }, { id: "sub", path: "/w/admin/sub" }];
  it("finds the deepest repo and the relative path", () => {
    expect(repoForPath("/w/admin/src/a.ts", repos)).toMatchObject({ repo: { id: "admin" }, rel: "src/a.ts" });
    expect(repoForPath("/w/admin/sub/x", repos)?.repo.id).toBe("sub");
    expect(repoForPath("/w/admin2/x", repos)).toBeUndefined();
    expect(repoForPath("/w/admin", repos)).toMatchObject({ rel: "" });
  });
});

describe("AttachmentStore", () => {
  it("adds a text file as a ready chip, dedupes, and removes", async () => {
    const s = mk();
    await s.addFiles([file("notes.md", "# hi", "text/markdown")]);
    expect(s.items()).toHaveLength(1);
    expect(s.items()[0]).toMatchObject({ name: "notes.md", kind: "text", status: "ready", inline: true });
    await s.addFiles([file("copy.md", "# hi", "text/markdown")]);
    expect(s.items()).toHaveLength(1);
    expect(s.items()[0].note).toBe("already attached");
    await s.remove(s.items()[0].id);
    expect(s.items()).toHaveLength(0);
    expect(await api.list("draft1")).toHaveLength(0);
    s.dispose();
  });

  it("processes an image into a chip with a thumbnail and a note", async () => {
    const s = mk();
    await s.addFiles([file("shot.png", new Uint8Array(2000), "image/png")]);
    const a = s.items()[0];
    expect(a).toMatchObject({ kind: "image", status: "ready", name: "shot.png" });
    expect(a.thumb).toBeTruthy();
    expect(a.size).toBe(2000); // fits already: only the metadata is stripped
    expect(a.note).toBe("metadata removed");
    s.dispose();
  });

  it("shows an error chip for an image the WebView cannot decode", async () => {
    const s = mk({ imageDeps: { decode: async () => null, encode: okImages.encode } });
    await s.addFiles([file("a.heic", new Uint8Array(10), "image/heic")]);
    expect(s.items()[0]).toMatchObject({ status: "error" });
    expect(s.items()[0].error).toMatch(/cannot decode/);
    expect(s.selection().ids).toEqual([]);
    s.dispose();
  });

  it("blocks sending until a guarded file is explicitly confirmed", async () => {
    const s = mk();
    await s.addFiles([file(".env", "TOKEN=abc")]);
    const a = s.items()[0];
    expect(a.guard?.reason).toBe("secret");
    expect(s.blocker()).toMatch(/Confirm or remove \.env/);
    await s.confirm(a.id);
    expect(s.items()[0].confirmed).toBe(true);
    expect(s.blocker()).toBeUndefined();
    expect(s.selection()).toEqual({ draftId: "draft1", ids: [a.id] });
    s.dispose();
  });

  it("guards by content too (a private key in notes.txt)", async () => {
    const s = mk();
    await s.addFiles([file("notes.txt", "x\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc")]);
    expect(s.items()[0].guard?.reason).toBe("key");
    s.dispose();
  });

  it("native drops: folders in a repo become path references, folders outside are refused, files are copied", async () => {
    api.inspect = async (paths) => paths.map((p) => ({ path: p, name: p.split("/").pop()!, isDir: p.endsWith("/src"), size: 3, guard: null }));
    api.importPaths = async (draftId, paths) => Promise.all(paths.map(async (p) => ({ path: p, imported: await api.importBytes(draftId, new Blob(["abc"]), p.split("/").pop()!, "text/plain", p) })));
    const s = mk({ repos: () => [{ id: "admin", path: "/w/admin" }] });
    await s.addDropItems([itemFromPath("/w/admin/src"), itemFromPath("/elsewhere/src"), itemFromPath("/w/admin/a.txt")]);
    const byName = Object.fromEntries(s.items().map((a) => [a.name, a]));
    expect(byName["src/"]).toMatchObject({ kind: "folder", status: "ready", repoId: "admin", relPath: "src" });
    expect(byName["src"]).toMatchObject({ kind: "folder", status: "error" });
    expect(byName["a.txt"]).toMatchObject({ kind: "text", status: "ready" });
    expect(s.folderRefs()).toHaveLength(1);
    expect(s.selection().ids).toHaveLength(1);
    s.dispose();
  });

  it("rotate starts a fresh draft after a send", async () => {
    const s = createAttachmentStore({ key: "rot", imageDeps: okImages });
    const first = s.draftId();
    await s.addFiles([file("a.txt", "a")]);
    s.rotate();
    expect(s.draftId()).not.toBe(first);
    expect(s.items()).toHaveLength(0);
    expect(await api.list(first)).toHaveLength(1); // the message still references the old draft's files
    s.dispose();
  });

  it("restores the chips of a persisted draft after a restart", async () => {
    await api.importBytes("keep1", new Blob(["x"]), "kept.txt", "text/plain");
    const s = mk({ draftId: "keep1" });
    await waitFor(() => expect(s.items().map((a) => a.name)).toEqual(["kept.txt"]));
    s.dispose();
  });
});

describe("chips", () => {
  const base = { mime: "text/plain", size: 2048, status: "ready" as const, confirmed: false };
  it("shows name, size and kind and removes", async () => {
    const onRemove = vi.fn();
    render(() => <AttachmentChips items={[{ ...base, id: "1", name: "a.ts", kind: "text" }]} provider="Anthropic (Claude)" onRemove={onRemove} onConfirm={() => {}} />);
    expect(screen.getByText("a.ts")).toBeTruthy();
    expect(screen.getByText(/text · 2\.0 KB/)).toBeTruthy();
    expect(screen.getByTestId("att-privacy").textContent).toMatch(/sent to Anthropic \(Claude\)/);
    fireEvent.click(screen.getByRole("button", { name: "Remove a.ts" }));
    expect(onRemove).toHaveBeenCalledWith("1");
  });
  it("shows a blocking warning for a guarded file that needs an explicit confirm", () => {
    const onConfirm = vi.fn();
    render(() => <AttachmentChips items={[{ ...base, id: "2", name: ".env", kind: "text", guard: { reason: "secret", detail: "the name looks like a secret or key file" } }]} provider="Anthropic (Claude)" onRemove={() => {}} onConfirm={onConfirm} />);
    expect(screen.getByTestId("att-guard").textContent).toMatch(/May contain secrets.*would be sent to Anthropic \(Claude\)/);
    fireEvent.click(screen.getByRole("button", { name: "Attach anyway" }));
    expect(onConfirm).toHaveBeenCalledWith("2");
  });
  it("opens the lightbox from an image chip", () => {
    render(() => <AttachmentChips items={[{ ...base, id: "3", name: "p.png", kind: "image", mime: "image/png", thumb: "blob:p" }]} provider="X" onRemove={() => {}} onConfirm={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview p.png" }));
    expect(lightboxImage()).toMatchObject({ src: "blob:p", name: "p.png" });
    closeLightbox();
  });
  it("renders the attachments of a transcript message", () => {
    render(() => <MessageAttachments items={[{ id: "z", name: "spec.pdf", mime: "application/pdf", size: 4096, kind: "pdf", sha256: "x" }]} />);
    expect(screen.getByText("spec.pdf")).toBeTruthy();
  });
});

describe("New Run prompt", () => {
  it("inlines small text files and lists the others by path under the store", async () => {
    const s = mk();
    await s.addFiles([file("notes.md", "hello", "text/markdown"), file("p.png", new Uint8Array(100), "image/png")]);
    const out = await promptWithAttachments("Fix it", s);
    expect(out).toContain("Fix it");
    expect(out).toContain("File: notes.md\n```\nhello\n```");
    expect(out).toMatch(/- \/mock\/attachments\/draft1\/.+\/p\.png/);
    s.dispose();
  });
});

describe("api stand-in limits", () => {
  it("rejects bad draft ids and over-limit files", async () => {
    await expect(api.importBytes("../x", new Blob(["a"]), "a.txt")).rejects.toMatchObject({ code: "badId" });
    await expect(api.importBytes("d", new Blob([new Uint8Array(5 * 1024 * 1024 + 1)]), "a.png", "image/png")).rejects.toMatchObject({ code: "tooLarge" });
    await expect(api.importBytes("d", new Blob([new Uint8Array(10 * 1024 * 1024 + 1)]), "a.pdf", "application/pdf")).rejects.toMatchObject({ code: "tooLarge" });
    expect((await api.importBytes("d", new Blob(["a"]), "../../evil.sh", "text/plain")).meta.name).toBe("evil.sh");
  });
});
void (undefined as unknown as AttachApi);

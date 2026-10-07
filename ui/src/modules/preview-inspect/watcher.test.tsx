import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../store/workspace", () => {
  const repos = [
    { id: "admin", name: "admin", color: "#8b6cf0", badge: "AD", path: "/r/admin", order: 0, pushTargets: {} },
    { id: "pos", name: "pos", color: "#4caf7d", badge: "PO", path: "/r/pos", order: 1, pushTargets: {} },
  ];
  return { repos: () => repos, repoConfig: (id: string) => repos.find((r) => r.id === id), workspace: () => undefined };
});

import { registerCommand, resetCommands, execute } from "../../platform/commands";
import { resetKeymap } from "../../platform/keymap";
import { toast } from "../../ui-kit";
import { register } from "./index";
import PickerAndWatcher from "./PickerAndWatcher";
import { CHANNEL } from "./protocol";
import { inspecting, picker, setInspecting, setPicker } from "./state";

const ORIGIN = "http://127.0.0.1:5555";
const good = { intely: CHANNEL, file: "/r/admin/src/Login.js", line: 34, col: 7, componentName: "LoginForm" };
let frame: HTMLIFrameElement;
let opened: unknown[];
let now = 1_000_000;

function post(data: unknown, over: { origin?: string; source?: unknown } = {}) {
  window.dispatchEvent(new MessageEvent("message", { data, origin: over.origin ?? ORIGIN, source: ("source" in over ? over.source : frame.contentWindow) as MessageEventSource }));
}

beforeEach(() => {
  opened = [];
  now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => (now += 1000));
  registerCommand({ id: "editor.openFile", title: "Open file", group: "File", run: (a) => void opened.push(a) });
  frame = document.createElement("iframe");
  frame.setAttribute("data-intely-preview", "");
  frame.dataset.repoId = "admin";
  frame.src = `${ORIGIN}/`;
  document.body.appendChild(frame);
  render(() => <PickerAndWatcher />);
});

afterEach(() => {
  cleanup();
  frame.remove();
  resetCommands();
  resetKeymap();
  setInspecting(false);
  setPicker(undefined);
  vi.restoreAllMocks();
  toast.clear();
});

describe("preview inspect watcher", () => {
  it("opens the file of a valid message from the preview frame", async () => {
    post(good);
    await waitFor(() => expect(opened).toEqual([{ repoId: "admin", path: "src/Login.js", line: 34, column: 7 }]));
  });

  it("ignores messages from any other window, even with a valid payload", async () => {
    const other = document.createElement("iframe");
    document.body.appendChild(other);
    post(good, { source: other.contentWindow });
    post(good, { source: window });
    post(good, { source: null });
    await new Promise((r) => setTimeout(r, 30));
    expect(opened).toEqual([]);
    other.remove();
  });

  it("ignores messages whose origin is not the frame's own loopback origin", async () => {
    for (const origin of ["https://evil.example", "null", "http://127.0.0.1:6666", "http://localhost.evil.example:5555", "tauri://localhost"]) post(good, { origin });
    await new Promise((r) => setTimeout(r, 30));
    expect(opened).toEqual([]);
  });

  it("ignores payloads that are not exactly the inspector message", async () => {
    post({ ...good, extra: "cookie=1" });
    post({ ...good, file: "../../etc/passwd" });
    post("inspect/1");
    post(null);
    await new Promise((r) => setTimeout(r, 30));
    expect(opened).toEqual([]);
  });

  it("never opens a file outside the registered repos", async () => {
    for (const file of ["/etc/passwd", "/r/admin-evil/src/a.js", "/Users/x/.ssh/id_rsa", "/r/pos/../admin/src/a.js"]) post({ ...good, file, componentName: "" });
    await new Promise((r) => setTimeout(r, 30));
    expect(opened).toEqual([]);
  });

  it("does not execute anything for a frame that lost its marker", async () => {
    frame.removeAttribute("data-intely-preview");
    post(good);
    await new Promise((r) => setTimeout(r, 30));
    expect(opened).toEqual([]);
  });

  it("asks which definition when a name matches several files", async () => {
    // drive the picker directly: the search plumbing is covered by nameLookup.test.ts
    setPicker({ name: "Login", candidates: [{ repoId: "admin", path: "src/Login.js", line: 4, col: 1, preview: "function Login() {" }, { repoId: "admin", path: "src/old/Login.js", line: 9, col: 1, preview: "function Login() {" }] });
    const rows = await screen.findAllByRole("option");
    expect(rows).toHaveLength(2);
    rows[1]!.click();
    await waitFor(() => expect(opened).toEqual([{ repoId: "admin", path: "src/old/Login.js", line: 9, column: 1 }]));
    expect(picker()).toBeUndefined();
  });

  it("the Inspect toggle tells preview frames, addressed to their own origin only", async () => {
    const spy = vi.spyOn(frame.contentWindow!, "postMessage");
    register();
    await execute("preview.inspect.toggle");
    await waitFor(() => expect(inspecting()).toBe(true));
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ intely: "inspect.mode/1", on: true }, ORIGIN));
    expect(document.documentElement.hasAttribute("data-intely-inspecting")).toBe(true);
    await execute("preview.inspect.toggle");
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ intely: "inspect.mode/1", on: false }, ORIGIN));
  });
});

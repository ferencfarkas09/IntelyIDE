import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../store/workspace", () => {
  const repos = [{ id: "admin", name: "admin", color: "#8b6cf0", badge: "AD", path: "/r/admin", order: 0, pushTargets: {} }];
  return { repos: () => repos, repoConfig: (id: string) => repos.find((r) => r.id === id), workspace: () => undefined };
});

import { registerCommand, resetCommands } from "../../platform/commands";
import { resetKeymap } from "../../platform/keymap";
import { newRunPrefill, takeNewRunPrefill } from "../../platform/newRun";
import { createMockWebtools, setWebtoolsApi } from "../webtools/api";
import { setWebtoolsEnabled } from "../webtools/toggle";
import PickerAndWatcher from "./PickerAndWatcher";
import { STYLE_CHANNEL } from "./protocol";
import { setInspecting, setPicker, setStyleInfo, styleInfo } from "./state";

const ORIGIN = "http://127.0.0.1:5555";
const style = { intely: STYLE_CHANNEL, tag: "div", id: "", classes: ["card"], styles: { display: "flex", color: "rgb(1, 2, 3)", "background-color": "red; x" }, width: 300, height: 80 };
let frame: HTMLIFrameElement;
let opened: unknown[];
let asked: string[];
let now = 0;

function post(data: unknown, over: { origin?: string; source?: unknown } = {}) {
  window.dispatchEvent(new MessageEvent("message", { data, origin: over.origin ?? ORIGIN, source: ("source" in over ? over.source : frame.contentWindow) as MessageEventSource }));
}

beforeEach(() => {
  opened = [];
  asked = [];
  setWebtoolsApi(createMockWebtools());
  now = 5_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  setInspecting(true);
  registerCommand({ id: "editor.openFile", title: "Open file", group: "File", run: (a) => void opened.push(a) });
  registerCommand({ id: "runs.new", title: "New run", group: "Runs", run: () => void asked.push(newRunPrefill()?.prompt ?? "") });
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
  setStyleInfo(undefined);
  setWebtoolsEnabled(true);
  takeNewRunPrefill();
  setWebtoolsApi(undefined);
});

describe("the element style panel", () => {
  it("opens on the second message of a preview frame and shows the key styles", async () => {
    post(style);
    await waitFor(() => expect(screen.getByTestId("pi-style")).toBeTruthy());
    expect(screen.getByText("div.card")).toBeTruthy();
    expect(screen.getByText("300×80")).toBeTruthy();
    expect(screen.getByText("flex")).toBeTruthy();
    // the colour value is not a plain colour (it carries more CSS), so it is shown as text and never painted
    expect(document.querySelectorAll(".pi__sw")).toHaveLength(1);
  });

  it("opens only while the person is picking, and not again within half a second", async () => {
    setInspecting(false);
    post(style);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("pi-style")).toBeNull();
    // the frame has the focus after an Alt-click in it
    frame.tabIndex = 0;
    frame.focus();
    post(style);
    await waitFor(() => expect(screen.getByTestId("pi-style")).toBeTruthy());
    setStyleInfo(undefined);
    now += 10; // the next message comes 10 ms after the first
    post({ ...style, classes: ["second"] });
    await new Promise((r) => setTimeout(r, 20));
    expect(styleInfo()).toBeUndefined();
    now += 2000;
    post({ ...style, classes: ["third"] });
    await waitFor(() => expect(styleInfo()?.hint.classes).toEqual(["third"]));
  });

  it("ignores the message from anything that is not a preview frame, or from the wrong origin", async () => {
    post(style, { source: window });
    post(style, { origin: "https://evil.test" });
    post({ ...style, tag: "DIV" });
    await new Promise((r) => setTimeout(r, 20));
    expect(styleInfo()).toBeUndefined();
    expect(screen.queryByTestId("pi-style")).toBeNull();
  });

  it("is off when the Web & Node tools are switched off", async () => {
    setWebtoolsEnabled(false);
    post(style);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("pi-style")).toBeNull();
  });

  it("Find the CSS rule opens the best match in the editor", async () => {
    post(style);
    await waitFor(() => expect(screen.getByTestId("pi-style")).toBeTruthy());
    fireEvent.click(screen.getByText("Find the CSS rule"));
    await waitFor(() => expect(opened).toEqual([{ repoId: "admin", path: "src/Card.scss", line: 3, column: 1 }]));
  });

  it("says when no rule was found", async () => {
    post({ ...style, classes: ["nothing-here"] });
    await waitFor(() => expect(screen.getByTestId("pi-style")).toBeTruthy());
    fireEvent.click(screen.getByText("Find the CSS rule"));
    await waitFor(() => expect(screen.getByText(/No CSS rule with these classes/)).toBeTruthy());
    expect(opened).toEqual([]);
  });

  it("Ask agent to restyle this fills the New run dialog and says no screenshot is attached", async () => {
    post(style);
    await waitFor(() => expect(screen.getByTestId("pi-style")).toBeTruthy());
    fireEvent.click(screen.getByText("Ask agent to restyle this"));
    await waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]).toContain("div.card, 300x80px");
    expect(newRunPrefill()?.repoIds).toEqual(["admin"]);
    expect(screen.getByText(/No screenshot is attached/)).toBeTruthy();
  });

  it("closes", async () => {
    post(style);
    await waitFor(() => expect(screen.getByTestId("pi-style")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Close"));
    expect(screen.queryByTestId("pi-style")).toBeNull();
  });
});

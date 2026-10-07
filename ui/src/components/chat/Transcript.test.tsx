import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyView, reduceEvents } from "../../store/agent-reducer";
import type { AgentEvent } from "../../store/agent-types";
import { installDomStubs } from "../../store/testing-u2";
import { ipc } from "../../ipc";
import { Transcript } from "./Transcript";

installDomStubs();
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ev = (seq: number, p: object) => ({ agentId: "a1", seq, ts: seq, provider: "claude", ...p }) as AgentEvent;
const view = (extra: object[] = []) =>
  reduceEvents(emptyView("a1"), [ev(1, { kind: "user.message", messageId: "u", text: "hi" }), ...extra.map((p, i) => ev(i + 2, p))]);

/** jsdom has no layout: give the scroller a height and a settable scrollTop. */
async function scroller(): Promise<HTMLElement> {
  const log = await screen.findByRole("log");
  let top = 0;
  Object.defineProperties(log, { scrollHeight: { value: 5000, configurable: true }, clientHeight: { value: 400, configurable: true }, scrollTop: { get: () => top, set: (v: number) => void (top = v), configurable: true } });
  await new Promise((r) => setTimeout(r, 0));
  return log;
}
const jump = () => screen.queryByRole("button", { name: /Jump to/ });
/** Animation frames that only run when the test says so, in the order they were requested. */
function manualFrames() {
  let next = 1;
  const queue = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => (queue.set(next, cb), next++));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => void queue.delete(id));
  return {
    flush() {
      for (let guard = 0; queue.size && guard < 100; guard++) {
        const [id, cb] = queue.entries().next().value!;
        queue.delete(id);
        cb(0);
      }
    },
  };
}
const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

describe("<Transcript> follow mode", () => {
  it("does not let a layout-driven scroll event switch following off", async () => {
    render(() => <Transcript agentId="a1" view={view()} />);
    const log = await scroller();
    log.scrollTop = 100;
    fireEvent.scroll(log);
    await frame();
    expect(jump()).toBeNull();
  });

  it("pauses on a wheel up and resumes once the bottom is reached again", async () => {
    render(() => <Transcript agentId="a1" view={view()} />);
    const log = await scroller();
    log.scrollTop = 100;
    log.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    await waitFor(() => expect(jump()).toBeTruthy());
    expect(jump()!.getAttribute("aria-label")).toBe("Jump to latest");
    log.scrollTop = 4560;
    fireEvent.scroll(log);
    await waitFor(() => expect(jump()).toBeNull());
  });

  it("never lets a pin queued by the stream undo a scroll the user has just started", async () => {
    const [v, setV] = createSignal(view());
    let seq = 10;
    const stream = () => setV((cur) => reduceEvents(cur, [ev(++seq, { kind: "user.message", messageId: `m${seq}`, text: "more" })]));
    render(() => <Transcript agentId="a1" view={v()} />);
    const log = await scroller();
    const frames = manualFrames();
    frames.flush();
    log.scrollTop = 4600;
    fireEvent.scroll(log);

    // The stream queues a pin; the user wheels up in the same frame; the stream delivers once more before the frame runs.
    stream();
    log.scrollTop = 100;
    log.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    stream();
    frames.flush();

    expect(log.scrollTop).toBe(100);
    expect(jump()).toBeTruthy();
    // And following still works for a reader who is at the bottom.
    log.scrollTop = 4600;
    fireEvent.scroll(log);
    stream();
    frames.flush();
    expect(log.scrollTop).toBe(5000);
    expect(jump()).toBeNull();
  });

  it("holds the pin until the release has looked at the scroll position, whichever frame was queued first", async () => {
    const [v, setV] = createSignal(view());
    let seq = 10;
    render(() => <Transcript agentId="a1" view={v()} />);
    const log = await scroller();
    const frames = manualFrames();
    frames.flush();
    log.scrollTop = 4600;
    fireEvent.scroll(log);

    // Wheel first, then the stream: the pin is queued AFTER the release frame, and used to run after it, unconditionally.
    log.scrollTop = 100;
    log.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    setV((cur) => reduceEvents(cur, [ev(++seq, { kind: "user.message", messageId: `m${seq}`, text: "more" })]));
    frames.flush();
    expect(log.scrollTop).toBe(100);
    await waitFor(() => expect(jump()).toBeTruthy());
  });

  it("does not pin on a layout resize between the wheel and the release frame", async () => {
    const observers: { cb: () => void; target?: Element }[] = [];
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      private entry: { cb: () => void; target?: Element };
      constructor(cb: () => void) {
        this.entry = { cb };
        observers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.target = target;
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      render(() => <Transcript agentId="a1" view={view()} />);
      const log = await scroller();
      const frames = manualFrames();
      frames.flush();
      log.scrollTop = 4600;
      fireEvent.scroll(log);
      log.scrollTop = 100;
      log.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      // A row measured itself and the content grew: that is layout, but it used to scroll to the bottom before the release frame ran.
      // Every observer on the content, whichever component made it (the scroll area has one too).
      const onContent = observers.filter((o) => o.target === log.firstElementChild);
      expect(onContent.length).toBeGreaterThan(0);
      onContent.forEach((o) => o.cb());
      expect(log.scrollTop).toBe(100);
      frames.flush();
      expect(log.scrollTop).toBe(100);
      expect(jump()).toBeTruthy();
    } finally {
      globalThis.ResizeObserver = original;
    }
  });

  it("pauses when the scrollbar is dragged", async () => {
    render(() => <Transcript agentId="a1" view={view()} />);
    const log = await scroller();
    log.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    log.scrollTop = 200;
    fireEvent.scroll(log);
    expect(jump()).toBeTruthy();
    window.dispatchEvent(new PointerEvent("pointerup"));
  });

  it("points the jump button at a pending request and keeps the listener silent", async () => {
    const v = view([{ kind: "permission.request", reqId: "p", toolId: "t", intent: { class: "exec", summary: "Run ls" }, options: ["allowOnce", "deny"] }]);
    render(() => <Transcript agentId="a1" view={v} />);
    const log = await scroller();
    expect(log.getAttribute("aria-live")).toBe("off");
    log.scrollTop = 100;
    log.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    await waitFor(() => expect(jump()?.getAttribute("aria-label")).toBe("Jump to request"));
  });

  it("drops the turn marker that repeats an error banner", () => {
    const v = view([
      { kind: "error", class: "network", message: "reset", retryable: true },
      { kind: "turn.end", stopReason: "error" },
    ]);
    render(() => <Transcript agentId="a1" view={v} />);
    expect(screen.queryByText("This turn ended with an error.")).toBeNull();
  });
});

describe("<Transcript> step limit", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(900);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(600);
  });
  afterEach(() => vi.restoreAllMocks());
  const tool = (i: number, extra: object = {}) => ({ kind: "tool.start", toolId: `t${i}`, name: "Read", toolKind: "read", input: { file_path: "/a" }, ...extra });
  const limit = [tool(1), tool(2), tool(3, { parentToolId: "t1" }), { kind: "turn.end", stopReason: "maxTurns" }];

  it("shows one row with the step count and a Continue button that sends 'Continue' as a new turn of the same run", async () => {
    const send = vi.spyOn(ipc, "agentSend").mockResolvedValue(undefined as never);
    render(() => <Transcript agentId="a1" view={view(limit)} />);
    expect(await screen.findByText("The run reached its step limit (2 steps).")).toBeTruthy();
    expect(screen.getAllByTestId("step-limit")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe("a1");
    expect(send.mock.calls[0]![1]).toBe("Continue");
  });

  it("offers no Continue while a turn is running or once the user went on", async () => {
    const running = view([...limit, { kind: "user.message", messageId: "u2", text: "go on" }, { kind: "turn.start", turnId: "t2" }]);
    render(() => <Transcript agentId="a1" view={running} />);
    expect(await screen.findByText("The run reached its step limit (2 steps).")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });
});

describe("<Transcript> permission cards", () => {
  // jsdom has no layout: the virtualiser draws rows only for a scroller that has a size.
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(900);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(600);
  });
  afterEach(() => vi.restoreAllMocks());
  const exitPlan = { kind: "permission.request", reqId: "p1", toolId: "t1", intent: { class: "other", tool: "ExitPlanMode", summary: "ExitPlanMode: leave plan mode" }, options: ["allow_once", "deny"], plan: "## Plan\n1. do it", modes: ["ask", "edit", "automatic"] };

  it("renders ExitPlanMode as the plan approval card with the full plan", async () => {
    render(() => <Transcript agentId="a1" view={view([exitPlan])} />);
    expect(await screen.findByRole("group", { name: "Plan approval" })).toBeTruthy();
    expect(screen.getByText("do it")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Permission request" })).toBeNull();
  });

  it("still renders a delegate's ExitPlanMode and every other request as the ordinary card", async () => {
    const delegate = { ...exitPlan, intent: { ...exitPlan.intent, actor: { agentId: "s1", role: "developer" } } };
    const other = { kind: "permission.request", reqId: "p2", toolId: "t2", intent: { class: "exec", rawCommand: "ls", summary: "ls" }, options: ["allow_once", "allow_run", "deny"], sessionAllow: { kind: "exec", scope: "ls" } };
    render(() => <Transcript agentId="a1" view={view([delegate, other])} />);
    expect(await screen.findAllByRole("group", { name: "Permission request" })).toHaveLength(2);
    expect(screen.queryByRole("group", { name: "Plan approval" })).toBeNull();
    expect(screen.getByRole("button", { name: "Allow always in this session" })).toBeTruthy();
  });
});

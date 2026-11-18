import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { buildRows, emptyView, reduceEvents } from "../../store/agent-reducer";
import type { AgentEvent } from "../../store/agent-types";
import { groupRows, type ToolGroup } from "../../store/toolGroups";
import { installDomStubs } from "../../store/testing-u2";
import { ActivityGroup, callTarget, groupSummary, toolLabel, type OpenState } from "./Activity";

installDomStubs();
afterEach(cleanup);

const groupOf = (events: object[]): ToolGroup => {
  const v = reduceEvents(
    emptyView("a1"),
    events.map((p, i) => ({ agentId: "a1", seq: i + 1, ts: (i + 1) * 1000, provider: "claude", ...p }) as AgentEvent),
  );
  const g = groupRows(buildRows(v.items)).find((r) => r.group)?.group;
  if (!g) throw new Error("no group");
  return g;
};
const call = (id: string, kind: string, name: string, input: object, result: object = { status: "ok", output: "ok" }) => [
  { kind: "tool.start", toolId: id, name, toolKind: kind, input },
  { kind: "tool.result", toolId: id, ...result },
];
/** The transcript's open state, in a signal (what Transcript.tsx holds). */
function openState(): OpenState {
  const [m, setM] = createSignal<Record<string, boolean>>({});
  return { isOpen: (k) => m()[k], toggle: (k, v) => setM((x) => ({ ...x, [k]: v })) };
}
const LONG = "set -euo pipefail\nfor f in src/*.tsx; do\n  npx prettier --check \"$f\"\ndone";

describe("<ActivityGroup>", () => {
  it("is one folded button with a summary once done, and renders no line of its body", () => {
    const g = groupOf([...call("t1", "read", "Read", { file_path: "a.ts" }), ...call("t2", "read", "Read", { file_path: "b.ts" }), ...call("t3", "search", "Grep", { pattern: "x" }), ...call("t4", "exec", "Bash", { command: "pnpm test" })]);
    const state = openState();
    render(() => <ActivityGroup group={g} state={state} live={false} member={() => null} />);
    const head = screen.getByRole("button", { name: /Read 2 files, searched once, ran 1 command/ });
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".act__list")).toBeNull();
    expect(head.textContent).toContain("Tool activity");
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByText("pnpm test").closest(".act-call__head")!.textContent).toContain("Ran");
  });

  it("shows one live line with the newest step while it runs", () => {
    const g = groupOf([...call("t1", "read", "Read", { file_path: "a.ts" }), { kind: "tool.start", toolId: "t2", name: "Bash", toolKind: "exec", input: { command: "pnpm vitest run" } }]);
    const state = openState();
    render(() => <ActivityGroup group={g} state={state} live member={() => null} />);
    const live = document.querySelector(".act__live")!;
    expect(live.textContent).toContain("Running");
    expect(live.textContent).toContain("pnpm vitest run");
    expect(document.querySelector(".act")!.hasAttribute("data-live")).toBe(true);
  });

  it("never hides a failure: the row says it, the group is open and the failing call shows its output", () => {
    const g = groupOf([...call("t1", "read", "Read", { file_path: "a.ts" }), ...call("t2", "exec", "Bash", { command: "pnpm test" }, { status: "error", output: "1 failed" })]);
    const state = openState();
    render(() => <ActivityGroup group={g} state={state} live={false} member={() => null} />);
    expect(document.querySelector(".act__flag")!.textContent).toContain("1 failed");
    expect(screen.getByRole("button", { name: /Tool activity/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("1 failed", { selector: "pre" })).toBeTruthy();
  });

  it("puts a long script on one line, and the whole of it (with a copy button) on expand", () => {
    const g = groupOf([...call("t1", "exec", "Bash", { command: LONG }, { status: "ok", output: "done" })]);
    const state = openState();
    render(() => <ActivityGroup group={g} state={state} live={false} member={() => null} />);
    fireEvent.click(screen.getByRole("button", { name: /Tool activity/ }));
    const line = document.querySelector(".act-call__target")!;
    expect(line.textContent).toBe("set -euo pipefail …");
    fireEvent.click(line.closest("button")!);
    expect(document.querySelector(".act-block__pre--cmd")!.textContent).toBe(LONG);
    expect(screen.getByRole("button", { name: "Copy command" })).toBeTruthy();
  });

  it("states the size of an edit on its line and shows the diff on expand", () => {
    const g = groupOf([...call("t1", "edit", "Edit", { file_path: "src/a.ts" }, { status: "ok", diff: { path: "src/a.ts", old: "a\nb", new: "a\nc\nd" } })]);
    const state = openState();
    render(() => <ActivityGroup group={g} state={state} live={false} member={() => null} />);
    fireEvent.click(screen.getByRole("button", { name: /Tool activity/ }));
    expect(screen.getByRole("img", { name: "2 lines added, 1 removed" })).toBeTruthy();
    expect(document.querySelector(".dpv")).toBeNull();
    fireEvent.click(document.querySelector(".act-call__head")!);
    expect(document.querySelector(".dpv")).toBeTruthy();
  });

  it("opens 600 calls a page at a time", () => {
    const events: object[] = [];
    for (let i = 0; i < 600; i++) events.push(...call(`t${i}`, "read", "Read", { file_path: `f${i}.ts` }));
    const g = groupOf(events);
    const state = openState();
    render(() => <ActivityGroup group={g} state={state} live={false} member={() => null} />);
    fireEvent.click(screen.getByRole("button", { name: /Tool activity/ }));
    expect(screen.getAllByRole("listitem")).toHaveLength(60);
    fireEvent.click(screen.getByRole("button", { name: "Show 540 more steps" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(600);
  });
});

describe("labels", () => {
  it("reads MCP tool names and capitalises the summary", () => {
    expect(toolLabel("mcp__github__search_issues")).toBe("github · search_issues");
    expect(callTarget({ summary: "a\nb", name: "Bash" } as never)).toBe("a …");
    const g = groupOf([...call("t1", "mcp", "mcp__github__x", {})]);
    expect(groupSummary(g)).toBe("Used 1 MCP tool");
  });
});

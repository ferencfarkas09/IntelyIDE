import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PermissionItem } from "../../store/agent-reducer";
import { installDomStubs } from "../../store/testing-u2";
import { PlanApprovalCard } from "./PlanApprovalCard";

installDomStubs();
afterEach(cleanup);

const PLAN = "## Plan\n\n1. Replace `toFixed`\n2. Update the call sites";

const plan = (over: Partial<PermissionItem> = {}): PermissionItem => ({
  key: "perm:p-plan",
  ts: 1,
  type: "permission",
  reqId: "p-plan",
  toolId: "t1",
  intent: { class: "other", tool: "ExitPlanMode", summary: "ExitPlanMode: leave plan mode" },
  options: ["allowOnce", "deny"],
  plan: PLAN,
  modes: ["ask", "edit", "automatic"],
  ...over,
});

const mount = (item: PermissionItem, onAnswer = vi.fn()) => {
  render(() => <PlanApprovalCard item={item} onAnswer={onAnswer} />);
  return onAnswer;
};
const radio = (name: string) => screen.getByRole("radio", { name: new RegExp(`^${name}`) });
const checked = () => screen.getAllByRole("radio").filter((r) => r.getAttribute("aria-checked") === "true").map((r) => r.getAttribute("data-mode"));

describe("<PlanApprovalCard> pending", () => {
  it("shows the full plan text and the three working modes, with Plan named in the header", () => {
    mount(plan());
    const card = screen.getByRole("group", { name: "Plan approval" });
    expect(within(card).getByText("A plan is ready")).toBeTruthy();
    expect(within(card).getByRole("region", { name: "A plan is ready" }).textContent).toContain("Update the call sites");
    expect(screen.getAllByRole("radio").map((r) => r.getAttribute("data-mode"))).toEqual(["ask", "edit", "automatic"]);
    expect(screen.getByRole("radiogroup", { name: "Continue in" })).toBeTruthy();
    // The explanation of each mode is the card's description.
    expect(radio("Ask").getAttribute("aria-describedby")).toBeTruthy();
  });

  it("preselects Ask, or Edit only when the run was in Edit automatically before Plan, and never Automatic", () => {
    const { unmount } = render(() => <PlanApprovalCard item={plan()} onAnswer={() => {}} />);
    expect(checked()).toEqual(["ask"]);
    unmount();
    render(() => <PlanApprovalCard item={plan({ prePlanMode: "edit" })} onAnswer={() => {}} />);
    expect(checked()).toEqual(["edit"]);
    cleanup();
    // Automatic before Plan, Bypass before Plan, or a list that starts with Automatic: still Ask.
    for (const pre of ["automatic", "bypass", "ask", "readOnly"] as const) {
      const r = render(() => <PlanApprovalCard item={plan({ prePlanMode: pre, modes: ["automatic", "edit", "ask"] })} onAnswer={() => {}} />);
      expect(checked()).toEqual(["ask"]);
      r.unmount();
    }
  });

  it("never lists Bypass, even when the event carries it", () => {
    mount(plan({ modes: ["ask", "edit", "automatic", "bypass"] }));
    expect(screen.queryByRole("radio", { name: /Bypass/ })).toBeNull();
  });

  it("approves with the picked mode; Automatic needs its own click and then says it will not ask again", () => {
    const answer = mount(plan());
    expect(screen.queryByTestId("plan-unattended")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Approve plan" }));
    expect(answer).toHaveBeenLastCalledWith("allowOnce", { mode: "ask" });
    fireEvent.click(radio("Automatic"));
    expect(checked()).toEqual(["automatic"]);
    expect(screen.getByTestId("plan-unattended").textContent).toBe("Automatic works without asking: after you approve, the agent will not ask again.");
    // Picking it did not answer anything.
    expect(answer).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Approve plan" }));
    expect(answer).toHaveBeenLastCalledWith("allowOnce", { mode: "automatic" });
  });

  it("adds what the run's MCP servers would run unasked to the Automatic note", () => {
    render(() => <PlanApprovalCard item={plan()} onAnswer={() => {}} mcp={[{ name: "fs", exposed: 2, hasSecretEnv: true }, { name: "docs", exposed: 0, hasSecretEnv: false }]} />);
    fireEvent.click(radio("Automatic"));
    const note = screen.getByTestId("plan-unattended").textContent!;
    expect(note).toContain("In this mode, 2 tools of fs that change things run without asking.");
    expect(note).toContain("fs keep a secret in their environment");
  });

  it("makes Approve plan the one primary button and focuses it once", async () => {
    render(() => (
      <div class="chat">
        <PlanApprovalCard item={plan()} onAnswer={() => {}} />
      </div>
    ));
    const approve = screen.getByRole("button", { name: "Approve plan" });
    expect(approve.hasAttribute("data-primary")).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(approve));
  });

  it("sends the note back with Request changes: the textarea needs text, Ctrl+Enter sends, nothing else is bound", () => {
    const answer = mount(plan());
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    const note = screen.getByLabelText("What should change?") as HTMLTextAreaElement;
    const send = screen.getByRole("button", { name: "Send feedback" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    // Enter alone is a newline, not a submit.
    fireEvent.keyDown(note, { key: "Enter" });
    expect(answer).not.toHaveBeenCalled();
    fireEvent.input(note, { target: { value: "  Keep the tests untouched  " } });
    expect(send.disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Reject without a note" })).toBeNull();
    fireEvent.click(send);
    expect(answer).toHaveBeenCalledWith("deny", { feedback: "Keep the tests untouched" });
  });

  it("sends with Ctrl+Enter or Cmd+Enter", () => {
    const answer = mount(plan());
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    const note = screen.getByLabelText("What should change?");
    fireEvent.input(note, { target: { value: "smaller steps" } });
    fireEvent.keyDown(note, { key: "Enter", ctrlKey: true });
    expect(answer).toHaveBeenCalledWith("deny", { feedback: "smaller steps" });
  });

  it("allows an empty rejection through a visible secondary action, only while the note is empty", () => {
    const answer = mount(plan());
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject without a note" }));
    // The model gets its default message: no feedback travels with this answer.
    expect(answer.mock.calls[0][0]).toBe("deny");
    expect(answer.mock.calls[0][1]).toBeUndefined();
  });

  it("goes back from the note form with the typed text and the picked mode kept", () => {
    mount(plan());
    fireEvent.click(radio("Edit automatically"));
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    fireEvent.input(screen.getByLabelText("What should change?"), { target: { value: "draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(checked()).toEqual(["edit"]);
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    expect((screen.getByLabelText("What should change?") as HTMLTextAreaElement).value).toBe("draft");
  });

  it("has no Escape binding: it would throw away a typed note", () => {
    const answer = mount(plan());
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    const note = screen.getByLabelText("What should change?");
    fireEvent.input(note, { target: { value: "keep me" } });
    fireEvent.keyDown(note, { key: "Escape" });
    fireEvent.keyDown(screen.getByRole("group", { name: "Plan approval" }), { key: "Escape" });
    expect(answer).not.toHaveBeenCalled();
    expect((note as HTMLTextAreaElement).value).toBe("keep me");
  });

  it("shows the reason when the host refused the approval and keeps the choice editable", () => {
    render(() => <PlanApprovalCard item={plan({ error: { code: "writeLease" } })} onAnswer={() => {}} />);
    expect(screen.getByRole("alert").textContent).toBe("Another run is writing to this repository. Wait for it, or pick Ask.");
    // Ask needs no writer lease: it can be picked and sent.
    fireEvent.click(radio("Ask"));
    expect(checked()).toEqual(["ask"]);
    expect((screen.getByRole("button", { name: "Approve plan" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("still renders the approval card when the plan text did not come through, with a notice", () => {
    mount(plan({ plan: undefined }));
    expect(screen.getByText("The plan text is not available. You can still approve, or ask for changes.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve plan" })).toBeTruthy();
  });

  it("says when the plan was cut", () => {
    mount(plan({ planTruncated: true }));
    expect(screen.getByText("The plan was cut at 64 KiB.")).toBeTruthy();
  });

  it("falls back to the three modes when the event names none", () => {
    mount(plan({ modes: undefined }));
    expect(screen.getAllByRole("radio").map((r) => r.getAttribute("data-mode"))).toEqual(["ask", "edit", "automatic"]);
  });
});

describe("<PlanApprovalCard> resolved", () => {
  it("says which mode the run continued in and keeps the plan collapsed", () => {
    mount(plan({ outcome: "allow", by: "user", decision: "allowOnce", mode: "edit" }));
    expect(screen.getByRole("status").textContent).toContain("Plan approved, continuing in Edit automatically");
    expect(screen.queryByRole("button", { name: "Approve plan" })).toBeNull();
    const details = document.querySelector("details.plan-approval__show") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("Show plan");
    expect(details.textContent).toContain("Update the call sites");
  });

  it("does not guess a mode when none is known", () => {
    mount(plan({ outcome: "allow", by: "user" }));
    expect(screen.getByRole("status").textContent).toContain("Plan approved");
    expect(screen.getByRole("status").textContent).not.toContain("continuing in");
  });

  it("says a rejection was sent back, with the note", () => {
    mount(plan({ outcome: "deny", by: "user", decision: "deny", feedback: "Keep the tests untouched" }));
    expect(screen.getByRole("status").textContent).toContain("Plan sent back: Keep the tests untouched");
  });

  it("says a rejection without a note was sent back", () => {
    mount(plan({ outcome: "deny", by: "user", decision: "deny" }));
    expect(screen.getByRole("status").textContent).toContain("Plan sent back");
  });
});

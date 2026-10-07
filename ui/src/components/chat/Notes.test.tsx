import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteItem, ToolItem } from "../../store/agent-reducer";
import { resetAgents } from "../../store/agents";
import { installDomStubs } from "../../store/testing-u2";
import { Composer, type ComposerProps } from "./Composer";
import { NoteInput, NoteRow } from "./Notes";
import { ToolCard } from "./Tools";

installDomStubs();
beforeEach(resetAgents);
afterEach(cleanup);

const note = (over: Partial<NoteItem> = {}): NoteItem => ({ key: "note:n1", ts: 1, type: "note", noteId: "n1", state: "queued", text: "use staging", ...over });
const agentCall = (over: Partial<ToolItem> = {}): ToolItem => ({ key: "tool:ag1", ts: 1, type: "tool", toolId: "ag1", name: "Agent", toolKind: "other", summary: "researcher: look around", input: { subagent_type: "researcher" }, status: "running", ...over });

describe("<NoteRow>", () => {
  it("names who the note is for and where it stands", () => {
    const { unmount } = render(() => <NoteRow item={note()} />);
    expect(screen.getByText("Note for the agent")).toBeTruthy();
    expect(screen.getByText("use staging")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Queued");
    unmount();
    render(() => <NoteRow item={note({ state: "delivered", parentToolId: "ag1", toolId: "t3" })} />);
    expect(screen.getByText("Note for the subagent")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Delivered");
  });

  it("says why a note was not delivered and offers the lead only when its subagent had already finished", () => {
    const toLead = vi.fn();
    const { unmount } = render(() => <NoteRow item={note({ state: "dropped", reason: "finished", parentToolId: "ag1" })} onSendToLead={toLead} />);
    expect(screen.getByText("Not delivered")).toBeTruthy();
    expect(screen.getByText("The subagent had already finished.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Tell the agent instead" }));
    expect(toLead).toHaveBeenCalledWith("use staging");
    unmount();
    render(() => <NoteRow item={note({ state: "dropped", reason: "turnEnded" })} onSendToLead={toLead} />);
    expect(screen.getByText("The turn ended first.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Tell the agent instead" })).toBeNull();
  });
});

describe("<NoteRow> after the turn", () => {
  it("offers a note the turn outlived as a message of its own, and nothing else is offered for it", () => {
    const asMessage = vi.fn();
    render(() => <NoteRow item={note({ state: "dropped", reason: "turnEnded" })} onSendAsMessage={asMessage} onSendToLead={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Send as a message" }));
    expect(asMessage).toHaveBeenCalledWith("use staging");
    expect(screen.queryByRole("button", { name: "Tell the agent instead" })).toBeNull();
  });

  it("offers nothing for a note that was stopped or delivered", () => {
    const { unmount } = render(() => <NoteRow item={note({ state: "dropped", reason: "cancelled" })} onSendAsMessage={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
    unmount();
    render(() => <NoteRow item={note({ state: "delivered" })} onSendAsMessage={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("<NoteInput>", () => {
  const field = () => screen.getByLabelText("Add a note for this subagent...") as HTMLTextAreaElement;
  const type = (text: string) => {
    field().value = text;
    fireEvent.input(field());
  };

  it("sends the trimmed text with Enter and clears the field", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(() => <NoteInput label="Add a note for this subagent..." onSend={onSend} />);
    type("  check the edge cases \n");
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(field().value).toBe(""));
    expect(onSend).toHaveBeenCalledWith("check the edge cases");
  });

  it("breaks the line with Shift+Enter, sends nothing empty, and clears on Escape", () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(() => <NoteInput label="Add a note for this subagent..." onSend={onSend} />);
    fireEvent.keyDown(field(), { key: "Enter" });
    type("x");
    expect(fireEvent.keyDown(field(), { key: "Enter", shiftKey: true })).toBe(true);
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(field().value).toBe("");
  });

  it("keeps the text when the host refuses the note", async () => {
    const onSend = vi.fn().mockRejectedValue({ code: "noteUnknownTarget" });
    render(() => <NoteInput label="Add a note for this subagent..." onSend={onSend} />);
    type("too late");
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(field().value).toBe("too late");
  });
});

describe("<ToolCard> notes", () => {
  it("offers the note field on a working subagent call, and its notes even when the card is collapsed", () => {
    render(() => <ToolCard item={agentCall()} notes={[note({ parentToolId: "ag1", text: "be brief" })]} onNote={async () => {}} />);
    expect(screen.getByLabelText("Add a note for this subagent...")).toBeTruthy();
    expect(screen.getByText("be brief")).toBeTruthy();
  });

  it("has no field once the subagent is done, for another tool, or without permission to note", () => {
    const { unmount } = render(() => <ToolCard item={agentCall({ status: "ok" })} onNote={async () => {}} />);
    expect(screen.queryByLabelText("Add a note for this subagent...")).toBeNull();
    unmount();
    const other = render(() => <ToolCard item={agentCall({ name: "Bash", toolKind: "exec" })} onNote={async () => {}} />);
    expect(screen.queryByLabelText("Add a note for this subagent...")).toBeNull();
    other.unmount();
    render(() => <ToolCard item={agentCall()} />);
    expect(screen.queryByLabelText("Add a note for this subagent...")).toBeNull();
  });
});

describe("<Composer> notes", () => {
  const field = () => screen.getByLabelText("Message to the agent") as HTMLTextAreaElement;
  const props = (over: Partial<ComposerProps> = {}): ComposerProps => ({ agentId: "a1", repoIds: ["admin"], running: true, stopping: false, onSend: vi.fn(), onStop: vi.fn(), ...over });
  const type = (text: string) => {
    field().value = text;
    field().setSelectionRange(text.length, text.length);
    fireEvent.input(field());
  };

  it("turns Cmd+Return into a note for the lead while the run works, and clears the draft", async () => {
    const onNote = vi.fn().mockResolvedValue(undefined);
    const p = props({ onNote });
    render(() => <Composer {...p} />);
    expect(field().placeholder).toBe("Add a note for the agent...");
    type("  prefer small commits ");
    fireEvent.keyDown(field(), { key: "Enter", metaKey: true });
    await waitFor(() => expect(field().value).toBe(""));
    expect(onNote).toHaveBeenCalledWith("prefer small commits");
    expect(p.onSend).not.toHaveBeenCalled();
  });

  it("adds a note with the button next to Stop, and keeps the draft when the host refuses it", async () => {
    const onNote = vi.fn().mockRejectedValue({ code: "noteNoTurn" });
    render(() => <Composer {...props({ onNote })} />);
    type("one more thing");
    fireEvent.click(screen.getByRole("button", { name: /Add note/ }));
    await waitFor(() => expect(onNote).toHaveBeenCalledWith("one more thing"));
    await Promise.resolve();
    expect(field().value).toBe("one more thing");
    expect(screen.getByRole("button", { name: /Stop/ })).toBeTruthy();
  });

  it("does not add an empty note, and a provider without notes still says to stop first", () => {
    const onNote = vi.fn().mockResolvedValue(undefined);
    const { unmount } = render(() => <Composer {...props({ onNote })} />);
    fireEvent.keyDown(field(), { key: "Enter", metaKey: true });
    expect(onNote).not.toHaveBeenCalled();
    unmount();
    render(() => <Composer {...props()} />);
    expect(screen.queryByRole("button", { name: /Add note/ })).toBeNull();
    expect(field().placeholder).toBe("The agent is working. Stop it to send a new message.");
  });
});

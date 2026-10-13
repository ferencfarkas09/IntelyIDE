// Messages between a person's own runs (docs/peer-runs.md): the rows in either transcript, the card, the reducer.
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyView, reduceEvents } from "../../store/agent-reducer";
import type { NoteItem, PermissionItem } from "../../store/agent-reducer";
import { installDomStubs } from "../../store/testing-u2";
import { PermissionCard, scopeSentence } from "./Cards";
import { NoteRow, peerRefusal } from "./Notes";

installDomStubs();
afterEach(cleanup);

const note = (over: Partial<NoteItem> = {}): NoteItem => ({ key: "note:p1", ts: 1, type: "note", noteId: "p1", state: "queued", text: "the API is ready", ...over });

describe("<NoteRow> for a message from or to another run", () => {
  it("a received message names the sender, is marked as an agent message and is not a note of the user", () => {
    render(() => <NoteRow item={note({ from: "run 'Backend' (server build-1)" })} />);
    expect(screen.getByText("Agent message")).toBeTruthy();
    expect(screen.getByText(/From run 'Backend' \(server build-1\)/)).toBeTruthy();
    expect(screen.getByText("the API is ready")).toBeTruthy();
    expect(screen.queryByText("Note for the agent")).toBeNull();
    expect(screen.getByTestId("peer-note").getAttribute("data-dir")).toBe("from");
    expect(screen.getByRole("status").textContent).toBe("Queued");
  });

  it("the sender's record says where it went and that it was sent", () => {
    render(() => <NoteRow item={note({ state: "delivered", to: "run 'Frontend' (local)" })} />);
    expect(screen.getByText(/Sent to run 'Frontend' \(local\)/)).toBeTruthy();
    expect(screen.getByTestId("peer-note").getAttribute("data-dir")).toBe("to");
    expect(screen.getByRole("status").textContent).toBe("Sent");
  });

  it("a refusal is said in the user's language", () => {
    render(() => <NoteRow item={note({ state: "dropped", to: "run x", reason: "idle: that run is not working right now" })} />);
    expect(screen.getByRole("status").textContent).toBe("Not sent");
    expect(screen.getByText("That run was not working, so it could not take a message.")).toBeTruthy();
  });

  it("a chain that hit the hop limit reads as a banner", () => {
    render(() => <NoteRow item={note({ state: "dropped", to: "run x", reason: "hops: Runs stopped messaging each other — your turn" })} />);
    expect(screen.getByRole("alert").textContent).toBe("Runs stopped messaging each other — your turn");
    expect(peerRefusal("rate: too many").text).toBe("Too many messages to that run in a minute.");
    expect(peerRefusal("odd: something else").text).toBe("something else");
  });
});

describe("the reducer keeps the sender and the target", () => {
  it("builds the item from the note events", () => {
    const base = { agentId: "a1", provider: "claude" };
    const v = reduceEvents(emptyView("a1"), [
      { ...base, seq: 1, ts: 1, kind: "note", noteId: "p1", state: "queued", text: "hello", from: "run 'B' (local)" },
      { ...base, seq: 2, ts: 2, kind: "note", noteId: "p1", state: "delivered", toolId: "t3" },
      { ...base, seq: 3, ts: 3, kind: "note", noteId: "p2", state: "delivered", text: "hi there", to: "run 'C' (hq)" },
    ] as never);
    const items = v.items.filter((i): i is NoteItem => i.type === "note");
    expect(items.map((i) => [i.noteId, i.state, i.from, i.to])).toEqual([["p1", "delivered", "run 'B' (local)", undefined], ["p2", "delivered", undefined, "run 'C' (hq)"]]);
    expect(items[0]!.text).toBe("hello");
  });
});

describe("<PermissionCard> for peer_send", () => {
  const ask = (over: Partial<PermissionItem> = {}): PermissionItem => ({
    key: "perm:p9", ts: 1, type: "permission", reqId: "p9", toolId: "t9",
    intent: { class: "mcp", tool: "mcp__intely-peer__peer_send", server: "intely-peer", argv: ["run-b"], summary: "intely-peer: peer_send" },
    options: ["allowOnce", "allowRun", "deny"], sessionAllow: { kind: "peer", scope: "run-b" }, ...over,
  });

  it("asks 'let this run message run X' with the title, and offers once / for this run / deny", () => {
    const answer = vi.fn();
    render(() => <PermissionCard item={ask()} runTitle={(id) => (id === "run-b" ? "Frontend" : undefined)} onAnswer={answer} />);
    expect(screen.getByTestId("peer-ask").textContent).toMatch(/Let this run message run Frontend\?/);
    expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow always in this session" }));
    expect(answer).toHaveBeenCalledWith("allowRun");
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
  });

  it("falls back to the id and states what 'always' covers", () => {
    render(() => <PermissionCard item={ask()} onAnswer={() => {}} />);
    expect(screen.getByTestId("peer-ask").textContent).toMatch(/run run-b\?/);
    expect(scopeSentence({ kind: "peer", scope: "run-b" }).text).toBe("Always for this run: lets it message run run-b. A message grants the other run nothing. Never saved to disk.");
  });

  it("shows the target's title, place and mode and an excerpt of the text; a more permissive target is flagged", () => {
    render(() => (
      <PermissionCard
        item={ask({ options: ["allowOnce", "deny"], sessionAllow: undefined, peer: { title: "Deploy", location: "build-1", mode: "automatic", text: "please run the deploy script", riskier: true } })}
        onAnswer={() => {}}
      />
    ));
    expect(screen.getByText(/To: Deploy · build-1 · mode /)).toBeTruthy();
    expect(screen.getByText("please run the deploy script")).toBeTruthy();
    expect(screen.getByRole("note").textContent).toMatch(/may do more than this one/);
    expect(screen.getByTestId("peer-card").hasAttribute("data-riskier")).toBe(true);
    expect(screen.queryByRole("button", { name: "Allow always in this session" })).toBeNull();
  });

  it("the reducer keeps the host's peer card on the permission item", () => {
    const v = reduceEvents(emptyView("a1"), [
      { agentId: "a1", provider: "claude", seq: 1, ts: 1, kind: "permission.request", reqId: "p9", toolId: "t9", intent: { class: "mcp", tool: "mcp__intely-peer__peer_send", argv: ["run-b"], summary: "x" }, options: ["allowOnce", "deny"], peer: { title: "B", location: "local", mode: "edit", text: "hi", riskier: false } },
    ] as never);
    expect(v.items.find((i) => i.type === "permission")).toMatchObject({ peer: { title: "B", mode: "edit" } });
  });
});

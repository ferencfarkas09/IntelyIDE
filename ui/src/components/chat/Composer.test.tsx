import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAgents } from "../../store/agents";
import { installDomStubs } from "../../store/testing-u2";
import { Composer, type ComposerProps } from "./Composer";

installDomStubs();
beforeEach(resetAgents);
afterEach(cleanup);

const field = () => screen.getByLabelText("Message to the agent") as HTMLTextAreaElement;
const props = (over: Partial<ComposerProps> = {}): ComposerProps => ({ agentId: "a1", repoIds: ["admin"], running: false, stopping: false, onSend: vi.fn(), onStop: vi.fn(), ...over });
const type = (text: string) => {
  field().value = text;
  field().setSelectionRange(text.length, text.length);
  fireEvent.input(field());
};

describe("<Composer>", () => {
  it("sends with Cmd+Return, trims the text and clears the field", () => {
    const p = props();
    render(() => <Composer {...p} />);
    type("  hello agent \n");
    fireEvent.keyDown(field(), { key: "Enter", metaKey: true });
    expect(p.onSend).toHaveBeenCalledWith("hello agent", []);
    expect(field().value).toBe("");
  });

  it("keeps plain Enter as a newline and does not send empty text", () => {
    const p = props();
    render(() => <Composer {...p} />);
    fireEvent.keyDown(field(), { key: "Enter", metaKey: true });
    type("x");
    const plain = fireEvent.keyDown(field(), { key: "Enter" });
    expect(plain).toBe(true);
    expect(p.onSend).not.toHaveBeenCalled();
  });

  it("swaps Send for Stop while the agent works, and Stop interrupts", () => {
    const p = props({ running: true });
    render(() => <Composer {...p} />);
    expect(screen.queryByRole("button", { name: /Send/ })).toBeNull();
    type("queued?");
    fireEvent.keyDown(field(), { key: "Enter", metaKey: true });
    expect(p.onSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
    expect(p.onStop).toHaveBeenCalledOnce();
  });

  it("is not sendable when the caller gives a reason", () => {
    const p = props({ blockedReason: "Sign in first" });
    render(() => <Composer {...p} />);
    expect(field().placeholder).toBe("Sign in first");
    type("hi");
    fireEvent.keyDown(field(), { key: "Enter", metaKey: true });
    expect(p.onSend).not.toHaveBeenCalled();
  });

  it("lists repo files for an @mention, inserts the pick and sends it as an attachment", async () => {
    const p = props();
    render(() => <Composer {...p} />);
    type("look at @ord");
    const option = await screen.findByRole("option", { name: /OrderRow/ });
    expect(screen.getAllByRole("option").length).toBeGreaterThan(1);
    fireEvent.pointerDown(option);
    await waitFor(() => expect(field().value).toBe("look at @src/components/pages/orders/OrderRow.tsx "));
    fireEvent.keyDown(field(), { key: "Enter", metaKey: true });
    expect(p.onSend).toHaveBeenCalledWith("look at @src/components/pages/orders/OrderRow.tsx", [{ repoId: "admin", path: "src/components/pages/orders/OrderRow.tsx" }]);
  });

  it("navigates the picker with the keyboard and closes it with Escape", async () => {
    render(() => <Composer {...props()} />);
    type("@ord");
    await screen.findAllByRole("option");
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(field().value).toMatch(/^@src\/components\/pages\/orders\/OrderRow\.tsx $/));
    type("@ord");
    await screen.findAllByRole("option");
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("keeps a slash in the middle of a sentence a plain slash", () => {
    render(() => <Composer {...props({ slashCommands: ["compact"] })} />);
    type("and/or /re");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("says why Cmd+Return does nothing while the agent works and keeps the draft", () => {
    const p = props({ running: true });
    render(() => <Composer {...p} />);
    type("also add a test");
    fireEvent.keyDown(field(), { key: "Enter", metaKey: true });
    expect(p.onSend).not.toHaveBeenCalled();
    expect(screen.getByText("Stop the run to send")).toBeTruthy();
    expect(field().value).toBe("also add a test");
  });

  it("stops the run with Cmd+. and exposes combobox semantics", async () => {
    const p = props({ running: true });
    render(() => <Composer {...p} />);
    expect(field().getAttribute("role")).toBe("combobox");
    expect(field().getAttribute("aria-expanded")).toBe("false");
    expect(field().getAttribute("aria-autocomplete")).toBe("list");
    fireEvent.keyDown(field(), { key: ".", metaKey: true });
    expect(p.onStop).toHaveBeenCalledOnce();
    cleanup();
    const idle = props();
    render(() => <Composer {...idle} />);
    fireEvent.keyDown(field(), { key: ".", metaKey: true });
    expect(idle.onStop).not.toHaveBeenCalled();
  });
});

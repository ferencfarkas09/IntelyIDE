import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n";
import type { PermissionItem } from "../../store/agent-reducer";
import { installDomStubs } from "../../store/testing-u2";
import { PermissionCard, stopDoneWording } from "./Cards";
import { modeErrorText } from "./modes";

installDomStubs();
afterEach(async () => {
  cleanup();
  await setLocale("en", { persist: false });
});

const ALL = ["allowOnce", "allowRun", "allowAlways", "deny"] as PermissionItem["options"];
const secret = { kind: "secretFile", rule: "read.never-read", scope: "/work/admin/.env", repo: "/work/admin" } as const;
const cli = { kind: "cliPrompt", rule: "cli.prompt-denied", scope: "Contains brace with quote character (expansion obfuscation)", repo: "/work/admin" } as const;
const perm = (over: Partial<PermissionItem> = {}): PermissionItem => ({
  key: "perm:p1",
  ts: 1,
  type: "permission",
  reqId: "p1",
  toolId: "t1",
  intent: { class: "read", tool: "Read", paths: ["/work/admin/.env"], summary: "Read /work/admin/.env" },
  options: ALL,
  confirm: secret,
  ...over,
});
const show = (item: PermissionItem, onAnswer = vi.fn()) => {
  render(() => <PermissionCard item={item} onAnswer={onAnswer} />);
  return onAnswer;
};
const btn = (name: string | RegExp) => screen.getByRole("button", { name });

describe("tier-2 card", () => {
  it("says what is wanted, why it is stopped, and offers the four answers", () => {
    show(perm());
    expect(screen.getByTestId("stop-ask").textContent).toBe("Read the secret file .env?");
    expect(screen.getByTestId("stop-why").textContent).toMatch(/goes to the model provider and may land in logs and transcripts/);
    expect(screen.getByTestId("stop-path").textContent).toBe("/work/admin/.env");
    for (const n of ["Allow once", "Allow for this run", "Always allow for this repository", "Deny, tell the agent no"]) expect(btn(n)).toBeTruthy();
  });

  it("words each kind", () => {
    show(perm({ confirm: { ...secret, kind: "secretEdit" } }));
    expect(screen.getByTestId("stop-ask").textContent).toBe("Change the env file .env?");
    cleanup();
    show(perm({ confirm: cli, intent: { class: "exec", rawCommand: "node x.js", summary: "run" } }));
    expect(screen.getByTestId("stop-ask").textContent).toContain(`“${cli.scope}”`);
    expect(screen.getByLabelText("Command to run").textContent).toBe("node x.js");
    expect(btn("Always allow this reason in this repository")).toBeTruthy();
  });

  it("labels the helper agent that asks", () => {
    show(perm({ intent: { class: "read", tool: "Read", summary: "Read .env", actor: { agentId: "s1", role: "developer" } } }));
    expect(screen.getByTestId("stop-ask").textContent).toMatch(/^developer asks: /);
  });

  it("speaks Hungarian", async () => {
    await setLocale("hu", { persist: false });
    show(perm());
    expect(screen.getByTestId("stop-ask").textContent).toBe("Elolvashatja a(z) .env titkos fájlt?");
    for (const n of ["Egyszer engedélyezem", "Engedélyezem erre a futásra", "Mindig engedélyezem ehhez a repóhoz", "Elutasítom, az ügynök megkapja"]) expect(btn(n)).toBeTruthy();
  });

  it("puts the safe default on Deny", async () => {
    show(perm());
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(document.activeElement).toBe(btn("Deny, tell the agent no"));
    expect(btn("Deny, tell the agent no").hasAttribute("data-primary")).toBe(true);
    expect(btn("Allow once").hasAttribute("data-primary")).toBe(false);
  });

  it("answers once, for the run, and deny with a note", () => {
    const on = show(perm());
    fireEvent.click(btn("Allow once"));
    expect(on).toHaveBeenLastCalledWith("allowOnce", undefined);
    fireEvent.click(btn("Allow for this run"));
    expect(on).toHaveBeenLastCalledWith("allowRun", undefined);
    fireEvent.input(screen.getByLabelText("Optional note for the agent"), { target: { value: " use the example file " } });
    fireEvent.click(btn("Deny, tell the agent no"));
    expect(on).toHaveBeenLastCalledWith("deny", { feedback: "use the example file" });
  });

  it("Escape denies and never allows; Enter in the note denies", () => {
    const on = show(perm());
    fireEvent.keyDown(screen.getByRole("group"), { key: "Escape" });
    expect(on).toHaveBeenLastCalledWith("deny", undefined);
    fireEvent.keyDown(screen.getByLabelText("Optional note for the agent"), { key: "Enter" });
    expect(on).toHaveBeenCalledTimes(2);
    expect(on.mock.calls.every((c) => c[0] === "deny")).toBe(true);
  });

  it("always for a secret needs the second click; Cancel is focused; Escape backs out; only Yes sends confirmAlways", async () => {
    const on = show(perm());
    fireEvent.click(btn("Always allow for this repository"));
    expect(on).not.toHaveBeenCalled();
    expect(screen.getByTestId("stop-confirm").textContent).toBe("Always allow .env for admin? Its content goes to the model provider and may be written to logs and transcripts. Revoke any time in Settings > Safety.");
    await Promise.resolve();
    expect(document.activeElement).toBe(btn("Cancel"));
    fireEvent.keyDown(screen.getByRole("group"), { key: "Escape" });
    expect(on).not.toHaveBeenCalled();
    expect(screen.queryByTestId("stop-confirm")).toBeNull();
    fireEvent.click(btn("Always allow for this repository"));
    fireEvent.click(btn("Cancel"));
    expect(on).not.toHaveBeenCalled();
    fireEvent.click(btn("Always allow for this repository"));
    fireEvent.click(btn("Yes, always allow"));
    expect(on).toHaveBeenCalledTimes(1);
    expect(on).toHaveBeenCalledWith("allowAlways", { confirmAlways: true });
  });

  it("always for a CLI reason is one click and carries no confirmAlways", () => {
    const on = show(perm({ confirm: cli, intent: { class: "exec", rawCommand: "x", summary: "x" } }));
    fireEvent.click(btn("Always allow this reason in this repository"));
    expect(on).toHaveBeenCalledWith("allowAlways", undefined);
  });

  it("shows the host's refusal in words", () => {
    show(perm({ error: { code: "allowListFull" } }));
    expect(screen.getByRole("alert").textContent).toMatch(/always-list is full/);
    expect(modeErrorText("answerOnComputer")).toMatch(/only be lifted on your computer/);
    for (const c of ["confirmationRequired", "rulesMoved", "notOnServer", "storeFailed"]) expect(modeErrorText(c)).not.toBe("");
  });

  it("with only Deny offered (a phone) says to answer on the computer", () => {
    show(perm({ options: ["deny"] }));
    expect(screen.getByTestId("stop-phone").textContent).toBe("Answer this on your computer");
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
  });

  it("is reachable by Tab in a sensible order", () => {
    show(perm());
    const order = [...document.querySelectorAll<HTMLElement>("button, input")].map((e) => e.getAttribute("aria-label") ?? e.textContent);
    expect(order).toEqual(["Optional note for the agent", "Allow once", "Allow for this run", "Always allow for this repository", "Deny, tell the agent no"]);
  });
});

describe("override lines", () => {
  it("say what was allowed and how far", () => {
    expect(stopDoneWording({ confirm: secret, outcome: "allow", grant: "once" })).toBe("You allowed reading .env once");
    expect(stopDoneWording({ confirm: secret, outcome: "allow", grant: "run" })).toBe("You allowed reading .env for this run");
    expect(stopDoneWording({ confirm: { ...secret, kind: "secretEdit" }, outcome: "allow", grant: "always" })).toBe("You allowed changing .env always for this repository");
    expect(stopDoneWording({ confirm: secret, outcome: "deny", grant: "once" })).toBeUndefined();
    expect(stopDoneWording({ outcome: "allow", grant: "once" })).toBeUndefined();
  });

  it("the resolved card shows the line, also for a standing grant logged by the gate", () => {
    show(perm({ outcome: "allow", by: "saved", grant: "always", options: ["deny"] }));
    expect(screen.getByTestId("stop-done").textContent).toBe("You allowed reading .env always for this repository");
  });
});

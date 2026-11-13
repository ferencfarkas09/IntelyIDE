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

const ALL = ["allowOnce", "allowRun", "deny"] as PermissionItem["options"];
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
  it("says what is wanted, why it is stopped, and offers the three answers", () => {
    show(perm());
    expect(screen.getByTestId("stop-ask").textContent).toBe("Read the secret file .env?");
    expect(screen.getByTestId("stop-why").textContent).toMatch(/goes to the model provider and may land in logs and transcripts/);
    expect(screen.getByTestId("stop-path").textContent).toBe("/work/admin/.env");
    for (const n of ["Allow once", "Allow all secret files in this run", "Deny, tell the agent no"]) expect(btn(n)).toBeTruthy();
  });

  it("words each kind", () => {
    show(perm({ confirm: { ...secret, kind: "secretEdit" } }));
    expect(screen.getByTestId("stop-ask").textContent).toBe("Change the env file .env?");
    cleanup();
    show(perm({ confirm: cli, intent: { class: "exec", rawCommand: "node x.js", summary: "run" } }));
    expect(screen.getByTestId("stop-ask").textContent).toContain(`“${cli.scope}”`);
    expect(screen.getByLabelText("Command to run").textContent).toBe("node x.js");
    expect(btn("Allow this exact prompt in this run")).toBeTruthy();
    expect(screen.queryByTestId("stop-reach")).toBeNull();
  });

  it("labels the helper agent that asks", () => {
    show(perm({ intent: { class: "read", tool: "Read", summary: "Read .env", actor: { agentId: "s1", role: "developer" } } }));
    expect(screen.getByTestId("stop-ask").textContent).toMatch(/^developer asks: /);
  });

  it("speaks Hungarian", async () => {
    await setLocale("hu", { persist: false });
    show(perm());
    expect(screen.getByTestId("stop-ask").textContent).toBe("Elolvashatja a(z) .env titkos fájlt?");
    for (const n of ["Egyszer engedélyezem", "Minden titkos fájl engedélyezése ennél a futásnál", "Elutasítom, az ügynök megkapja"]) expect(btn(n)).toBeTruthy();
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
    expect(on).toHaveBeenLastCalledWith("allowOnce");
    fireEvent.input(screen.getByLabelText("Optional note for the agent"), { target: { value: " use the example file " } });
    fireEvent.click(btn("Deny, tell the agent no"));
    expect(on).toHaveBeenLastCalledWith("deny", { feedback: "use the example file" });
  });

  it("Escape denies and never allows; Enter in the note denies", () => {
    const on = show(perm());
    fireEvent.keyDown(screen.getByRole("group"), { key: "Escape" });
    expect(on).toHaveBeenLastCalledWith("deny");
    fireEvent.keyDown(screen.getByLabelText("Optional note for the agent"), { key: "Enter" });
    expect(on).toHaveBeenCalledTimes(2);
    expect(on.mock.calls.every((c) => c[0] === "deny")).toBe(true);
  });

  it("the card body says in visible text how far the run-wide choice reaches, for both secret kinds, en and hu", async () => {
    show(perm());
    expect(screen.getByTestId("stop-reach").textContent).toMatch(/every secret-looking file inside this run's folders \(nothing under \.git, \.claude, \.ssh or the IDE's data\), for the lead agent and its helpers, until you press Stop or the run is closed/);
    expect(screen.getByTestId("stop-reach").textContent).toMatch(/^“Allow once” covers only this file/);
    cleanup();
    show(perm({ confirm: { ...secret, kind: "secretEdit" } }));
    expect(btn("Allow editing all .env files in this run")).toBeTruthy();
    expect(screen.getByTestId("stop-reach").textContent).toMatch(/editing every \.env and \.env\.\* file/);
    cleanup();
    await setLocale("hu", { persist: false });
    show(perm({ confirm: { ...secret, kind: "secretEdit" } }));
    expect(btn("Minden .env fájl szerkesztésének engedélyezése ennél a futásnál")).toBeTruthy();
    expect(screen.getByTestId("stop-reach").textContent).toMatch(/\.git, \.claude, \.ssh/);
    expect(screen.getByTestId("stop-reach").textContent).toMatch(/amíg le nem állítod a futást, vagy az be nem záródik/);
    fireEvent.click(btn("Minden .env fájl szerkesztésének engedélyezése ennél a futásnál"));
    expect(screen.getByTestId("stop-confirm").textContent).toMatch(/^Engedélyezed a futás mappáin belüli minden \.env fájl módosítását, amíg le nem állítod a futást, vagy az be nem záródik\?/);
  });

  it("no always anywhere: no button, no option, no Settings list", () => {
    show(perm());
    expect(screen.queryByRole("button", { name: /always/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/always|Revoke/i);
  });

  it("the run-wide choice for a secret needs the second click; Cancel is focused; Escape backs out; only Yes sends confirmBroad", async () => {
    const on = show(perm());
    fireEvent.click(btn("Allow all secret files in this run"));
    expect(on).not.toHaveBeenCalled();
    expect(screen.getByTestId("stop-confirm").textContent).toBe("Allow reading every secret-looking file in this run's folders until you press Stop or the run is closed? Their content goes to the model provider and may be written to logs and transcripts.");
    await Promise.resolve();
    expect(document.activeElement).toBe(btn("Cancel"));
    fireEvent.keyDown(screen.getByRole("group"), { key: "Escape" });
    expect(on).not.toHaveBeenCalled();
    expect(screen.queryByTestId("stop-confirm")).toBeNull();
    fireEvent.click(btn("Allow all secret files in this run"));
    fireEvent.click(btn("Cancel"));
    expect(on).not.toHaveBeenCalled();
    fireEvent.click(btn("Allow all secret files in this run"));
    fireEvent.click(btn("Yes, allow for this run"));
    expect(on).toHaveBeenCalledTimes(1);
    expect(on).toHaveBeenCalledWith("allowRun", { confirmBroad: true });
  });

  it("the run-wide choice for an edit asks twice as well and words the question for editing", () => {
    const on = show(perm({ confirm: { ...secret, kind: "secretEdit" } }));
    fireEvent.click(btn("Allow editing all .env files in this run"));
    expect(on).not.toHaveBeenCalled();
    expect(screen.getByTestId("stop-confirm").textContent).toMatch(/^Allow changing every \.env file/);
  });

  it("the run-wide choice for a CLI reason is one click and carries no confirmBroad", () => {
    const on = show(perm({ confirm: cli, intent: { class: "exec", rawCommand: "x", summary: "x" } }));
    fireEvent.click(btn("Allow this exact prompt in this run"));
    expect(on).toHaveBeenCalledWith("allowRun");
  });

  it("a card without allow_run (the run's folder is the home folder) shows once and deny only, and no reach text", () => {
    show(perm({ options: ["allowOnce", "deny"] as PermissionItem["options"] }));
    expect(btn("Allow once")).toBeTruthy();
    expect(screen.queryByTestId("stop-run")).toBeNull();
    expect(screen.queryByTestId("stop-reach")).toBeNull();
    expect(btn("Deny, tell the agent no")).toBeTruthy();
  });

  it("shows the host's refusal in words", () => {
    show(perm({ error: { code: "confirmationRequired" } }));
    expect(screen.getByRole("alert").textContent).toMatch(/second confirmation/);
    expect(modeErrorText("answerOnComputer")).toMatch(/main window of the IDE on this computer/);
    for (const c of ["confirmationRequired", "rulesMoved", "notOnServer", "runWideNotAllowed"]) expect(modeErrorText(c)).not.toBe("");
  });

  it("with only Deny offered (a phone) says to answer on the computer", () => {
    show(perm({ options: ["deny"] }));
    expect(screen.getByTestId("stop-phone").textContent).toBe("Answer this on your computer");
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
  });

  it("is reachable by Tab in a sensible order", () => {
    show(perm());
    const order = [...document.querySelectorAll<HTMLElement>("button, input")].map((e) => e.getAttribute("aria-label") ?? e.textContent);
    expect(order).toEqual(["Optional note for the agent", "Allow once", "Allow all secret files in this run", "Deny, tell the agent no"]);
  });
});

describe("override lines in Hungarian", () => {
  it("word the run-wide answer and the standing use", async () => {
    await setLocale("hu", { persist: false });
    expect(stopDoneWording({ confirm: secret, outcome: "allow", grant: "run", by: "user" })).toBe("Engedélyezted a titkos fájlok olvasását ennél a futásnál");
    expect(stopDoneWording({ confirm: secret, outcome: "allow", grant: "run", by: "saved" })).toBe(".env olvasása a futásra szóló engedéllyel");
  });
});

describe("override lines", () => {
  it("say what was allowed and how far", () => {
    expect(stopDoneWording({ confirm: secret, outcome: "allow", grant: "once" })).toBe("You allowed reading .env once");
    expect(stopDoneWording({ confirm: { ...secret, kind: "secretEdit" }, outcome: "allow", grant: "once" })).toBe("You allowed changing .env once");
    expect(stopDoneWording({ confirm: cli, outcome: "allow", grant: "once" })).toBe(`You allowed a command the Claude CLI flagged once: “${cli.scope}”`);
    // run-wide on a card: the kind, never a file that was not on a card
    expect(stopDoneWording({ confirm: secret, outcome: "allow", grant: "run", by: "user" })).toBe("You allowed reading secret files in this run");
    expect(stopDoneWording({ confirm: { ...secret, kind: "secretEdit" }, outcome: "allow", grant: "run", by: "user" })).toBe("You allowed changing .env files in this run");
    expect(stopDoneWording({ confirm: cli, outcome: "allow", grant: "run", by: "user" })).toBe(`You allowed the Claude CLI prompt “${cli.scope}” in this run`);
    // the audit pair of a standing run-wide grant: the file or prompt actually used
    const used = { ...secret, scope: "/work/admin/prod.pem" };
    expect(stopDoneWording({ confirm: used, outcome: "allow", grant: "run", by: "saved" })).toBe("Read prod.pem under the run-wide permission");
    expect(stopDoneWording({ confirm: { ...used, kind: "secretEdit", scope: "/work/admin/.env.local" }, outcome: "allow", grant: "run", by: "saved" })).toBe("Changed .env.local under the run-wide permission");
    expect(stopDoneWording({ confirm: cli, outcome: "allow", grant: "run", by: "saved" })).toBe(`Allowed the Claude CLI prompt “${cli.scope}” under the run-wide permission`);
    expect(stopDoneWording({ confirm: secret, outcome: "deny", grant: "once" })).toBeUndefined();
    expect(stopDoneWording({ outcome: "allow", grant: "once" })).toBeUndefined();
  });

  it("the resolved card shows the line, also for a standing grant logged by the gate", () => {
    show(perm({ outcome: "allow", by: "saved", grant: "run", options: ["deny"] }));
    expect(screen.getByTestId("stop-done").textContent).toBe("Read .env under the run-wide permission");
  });
});

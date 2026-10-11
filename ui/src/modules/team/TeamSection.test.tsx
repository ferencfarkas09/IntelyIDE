import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", async (orig) => {
  const mod = await orig<typeof import("../../ipc")>();
  const { createMockIpc } = await import("../../ipc/mock");
  return { ...mod, ipc: createMockIpc("normal", { delayScale: 0 }) };
});

import { ipc } from "../../ipc";
import { createMockTeam, type MockTeamHandle } from "../../ipc/mock/team";
import { resetSettings, settingsSections } from "../../platform/settings";
import { installDomStubs } from "../../store/testing-u2";
import { register } from "./index";
import { resetTeam } from "./store";
import TeamSection from "./TeamSection";

installDomStubs();
vi.setConfig({ testTimeout: 30000 });

let mock: MockTeamHandle;
const install = (preset: "off" | "on") => {
  mock = createMockTeam({ preset });
  (ipc as { team: unknown }).team = mock;
};
beforeEach(() => resetTeam());
afterEach(() => {
  cleanup();
  resetSettings();
  vi.restoreAllMocks();
});

describe("register()", () => {
  it("adds the Team section and calls no IPC", () => {
    install("off");
    const calls = [vi.spyOn(ipc.team, "status"), vi.spyOn(ipc.team, "onChanged")];
    register();
    expect(settingsSections().find((s) => s.id === "team")).toMatchObject({ order: 51 });
    for (const c of calls) expect(c).not.toHaveBeenCalled();
  });
});

describe("no team yet", () => {
  it("creates a team and then shows the members, with the admin badge", async () => {
    install("off");
    render(() => <TeamSection />);
    await screen.findByText("Create a team");
    const create = screen.getByRole("button", { name: "Create team" });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    fireEvent.input(screen.getAllByLabelText("Your name in the team")[0]!, { target: { value: "Sam" } });
    fireEvent.click(create);
    const list = await screen.findByRole("list", { name: "Team members" });
    const me = within(list).getByRole("listitem", { name: "Sam" });
    expect(within(me).getByText("You")).toBeTruthy();
    expect(within(me).getByText("Admin")).toBeTruthy();
    expect(screen.getByText("Key epoch 1")).toBeTruthy();
  });

  it("joins with a code, shows the six digits, and becomes a member once confirmed and welcomed", async () => {
    install("off");
    render(() => <TeamSection />);
    await screen.findByText("Join a team");
    fireEvent.input(screen.getByLabelText("Invite code"), { target: { value: "intely-team://join#ws://x,t,a,b,c" } });
    fireEvent.input(screen.getAllByLabelText("Your name in the team")[1]!, { target: { value: "Robin" } });
    fireEvent.click(screen.getByRole("button", { name: "Join team" }));
    const sas = await screen.findByTestId("sas");
    expect(sas.textContent).toMatch(/^\d{3} \d{3}$/);
    fireEvent.click(screen.getByRole("button", { name: "The digits match" }));
    await screen.findByText(/Codes confirmed/);
    mock.sim.adminWelcomes();
    await screen.findByRole("list", { name: "Team members" });
  });

  it("shows a refused code as text", async () => {
    install("off");
    render(() => <TeamSection />);
    await screen.findByText("Join a team");
    fireEvent.input(screen.getByLabelText("Invite code"), { target: { value: "nonsense" } });
    fireEvent.input(screen.getAllByLabelText("Your name in the team")[1]!, { target: { value: "Robin" } });
    fireEvent.click(screen.getByRole("button", { name: "Join team" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/not a team invite code/);
  });
});

describe("in a team", () => {
  it("lists members with presence and follows presence events", async () => {
    install("on");
    render(() => <TeamSection />);
    const list = await screen.findByRole("list", { name: "Team members" });
    expect(within(within(list).getByRole("listitem", { name: "Jordan" })).getByText("Online")).toBeTruthy();
    expect(within(within(list).getByRole("listitem", { name: "Riley" })).getByText("Offline")).toBeTruthy();
    expect(screen.getByText("2 of 3 online")).toBeTruthy();
    mock.sim.setOnline("m_ri", true);
    await waitFor(() => expect(within(within(list).getByRole("listitem", { name: "Riley" })).getByText("Online")).toBeTruthy());
    expect(screen.getByText("3 of 3 online")).toBeTruthy();
  });

  it("invites: shows the code and the QR, and the request card appears when somebody arrives", async () => {
    install("on");
    render(() => <TeamSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Invite" }));
    const code = await screen.findByTestId("invite-code");
    expect(code.textContent).toMatch(/^intely-team:\/\/join#/);
    expect(screen.getByRole("img", { name: "QR code of the invite" })).toBeTruthy();
    expect(screen.getByTestId("countdown").textContent).toMatch(/Valid for (10:0\d|9:5\d)/);
    const digits = mock.sim.someoneArrives("Casey");
    const card = await screen.findByTestId("join-request");
    expect(within(card).getByTestId("sas").textContent?.replace(" ", "")).toBe(digits);
    fireEvent.click(within(card).getByRole("button", { name: "Let them in" }));
    await waitFor(() => expect(screen.getByRole("listitem", { name: "Casey" })).toBeTruthy());
  });

  it("revokes a member after a confirmation and starts a new epoch; admins have no remove button", async () => {
    install("on");
    render(() => <TeamSection />);
    const list = await screen.findByRole("list", { name: "Team members" });
    expect(within(within(list).getByRole("listitem", { name: "Sam" })).queryByRole("button")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove Jordan from the team" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByRole("listitem", { name: "Jordan" })).toBeNull());
    expect(screen.getByText("Key epoch 2")).toBeTruthy();
  });

  it("an admin cannot leave while members remain (the refusal is shown), a sole admin can", async () => {
    install("on");
    render(() => <TeamSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Leave team" }));
    let dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Leave team" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/cannot leave while other members remain/);
    cleanup();
    resetTeam();
    install("off");
    render(() => <TeamSection />);
    await screen.findByText("Create a team");
    fireEvent.input(screen.getAllByLabelText("Your name in the team")[0]!, { target: { value: "Sam" } });
    fireEvent.click(screen.getByRole("button", { name: "Create team" }));
    fireEvent.click(await screen.findByRole("button", { name: "Leave team" }));
    dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Leave team" }));
    await screen.findByText("Create a team");
  });

  it("when the relay closes the socket as removed it asks before forgetting, and shows an audit problem", async () => {
    install("on");
    render(() => <TeamSection />);
    await screen.findByRole("list", { name: "Team members" });
    mock.sim.setAuditError("audit chain broken at line 2");
    expect((await screen.findByTestId("audit-error")).textContent).toMatch(/audit chain broken at line 2/);
    mock.sim.removedByRelay();
    const card = await screen.findByTestId("removed");
    // nothing was wiped: the members are still listed
    expect(screen.getByRole("listitem", { name: "Jordan" })).toBeTruthy();
    // an admin with other members cannot just forget
    fireEvent.click(within(card).getByRole("button", { name: "Forget this team" }));
    expect((await within(card).findByRole("alert")).textContent).toMatch(/revoke them first/);
  });
});

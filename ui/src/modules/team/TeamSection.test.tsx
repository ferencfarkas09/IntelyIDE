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
    fireEvent.input(screen.getByLabelText("Invite code"), { target: { value: "intely-team://join#ws://127.0.0.1:8787,teamteam1234,adminadmin12,b,c" } });
    fireEvent.input(screen.getAllByLabelText("Your name in the team")[1]!, { target: { value: "Robin" } });
    await screen.findByText("A relay on this computer.");
    fireEvent.click(screen.getByRole("button", { name: "Join team" }));
    const sas = await screen.findByTestId("sas");
    expect(sas.textContent).toMatch(/^\d{3} \d{3}$/);
    fireEvent.click(screen.getByRole("button", { name: "The digits match" }));
    await screen.findByText(/Codes confirmed/);
    mock.sim.adminWelcomes();
    await screen.findByRole("list", { name: "Team members" });
  });
});

const CODE = "intely-team://join#wss://relay.example.org,teamteam1234,adminadmin12,b,c";
const typeCode = (v: string) => fireEvent.input(screen.getByLabelText("Invite code"), { target: { value: v } });
const typeName = (v = "Robin") => fireEvent.input(screen.getAllByLabelText("Your name in the team")[1]!, { target: { value: v } });
const joinBtn = () => screen.getByRole("button", { name: "Join team" }) as HTMLButtonElement;

describe("join preview", () => {
  it("says nothing for an empty field, shows a spinner while checking, then the card", async () => {
    install("off");
    render(() => <TeamSection />);
    await screen.findByText("Join a team");
    expect(screen.queryByTestId("join-preview")).toBeNull();
    typeCode(CODE);
    expect(screen.getByTestId("join-checking")).toBeTruthy();
    const card = await screen.findByTestId("join-preview");
    expect(card.textContent).toContain("Relay: relay.example.org");
    expect(card.textContent).toContain("Team teamteam · invited by adminadm");
    expect(screen.queryByTestId("join-checking")).toBeNull();
  });

  it("a trusted relay needs no box and the Join button follows the name", async () => {
    install("off");
    mock.sim.trustRelay("relay.example.org");
    render(() => <TeamSection />);
    await screen.findByText("Join a team");
    typeCode(CODE);
    await screen.findByText("This relay is already trusted on this Mac.");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(joinBtn().disabled).toBe(true);
    typeName();
    expect(joinBtn().disabled).toBe(false);
  });

  it("an untrusted relay needs the ticked box; join passes trustRelay true", async () => {
    install("off");
    const join = vi.spyOn(ipc.team, "join");
    render(() => <TeamSection />);
    await screen.findByText("Join a team");
    typeCode(CODE);
    typeName();
    const box = (await screen.findByRole("checkbox")) as HTMLInputElement;
    expect(screen.getByText(/only passes on encrypted messages/)).toBeTruthy();
    expect(joinBtn().disabled).toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect(joinBtn().disabled).toBe(false));
    fireEvent.click(joinBtn());
    await screen.findByTestId("sas");
    expect(join).toHaveBeenCalledWith(CODE, "Robin", true);
  });

  it("a trusted relay joins with trustRelay false", async () => {
    install("off");
    const join = vi.spyOn(ipc.team, "join");
    render(() => <TeamSection />);
    await screen.findByText("Join a team");
    typeCode("intely-team://join#ws://localhost:1,teamteam1234,adminadmin12,b,c");
    typeName();
    await screen.findByText("A relay on this computer.");
    fireEvent.click(joinBtn());
    await screen.findByTestId("sas");
    expect(join).toHaveBeenCalledWith(expect.any(String), "Robin", false);
  });

  it("text that is not an invite shows the hint and keeps Join off", async () => {
    install("off");
    render(() => <TeamSection />);
    await screen.findByText("Join a team");
    typeCode("nonsense");
    typeName();
    expect((await screen.findByTestId("join-invalid")).textContent).toMatch(/not an invite code.*intely-team:\/\/join#/);
    expect(joinBtn().disabled).toBe(true);
  });

  it("an invite whose relay address is refused says why instead of calling the text no invite", async () => {
    install("off");
    vi.spyOn(ipc.team, "joinPreview").mockRejectedValue({ code: "insecure", message: "raw" });
    render(() => <TeamSection />);
    await screen.findByText("Join a team");
    typeCode(CODE);
    typeName();
    const msg = (await screen.findByTestId("join-invalid")).textContent ?? "";
    expect(msg).toMatch(/relay address in the invite looks wrong/);
    expect(msg).not.toMatch(/not an invite code/);
    expect(joinBtn().disabled).toBe(true);
  });

  it("ignores a stale answer", async () => {
    install("off");
    let release!: (v: Awaited<ReturnType<typeof ipc.team.joinPreview>>) => void;
    const slow = new Promise<Awaited<ReturnType<typeof ipc.team.joinPreview>>>((r) => (release = r));
    vi.spyOn(ipc.team, "joinPreview").mockImplementationOnce(() => slow).mockRejectedValue({ code: "invalidCode", message: "x" });
    render(() => <TeamSection />);
    await screen.findByText("Join a team");
    typeCode(CODE);
    await waitFor(() => expect(ipc.team.joinPreview).toHaveBeenCalledTimes(1));
    typeCode("changed");
    await screen.findByTestId("join-invalid");
    release({ relayHost: "old.example", trusted: true, local: false, teamId: "x", adminId: "y" });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("join-preview")).toBeNull();
    expect(screen.getByTestId("join-invalid")).toBeTruthy();
  });

  it("when the backend still says hostNotAllowed, the box comes back", async () => {
    install("off");
    vi.spyOn(ipc.team, "joinPreview").mockResolvedValue({ relayHost: "r.example", trusted: true, local: false, teamId: "t", adminId: "a" });
    vi.spyOn(ipc.team, "join").mockRejectedValue({ code: "hostNotAllowed", message: "raw" });
    render(() => <TeamSection />);
    await screen.findByText("Join a team");
    typeCode(CODE);
    typeName();
    await screen.findByTestId("join-trusted");
    fireEvent.click(joinBtn());
    expect((await screen.findByRole("alert")).textContent).toMatch(/does not trust the relay/);
    expect(await screen.findByRole("checkbox")).toBeTruthy();
    expect(joinBtn().disabled).toBe(true);
  });

  it.each([
    ["invalidCode", /not an invite code/],
    ["scheme", /must start with wss/],
    ["insecure", /must start with wss/],
    ["urlSyntax", /must start with wss/],
    ["userinfo", /must start with wss/],
    ["ipLiteral", /must start with wss/],
    ["idn", /must start with wss/],
    ["readOnly", /read-only/],
    ["testJail", /restricted test mode/],
    ["inviteSpent", /expired or was already used.*10 minutes/],
    ["full", /team is full/],
    ["alreadyInTeam", /already in a team/],
  ])("shows %s in plain words", async (code, re) => {
    install("off");
    vi.spyOn(ipc.team, "joinPreview").mockResolvedValue({ relayHost: "r.example", trusted: true, local: false, teamId: "t", adminId: "a" });
    vi.spyOn(ipc.team, "join").mockRejectedValue({ code, message: "raw message" });
    render(() => <TeamSection />);
    await screen.findByText("Join a team");
    typeCode(CODE);
    typeName();
    await screen.findByTestId("join-trusted");
    fireEvent.click(joinBtn());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(re);
    expect(alert.textContent).not.toContain("raw message");
  });

  it("an unknown code keeps the raw message", async () => {
    install("off");
    vi.spyOn(ipc.team, "joinPreview").mockResolvedValue({ relayHost: "r.example", trusted: true, local: false, teamId: "t", adminId: "a" });
    vi.spyOn(ipc.team, "join").mockRejectedValue({ code: "weird", message: "something odd" });
    render(() => <TeamSection />);
    await screen.findByText("Join a team");
    typeCode(CODE);
    typeName();
    await screen.findByTestId("join-trusted");
    fireEvent.click(joinBtn());
    expect((await screen.findByRole("alert")).textContent).toBe("something odd");
  });
});

describe("mock join", () => {
  it("previews, rejects an unacknowledged host and accepts it with trustRelay", async () => {
    const m = createMockTeam({ preset: "off" });
    await expect(m.joinPreview("nope")).rejects.toMatchObject({ code: "invalidCode" });
    const p = await m.joinPreview(" INTELY-TEAM://join#\n wss://Relay.Example.org:8443,teamteam1234,adminadmin12,b,c ");
    expect(p).toEqual({ relayHost: "relay.example.org:8443", trusted: false, local: false, teamId: "teamteam", adminId: "adminadm" });
    await expect(m.join(CODE, "Robin")).rejects.toMatchObject({ code: "hostNotAllowed" });
    await m.join(CODE, "Robin", true);
    expect((await m.joinPreview(CODE)).trusted).toBe(true);
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

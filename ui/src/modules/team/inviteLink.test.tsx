import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", async (orig) => {
  const mod = await orig<typeof import("../../ipc")>();
  const { createMockIpc } = await import("../../ipc/mock");
  return { ...mod, ipc: createMockIpc("normal", { delayScale: 0 }) };
});

import { ipc } from "../../ipc";
import { createMockTeam, type MockTeamHandle } from "../../ipc/mock/team";
import { activeSettingsSection, registerSettingsSection, resetSettings, settingsOpen } from "../../platform/settings";
import { installDomStubs } from "../../store/testing-u2";
import { toast } from "../../ui-kit";
import { pendingInvite, receiveInviteLink, resetInviteLinks, startInviteLinks } from "./inviteLink";
import { resetTeam } from "./store";
import TeamSection from "./TeamSection";

installDomStubs();
vi.setConfig({ testTimeout: 30000 });

const LINK = "intely-team://join#wss://relay.example.workers.dev,CEx5c2s4WAO1kx7iTVzL9g,gKAK926tlsM_abcdef,AAAA,BBBB";

let mock: MockTeamHandle;
const install = (preset: "off" | "on") => {
  mock = createMockTeam({ preset });
  (ipc as { team: unknown }).team = mock;
};

beforeEach(() => {
  resetTeam();
  resetInviteLinks();
  registerSettingsSection({ id: "team", title: "Team", order: 51, searchTerms: [], component: () => null });
});
afterEach(() => {
  cleanup();
  resetSettings();
  toast.clear();
  vi.restoreAllMocks();
});

describe("a clicked invite link", () => {
  it("opens Settings on Team and puts the code in the join form, whose preview reads it", async () => {
    install("off");
    render(() => <TeamSection />);
    await screen.findByText("Join a team");
    startInviteLinks();
    mock.sim.inviteLink(LINK);
    const preview = await screen.findByTestId("join-preview");
    expect(preview.textContent).toContain("relay.example.workers.dev");
    expect((screen.getByLabelText("Invite code") as HTMLTextAreaElement).value).toBe(LINK);
    expect(settingsOpen()).toBe(true);
    expect(activeSettingsSection()?.id).toBe("team");
    expect(pendingInvite()).toBeUndefined();
    // it only fills the form: nothing is joined and the relay still has to be trusted by the person
    expect((await ipc.team.status()).state).toBe("none");
    expect(screen.getByRole("button", { name: "Join team" }).hasAttribute("disabled")).toBe(true);
  });

  it("waits for a form that is not on screen yet (a link that started the app)", async () => {
    install("off");
    mock.sim.inviteLink(LINK);
    startInviteLinks();
    await waitFor(() => expect(pendingInvite()).toBe(LINK));
    expect(settingsOpen()).toBe(true);
    render(() => <TeamSection />);
    expect(await screen.findByTestId("join-preview")).toBeTruthy();
    expect(pendingInvite()).toBeUndefined();
  });

  it("is handed over once and a second link replaces a form that has not taken the first", async () => {
    install("off");
    startInviteLinks();
    mock.sim.inviteLink(LINK);
    await waitFor(() => expect(pendingInvite()).toBe(LINK));
    const second = LINK.replace("CEx5c2s4", "ZZx5c2s4");
    mock.sim.inviteLink(second);
    await waitFor(() => expect(pendingInvite()).toBe(second));
    expect(await ipc.team.takeInviteLink()).toBeNull();
  });

  it("does not offer the form to an install that is in a team: it says so and still opens Settings on Team", async () => {
    install("on");
    await receiveInviteLink(LINK);
    expect(pendingInvite()).toBeUndefined();
    expect(settingsOpen()).toBe(true);
    expect(activeSettingsSection()?.id).toBe("team");
    expect(toast.toasts().map((x) => x.title)).toContain("You are already in a team");
  });

  it("ignores a start with no link waiting", async () => {
    install("off");
    startInviteLinks();
    await Promise.resolve();
    expect(pendingInvite()).toBeUndefined();
    expect(settingsOpen()).toBe(false);
  });
});

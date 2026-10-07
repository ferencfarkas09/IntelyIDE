import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../ipc";
import { availableCommands, resetCommands } from "../../platform/commands";
import { dockTabs } from "../../platform/dock";
import { resetStatusItems, statusItems } from "../../platform/statusbar";
import { connectHappyForTest, disconnectHappyForTest } from "../../store/happyTestKit";
import { register } from "./index";
import MeetItem from "./MeetItem";
import MeetTab from "./MeetTab";

afterEach(async () => {
  cleanup();
  resetCommands();
  resetStatusItems();
  vi.restoreAllMocks();
  await disconnectHappyForTest();
});

describe("happy-meet register()", () => {
  it("registers a status item, a Meet dock tab and commands, hidden until Meet is connected", async () => {
    register();
    expect(dockTabs().some((t) => t.id === "meet")).toBe(true);
    expect(statusItems("right").map((i) => i.id)).not.toContain("happy-meet");
    expect(availableCommands().map((c) => c.id)).not.toContain("meet.join");
    const stop = await connectHappyForTest();
    expect(statusItems("right").map((i) => i.id)).toContain("happy-meet");
    expect(availableCommands().map((c) => c.id)).toEqual(expect.arrayContaining(["meet.show", "meet.join"]));
    stop();
  });
});

describe("<MeetItem>", () => {
  it("points at the live meeting and joins it in the browser", async () => {
    const stop = await connectHappyForTest();
    const join = vi.spyOn(ipc.happy.meet, "join");
    render(() => <MeetItem />);
    expect(screen.getByText("Reggeli standup is live")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    await waitFor(() => expect(join).toHaveBeenCalledWith("m_live_1"));
    stop();
  });

  it("shows a toast with the reason when joining fails, and never throws", async () => {
    const stop = await connectHappyForTest();
    vi.spyOn(ipc.happy.meet, "join").mockRejectedValue({ code: "INSUFFICIENT_CREDITS", message: "No credits" });
    render(() => <MeetItem />);
    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    await waitFor(() => expect(ipc.happy.meet.join).toHaveBeenCalled());
    stop();
  });
});

describe("<MeetTab>", () => {
  it("explains that Meet is off", () => {
    render(() => <MeetTab />);
    expect(screen.getByText("Meet is off")).toBeTruthy();
  });

  it("lists live and upcoming meetings with a Join button each", async () => {
    const stop = await connectHappyForTest();
    render(() => <MeetTab />);
    expect(await screen.findByText("Sprint review")).toBeTruthy();
    expect(screen.getByText("Live now")).toBeTruthy();
    expect(screen.getByText("Retro")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Join" })).toHaveLength(3);
    stop();
  });
});

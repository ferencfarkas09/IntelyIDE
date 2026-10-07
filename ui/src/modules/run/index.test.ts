import { afterEach, describe, expect, it } from "vitest";
import { availableCommands, resetCommands } from "../../platform/commands";
import { getRailItem, resetRail } from "../../platform/rail";
import { resetStatusItems, statusItems } from "../../platform/statusbar";
import { applyServerState, resetDevServers, unwireDevServers } from "../../store/devservers";
import { register } from "./index";

afterEach(() => {
  resetCommands();
  resetRail();
  resetStatusItems();
  unwireDevServers();
  resetDevServers();
  localStorage.clear();
});

describe("run module", () => {
  it("registers a bottom rail item, palette commands and a status chip that shows only while a server runs", () => {
    register();
    expect(getRailItem("run")?.position).toBe("bottom");
    expect(availableCommands().map((c) => c.id)).toEqual(expect.arrayContaining(["run.show", "run.runScript"]));
    expect(availableCommands().map((c) => c.id)).not.toContain("run.stopAll");
    expect(statusItems("left").map((i) => i.id)).not.toContain("run");
    applyServerState({ id: "r:npm:dev", repoId: "r", script: "npm:dev", runner: "npm run dev", status: "running", startedAt: 1, ports: [8082], procs: 3 });
    expect(statusItems("left").map((i) => i.id)).toContain("run");
    expect(availableCommands().map((c) => c.id)).toContain("run.stopAll");
  });
});

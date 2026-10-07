import { afterEach, describe, expect, it } from "vitest";
import { applyServerState, devServers, formatRss, heavyServers, isLive, liveServers, resetDevServers, totalRssMb } from "../../store/devservers";
import type { ServerInfo } from "../../ipc/run";

const server = (id: string, extra: Partial<ServerInfo> = {}): ServerInfo => ({ id, repoId: "r", script: "npm:dev", runner: "npm run dev", status: "running", startedAt: 1, ports: [], procs: 1, ...extra });

afterEach(resetDevServers);

describe("the dev server store", () => {
  it("upserts by id and counts only live servers", () => {
    applyServerState(server("a", { rssMb: 500 }));
    applyServerState(server("b", { status: "exited", rssMb: 900 }));
    applyServerState(server("a", { rssMb: 700, heavyMb: 4800 }));
    expect(devServers()).toHaveLength(2);
    expect(liveServers().map((s) => s.id)).toEqual(["a"]);
    expect(totalRssMb()).toBe(700);
    expect(heavyServers()).toHaveLength(1);
    expect(isLive(server("c", { status: "stopping" }))).toBe(true);
  });

  it("formats sizes", () => {
    expect([formatRss(null), formatRss(512), formatRss(2048)]).toEqual(["–", "512 MB", "2.0 GB"]);
  });
});

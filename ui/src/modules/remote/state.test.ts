import { afterEach, describe, expect, it } from "vitest";
import { ipc } from "../../ipc";
import { refreshRemote, remoteView, resetRemoteState } from "./state";

afterEach(() => resetRemoteState());

describe("remote state", () => {
  it("reloads the view when the relay changed (the pairing dialog shows the new expected hash and relay)", async () => {
    await ipc.remote.enable();
    await refreshRemote();
    const before = remoteView()?.relay;
    await ipc.remote.applyLocalRelay("ws://127.0.0.1:9191", false);
    await new Promise((r) => setTimeout(r, 20));
    expect(remoteView()?.relay).toBe("ws://127.0.0.1:9191");
    expect(before).not.toBe("ws://127.0.0.1:9191");
  });
});

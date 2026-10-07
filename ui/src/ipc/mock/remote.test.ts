import { describe, expect, it } from "vitest";
import { createMockRemote } from "./remote";

describe("mock remote", () => {
  it("starts off, with nothing paired", async () => {
    const r = createMockRemote({ preset: "off" });
    const v = await r.status();
    expect(v.state).toBe("off");
    expect(v.devices).toEqual([]);
    expect(v.claudeRemoteControl).toBe("blocked");
  });

  it("pairs through the six-digit comparison and the new device is view-only", async () => {
    const r = createMockRemote({ preset: "off" });
    await expect(r.pairStart()).rejects.toMatchObject({ code: "remote" });
    await r.enable();
    const offer = await r.pairStart();
    expect(offer.manualCode).toMatch(/^[0-9A-Z-]+$/);
    const code = r.sim.phoneArrives("iPhone");
    expect(code).toMatch(/^\d{6}$/);
    expect((await r.status()).pairing.sas).toEqual({ code, deviceName: "iPhone" });
    await r.pairConfirm(true);
    const v = await r.status();
    expect(v.devices).toMatchObject([{ name: "iPhone", capability: "view" }]);
    expect(v.pairing).toEqual({ offer: null, sas: null });
    expect(v.audit.map((e) => e.event)).toContain("pairing.accepted");
  });

  it("a declined or cancelled pairing registers nothing", async () => {
    const r = createMockRemote({ preset: "off" });
    await r.enable();
    await r.pairStart();
    r.sim.phoneArrives("stranger");
    await r.pairConfirm(false);
    expect((await r.status()).devices).toEqual([]);
    await r.pairStart();
    await r.pairCancel();
    expect((await r.status()).pairing.offer).toBeNull();
  });

  it("revokes, promotes, and panic removes everything and switches off", async () => {
    const r = createMockRemote({ preset: "on" });
    const seen: string[] = [];
    r.onEvent((e) => seen.push(e.kind));
    await r.setCapability("d_1", "reply");
    expect((await r.status()).devices[0]?.capability).toBe("reply");
    expect(await r.revoke("nope")).toBe(false);
    await r.pairStart();
    r.sim.phoneArrives("second");
    await r.pairConfirm(true, { capability: "reply" });
    const after = await r.panic();
    expect(after.state).toBe("off");
    expect(after.devices).toEqual([]);
    expect(seen).toContain("devicesChanged");
  });

  it("configure never changes the relay; applyLocalRelay takes loopback only; the re-auth window is clamped", async () => {
    const r = createMockRemote({ preset: "off" });
    await expect(r.configure({ relayUrl: "ws://localhost:8787" })).rejects.toMatchObject({ code: "useApply" });
    await expect(r.applyLocalRelay("wss://relay.example.com", false)).rejects.toMatchObject({ code: "hostNotAllowed" });
    await expect(r.applyLocalRelay("ws://relay.localhost:8787", false)).rejects.toMatchObject({ code: "hostNotAllowed" });
    await r.configure({ reauthHours: 500, macName: "Studio" });
    await r.applyLocalRelay("ws://localhost:8787", false);
    const v = await r.status();
    expect(v).toMatchObject({ relay: "ws://localhost:8787", reauthHours: 72, macName: "Studio", relayMode: "local", relayHostAllowed: true, bundle: null });
  });

  it("the kill switch switches off and keeps the devices", async () => {
    const r = createMockRemote({ preset: "on" });
    const v = await r.kill();
    expect(v.state).toBe("off");
    expect(v.devices).toHaveLength(1);
    expect(v.devices[0]?.connected).toBe(false);
  });
});

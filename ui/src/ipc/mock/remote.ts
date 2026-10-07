import type { Capability, DeviceView, OfferView, RemoteSettingsView } from "../../bindings/remote";
import type { RemoteConfigPatch, RemoteEvent, RemoteIpc } from "../remote";
import { isShowcase } from "./showcase";

export interface MockRemoteOptions {
  now?: () => number;
  /** `?remote=on` in the dev URL opens the mock with Remote already on and one paired phone, for screenshots. */
  preset?: "off" | "on";
}

/** Drives the mock like a phone would; the real thing is `crates/remote`. */
export interface MockRemoteSim {
  /** A phone scans the offer and proves the code: the Mac now shows the six digits. */
  phoneArrives(name: string): string;
  /** A paired phone connects or disconnects. */
  setConnected(id: string, connected: boolean): void;
  events: RemoteEvent[];
}

const HOUR = 3_600_000;
const E2E_NOTE = "End-to-end encryption holds against an honest-code, passive relay only, until the native app: a compromised relay could serve hostile JavaScript. Compare the bundle hash when pairing.";

function presetFromUrl(): "off" | "on" {
  return new URLSearchParams(globalThis.location?.search).get("remote") === "on" ? "on" : "off";
}

export function createMockRemote(options: MockRemoteOptions = {}): RemoteIpc & { sim: MockRemoteSim } {
  const now = options.now ?? Date.now;
  let on = (options.preset ?? presetFromUrl()) === "on";
  let relay = "ws://127.0.0.1:8787";
  let macName = "My Mac";
  let reauthHours = 12;
  let seq = 0;
  let devices: DeviceView[] = on ? [{ id: "d_1", name: isShowcase() ? "Jordan's iPhone" : "Sam's iPhone", capability: "view", reauthRequired: false, hasPasskey: true, connected: true, createdAt: now() - 3 * 24 * HOUR, lastSeenAt: now() - 60_000 }] : [];
  let audit: RemoteSettingsView["audit"] = [];
  let offer: OfferView | null = null;
  let sas: { code: string; deviceName: string } | null = null;
  const listeners = new Set<(e: RemoteEvent) => void>();
  const events: RemoteEvent[] = [];

  const log = (event: string, extra: Partial<RemoteSettingsView["audit"][number]> = {}) => {
    audit = [...audit, { seq: audit.length + 1, ts: now(), event, prev: "0".repeat(64), hash: String(++seq).padStart(64, "0"), ...extra }].slice(-20);
  };
  const emit = (e: RemoteEvent) => {
    events.push(e);
    listeners.forEach((l) => l(e));
  };
  const view = (): RemoteSettingsView => ({
    state: on ? "online" : "off",
    tampered: null,
    relay,
    macName,
    devices: devices.map((d) => ({ ...d, reauthRequired: d.capability === "reply" && now() - d.lastSeenAt > reauthHours * HOUR })),
    pairing: { offer, sas },
    audit,
    auditLen: audit.length,
    reauthHours,
    expectedBundleHash: null,
    claudeRemoteControl: "blocked",
    e2eNote: E2E_NOTE,
    relayMode: "local",
    relayHostAllowed: true,
    bundle: null,
    relayStats: { day: new Date(now()).toISOString().slice(0, 10), framesSent: 0, consecutiveFailures: 0, lastError: null },
  });
  const requireOn = () => {
    if (!on) throw { code: "remote", message: "Remote is off" };
  };

  const api: RemoteIpc = {
    async status() {
      return view();
    },
    async configure(patch: RemoteConfigPatch) {
      if (patch.relayUrl !== undefined) throw { code: "useApply", message: "the relay is changed with the apply commands, not with configure" };
      if (patch.macName !== undefined) macName = patch.macName.slice(0, 60);
      if (patch.reauthHours !== undefined) reauthHours = Math.min(72, Math.max(1, patch.reauthHours));
    },
    async applyLocalRelay(url: string, _confirmUnpair: boolean) {
      const m = /^(ws|wss):\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?\/?$/.exec(url);
      if (!m) throw { code: "hostNotAllowed", message: "only a relay on this machine can be applied here" };
      relay = `${m[1]}://${m[2]}${m[3] ?? ""}`;
      emit({ kind: "relayChanged" });
      return view();
    },
    async sendBuildKey() {},
    async enable() {
      on = true;
      log("remote.started");
      return view();
    },
    async disable() {
      on = false;
      offer = null;
      sas = null;
      devices = devices.map((d) => ({ ...d, connected: false }));
      return view();
    },
    async pairStart() {
      requireOn();
      offer = { qrFragment: `#p=${relay.replace(/^wss?:\/\//, "")},mockRoom,mockMacKey,mockOtp`, manualCode: "7QXKM-3D9PT-WB2N5-H4ZRC-A8", expiresAt: now() + 60_000 };
      log("pairing.started");
      return offer;
    },
    async pairConfirm(accept, opts) {
      requireOn();
      if (!sas) throw { code: "remote", message: "no pairing is waiting for confirmation" };
      if (accept) {
        const id = `d_${devices.length + 1}`;
        devices = [...devices, { id, name: opts?.name ?? sas.deviceName, capability: opts?.capability ?? "view", reauthRequired: false, hasPasskey: false, connected: false, createdAt: now(), lastSeenAt: now() }];
        log("pairing.accepted", { deviceId: id });
        emit({ kind: "devicesChanged" });
      } else {
        log("pairing.declined");
      }
      emit({ kind: "pairingEnded", outcome: accept ? "accepted" : "declined" });
      offer = null;
      sas = null;
    },
    async pairCancel() {
      offer = null;
      sas = null;
      emit({ kind: "pairingEnded", outcome: "cancelled" });
    },
    async revoke(id) {
      const had = devices.some((d) => d.id === id);
      devices = devices.filter((d) => d.id !== id);
      if (had) {
        log("device.revoked", { deviceId: id });
        emit({ kind: "devicesChanged" });
      }
      return had;
    },
    async setCapability(id: string, capability: Capability) {
      if (!devices.some((d) => d.id === id)) throw { code: "remote", message: "unknown device" };
      devices = devices.map((d) => (d.id === id ? { ...d, capability } : d));
      log("device.capability", { deviceId: id, detail: capability });
    },
    async kill() {
      log("remote.killed");
      return api.disable();
    },
    async panic() {
      const n = devices.length;
      devices = [];
      log("device.revokedAll", { detail: `panic; ${n} devices` });
      emit({ kind: "devicesChanged" });
      return api.disable();
    },
    onEvent(cb) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
  };

  const sim: MockRemoteSim = {
    phoneArrives(name) {
      requireOn();
      if (!offer || offer.expiresAt <= now()) throw { code: "remote", message: "no open pairing offer" };
      sas = { code: "482 915".replace(" ", ""), deviceName: name };
      log("pairing.codeProven");
      emit({ kind: "pairingSas", code: sas.code, deviceHint: name });
      return sas.code;
    },
    setConnected(id, connected) {
      devices = devices.map((d) => (d.id === id ? { ...d, connected, lastSeenAt: now() } : d));
    },
    events,
  };
  // Screenshots and manual checks: a headless browser can play the phone (`__intelyMockRemote.phoneArrives("iPhone")`) when `?remote=` is in the URL.
  if (typeof window !== "undefined" && new URLSearchParams(window.location?.search).has("remote")) (window as unknown as { __intelyMockRemote?: MockRemoteSim }).__intelyMockRemote = sim;
  return Object.assign(api, { sim });
}

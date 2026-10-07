import type { Capability, OfferView, RemoteSettingsView } from "../bindings/remote";
import { call, subscribe } from "./rpc";
import type { Unsubscribe } from "./index";

export type { AuditEntry, BundleSource, BundleView, Capability, DeviceView, OfferView, PairingView, RelayStatsView, RemoteSettingsView, RemoteState, SasView } from "../bindings/remote";

/** `remote:event` payloads: things the Settings page should react to without polling. */
export type RemoteEvent =
  | { kind: "pairingSas"; code: string; deviceHint: string }
  | { kind: "pairingEnded"; outcome: string }
  | { kind: "devicesChanged" }
  | { kind: "anomaly"; deviceId: string }
  | { kind: "tampered"; message: string }
  | { kind: "needsYouAging" }
  /** The relay URL, mode or bundle changed live; reload the view. */
  | { kind: "relayChanged" };

export interface RemoteConfigPatch {
  /** Rejected with the error code `useApply` in every state: change the relay with `applyLocalRelay` or the cloud commands. */
  relayUrl?: string;
  macName?: string;
  /** 1 to 72: how long a `reply` device stays `reply` before its passkey check. */
  reauthHours?: number;
}

/**
 * IntelyIDE Remote (`(design notes: remote-plan)`), the data API of Settings > Remote (`src-tauri/src/modules/remote.rs`). Everything
 * here is a desktop gesture: pairing, promotion, revocation, enabling, the kill switch and panic are never reachable from the
 * phone or an agent. Keys, tokens and the Noise state never cross this boundary; the view carries names, capabilities, times
 * and the hash-chained audit tail only. Remote is off by default and a newly paired device is `view`-only.
 * Rejections are `EngineError`s with code `remote` (message in words), `unavailable`, or the settings codes.
 */
export interface RemoteIpc {
  /** The whole Settings > Remote page. Opens nothing and creates nothing while Remote was never used. */
  status(): Promise<RemoteSettingsView>;
  /** Saved for the next time Remote is switched on. */
  configure(patch: RemoteConfigPatch): Promise<void>;
  /**
   * The one live path for a relay on this machine (`ws://127.0.0.1:<port>`, `localhost`, `[::1]`): applied without a restart.
   * Rejections: `hostNotAllowed` (not a local relay), `urlSyntax`/`scheme`/`ipLiteral`/..., `needsRepair` (the host changes
   * while phones are paired; `detail` holds their number, retry with `confirmUnpair`).
   */
  applyLocalRelay(url: string, confirmUnpair: boolean): Promise<RemoteSettingsView>;
  /** Sends the Mac's build-signing key to paired phones (live sessions now, the others at their next session). */
  sendBuildKey(): Promise<void>;
  enable(): Promise<RemoteSettingsView>;
  /** Thread, socket and event subscription are gone when this resolves. */
  disable(): Promise<RemoteSettingsView>;
  /** A one-time code valid for 60 s: QR fragment and the manual code. Needs Remote on. */
  pairStart(): Promise<OfferView>;
  /** After comparing the 6 digits: `accept=false` is "Codes do not match". New devices are `view` unless `capability` says otherwise. */
  pairConfirm(accept: boolean, opts?: { name?: string; capability?: Capability }): Promise<void>;
  pairCancel(): Promise<void>;
  /** Effective at once locally; a live session is dropped within a tick. `false` = no such device. */
  revoke(id: string): Promise<boolean>;
  setCapability(id: string, capability: Capability): Promise<void>;
  /** Closes every session, refuses connections, switches Remote off. */
  kill(): Promise<RemoteSettingsView>;
  /** Lock all: revokes every device, rotates key, room and token, wipes the relay room, switches Remote off. */
  panic(): Promise<RemoteSettingsView>;
  onEvent(cb: (e: RemoteEvent) => void): Unsubscribe;
}

export function createTauriRemote(): RemoteIpc {
  return {
    status: () => call("remote_status"),
    configure: (patch) => call("remote_configure", { patch }),
    applyLocalRelay: (url, confirmUnpair) => call("remote_apply_local_relay", { url, confirmUnpair }),
    sendBuildKey: () => call("remote_send_build_key"),
    enable: () => call("remote_enable"),
    disable: () => call("remote_disable"),
    pairStart: () => call("remote_pair_start"),
    pairConfirm: (accept, opts) => call("remote_pair_confirm", { accept, name: opts?.name ?? null, capability: opts?.capability ?? null }),
    pairCancel: () => call("remote_pair_cancel"),
    revoke: (id) => call("remote_revoke", { id }),
    setCapability: (id, capability) => call("remote_set_capability", { id, capability }),
    kill: () => call("remote_kill"),
    panic: () => call("remote_panic"),
    onEvent: (cb) => subscribe("remote:event", cb),
  };
}

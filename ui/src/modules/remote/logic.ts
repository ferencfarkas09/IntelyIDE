import { t } from "../../i18n";
import type { Capability, DeviceView, RemoteState } from "../../ipc/remote";

export const STATE_LABEL: Record<RemoteState, string> = {
  get off() {
    return t("remote.state.off");
  },
  get connecting() {
    return t("remote.state.connecting");
  },
  get online() {
    return t("remote.state.online");
  },
  get tampered() {
    return t("remote.state.tampered");
  },
};

export const CAPABILITY_LABEL: Record<Capability, string> = {
  get view() {
    return t("remote.cap.view");
  },
  get reply() {
    return t("remote.cap.reply");
  },
};

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return t("remote.ago.now");
  const m = Math.round(s / 60);
  if (m < 60) return t("remote.ago.min", { n: m });
  const h = Math.round(m / 60);
  if (h < 48) return t("remote.ago.hour", { n: h });
  return t("remote.ago.day", { n: Math.round(h / 24) });
}

/** The address a phone opens: the relay URL with http(s) instead of ws(s), plus the pairing fragment. */
export function pairingLink(relay: string, fragment: string): string {
  const base = relay.replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/+$/, "");
  return `${base}/${fragment}`;
}

export function deviceLine(d: DeviceView, now: number): string {
  const seen = d.connected ? t("remote.device.connected") : t("remote.device.lastSeen", { ago: ago(d.lastSeenAt, now) });
  const parts = [seen];
  if (d.reauthRequired) parts.push(t("remote.device.reauth"));
  if (!d.hasPasskey && d.capability === "reply") parts.push(t("remote.device.noPasskey"));
  return parts.join(" · ");
}

/** Short human text of an audit event name (`pairing.accepted` -> `Pairing accepted`). */
export function auditLabel(event: string): string {
  const [head = "", tail = ""] = event.split(".");
  const words = `${head} ${tail.replace(/([A-Z])/g, " $1")}`.trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const statusChipText = (state: RemoteState, devices: number): string =>
  state === "online" ? t("remote.chip.online", { n: devices }) : state === "tampered" ? t("remote.chip.stopped") : t("remote.chip.connecting");

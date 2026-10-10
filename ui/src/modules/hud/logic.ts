// Pure helpers of the HUD module.
import { t } from "../../i18n";
import type { ProcKind, ProcRow } from "../../ipc/hud";

export function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

export const KIND_LABEL: Record<ProcKind, string> = {
  get app() {
    return t("hud.kind.app");
  },
  webKit: "WebKit",
  sidecar: "Sidecar",
  get agent() {
    return t("hud.kind.agent");
  },
  get child() {
    return t("hud.kind.child");
  },
};

/** Totals per kind, largest first, for the popover summary. */
export function byKind(rows: readonly ProcRow[]): { kind: ProcKind; bytes: number; count: number }[] {
  const m = new Map<ProcKind, { bytes: number; count: number }>();
  for (const r of rows) {
    const cur = m.get(r.kind) ?? { bytes: 0, count: 0 };
    m.set(r.kind, { bytes: cur.bytes + r.rssBytes, count: cur.count + 1 });
  }
  return [...m.entries()].map(([kind, v]) => ({ kind, ...v })).sort((a, b) => b.bytes - a.bytes);
}

/** `ok` under 1 GB, `warn` under 2 GB, `danger` above: the tint of the chip. */
export function pressure(totalBytes: number): "ok" | "warn" | "danger" {
  const gb = totalBytes / 1024 ** 3;
  return gb < 1 ? "ok" : gb < 2 ? "warn" : "danger";
}

export const ECO_MINUTES = [1, 2, 5, 10, 15, 30] as const;

export interface HudSettings {
  enabled: boolean;
  eco: boolean;
  ecoMinutes: number;
}

export const DEFAULT_HUD: HudSettings = { enabled: false, eco: false, ecoMinutes: 5 };

export function readHud(v: Record<string, unknown> | undefined): HudSettings {
  const minutes = typeof v?.ecoMinutes === "number" && v.ecoMinutes >= 1 && v.ecoMinutes <= 240 ? Math.round(v.ecoMinutes) : DEFAULT_HUD.ecoMinutes;
  return { enabled: v?.enabled === true, eco: v?.eco === true, ecoMinutes: minutes };
}

export interface TraySettings {
  enabled: boolean;
}

export const DEFAULT_TRAY: TraySettings = { enabled: false };

export function readTray(v: Record<string, unknown> | undefined): TraySettings {
  return { enabled: v?.enabled === true };
}

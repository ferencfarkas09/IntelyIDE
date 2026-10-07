import type { Unsubscribe } from "../index";
import type { UpdateLatest, UpdateNotice, UpdatesIpc } from "../updates";

export const MOCK_LATEST: UpdateLatest = {
  version: "0.1.1",
  tag: "v0.1.1",
  url: "https://github.com/ferencfarkas09/IntelyIDE/releases/tag/v0.1.1",
  publishedAt: "2026-10-06T10:00:00Z",
  prerelease: true,
  notes: "Fixes and polish.\n- Faster start\n- Better diff colors",
  dmgName: "IntelyIDE_0.1.1_x64.dmg",
  dmgBytes: 48_000_000,
};

/** Deterministic updates for the browser mock and tests. Nothing is newer unless `latest` is passed. */
export function createMockUpdates(opts: { latest?: UpdateLatest; fail?: string; disclosed?: boolean } = {}): UpdatesIpc & { notice: () => UpdateNotice } {
  let notice: UpdateNotice = { enabled: true, currentVersion: "0.1.0", state: "idle", ...(opts.disclosed === false ? {} : { disclosedAt: 1 }) };
  const status = new Set<(n: UpdateNotice) => void>();
  const menu = new Set<() => void>();
  const set = (next: Partial<UpdateNotice>) => {
    notice = { ...notice, ...next };
    status.forEach((l) => l(notice));
    return notice;
  };
  return {
    notice: () => notice,
    async status() {
      return notice;
    },
    async check() {
      const at = Math.floor(Date.now() / 1000);
      if (opts.fail) return set({ state: "error", error: opts.fail, latest: undefined });
      return opts.latest ? set({ state: "available", latest: opts.latest, error: undefined, lastCheckedAt: at }) : set({ state: "upToDate", latest: undefined, error: undefined, lastCheckedAt: at });
    },
    async setEnabled(enabled) {
      return set({ enabled });
    },
    async dismiss(version) {
      return set({ dismissedVersion: version });
    },
    onStatus(cb): Unsubscribe {
      status.add(cb);
      return () => void status.delete(cb);
    },
    onMenuCheck(cb): Unsubscribe {
      menu.add(cb);
      return () => void menu.delete(cb);
    },
  };
}

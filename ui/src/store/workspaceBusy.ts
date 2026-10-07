import type { BusyItem, BusyReport } from "../ipc/workspaces";

/**
 * What stands between the user and a switch ((design notes: workspaces-spec) 3.9 and 4.11): Rust's `BusyReport` (git runs and operations
 * block; agents, servers, checks, terminals, previews and database connections are confirmable) plus the one UI-only item,
 * the unsaved editor buffers.
 */
export interface GuardModel {
  blocking: BusyItem[];
  confirmable: BusyItem[];
  /** Titles of the unsaved buffers (handled first, with Save all / Don't save). */
  unsaved: string[];
}

export const EMPTY_REPORT: BusyReport = { blocking: [], confirmable: [] };

const live = (items: BusyItem[]): BusyItem[] => items.filter((i) => i.count > 0);

export function mergeBusy(report: BusyReport, unsaved: readonly string[]): GuardModel {
  return { blocking: live(report.blocking), confirmable: live(report.confirmable), unsaved: [...unsaved] };
}

/** Nothing to ask: the switch can start without a dialog. */
export const isClear = (m: GuardModel): boolean => !m.blocking.length && !m.confirmable.length && !m.unsaved.length;

/** A git run or operation is in flight: the confirm buttons stay disabled until it is gone. */
export const hasBlocking = (m: GuardModel): boolean => m.blocking.length > 0;

/** The report Rust attaches to a `workspaceBusy` error (`detail` is JSON), or `null` when it is missing or malformed. */
export function parseBusyDetail(detail: string | null | undefined): BusyReport | null {
  if (!detail) return null;
  try {
    const v = JSON.parse(detail) as Partial<BusyReport>;
    if (!Array.isArray(v.blocking) || !Array.isArray(v.confirmable)) return null;
    return { blocking: v.blocking, confirmable: v.confirmable };
  } catch {
    return null;
  }
}

/** The dialog follows the world: it re-reads the report while it is open, so a finished operation enables the buttons. */
export const GUARD_POLL_MS = 1000;

// Latest report per repository. Filled by the tab (on demand) and by the watcher (after the Changes tree changed).
import { createRoot, createSignal } from "solid-js";
import { errorText } from "../../store/snapshots";
import { l10nApi } from "./api";
import type { Report } from "./types";

const state = createRoot(() => {
  const [reports, setReports] = createSignal<Record<string, Report>>({});
  const [busy, setBusy] = createSignal<Record<string, boolean>>({});
  const [errors, setErrors] = createSignal<Record<string, string>>({});
  return { reports, setReports, busy, setBusy, errors, setErrors };
});

export const reports = state.reports;
export const reportOf = (repoId: string): Report | undefined => state.reports()[repoId];
export const analyzing = (repoId: string): boolean => !!state.busy()[repoId];
export const analyzeError = (repoId: string): string | undefined => state.errors()[repoId];

const inflight = new Map<string, Promise<Report | undefined>>();

/** Runs the checker for one repo; concurrent calls share one run. A failure is kept as text, never thrown. */
export function refresh(repoId: string): Promise<Report | undefined> {
  const running = inflight.get(repoId);
  if (running) return running;
  state.setBusy((b) => ({ ...b, [repoId]: true }));
  const p = l10nApi()
    .analyze(repoId)
    .then((r) => {
      state.setReports((all) => ({ ...all, [repoId]: r }));
      state.setErrors((e) => ({ ...e, [repoId]: "" }));
      return r;
    })
    .catch((e) => {
      state.setErrors((all) => ({ ...all, [repoId]: errorText(e) }));
      return undefined;
    })
    .finally(() => {
      inflight.delete(repoId);
      state.setBusy((b) => ({ ...b, [repoId]: false }));
    });
  inflight.set(repoId, p);
  return p;
}

export const clearReports = (): void => void (state.setReports({}), state.setErrors({}));

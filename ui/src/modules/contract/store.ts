// Latest report plus a small cache of endpoint details. Filled by the tab (on demand) and by the watcher.
import { createRoot, createSignal } from "solid-js";
import { errorText } from "../../store/snapshots";
import { contractApi } from "./api";
import type { Detail, Report, SchemaNode } from "./types";

const state = createRoot(() => {
  const [report, setReport] = createSignal<Report | undefined>(undefined);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  return { report, setReport, busy, setBusy, error, setError };
});

export const report = state.report;
export const analyzing = state.busy;
export const analyzeError = state.error;

const details = new Map<string, Promise<Detail>>();
const defs = new Map<string, Promise<SchemaNode>>();
let inflight: Promise<Report | undefined> | undefined;

/** Runs the check; concurrent calls share one run. A failure is kept as text, never thrown. */
export function refresh(): Promise<Report | undefined> {
  if (inflight) return inflight;
  state.setBusy(true);
  inflight = contractApi()
    .analyze()
    .then((r) => {
      if (r.fingerprint !== state.report()?.fingerprint) {
        details.clear();
        defs.clear();
      }
      state.setReport(r);
      state.setError("");
      return r;
    })
    .catch((e) => {
      state.setError(errorText(e));
      return undefined;
    })
    .finally(() => {
      inflight = undefined;
      state.setBusy(false);
    });
  return inflight;
}

export function detailOf(id: string): Promise<Detail> {
  let p = details.get(id);
  if (!p) {
    p = contractApi().detail(id);
    details.set(id, p);
    p.catch(() => details.delete(id));
  }
  return p;
}

export function definitionOf(name: string): Promise<SchemaNode> {
  let p = defs.get(name);
  if (!p) {
    p = contractApi().definition(name);
    defs.set(name, p);
    p.catch(() => defs.delete(name));
  }
  return p;
}

export const clearReport = (): void => void (state.setReport(undefined), state.setError(""), details.clear(), defs.clear());

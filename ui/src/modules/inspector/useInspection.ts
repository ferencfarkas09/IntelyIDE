import { createMemo, onMount } from "solid-js";
import { snapshots } from "../../store/snapshots";
import { repos } from "../../store/workspace";
import { buildInspection, type Inspection } from "./model";
import { loadRunLog, runLog, type RunLog } from "./runEvents";

/** What a run tab is opened with; everything but `runId` is a hint until the log loads. */
export interface RunParams {
  runId: string;
  repoIds?: string[];
  title?: string;
  role?: string;
  /** Open the Rewind dialog right away. */
  rewind?: boolean;
}

export const asRunParams = (params: Record<string, unknown> | undefined): RunParams => ({
  runId: String(params?.runId ?? ""),
  repoIds: Array.isArray(params?.repoIds) ? (params!.repoIds as string[]) : undefined,
  title: typeof params?.title === "string" ? params.title : undefined,
  role: typeof params?.role === "string" ? params.role : undefined,
  rewind: params?.rewind === true ? true : undefined,
});

/** The event log of a run (loaded on mount, live afterwards) folded into an Inspection. Call inside a component. */
export function useInspection(params: () => RunParams): { log: () => RunLog | undefined; inspection: () => Inspection } {
  onMount(() => void loadRunLog(params().runId));
  const log = () => runLog(params().runId);
  const inspection = createMemo(() => {
    const roots = repos().map((r) => ({ id: r.id, path: r.path }));
    const snaps = snapshots();
    const exists = (repoId: string, path: string) => !!snaps[repoId]?.changes.some((c) => c.path === path);
    return buildInspection(params().runId, log()?.events ?? [], { repoIds: params().repoIds?.length ? params().repoIds! : roots.map((r) => r.id), roots, exists });
  });
  return { log, inspection };
}

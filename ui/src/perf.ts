import { invoke } from "@tauri-apps/api/core";
import { repos } from "./store/workspace";
import { onSnapshotApplied } from "./store/snapshots";

function mark(name: string, detail?: string, epochMs?: number): void {
  void invoke("perf_mark", { name, detail, epochMs }).catch(() => undefined);
}

/** After the next paint, so the mark is when the user could see it, not when the code ran. */
function afterPaint(fn: () => void): void {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

const at = (name: string): string => {
  const entry = performance.getEntriesByName(name, "mark")[0];
  return entry ? `${name.replace("app:", "")}=${entry.startTime.toFixed(0)}` : "";
};

/**
 * Startup milestones for the shell's opt-in perf log (`INTELY_PERF=1`): the webview's first contentful paint, the first
 * repo shown and all repos shown. The detail of `ready` carries the page-relative module and render marks (ms).
 */
export function trackStartup(): void {
  new PerformanceObserver((list, observer) => {
    const fcp = list.getEntries().find((e) => e.name === "first-contentful-paint");
    if (!fcp) return;
    observer.disconnect();
    mark("first_paint", `fcp=${fcp.startTime.toFixed(0)}`, performance.timeOrigin + fcp.startTime);
  }).observe({ type: "paint", buffered: true });

  const seen = new Set<string>();
  let readySent = false;
  onSnapshotApplied((s) => {
    if (seen.size === 0) afterPaint(() => mark("first_snapshot", s.repoId));
    seen.add(s.repoId);
    const wanted = repos();
    if (!readySent && wanted.length > 0 && wanted.every((r) => seen.has(r.id))) {
      readySent = true;
      afterPaint(() => mark("ready", ["repos=" + seen.size, at("app:boot"), at("app:render"), at("app:rendered")].filter(Boolean).join(" ")));
    }
  });
}

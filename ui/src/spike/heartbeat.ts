import { invoke } from "@tauri-apps/api/core";

// rAF heartbeat, reported once per second. `maxGapMs` is the largest inter-frame gap of the WHOLE run (never reset),
// `sinceFrameMs` is how long ago the last frame was drawn (a page whose rAF stopped shows up here even though no gap
// has been recorded yet) and `intervalMs` is the real time since the previous report, so frames/s can be normalised.
export function startHeartbeat(): void {
  let frames = 0;
  let maxGapMs = 0;
  let last = performance.now();
  let lastReport = last;
  let firstPaintSent = false;
  let rafId = 0;

  const tick = (now: number) => {
    frames += 1;
    maxGapMs = Math.max(maxGapMs, now - last);
    last = now;
    if (!firstPaintSent) {
      firstPaintSent = true;
      const count = (sel: string) => document.querySelectorAll(sel).length;
      const info = `mode=${window.__INTELY_MODE__ || "empty"} rows=${count(".row")} panes=${count(".pane")} cmLines=${count(".cm-line")} diffLines=${count(".cm-changedLine, .cm-deletedChunk")}`;
      void invoke("first_paint", { perfNow: now, info });
      void invoke("perf_mark", { name: "ready", detail: info });
    }
    rafId = requestAnimationFrame(tick);
  };
  // INTELY_RAF=0 (Rust) stops the continuous loop after first paint, to measure true idle CPU.
  const continuous = window.__INTELY_RAF__ !== false;
  requestAnimationFrame((now) => {
    tick(now);
    if (!continuous) cancelAnimationFrame(rafId);
  });

  setInterval(() => {
    const now = performance.now();
    const payload = {
      frames,
      intervalMs: Math.round(now - lastReport),
      maxGapMs: Math.round(maxGapMs),
      sinceFrameMs: Math.round(now - last),
    };
    frames = 0;
    lastReport = now;
    void invoke("heartbeat", payload);
  }, 1000);
}

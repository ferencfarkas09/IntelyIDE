// Diagnostic, not a scenario: reports the webview's own timings (navigation, paint, per-resource) so a slow startup can be
// split into "loading assets" and "running JS". Use it with a hand-made config, see scripts/e2e/startup-probe.sh.
await waitForTree();
const nav = performance.getEntriesByType("navigation")[0];
const paints = Object.fromEntries(performance.getEntriesByType("paint").map((p) => [p.name, Math.round(p.startTime)]));
const resources = performance.getEntriesByType("resource").map((r) => ({
  name: r.name.replace(/^.*\//, ""),
  start: Math.round(r.startTime),
  end: Math.round(r.responseEnd),
  bytes: r.transferSize || r.encodedBodySize || 0,
}));
const marks = performance.getEntriesByType("mark").map((m) => [m.name, Math.round(m.startTime)]);
await finish({
  nav: { domInteractive: Math.round(nav.domInteractive), domContentLoaded: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd), responseEnd: Math.round(nav.responseEnd) },
  paints,
  resources,
  marks,
  perfNow: Math.round(performance.now()),
});

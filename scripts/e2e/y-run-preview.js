// (y) Run panel + Preview + click-to-source in the real window, on a fixture dev server (scripts/e2e/y-fixture, never a real project).
//   y   READ-ONLY jail (the mode `pnpm dev:app` starts in): starting is refused until Settings > Safety > "Allow processes" is on;
//       then Run starts the fixture dev server, the port chip shows, the Preview tab loads it through the loopback proxy, an
//       Alt+click on an element opens src/App.jsx at the right line in an editor tab, Stop leaves no process. A second start is left
//       running on purpose: run.sh then checks that quitting the IDE took the server with it.
//   y2  E2E jail: the fixture-root rule needs no switch (it is disabled), the proxy refuses a port no Run-panel server listens on.
// The Alt+click is replayed by the fixture page itself (it dispatches a click with altKey when the IDE posts {e2e:"altclick"} to
// the frame): the harness has no OS-level mouse and a cross-origin frame cannot be clicked from here. The injected inspector,
// the proxy, the message to the IDE, the path jail and the editor open are all the real ones.
await waitForTree();
const BE = FX.repoIds[0];
const two = PHASE === 2;
const runButton = () => qa("button").find((b) => /^Run npm run dev/.test(b.getAttribute("aria-label") ?? ""));
const stopButton = () => qa("button").find((b) => /^Stop npm run dev/.test(b.getAttribute("aria-label") ?? ""));
const portChip = () => qa(".run-script__state .run-chip").map((c) => text(c)).find((t) => /^:\d+$/.test(t));
const listed = async () => (await invoke("run_list")).find((s) => s.id.startsWith(`${BE}:`));
const frameEl = () => q("iframe[data-intely-preview]");
const settingsOpen = () => q(".settings");

/** The rail also has "Run history": match the Run button itself. */
async function openRunPanel() {
  const b = await waitFor(() => qa("nav.rail button").find((x) => /^Run(?! history)/.test(x.getAttribute("aria-label") ?? "")), { what: "the Run rail button" });
  if (b.getAttribute("aria-pressed") !== "true") b.click();
  await sleep(150);
}

async function openSafety() {
  if (!settingsOpen()) { await press(",", { meta: true }); await waitFor(settingsOpen, { what: "Settings" }); }
  const item = await waitFor(() => qa(".settings__item", settingsOpen()).find((b) => text(b) === "Safety"), { what: "Settings > Safety" });
  item.click();
  return waitFor(() => qa('[role="switch"]', settingsOpen()).find((s) => /Allow processes/.test(s.getAttribute("aria-label") ?? "")), { what: "the Allow processes switch" });
}
async function closeSettings() {
  if (!settingsOpen()) return;
  await press("Escape");
  await waitFor(() => !settingsOpen(), { what: "Settings to close", timeout: 5000 });
}

// ---- access before anything ------------------------------------------------------------------------------------------------------------
step("access");
const acc0 = await invoke("run_access", { repoId: BE });
if (two) check("E2E jail: processes are startable inside the fixture root without any switch", acc0.startable && acc0.jail === "e2e", JSON.stringify(acc0));
else check("READ-ONLY jail: starting a process is refused until the switch is on", !acc0.startable && acc0.jail === "readOnly" && !acc0.allowed, JSON.stringify(acc0));

// ---- Settings > Safety > Allow processes ----------------------------------------------------------------------------------------
step("allow processes");
{
  const sw = await openSafety();
  if (two) {
    check("E2E jail: the Allow processes switch is disabled (not needed here)", sw.disabled || sw.getAttribute("aria-disabled") === "true");
  } else {
    check("the Allow processes switch starts OFF", sw.getAttribute("aria-checked") === "false");
    sw.click();
    await waitFor(() => sw.getAttribute("aria-checked") === "true", { what: "the switch to turn on" });
    const acc1 = await invoke("run_access", { repoId: BE });
    check("turning it on makes processes startable for this session", acc1.startable && acc1.allowed, JSON.stringify(acc1));
  }
  await snap("settings-safety");
  await closeSettings();
}

// ---- Run panel: start the fixture dev server ------------------------------------------------------------------------------------
step("run panel");
await openRunPanel();
await waitFor(() => q(".run"), { what: "the Run panel" });
const rb = await waitFor(runButton, { what: "the Run button of the dev script", timeout: 20000 });
check("the dev script is listed and its Run button is enabled", !rb.disabled);
rb.click();
const port = Number((await waitFor(portChip, { what: "the port chip", timeout: 40000 })).slice(1));
check("the port chip shows the server's loopback port", port > 1024, String(port));
const info1 = await waitFor(async () => { const s = await listed(); return s && s.status === "running" && s.procs >= 1 ? s : null; }, { what: "the server to be running", timeout: 20000 });
check("the server is running with a process tree and a pid", info1.pid > 1 && info1.procs >= 1, JSON.stringify({ pid: info1.pid, procs: info1.procs }));
await waitFor(() => /Project is running at/.test(text(q(".run-log__body") ?? document.body)), { what: "the server's log line", timeout: 15000 });
check("the status bar chip counts one server", !!qa("button.run-status").find((b) => /^1 dev server running/.test(b.getAttribute("aria-label") ?? "")), qa("button.run-status").map((b) => b.getAttribute("aria-label")).join("|"));
await snap("run-panel");

if (two) {
  // ---- the proxy gate in the E2E jail -------------------------------------------------------------------------------------------
  step("proxy gate");
  const ok = await invoke("preview_proxy_start", { url: `http://localhost:${port}/` });
  check("the proxy starts for the port the Run panel's server listens on", ok.port > 1024 && ok.upstreamPort === port && ok.url.startsWith("http://127.0.0.1:"), JSON.stringify(ok));
  const again = await invoke("preview_proxy_start", { url: `http://localhost:${port}/x` });
  check("a second start reuses the same proxy", again.port === ok.port, JSON.stringify(again));
  const refused = await invoke("preview_proxy_start", { url: "http://localhost:9/" }).then(() => null, (e) => e);
  check("E2E jail: a port no Run-panel server listens on is refused (testJail)", refused && refused.code === "testJail", JSON.stringify(refused));
  const remote = await invoke("preview_proxy_start", { url: "http://example.com:8082/" }).then(() => null, (e) => e);
  check("a non-loopback address is refused by the gate", remote && remote.code === "notLoopback", JSON.stringify(remote));
  await invoke("preview_proxy_stop", { upstreamPort: port });
  stopButton().click();
  await waitFor(async () => { const s = await listed(); return s && s.status === "exited"; }, { what: "the server to stop", timeout: 20000 });
  await finish();
}

// ---- Preview tab: load the server through the proxy -----------------------------------------------------------------------------
step("preview");
await runCommand("Preview: open in a tab");
const field = await waitFor(() => q('input[aria-label="Preview address (loopback only)"]'), { what: "the preview address field" });
await typeInto(field, `http://localhost:${port}/`);
field.closest("form").requestSubmit();
const frame = await waitFor(() => { const f = frameEl(); return f && f.src && f.src.startsWith("http://127.0.0.1:") && !f.src.includes(`:${port}/`) ? f : null; }, { what: "the frame on the proxy origin", timeout: 20000 });
check("the frame is marked for click-to-source with the preview's repo id", frame.hasAttribute("data-intely-preview") && frame.dataset.repoId === BE, frame.dataset.repoId);
check("the frame loads the proxy's origin, not the dev server's own port", new URL(frame.src).port !== String(port), frame.src);
const frameOrigin = new URL(frame.src).origin;
const messages = [];
window.addEventListener("message", (e) => { if (e.source === frame.contentWindow) messages.push({ origin: e.origin, data: e.data }); });
await waitFor(() => messages.some((m) => m.data?.e2e === "ready"), { what: "the framed page to load (its glue says ready)", timeout: 30000 });
check("the framed page loaded through the proxy (X-Frame-Options: DENY did not block it)", true);
await waitFor(() => /Server answers/.test(text(q(".pv__status") ?? document.body)), { what: "the status line to say the server answers", timeout: 10000 });
await sleep(800); // React renders
await snap("preview-frame");

// ---- click-to-source: Alt+click inside the frame --------------------------------------------------------------------------------
step("alt+click");
const appText = (await invoke("files_read_file", { repoId: BE, relPath: "src/App.jsx" })).text;
const wantLine = appText.split("\n").findIndex((l) => l.includes('id="inc"')) + 1;
check("the fixture's App.jsx has the element on a known line", wantLine > 1, String(wantLine));
frame.contentWindow.postMessage({ e2e: "altclick", selector: "#inc" }, frameOrigin);
await waitFor(() => messages.some((m) => m.data?.e2e === "altclicked" && m.data.found), { what: "the frame to replay the Alt+click", timeout: 10000 });
const fileTab = await waitFor(() => qa('[role="tab"]').find((t) => /App\.jsx/.test(text(t))), { what: "an editor tab for App.jsx", timeout: 20000 });
check("Alt+click opened src/App.jsx in an editor tab", !!fileTab, text(fileTab));
const lineNow = () => { const m = /Ln (\d+), Col (\d+)/.exec(text(document.body)); return m ? Number(m[1]) : null; };
await waitFor(() => lineNow() === wantLine, { what: `the cursor on line ${wantLine}`, timeout: 10000 }).catch(() => {});
const gotLine = lineNow();
check("the cursor is on the line of the clicked element", gotLine === wantLine, `want ${wantLine}, got ${gotLine}`);
check("the inspector never leaked anything but the inspect message to the IDE", messages.filter((m) => m.data?.intely).every((m) => Object.keys(m.data).sort().join() === "col,componentName,file,intely,line"), JSON.stringify(messages.map((m) => Object.keys(m.data ?? {}))));
await snap("click-to-source");

// ---- Inspect toggle ---------------------------------------------------------------------------------------------------------------
step("inspect toggle");
const previewTab = qa('[role="tab"]').find((t) => /Preview/.test(text(t)));
previewTab?.click();
const inspectBtn = await waitFor(() => qa("button").find((b) => b.getAttribute("aria-label") === "Inspect"), { what: "the Inspect button" });
inspectBtn.click();
await waitFor(() => document.documentElement.hasAttribute("data-intely-inspecting"), { what: "inspect mode on" });
check("the Inspect button turns inspect mode on and shows it pressed", await waitFor(() => inspectBtn.getAttribute("aria-pressed") === "true"));
inspectBtn.click();
await waitFor(() => !document.documentElement.hasAttribute("data-intely-inspecting"), { what: "inspect mode off" });

// ---- stop: no process, no port ----------------------------------------------------------------------------------------------------
step("stop");
await openRunPanel();
const pid1 = info1.pid;
const stop = await waitFor(stopButton, { what: "the Stop button" });
stop.click();
await waitFor(async () => { const s = await listed(); return s && s.status === "exited"; }, { what: "the server to be stopped", timeout: 25000 });
const after = await listed();
check("Stop: the server exited with no process left in its tree", after.procs === 0, JSON.stringify({ status: after.status, procs: after.procs }));
check("Stop reads as stopped, not as a failed exit", after.exitCode == null && /^Stopped$/.test(text(q(".run-log__status"))), `${after.exitCode} ${text(q(".run-log__status"))}`);
const probe = await invoke("preview_probe", { url: `http://localhost:${port}/` });
check("Stop: nothing listens on the port any more", probe.reachable === false, JSON.stringify(probe));
notes.stoppedPid = pid1;
await snap("run-stopped");

// ---- start again and leave it running: run.sh checks that quitting the IDE takes it along -------------------------------------
step("start again");
(await waitFor(runButton, { what: "the Run button again" })).click();
await waitFor(async () => { const s = await listed(); return s && s.status === "running" ? s : null; }, { what: "the second run", timeout: 40000 });
notes.leftRunning = (await listed()).pid;
await finish();

// (x3) MongoDB Studio over an SSH tunnel on the REAL window, with a FAKE ssh (scripts/mongo-fixture/fake-ssh, selected by
// INTELY_SSH_BINARY, which the tunnel code honours only under the E2E jail) in front of a FAKE loopback mongod
// (scripts/e2e/fake-mongod.mjs). No Docker, no sshd, no network beyond 127.0.0.1. What it proves in the app: the wizard's SSH
// starting point, the host-key dialog for an unknown key (fingerprint shown, "Trust and connect"), tunnel auth failure, a bastion that
// forbids forwarding, the password reaching ssh through the askpass FIFO (the fake accepts only the right secret, and run.sh checks
// that the secret never appeared in an argv), the SOCKS relay carrying a real driver handshake to 127.0.0.1:<fake port>
// (the E2E jail allows loopback targets only, so a real database host name over the relay is NOT shown here), a tunnelled profile treated as production, the drop notice with Reconnect when the master
// dies, and a clean teardown (run.sh checks processes and temp directories). NOT proven here (Rust tests cover them): a changed host
// key (the fake keyscan always returns one key), TLS hostname checks over the relay, real sshd behaviour.
// The fake ssh reads its mode from a file; the page cannot write there, so it asks run.sh through .ssh-cmd in a fixture repo.
await waitForTree();
const BE = FX.repoIds[0];
const SSH_PW = "SSH-CANARY-pw-91"; // also written to the fake's expect-secret file by run.sh; run.sh greps argv logs and settings for it
const errTxt = (e) => (e && typeof e === "object" ? `${e.code ?? ""} ${e.message ?? ""}` : String(e));
const dlg = () => q(".settings");
const pick = (row) => (q(".ui-tree-row__main", row) ?? row).click();
async function openSettings(section) {
  if (!dlg()) { await press(",", { meta: true }); await waitFor(dlg, { what: "Settings" }); }
  (await waitFor(() => qa(".settings__item", dlg()).find((b) => text(b) === section), { what: `the ${section} section` })).click();
  await sleep(250);
  return dlg();
}
const pane = () => q(".settings__pane", dlg());
const sw = (label) => q(`[role="switch"][aria-label="${label}"]`, pane());
let ctlN = 0;
/** Asks run.sh to put <mode> into the fake ssh's mode file ("ok", "hostkey-unknown", "die-after-n-seconds 4"...). */
async function sshMode(mode) {
  const line = `mode|${mode}|${ctlN++}`;
  await invoke("files_write_file", { repoId: BE, relPath: ".ssh-cmd", text: `${line}\n`, expectedMtimeMs: 0, reveal: false });
  await waitFor(async () => (await invoke("files_read_file", { repoId: BE, relPath: ".ssh-ack" }).catch(() => null))?.text?.trim() === line, { what: `ssh mode ${mode}`, timeout: 15000, interval: 200 });
}
async function setSelect(el, value) {
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(120);
}
const FINAL = ["ok", "warn", "failed"];
const stepOf = (root, id) => q(`li.mgs-step[data-step="${id}"]`, root)?.getAttribute("data-state");
async function runTest(wiz) {
  // the engine allows one test per second, and a trusted host key re-runs the test by itself: let both settle first
  await waitFor(() => q("section.mgs", wiz)?.getAttribute("data-state") !== "running", { what: "a running test to end", timeout: 60000 });
  await sleep(1300);
  await clickButton("Test connection", wiz);
  await sleep(400);
  await waitFor(() => { const s = q("section.mgs", wiz); return s && FINAL.includes(s.getAttribute("data-state")) && !findButton("Test connection", wiz)?.getAttribute("aria-busy"); }, { what: "the test result", timeout: 60000 }).catch((e) => { notes.stuck = text(q(".mm-wiz__review", wiz)).slice(0, 1200) + " || btn=" + (findButton("Test connection", wiz)?.outerHTML ?? "none").slice(0, 300); throw e; });
  await sleep(200);
  return q("section.mgs", wiz);
}

// ---- 1. switch on, wizard: through an SSH server ------------------------------------------------------------------------------------------
step("enable");
await openSettings("Database");
await waitFor(() => sw("Enable MongoDB Studio"), { what: "the Enable switch" });
sw("Enable MongoDB Studio").click();
await waitFor(() => sw("Enable MongoDB Studio").getAttribute("aria-checked") === "true", { what: "the switch to turn on" });
const first = await waitFor(() => q("section.mm-first", pane()), { what: "the first-run screen", timeout: 20000 });
await clickButton("Through an SSH server", first);
const wiz = await waitDialog(/New connection/, "the wizard");
await typeInto(q("#mgf-name", wiz), "Via bastion");
await typeInto(q("#mgf-tunnel-host", wiz), "localhost");
await typeInto(q("#mgf-tunnel-user", wiz), "tester");
await setSelect(q("#mgf-tunnel-auth", wiz), "password");
await typeInto(await waitFor(() => q("#mgf-tunnel-secret", wiz), { what: "the SSH password field" }), SSH_PW);
await typeInto(q("#mgf-hosts-0-host", wiz), "127.0.0.1"); // the E2E jail allows loopback targets only
await typeInto(q("#mgf-hosts-0-port", wiz), String(MONGO.port));
await setSelect(q("#mgf-auth-mechanism", wiz), "none");
check("the SSH starting point opens on the tunnel section and a tunnel forces the Production tag", qa('[role="radio"]', wiz).some((r) => text(r) === "Production" && r.getAttribute("aria-checked") === "true"), text(wiz).slice(0, 200));
await snap("mongo-x3-wizard-2");
await clickButton("Next", wiz);
await waitFor(() => q(".mm-wiz__review", wiz), { what: "wizard step 3" });

// ---- 2. unknown host key -> dialog -> trust -------------------------------------------------------------------------------------------------
step("host key");
let s = await runTest(wiz);
check("unknown host key: the Tunnel step fails and the diagnosis offers to review the key", s.getAttribute("data-state") === "failed" && stepOf(wiz, "tunnel") === "failed" && !!findButton("Review the host key", wiz), `${s.getAttribute("data-state")} tunnel=${stepOf(wiz, "tunnel")} ${text(q(".mgd", wiz) ?? s).slice(0, 300)}`);
await snap("mongo-x3-hostkey-diagnosis");
findButton("Review the host key", wiz).click();
const hk = await waitDialog(/Trust this SSH server/, "the host-key dialog", 20000);
check("the dialog shows a SHA256 fingerprint and the comparison sentence, and has a Trust button", /SHA256:/.test(text(hk)) && /Compare this with the fingerprint/.test(text(hk)) && !!findButton("Trust and connect", hk), text(hk).slice(0, 300));
await snap("mongo-x3-hostkey-dialog");
await clickButton("Trust and connect", hk);
await dialogGone(hk, 20000);
await sleep(500);

// ---- 3. failure modes of the tunnel ------------------------------------------------------------------------------------------------------------
step("auth denied");
await sshMode("auth-denied");
s = await runTest(wiz);
check("auth denied: the Tunnel step fails with a sign-in explanation", stepOf(wiz, "tunnel") === "failed" && /sign|password|permission|key/i.test(text(q(".mgd", wiz) ?? "")), `tunnel=${stepOf(wiz, "tunnel")} ${text(q(".mgd", wiz) ?? s).slice(0, 300)}`);
await snap("mongo-x3-auth-denied");
step("forwarding disabled");
await sshMode("forwarding-disabled");
s = await runTest(wiz);
check("a bastion that forbids forwarding: the test fails and says so", s.getAttribute("data-state") === "failed" && /forward/i.test(text(q(".mgd", wiz) ?? "")), `${stepOf(wiz, "tunnel")} ${stepOf(wiz, "connect")} ${text(q(".mgd", wiz) ?? s).slice(0, 300)}`);

// ---- 4. password through the askpass FIFO, relay carries the driver -------------------------------------------------------------------------------
step("password test");
await sshMode("ask-password");
s = await runTest(wiz);
check("password sign-in through the FIFO: the whole test passes (tunnel, handshake over the relay, version)", ["ok", "warn"].includes(s.getAttribute("data-state")) && stepOf(wiz, "tunnel") === "ok" && new RegExp(MONGO.version.replace(/\./g, "\\.")).test(text(q(".mgs-ok", wiz) ?? "")), `${s.getAttribute("data-state")} tunnel=${stepOf(wiz, "tunnel")} ${text(q(".mgd", wiz) ?? s).slice(0, 300)}`);
await snap("mongo-x3-test-ok");
await clickButton("Save", wiz);
await waitFor(() => q(".mm-done", wiz), { what: "the saved step", timeout: 15000 });
const prof = (await invoke("mongo_profiles")).find((p) => p.name === "Via bastion");
check("the saved profile is Production-level because of the tunnel, read-only, and the view carries no password", !!prof && prof.effectiveLevel !== "local" && prof.readOnly === true && !JSON.stringify(prof).includes(SSH_PW), JSON.stringify(prof)?.slice(0, 300));
await clickButton("Close", wiz);
await dialogGone(wiz);

// ---- 5. connect from the connection card (production confirm, password prompt: the rail tree has no prompt, see the report) ---------------
const card = () => qa("article.mg-card", pane()).find((a) => a.getAttribute("aria-label") === "Via bastion");
const otherDialogs = () => dialogsOpen().filter((d) => !(d.matches(".settings") || d.querySelector(".settings")));
async function connectFlow(label) {
  const deadline = performance.now() + 60000;
  let lastClick = 0;
  while (performance.now() < deadline) {
    if (!otherDialogs().length && performance.now() - lastClick > 5000 && card() && findButton("Connect", card())) { findButton("Connect", card()).click(); lastClick = performance.now(); }
    const open = (await invoke("mongo_status")).connections.find((c) => c.id === prof.id);
    if (open) return open;
    const prod = dialogWith(/Connect to production/);
    const pw = dialogWith(/Password for/);
    const ends = dialogWith(/for the first time/);
    if (ends && findButton("Connect", ends)) { (notes.endpointsDialog ??= text(ends).slice(0, 400)); findButton("Connect", ends).click(); await sleep(300); }
    else if (prod && findButton("Connect", prod)) { findButton("Connect", prod).click(); await sleep(300); }
    else if (pw && q("#mm-pw-sshSecret", pw)) { await typeInto(q("#mm-pw-sshSecret", pw), SSH_PW); findButton("Connect", pw)?.click(); await sleep(300); }
    await sleep(150);
  }
  throw new Error(`${label}: the connection did not open (dialogs: ${dialogsOpen().map((d) => text(d).slice(0, 80)).join(" | ")}; toasts: ${qa(".ui-toast").map(text).join(" | ")}; status: ${JSON.stringify(await invoke("mongo_status")).slice(0, 300)})`);
}
step("connect");
await sshMode("ask-password");
const needed = await invoke("mongo_connect", { id: prof.id }).then(() => null, (e) => errTxt(e));
check("a connect without the SSH secret is refused up front, naming the missing secret (nothing is spawned)", /mongoNeedSecret/.test(needed ?? "") && /sshSecret/.test(needed ?? ""), needed);
await waitFor(card, { what: "the connection card", timeout: 15000 });
const conn = await connectFlow("first connect");
check("connected over the tunnel: the connection reports the tunnel as up", conn.tunnel === "up" || conn.tunnel?.state === "up", JSON.stringify(conn).slice(0, 300));
await snap("mongo-x3-connected");
await press("Escape");
await waitFor(() => !dlg(), { what: "Settings to close", timeout: 5000 }).catch(() => undefined);
await openRail("Database");
const tree = await waitFor(() => q('[role="tree"][aria-label="Databases and collections"]'), { what: "the databases tree" });
await waitTreeItem("Via bastion", tree);
pick(treeItem("Via bastion", tree));
await waitTreeItem("fakeshop", tree, 60000);
check("the tree lists the database found through the relay", !!treeItem("fakeshop", tree));
await snap("mongo-x3-tree");

// ---- 6. the master dies: notice and Reconnect, nothing reconnects by itself ----------------------------------------------------------------------
step("drop");
await invoke("mongo_disconnect", { id: prof.id });
await waitFor(async () => !(await invoke("mongo_status")).connections.some((c) => c.id === prof.id), { what: "the disconnect", timeout: 20000 });
await sshMode("die-after-n-seconds 4");
await openSettings("Database");
await waitFor(card, { what: "the connection card", timeout: 15000 });
await connectFlow("second connect");
await waitFor(async () => !(await invoke("mongo_status")).connections.some((c) => c.id === prof.id), { what: "the connection to close after the ssh master died", timeout: 40000 });
const lost = await waitFor(() => qa("*").find((e) => e.children.length < 6 && /SSH tunnel for Via bastion ended/.test(text(e))), { what: "the tunnel-ended notice", timeout: 15000 }).catch(() => null);
check("the dead master closes the connection and the UI says the SSH tunnel ended (no silent reconnect)", !!lost, text(pane() ?? document.body).slice(0, 300));
await sleep(3000);
check("nothing reconnected by itself", !(await invoke("mongo_status")).connections.some((c) => c.id === prof.id));
await snap("mongo-x3-dropped");

// ---- 7. switch off: nothing left -----------------------------------------------------------------------------------------------------------------
step("switch off");
await openSettings("Database");
await waitFor(() => sw("Enable MongoDB Studio"), { what: "the switch again" });
sw("Enable MongoDB Studio").click();
await waitFor(() => sw("Enable MongoDB Studio").getAttribute("aria-checked") === "false", { what: "the switch to turn off" });
const st = await invoke("mongo_status");
check("off: no connection is left", st.enabled === false && st.connections.length === 0);
await press("Escape");
await finish();

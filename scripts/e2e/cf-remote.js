// (cf) Settings > Remote > "My Cloudflare" end to end on the real window, against a FAKE wrangler (scripts/e2e/fake-wrangler.mjs, reached through
// the INTELY_WRANGLER_BIN seam of the E2E jail) and a loopback relay whose static assets are a fixture directory the fake `deploy` fills. The
// other half is remote-web/test/e2e/cf.e2e.test.ts (relay, phone, fixture files); the two talk through .cf-cmd / .cf-ack in a fixture repo.
// Nothing here reaches Cloudflare: the E2E jail allows only that fake binary and loopback sockets.
await waitForTree();
setTimeout(() => { if (!window.__e2eFinished) void failWith(new Error("watchdog: stuck at " + notes.step)); }, 330000);
const ws = await invoke("workspace_get");
const BE = FX.repoIds[0];
const WORKER = "intely-relay-3f9a1c5b7d2e";
const TOKEN_MARKER = "E2eFakeTokenMarker0123456789abcdefghijklmnop";

// CONTRACT PROBE (reported, not hidden): the Rust CloudView / DeployPreview / RunStarted / relay-cloud:state of
// src-tauri/src/modules/relay_cloud.rs and the TypeScript types of ui/src/modules/remote/cloud/types.ts disagree (secretStore.durable vs
// secretStoreDurable, no workersSubdomain / updateAvailable / interrupted / kit.dirtyFiles, kitDirty vs kitDirtyFiles, RunStarted without
// status, state events with step/stepStatus/code instead of steps[]/error). With the real commands the wizard cannot leave its first step, so
// while the gaps exist this scenario drives the SAME Rust commands over IPC (the wizard's own call sequence) and fails the CONTRACT check.
const contractGaps = [];
function probeContract(v, preview) {
  const gap = (k, ok) => { if (!ok && !contractGaps.includes(k)) contractGaps.push(k); };
  if (v) {
    gap("status.secretStoreDurable", "secretStoreDurable" in v);
    gap("status.workersSubdomain", "workersSubdomain" in v);
    gap("status.updateAvailable", "updateAvailable" in v);
    gap("status.interrupted", "interrupted" in v);
    gap("status.kit.dirtyFiles", v.kit && "dirtyFiles" in v.kit);
  }
  if (preview) gap("preview.kitDirtyFiles", "kitDirtyFiles" in preview);
}
// every relay-cloud:state event of the app, kept for the IPC path (the listener is the one the UI uses: plugin:event|listen)
const runEvents = [];
{
  const I = window.__TAURI_INTERNALS__;
  const handler = I.transformCallback((e) => runEvents.push({ at: Date.now(), ...e.payload }));
  await I.invoke("plugin:event|listen", { event: "relay-cloud:state", target: { kind: "Any" }, handler });
}
/** Resolves with the terminal state event of the next `op` run that ends after `since`. */
const terminal = (op, since) => waitFor(() => runEvents.find((e) => e.op === op && e.status !== "running" && e.at >= since), { what: `the ${op} run to end`, timeout: 120000, interval: 150 });

let cfN = 0;
/** One request to the fixture/phone driver; resolves with its acknowledgement object. */
async function cf(name, arg = {}, timeout = 90000) {
  const line = `${name}|${JSON.stringify({ ...arg, n: cfN++ })}`;
  await invoke("files_write_file", { repoId: BE, relPath: ".cf-cmd", text: `${line}\n`, expectedMtimeMs: 0, reveal: false });
  let got = null;
  await waitFor(async () => {
    const r = await invoke("files_read_file", { repoId: BE, relPath: ".cf-ack" }).catch(() => null);
    try { const j = JSON.parse(r?.text ?? ""); if (j.line === line) { got = j; return true; } } catch { /* partial write */ }
    return false;
  }, { what: `the driver to answer ${name}`, timeout, interval: 150 });
  if (got.error) throw new Error(`driver ${name}: ${got.error}`);
  return got;
}
async function shot(name) {
  try { (notes.shots ??= []).push(await window.__e2e.screenshot(name)); } catch (e) { (notes.shotErrors ??= []).push(String(e?.message ?? e)); }
}
const dlg = () => q(".settings");
const pane = () => q(".settings__pane", dlg());
const sw = () => q('[role="switch"][aria-label="Enable Remote"]', pane());
async function openRemote() {
  if (!dlg()) { await press(",", { meta: true }); await waitFor(dlg, { what: "Settings" }); }
  (await waitFor(() => qa(".settings__item", dlg()).find((b) => text(b) === "Remote"), { what: "the Remote section in Settings" })).click();
  await waitFor(() => sw(), { what: "the Enable Remote switch", timeout: 15000 });
}
const isOn = () => sw()?.getAttribute("aria-checked") === "true";
const closeSettings = async () => { if (dlg()) { await press("Escape"); await waitFor(() => !dlg(), { what: "Settings to close", timeout: 5000 }); } };
const tid = (id) => q(`[data-testid="${id}"]`);
const wiz = () => q(".cloud-wizard");
const enabled = (el) => el && !el.disabled && el.getAttribute("aria-disabled") !== "true";
const clickTid = async (id, what = id) => { const el = await waitFor(() => { const e = tid(id); return enabled(e) ? e : null; }, { what: `enabled ${what}`, timeout: 30000 }); el.click(); await sleep(80); };
const sha256hex = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const status = () => invoke("remote_status");
const realDeploys = (calls) => calls.filter((c) => c.argv[0] === "deploy" && !c.argv.includes("--dry-run"));

// ---- cf2: READONLY + INTELY_CLOUD=1 (PHASE 2) --------------------------------------------------------------------------------
// The jail is READONLY (the mode `pnpm dev:app` starts in) and the cloud flag lifts it for the relay tools ONLY. The repos stay jailed: no
// fixture-file protocol is possible here, so run.sh (verify_cf2) reads the fake's call log: the relay tools ran the kit's wrangler (the fixture
// copy under kit/remote-relay/node_modules/.bin), nothing else.
if (PHASE === 2) {
  step("cf2. READONLY + INTELY_CLOUD");
  const v = await invoke("relay_cloud_status");
  check("cf2 the relay tools see the lifted jail (off) with the cloud flag set, and the kit is the fixture kit", v.jail === "off" && v.cloudFlag === true && v.kit.found === true && v.kit.wranglerOk === true, JSON.stringify({ jail: v.jail, flag: v.cloudFlag, kit: v.kit }));
  const w0 = await invoke("relay_cloud_whoami");
  check("cf2 whoami runs (a logged-out answer, not a refusal)", w0.loggedIn === false, JSON.stringify(w0));
  const t0 = Date.now();
  await invoke("relay_cloud_login", { device: false });
  const l = await terminal("login", t0);
  check("cf2 sign-in runs under READONLY + INTELY_CLOUD", l.status === "ok", JSON.stringify(l));
  const w1 = await invoke("relay_cloud_whoami");
  check("cf2 whoami after the sign-in lists the accounts", w1.loggedIn === true && w1.accounts?.length === 2, JSON.stringify(w1));
  const wrote = await invoke("files_write_file", { repoId: FX.repoIds[0], relPath: "cf2-must-not-exist.txt", text: "x", expectedMtimeMs: 0, reveal: false }).then(() => "written", (e) => e.code ?? String(e));
  check("cf2 a write into a repo is still refused: only the relay commands are lifted", wrote !== "written", wrote);
  const mode = await invoke("relay_cloud_token_set", { token: "short" }).then(() => "accepted", (e) => e.code);
  check("cf2 an invalid token is refused by the relay command itself (it ran, the jail did not refuse it)", mode === "authInvalid", mode);
  await shot("cf2-readonly-cloud");
  await finish();
  await new Promise(() => {});
}

// ---- 1. page open: nothing spawned ------------------------------------------------------------------------------------------
step("1. the page opens without a single wrangler call");
const hello = await cf("hello");
const view0 = await invoke("relay_cloud_status");
check("1 the status is read without a spawn; the test jail is on", view0.jail === "e2e" && view0.kit.found === true, JSON.stringify({ jail: view0.jail, kit: view0.kit }));
probeContract(view0);
check("1 CONTRACT: relay_cloud_status and relay_cloud_preview carry every field the UI types declare", contractGaps.length === 0, "missing: " + contractGaps.join(", "));
check("1 the fixture kit is complete: wrangler at the pinned version, node, pnpm, a built phone app, a durable (test) secret store", view0.kit.wranglerOk && view0.kit.nodeOk && view0.kit.pnpmOk && view0.kit.distBuilt && (view0.secretStoreDurable ?? view0.secretStore?.durable) === true, JSON.stringify({ kit: view0.kit, durable: view0.secretStoreDurable ?? view0.secretStore?.durable }));
await openRemote();
check("1 Remote is off at the start", !isOn());
const modeCf = await waitFor(() => qa('[role="radio"]', pane()).find((b) => text(b) === "My Cloudflare"), { what: "the My Cloudflare mode" });
modeCf.click();
await waitFor(() => tid("setup"), { what: "the set-up button", timeout: 15000 });
await shot("cf-empty");
const s0 = await status();
const pid0 = (await cf("sample", { label: "start" })).pid;
check("1 the mode starts as local and nothing outward ran when the page opened", s0.relayMode === "local" && (await cf("calls")).calls.length === 0, `${s0.relayMode}`);

// ---- 2. Remote on against the OLD relay URL ---------------------------------------------------------------------------------
step("2. Remote on against the old relay");
sw().click();
await waitFor(isOn, { what: "Remote switched on", timeout: 20000 });
const old = await status();
const onOld = await cf("sample", { label: "on-old" });
check("2 the app holds no socket to the new relay yet (the old URL points elsewhere)", onOld.relaySockets === 0 && old.relay !== `ws://127.0.0.1:${hello.base.split(":").pop()}`, `${old.relay} sockets=${onOld.relaySockets}`);

const UIOK = contractGaps.length === 0;
const ACC = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
var clickedAt, clicked2, sampleBefore;
if (UIOK) {
// ---- 3. wizard: sign in -----------------------------------------------------------------------------------------------------
step("3. wizard: sign in");
tid("setup").click();
await waitFor(wiz, { what: "the wizard", timeout: 15000 });
await waitFor(() => tid("login"), { what: "the sign-in step", timeout: 15000 });
check("3 opening the wizard spawned nothing", (await cf("calls")).calls.length === 0);
await shot("cf-signin");
await clickTid("login", "the Cloudflare sign-in button");
const loginUrl = await waitFor(() => text(tid("login-url")), { what: "the sign-in URL", timeout: 20000 });
check("3 the sign-in URL is the Cloudflare dashboard host, shown as text", /^https:\/\/dash\.cloudflare\.com\//.test(loginUrl), loginUrl.slice(0, 80));
await waitFor(() => tid("signed-in"), { what: "the signed-in line (login, then whoami)", timeout: 40000 });
const radios = await waitFor(() => { const r = qa('.cloud-radios input[type="radio"]', wiz()).filter((i) => /E2E/.test(text(i.closest("label")))); return r.length === 2 ? r : null; }, { what: "the two accounts", timeout: 15000 });
await shot("cf-accounts");
check("3 two accounts are offered and none is chosen for the user", radios.length === 2 && radios.every((r) => !r.checked));
const nextBtn = () => tid("wiz-next");
check("3 Next is blocked until an account is chosen", nextBtn().getAttribute("aria-disabled") === "true");
radios.find((r) => /Personal/.test(text(r.closest("label")))).click();
await waitFor(() => enabled(nextBtn()), { what: "Next after choosing an account", timeout: 15000 });
nextBtn().click();

// ---- 4. wizard: name --------------------------------------------------------------------------------------------------------
step("4. wizard: name");
const nameIn = await waitFor(() => tid("worker-name"), { what: "the Worker name field" });
await typeInto(nameIn, WORKER);
await sleep(150);
check("4 the Worker name is accepted as valid", enabled(nextBtn()), q("#cloud-name-msg")?.textContent);
nextBtn().click();

// ---- 5. review, then the tamper case (the relay serves a changed phone-app file) ---------------------------------------------
step("5. review");
await cf("scenario", { set: { tamper: { file: "sw.js" } } });
await waitFor(() => tid("review-cmd"), { what: "the review", timeout: 60000 });
const reviewCmd = text(tid("review-cmd"));
check("5 the review shows the exact deploy command with the stamp and no secret", /deploy --config .*wrangler\.jsonc --name intely-relay-3f9a1c5b7d2e --message intely-relay:[0-9a-f]{16}/.test(reviewCmd) && !reviewCmd.includes(TOKEN_MARKER), reviewCmd.slice(0, 300));
check("5 the name check is shown (free)", /name is free|available|not used|does not exist/i.test(text(tid("name-check")) || text(wiz())), text(tid("name-check")));
await shot("cf-review");
const mid = (await cf("calls")).calls;
check("5 until now only read-only calls ran: the dry run and the name check, no real deploy and no secret", realDeploys(mid).length === 0 && !mid.some((c) => c.argv[0] === "secret"), JSON.stringify(mid.map((c) => c.argv.slice(0, 2).join(" "))));
check("5 every account-bound call carries the chosen account in its environment", mid.filter((c) => ["deploy", "deployments"].includes(c.argv[0])).every((c) => /^a1b2c3d4/.test(c.accountEnv ?? "")), JSON.stringify(mid.map((c) => c.accountEnv)));

step("5b. the typed confirmation");
const ackBox = () => q('input[type="checkbox"]', q(".cloud-confirm"));
ackBox().click();
await typeInto(tid("confirm-name"), "intely-relay-wrong");
await sleep(150);
check("5 a wrong typed name leaves Deploy disabled with its reason", tid("deploy").getAttribute("aria-disabled") === "true" && /Type exactly/.test(text(tid("deploy-reason"))), text(tid("deploy-reason")));
tid("deploy").click();
await sleep(1200);
check("5 clicking the blocked Deploy does nothing (no real deploy call)", realDeploys((await cf("calls")).calls).length === 0);
await typeInto(tid("confirm-name"), WORKER);
await waitFor(() => enabled(tid("deploy")), { what: "Deploy enabled after the exact name", timeout: 10000 });
clickedAt = Date.now();
tid("deploy").click();
await waitFor(() => tid("cloud-error"), { what: "the tamper failure", timeout: 120000 });
const tamperMsg = text(tid("cloud-error"));
await shot("cf-tamper");
check("5 the tampered phone app is rejected at Verify (the relay serves another sw.js than the staged one)", /not the one that was deployed|bundle|does not verify/i.test(tamperMsg), tamperMsg);
const afterTamper = (await cf("calls")).calls;
const dep1 = realDeploys(afterTamper);
check("5 the deploy ran once, after the typed confirmation", dep1.length === 1 && dep1[0].ts >= clickedAt - 50, JSON.stringify(dep1.map((c) => c.ts - clickedAt)));
const viewTamper = await invoke("relay_cloud_status");
check("5 nothing was applied after the failed verification (the relay URL is unchanged)", (await status()).relay === old.relay && viewTamper.mode === "local", `${(await status()).relay} ${viewTamper.mode}`);

// ---- 6. the clean deploy ----------------------------------------------------------------------------------------------------
step("6. clean deploy");
await cf("scenario", { set: {} });
(await waitFor(() => qa("button", wiz()).find((b) => text(b) === "Back to the review"), { what: "Back to the review" })).click();
await waitFor(() => tid("review-cmd") && tid("confirm-name"), { what: "a fresh review", timeout: 60000 });
check("6 the new review starts with an empty confirmation (a preview is single use)", tid("confirm-name").value === "" && !ackBox().checked);
ackBox().click();
await typeInto(tid("confirm-name"), WORKER);
await waitFor(() => enabled(tid("deploy")), { what: "Deploy enabled", timeout: 10000 });
clicked2 = Date.now();
tid("deploy").click();
await waitFor(() => tid("deploy-continue") || tid("cloud-error"), { what: "the end of the clean deploy", timeout: 60000 });
check("6 the clean deploy ends ok (no error shown)", !tid("cloud-error"), tid("cloud-error") ? text(tid("cloud-error")) + " | " + text(q(".cloud-tail")) : "");
await clickTid("deploy-continue", "Continue after the deploy");
step("6b. verify and use the relay now");
await waitFor(() => tid("verify-result"), { what: "the verification", timeout: 30000 });
check("6 the verification says the signed bundle matches", /match|verified|ok/i.test(text(tid("verify-result"))), text(tid("verify-result")).slice(0, 300));
await shot("cf-verify");
sampleBefore = await cf("sample", { label: "before-apply" });
await clickTid("use-relay", "Use this relay now");
await waitFor(() => /Your relay is in use/.test(text(wiz())), { what: "the done step", timeout: 40000 });
await shot("cf-done");

} else {

  step("3. (IPC) sign in");
  let t0 = Date.now();
  const lr = await invoke("relay_cloud_login", { device: false });
  const lend = await terminal("login", t0);
  const lchunk = await invoke("relay_cloud_logs", { runId: lr.runId, fromSeq: 0 }).catch(() => ({ lines: [] }));
  const ltext = (lchunk.lines ?? []).join("\n");
  check("3 sign-in ran through the fake wrangler and ended ok", lend.status === "ok", JSON.stringify(lend));
  check("3 the sign-in output shows the Cloudflare dashboard URL with its OAuth values masked", /dash\.cloudflare\.com/.test(ltext) && !ltext.includes("e2e-state-value"), ltext.slice(0, 300));
  check("3 opening the wizard and signing in spawned only login (zero calls at page open)", (await cf("calls")).calls.map((c) => c.argv[0]).join() === "login");
  const who = await invoke("relay_cloud_whoami");
  check("3 two accounts are offered and none is chosen for the user", who.loggedIn === true && who.accounts?.length === 2 && !who.chosenAccountId, JSON.stringify(who));
  await invoke("relay_cloud_choose_account", { accountId: ACC });

  step("4. (IPC) review");
  await cf("scenario", { set: { tamper: { file: "sw.js" } } });
  let pv = await invoke("relay_cloud_preview", { workerName: WORKER, push: true, customDomain: null });
  probeContract(null, pv);
  // the plan: Rust holds the exact command, directory, Worker name and a one-time nonce (docs/safety.md, "Plan nonce")
  const noPlan = await invoke("relay_cloud_deploy", { previewId: pv.previewId, confirmName: WORKER, overwritePhrase: null }).then(() => "accepted", (e) => e.code);
  const bogusPlan = await invoke("relay_cloud_deploy", { previewId: pv.previewId, confirmName: WORKER, overwritePhrase: null, planId: "0".repeat(32) }).then(() => "accepted", (e) => e.code);
  check("5 a deploy without a plan, or with a made-up nonce, is refused (previewStale) and spawns nothing", noPlan === "previewStale" && bogusPlan === "previewStale" && realDeploys((await cf("calls")).calls).length === 0, `${noPlan} ${bogusPlan}`);
  const plan = await invoke("relay_cloud_plan", { op: "deploy", previewId: pv.previewId });
  check("5 the plan holds the exact argv, the directory, the Worker name and a nonce with an expiry", plan.argv.join(" ") === pv.argv.join(" ") && plan.workerName === WORKER && /\/relay-deploy\//.test(plan.cwd) && /^[0-9a-f]{32}$/.test(plan.planId) && plan.expiresAt > Math.floor(Date.now() / 1000), JSON.stringify(plan).slice(0, 300));
  const reviewCmd = plan.commandLine ?? plan.argv.join(" ");
  check("5 the review shows the exact deploy command with the stamp and no secret", /deploy --config .*wrangler\.jsonc --name intely-relay-3f9a1c5b7d2e --message intely-relay:[0-9a-f]{16}/.test(reviewCmd) && !reviewCmd.includes(TOKEN_MARKER), reviewCmd.slice(0, 300));
  check("5 the name check is free and needs no overwrite phrase", pv.nameCheck === "free" && !pv.needsOverwritePhrase, `${pv.nameCheck} ${pv.needsOverwritePhrase}`);
  check("5 the dry run proved the bundled modules lie inside the snapshot", pv.moduleCheck === "verified", pv.moduleCheck);
  const mid = (await cf("calls")).calls;
  check("5 until now only read-only calls ran: the dry run and the name check, no real deploy and no secret", realDeploys(mid).length === 0 && !mid.some((c) => c.argv[0] === "secret"), JSON.stringify(mid.map((c) => c.argv.slice(0, 2).join(" "))));
  check("5 every account-bound call carries the chosen account in its environment", mid.filter((c) => ["deploy", "deployments"].includes(c.argv[0])).every((c) => c.accountEnv === ACC), JSON.stringify(mid.map((c) => c.accountEnv)));

  step("5. (IPC) the typed confirmation, then the tamper case");
  const wrong = await invoke("relay_cloud_deploy", { previewId: pv.previewId, confirmName: "intely-relay-wrong", overwritePhrase: null, planId: plan.planId }).then(() => "accepted", (e) => e.code);
  await sleep(600);
  check("5 a wrong typed name is refused (confirmMismatch) and nothing is deployed", wrong === "confirmMismatch" && realDeploys((await cf("calls")).calls).length === 0, wrong);
  clickedAt = Date.now();
  t0 = clickedAt;
  await invoke("relay_cloud_deploy", { previewId: pv.previewId, confirmName: WORKER, overwritePhrase: null, planId: plan.planId });
  const bad = await terminal("deploy", t0);
  check("5 the tampered phone app is rejected at Verify (the relay serves another sw.js than the staged one)", bad.status === "failed" && bad.code === "bundleMismatch", JSON.stringify(bad));
  const afterTamper = (await cf("calls")).calls;
  const dep1 = realDeploys(afterTamper);
  check("5 the deploy ran once, after the typed confirmation", dep1.length === 1 && dep1[0].ts >= clickedAt - 50, JSON.stringify(dep1.map((c) => c.ts - clickedAt)));
  check("5 nothing was applied after the failed verification (the relay URL is unchanged)", (await status()).relay === old.relay && (await invoke("relay_cloud_status")).mode === "local", (await status()).relay);
  const reuse = await invoke("relay_cloud_deploy", { previewId: pv.previewId, confirmName: WORKER, overwritePhrase: null, planId: plan.planId }).then(() => "accepted", (e) => e.code);
  check("5 a preview and its plan are single use: the second deploy with the same ids is refused", reuse === "previewStale", reuse);

  step("6. (IPC) clean deploy");
  await cf("scenario", { set: {} });
  pv = await invoke("relay_cloud_preview", { workerName: WORKER, push: true, customDomain: null });
  const plan2 = await invoke("relay_cloud_plan", { op: "deploy", previewId: pv.previewId });
  clicked2 = Date.now();
  t0 = clicked2;
  await invoke("relay_cloud_deploy", { previewId: pv.previewId, confirmName: WORKER, overwritePhrase: null, planId: plan2.planId });
  const good = await terminal("deploy", t0);
  check("6 the clean deploy ends ok (Stage, Config, Deploy, Parse, Secrets, Health, Verify, Record)", good.status === "ok", JSON.stringify(good));
  sampleBefore = await cf("sample", { label: "before-apply" });
  const cv1 = await invoke("relay_cloud_status");
  check("6 the verification says the signed bundle matches the staged one", cv1.lastCheck?.verdict === "ok" && cv1.mode === "local", JSON.stringify(cv1.lastCheck)?.slice(0, 300));
  await invoke("relay_cloud_apply", { mode: "cloudflare", confirmUnpair: false });
}

const calls = (await cf("calls"));
const deploys = realDeploys(calls.calls);
check("6 the second deploy ran after the second confirmation", deploys.length === 2 && deploys[1].ts >= clicked2 - 50, JSON.stringify(deploys.map((c) => c.ts)));
const allSecretCalls = calls.calls.filter((c) => c.argv[0] === "secret");
const secretCalls = allSecretCalls.filter((c) => c.ts > deploys[1].ts); // the tampered first deploy put them too (secrets come before Verify)
check("6 three secrets were put, after the deploy", secretCalls.length === 3 && secretCalls.every((c) => c.ts > deploys[1].ts) && ["VAPID_PRIVATE_KEY", "VAPID_PUBLIC_KEY", "VAPID_SUBJECT"].every((k) => secretCalls.some((c) => c.argv[2] === k)), JSON.stringify(secretCalls.map((c) => c.argv.slice(0, 3))));
check("6 no secret value is in any argv", !JSON.stringify(calls.calls.map((c) => c.argv)).includes(calls.secrets.VAPID_PRIVATE_KEY ?? "no-hash") && allSecretCalls.every((c) => c.argv.length === 7));

// ---- 7. live apply ----------------------------------------------------------------------------------------------------------
step("7. live apply");
const staged = await cf("staged", { worker: WORKER });
const port = hello.base.split(":").pop();
await waitFor(async () => (await status()).state === "online", { what: "the gateway online on the new relay", timeout: 40000, interval: 400 });
const st = await status();
const after = await cf("sample", { label: "after-apply" });
check("7 the relay URL changed live to the deployed relay (same app process, no restart)", st.relay === `ws://127.0.0.1:${port}` && st.relayMode === "cloudflare" && after.pid === pid0 && sampleBefore.relaySockets === 0 && after.relaySockets >= 1, `${st.relay} mode=${st.relayMode} pid ${pid0}->${after.pid} sockets ${sampleBefore.relaySockets}->${after.relaySockets}`);
check("7 the expected bundle hash equals the manifest hash of the staged, signed bundle", !!staged.group && st.expectedBundleHash === staged.group, `${st.expectedBundleHash} vs ${staged.group}`);
check("7 the relay serves exactly the staged bundle (fake deploy filled the fixture directory)", staged.served?.manifestSha256 === staged.staged?.manifestSha256 && staged.staged?.v === 2 && staged.staged.manifestSha256 !== hello.serveFull, `${staged.served?.manifestSha256?.slice(0, 12)} ${staged.staged?.manifestSha256?.slice(0, 12)}`);
const cv = await invoke("relay_cloud_status");
check("7 the profile records the worker, the account tail and the signed bundle", cv.profile?.workerName === WORKER && cv.profile?.accountIdTail === "8f90" && cv.bundle?.hashFull === staged.staged?.manifestSha256 && cv.mode === "cloudflare", JSON.stringify({ p: cv.profile, m: cv.mode }));

// ---- 8. push secrets --------------------------------------------------------------------------------------------------------
step("8. secrets match the generated VAPID keys");
const sec = (await cf("calls")).secrets;
const subject = `https://127.0.0.1:${port}/`;
check("8 VAPID_PUBLIC_KEY sent over stdin equals the public key staged in push-config.json", !!staged.vapidPublic && sec.VAPID_PUBLIC_KEY === (await sha256hex(staged.vapidPublic)), `${sec.VAPID_PUBLIC_KEY?.slice(0, 10)}`);
check("8 VAPID_SUBJECT is the relay host, not an e-mail address", sec.VAPID_SUBJECT === (await sha256hex(subject)), `${sec.VAPID_SUBJECT?.slice(0, 10)}`);
check("8 a distinct private key was put (never equal to the public one)", !!sec.VAPID_PRIVATE_KEY && sec.VAPID_PRIVATE_KEY !== sec.VAPID_PUBLIC_KEY);

// ---- 9. pairing through the QR against the deployed relay -------------------------------------------------------------------
step("9. pair through the QR against the deployed relay");
if (UIOK) await clickTid("wiz-close", "Close the wizard");
await closeSettings();
await openRemote();
await sleep(300);
(await waitFor(() => { const b = tid("pair"); return enabled(b) ? b : null; }, { what: "the Pair a phone button", timeout: 15000 })).click();
const link = await waitFor(() => q(".remote-pair__qr[data-link]")?.getAttribute("data-link"), { what: "the pairing offer", timeout: 20000 });
check("9 the pairing link points at the deployed relay", link.includes(`127.0.0.1:${port}`) || link.includes(`127.0.0.1%3A${port}`), link.replace(/#.*/, "#<hidden>"));
await shot("cf-pair-dialog");
const hashShown = text(q('[data-testid="expected-hash"]')); // the offer step shows it; the code step replaces it
const pairRes = await cf("pair", { link });
check("9 the phone shows the build hash of the deployed bundle and the Mac expects the same", pairRes.phoneHash === hashShown && hashShown === staged.group, `${pairRes.phoneHash} | ${hashShown} | ${staged.group} | ${JSON.stringify((({ relayMode, expectedBundleHash, bundle, relay }) => ({ relayMode, expectedBundleHash, bundle, relay }))(await status()))}`);
const sasEl = await waitFor(() => q('[data-testid="sas"]'), { what: "the SAS on the Mac", timeout: 30000 });
check("9 the six digits on the Mac equal the phone's", text(sasEl).replace(/\s/g, "") === pairRes.sas, `${text(sasEl)} vs ${pairRes.sas}`);
await typeInto(q('input[aria-label="Device name"]'), "E2E iPhone");
await clickButton("Codes match: approve");
const paired = await cf("paired", {}, 120000);
check("9 the phone is live and holds the welcome pin: the Mac's signing key, the relay host and a sequence number", paired.conn === "live" && paired.bundlePub === staged.staged?.pubkey && paired.relayHost === `127.0.0.1:${port}` && paired.maxSeq === staged.staged?.seq, JSON.stringify({ pub: paired.bundlePub?.slice(0, 10), host: paired.relayHost, seq: paired.maxSeq, want: staged.staged }));
check("9 the phone's shell is the deployed bundle, now verified under the pin", paired.shell?.hash === staged.staged?.manifestSha256 && paired.shell?.signed === true, JSON.stringify(paired.shell));
await shot("cf-paired");

// ---- 10. the phone's service worker against a bad bundle --------------------------------------------------------------------
step("10. service worker rejects a changed bundle");
const swr = await cf("sw-tamper", {}, 120000);
check("10 an edited manifest is refused and the verified shell keeps serving", swr.bad?.ok === false && swr.activeAfterBad === swr.activeBefore, JSON.stringify({ bad: swr.bad, a: swr.activeAfterBad, b: swr.activeBefore }));
check("10 a bundle signed by another key is refused as a key mismatch", swr.wrongKey?.ok === false && swr.wrongKey?.reason === "keyMismatch" && swr.activeAfterKey === swr.activeBefore, JSON.stringify(swr.wrongKey));
check("10 the Mac-signed bundle is accepted again", swr.good?.ok === true && swr.good?.signed === true && swr.good?.hash === staged.staged?.manifestSha256, JSON.stringify(swr.good));

// ---- 11. token mode: the token reaches the child's environment only, never argv, settings or logs ---------------------------
step("11. token mode");
await invoke("relay_cloud_token_set", { token: TOKEN_MARKER });
const who = await invoke("relay_cloud_whoami");
check("11 whoami in token mode answers as a token login", who.loggedIn === true && who.authType === "token", JSON.stringify({ t: who.authType, l: who.loggedIn }));
await invoke("relay_cloud_token_clear");
const fin = (await cf("calls")).calls;
const tokenCalls = fin.filter((c) => c.tokenInEnv);
check("11 the token marker reached the environment of exactly the token-mode call(s) and of nothing else", tokenCalls.length >= 1 && tokenCalls.every((c) => c.tokenMarkerInEnv && c.argv[0] === "whoami") && fin.filter((c) => !c.tokenInEnv).length === fin.length - tokenCalls.length, JSON.stringify(fin.map((c) => [c.argv[0], c.tokenInEnv])));
check("11 the token marker is in no argv", !JSON.stringify(fin.map((c) => c.argv)).includes(TOKEN_MARKER));
check("11 no call inherited a Cloudflare variable from the app's environment other than the account id and the token", fin.every((c) => c.envNames.every((n) => !/^CLOUDFLARE_/.test(n) || ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"].includes(n))), JSON.stringify([...new Set(fin.flatMap((c) => c.envNames.filter((n) => /CLOUDFLARE|^CF_|WRANGLER|NODE_OPTIONS/.test(n))))]));
check("11 wrangler's own metrics are off and its log path is inside the state directory", fin.every((c) => c.envNames.includes("WRANGLER_SEND_METRICS")) && fin.every((c) => !c.cwd.includes("/repos/")), JSON.stringify([...new Set(fin.map((c) => c.cwd))]));
const leaks = await cf("leaks", { marker: TOKEN_MARKER });
check("11 the token marker is in no file the app wrote, no log and not in the app's output", leaks.hits.length === 0 && !leaks.opsText.includes(TOKEN_MARKER), JSON.stringify(leaks.hits));
check("11 the op log is a debug trail with no argv values", leaks.ops >= 5 && !/--config|--name/.test(leaks.opsText), leaks.opsText.slice(-200));

// ---- 12. switch off, nothing left running -----------------------------------------------------------------------------------
step("12. switch off");
await closeSettings();
await openRemote();
sw().click();
await waitFor(() => !isOn(), { what: "Remote off", timeout: 20000 });
await waitFor(async () => (await cf("sample", { label: "off" })).relaySockets === 0, { what: "the relay socket to close", timeout: 20000, interval: 500 });
check("12 Remote is off and the app holds no relay socket", !isOn());
await shot("cf-off");
check("13 CONTRACT: relay_cloud_status, relay_cloud_preview, RunStarted and relay-cloud:state carry what the UI types declare (the wizard cannot run otherwise)", contractGaps.length === 0, "missing: " + contractGaps.join(", ") + (runEvents.some((e) => "steps" in e) ? "" : "; state events have no steps[]/error"));
await cf("bye");
await finish();

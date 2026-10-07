// (ro) Roles and orchestration ((design notes: roles-orchestration-spec) 8.5): grouped roles with trust, migration, hide/pin, typed-name delete
// with a verified backup, a corrupt overlay, a symlinked agents dir, a hostile repository role, then an Auto-style run with the scripted
// mock lead (`mock-auto`, scenario delegate-roles) whose delegates are the REAL resolved set and whose every call goes through the REAL
// Rust broker with the actor of its delegate. Opt-in (--only ro); needs INTELY_MOCK_PROVIDER=1 and the fixtures of ro-setup.sh
// (CLAUDE_CONFIG_DIR=<fx>/claude-config, INTELY_DATA_DIR=<fx>/data). No model call anywhere.
//
// What this proves: the broker + event log + UI with SIMULATED actors. It does NOT prove that the real Claude CLI reports agent_id /
// agent_type or honours updatedInput on an Agent call (only the opt-in live smoke in sidecar/test/claude-live.test.ts does).
await waitForTree();
const ws = await invoke("workspace_get");
const nameOf = (id) => ws.repos.find((r) => r.id === id).name;
const [BACKEND_ID, ADMIN_ID, SERVICES_ID, POS_ID] = FX.repoIds;
const byName = (groups, name) => groups.find((g) => g.name === name);
const settingsDlg = () => q(".settings");
async function openSettings(section) {
  if (!settingsDlg()) { await press(",", { meta: true }); await waitFor(settingsDlg, { what: "Settings" }); }
  (await waitFor(() => qa(".settings__item", settingsDlg()).find((b) => text(b) === section), { what: `the ${section} section` })).click();
  await sleep(250);
  return settingsDlg();
}
const pane = () => q(".settings__pane", settingsDlg());
const rejected = (p) => p.then(() => "accepted", (e) => e?.code ?? String(e?.message ?? e));

// ---- 0. the fixtures are what the setup says (nothing from the real ~/.claude) ----------------------------------------------------------
const status0 = await invoke("roles_status");
check("the global agents dir is the fixture's, not ~/.claude", status0.globalDir.startsWith(`${FX.root}/claude-config`), status0.globalDir);
notes.globalDir = status0.globalDir;

// ---- 1. migration: a real-shaped 0.1.0 overlay ---------------------------------------------------------------------------------------------
check("the legacy overlay loads (not corrupt)", status0.overlayCorrupt === false, JSON.stringify(status0).slice(0, 200));
const mismatchIds = status0.mismatches.map((m) => m.id);
check("migration: the role pinned read-only that its file derives as edit is listed", status0.mismatches.some((m) => m.id === "writer" && m.overlay === "readOnly" && m.derived === "edit"), JSON.stringify(status0.mismatches));
check("migration: a pin that agrees with the file is not listed", !mismatchIds.includes("researcher"), mismatchIds.join(","));
check("a symlinked repository agents dir is skipped and reported", status0.skippedDirs.some((d) => d.repoId === SERVICES_ID && d.code === "agentsDirSymlink"), JSON.stringify(status0.skippedDirs));

// ---- 2. groups: one row per name, copies, trust, derived permission --------------------------------------------------------------------
let groups = await invoke("roles_groups");
const researcher = byName(groups, "researcher");
check("ONE group researcher with three copies (global, admin, shop-pos)", researcher?.copies.length === 3 && groups.filter((g) => g.name === "researcher").length === 1, JSON.stringify(researcher?.copies.map((c) => c.id)));
check("the differing copy makes the group conflict and the global copy wins", researcher?.conflict === true && researcher?.winnerReason === "global", `${researcher?.conflict} ${researcher?.winnerReason}`);
check("the diff names the field that differs", researcher?.diffs.some((d) => d.fields.includes("model")), JSON.stringify(researcher?.diffs));
check("the identical admin copy is identical, the other is not", researcher?.copies.find((c) => c.repoId === ADMIN_ID)?.sameAsWinner === true && researcher?.copies.find((c) => c.repoId === POS_ID)?.sameAsWinner === false);
check("researcher is read-only because of its tools (not because the overlay lacks an entry)", researcher?.role.permission === "readOnly" && researcher?.role.permissionReason === "overlay" || researcher?.role.permissionReason === "tools:readOnly", `${researcher?.role.permission} ${researcher?.role.permissionReason}`);
const writer0 = byName(groups, "writer");
check("writer is pinned read-only by the legacy overlay (the migration trap), so it cannot edit yet", writer0?.role.permission === "readOnly" && writer0?.role.permissionSource === "overlay", JSON.stringify([writer0?.role.permission, writer0?.role.permissionSource]));
const hostile = byName(groups, "hostile");
check("a repository-only role is untrusted and never a delegate", hostile?.copies[0].trust === "untrusted" && hostile?.delegate.ok === false && hostile?.delegate.reason === "untrusted", JSON.stringify([hostile?.copies[0].trust, hostile?.delegate]));
const reviewer = byName(groups, "reviewer");
check("a repository reviewer.md without a tools line does not widen the read-only built-in", reviewer?.role.permission === "readOnly", `${reviewer?.role.permission} ${reviewer?.role.permissionReason} (winner ${reviewer?.winnerReason})`);
check("the symlinked agents dir's role is not in any group", !groups.some((g) => g.name === "evil"), groups.map((g) => g.name).join(","));
notes.groups = groups.map((g) => `${g.name}:${g.copies.length}${g.hidden ? ":hidden" : ""}`).join(",");

// ---- 3. the Roles table (DOM): one row per name, plain words, chips -----------------------------------------------------------------
await openSettings("Roles");
const roleNameInputs = () => qa('input[aria-label="Role name"]', pane());
await waitFor(() => roleNameInputs().some((i) => i.value === "researcher"), { what: "the roles table", timeout: 30000 });
const rowsFor = (name) => roleNameInputs().filter((i) => i.value === name).length;
check("the table has ONE row for researcher although three files exist", rowsFor("researcher") === 1, `${rowsFor("researcher")} rows`);
check("the table says the copies differ", /Copies differ/i.test(text(pane())), text(pane()).slice(0, 300));
check("the table explains the permission in words", /Read-only|Can read and search files/i.test(text(pane())), text(pane()).slice(0, 300));
check("the migration bar lists the pinned role and offers Use automatic", /Use automatic/i.test(text(pane())), text(pane()).slice(0, 300));
await snap("ro-roles-table");
await press("Escape");
await waitFor(() => !settingsDlg(), { what: "Settings to close" });

// ---- 4. Use automatic removes only the overlay permission ---------------------------------------------------------------------------
await invoke("roles_use_automatic", { roleIds: ["writer"] });
const status1 = await invoke("roles_status");
check("Use automatic: the role is no longer listed", !status1.mismatches.some((m) => m.id === "writer"), JSON.stringify(status1.mismatches));
groups = await invoke("roles_groups");
const writer = byName(groups, "writer");
check("Use automatic: writer derives edit from its own file now", writer?.role.permission === "edit" && writer?.role.permissionSource === "tools", JSON.stringify([writer?.role.permission, writer?.role.permissionSource]));
check("writer edits files but runs no commands (Read, Edit, Write)", writer?.role.canEdit === true && writer?.role.canRun === false, JSON.stringify([writer?.role.canEdit, writer?.role.canRun]));

// ---- 5. hide and pin only touch the overlay -----------------------------------------------------------------------------------------------
await invoke("roles_set_hidden", { name: "hidden-one", hidden: true });
groups = await invoke("roles_groups");
check("hide: the group is flagged hidden", byName(groups, "hidden-one")?.hidden === true);
const info = await invoke("agents_auto_info", { repoIds: [BACKEND_ID] });
check("a hidden role is not a delegate and is listed as excluded (hidden)", !info.delegates.some((d) => d.name === "hidden-one") && info.excluded.some((e) => e.name === "hidden-one" && e.reason === "hidden"), JSON.stringify(info.excluded));
check("the delegates are the roles of THIS run's repositories plus global and built-ins", ["researcher", "writer"].every((n) => info.delegates.some((d) => d.name === n)) && !info.delegates.some((d) => d.name === "hostile"), info.delegates.map((d) => d.name).join(","));
check("the lead is the Auto lead: edit posture, a spend/turn worst case is shown", info.permission === "edit" && info.worstCaseTurns > 60, `${info.permission} ${info.worstCaseTurns}`);
const roleList = await invoke("agent_roles");
check("the New run picker (Run as role...) omits the hidden role, the untrusted one and auto", !roleList.some((r) => ["hidden-one", "hostile", "auto"].includes(r.name)) && roleList.some((r) => r.name === "researcher"), roleList.map((r) => r.name).join(","));
check("an untrusted repository copy cannot be pinned (it must be approved first)", /no usable copy/i.test(String(await invoke("roles_set_pin", { name: "researcher", pin: `repo:${POS_ID}` }).then(() => "accepted", (e) => e?.message ?? e))));
const posCopyHash = byName(await invoke("roles_groups"), "researcher").copies.find((c) => c.repoId === POS_ID).contentHash;
await invoke("roles_set_trust", { name: "researcher", hash: posCopyHash, trusted: true });
const pinned = await invoke("roles_set_pin", { name: "researcher", pin: `repo:${POS_ID}` });
check("pin: the pinned repository copy wins", pinned.winnerReason === "pinned" && pinned.winnerId === `researcher@${POS_ID}`, `${pinned.winnerReason} ${pinned.winnerId}`);
const unpinned = await invoke("roles_set_pin", { name: "researcher", pin: null });
check("unpin: back to the default winner", unpinned.winnerReason === "global", unpinned.winnerReason);
await invoke("roles_set_trust", { name: "researcher", hash: posCopyHash, trusted: false });

// ---- 6. the Trust flow for the hostile repository role ----------------------------------------------------------------------------
const posInfo = await invoke("agents_auto_info", { repoIds: [POS_ID] });
check("trust: before approval the hostile role is excluded as untrusted", posInfo.excluded.some((e) => e.name === "hostile" && e.reason === "untrusted"), JSON.stringify(posInfo.excluded));
const hash = byName(await invoke("roles_groups"), "hostile").copies[0].contentHash;
await invoke("roles_set_trust", { name: "hostile", hash, trusted: true });
const posInfo2 = await invoke("agents_auto_info", { repoIds: [POS_ID] });
const hostileDelegate = posInfo2.delegates.find((d) => d.name === "hostile");
check("trust: once approved it is a delegate, but held at the ceiling (never wider than ask, no bypass)", !!hostileDelegate && hostileDelegate.permission !== "edit" && hostileDelegate.permission !== "auto", JSON.stringify(hostileDelegate));
await invoke("roles_set_trust", { name: "hostile", hash, trusted: false });
check("trust is reversible", (await invoke("agents_auto_info", { repoIds: [POS_ID] })).excluded.some((e) => e.name === "hostile"));

// ---- 7. delete: typed name, verified backup ------------------------------------------------------------------------------------------
const preview = await invoke("roles_delete_preview", { roleIds: [`researcher@${ADMIN_ID}`] });
check("the delete preview lists the path and the backup dir (outside .claude)", preview.files.length === 1 && preview.files[0].path.endsWith("/admin/.claude/agents/researcher.md") && !!preview.backupDir && !preview.backupDir.includes("/.claude"), JSON.stringify(preview));
check("delete without the typed name is refused and nothing is touched", (await rejected(invoke("roles_delete", { roleIds: [`researcher@${ADMIN_ID}`], typed: "" }))) === "confirmDelete");
check("delete with a wrong-case name is refused", (await rejected(invoke("roles_delete", { roleIds: [`researcher@${ADMIN_ID}`], typed: "Researcher" }))) === "confirmDelete");
check("a built-in has no file to delete", ["builtinNoFile", "unknownRole"].includes(await rejected(invoke("roles_delete", { roleIds: ["developer"], typed: "developer" }))));
const report = await invoke("roles_delete", { roleIds: [`researcher@${ADMIN_ID}`], typed: "researcher" });
check("delete: one file removed, one backup written first", report.deleted.length === 1 && report.backups.length === 1, JSON.stringify(report));
groups = await invoke("roles_groups");
check("delete: the group now has two copies", byName(groups, "researcher")?.copies.length === 2, String(byName(groups, "researcher")?.copies.length));

// ---- 8. New run in Auto: the dialog starts without a role -------------------------------------------------------------------------
await openAgents();
await clickButton("New run", agentsPanel());
const pop = await waitFor(() => q(".newrun"), { what: "the New run dialog" });
await waitFor(() => /Auto/.test(text(pop)), { what: "the Auto card", timeout: 15000 });
check("New run opens in Auto: no role has to be picked", /Auto/.test(text(pop)) && !/pick a role|Pick a role/i.test(text(pop)), text(pop).slice(0, 300));
await snap("ro-new-run-auto");
await press("Escape");
await sleep(200);

await invoke("roles_set_hidden", { name: "hidden-one", hidden: true }); // stays hidden for the run below: it must not be a delegate
// ---- 9. the scripted lead: delegates + the real broker with an actor -----------------------------------------------------------------
const started = await invoke("agent_start", { req: { role: "mock-auto", repoIds: [BACKEND_ID], prompt: "go" }, runWithoutSafetyNet: false });
const agentId = started.agentId;
await waitFor(async () => (await invoke("agent_list")).find((a) => a.agentId === agentId)?.status === "done", { what: "the delegating run to finish", timeout: 90000 });
const h = await historyOf(agentId);
check("the run's log is gap-free with paired tools and turns", h.problems.length === 0, h.problems.join("; "));
const ev = h.events;
const infoEv = ev.find((e) => e.kind === "session.info" && (e.delegates ?? []).length);
check("session.info carries the delegates of the run (without prompts)", !!infoEv && ["researcher", "writer"].every((n) => infoEv.delegates.some((d) => d.name === n)) && !JSON.stringify(infoEv).includes("You are researcher"), JSON.stringify(infoEv?.delegates?.map((d) => d.name)));
check("the hidden/untrusted roles are not in the run's delegates", !infoEv?.delegates.some((d) => ["hidden-one", "hostile"].includes(d.name)));
const agentStarts = ev.filter((e) => e.kind === "tool.start" && e.name === "Agent").map((e) => e.input.subagent_type);
check("the lead started both roles through the Agent tool", agentStarts.join() === "researcher,writer", agentStarts.join());
const resultOf = (id) => ev.find((e) => e.kind === "tool.result" && e.toolId === id);
const resolvedBy = (id) => ev.find((e) => e.kind === "permission.resolved" && e.reqId === `perm-${id}`)?.by;
const requestOf = (id) => ev.find((e) => e.kind === "permission.request" && e.toolId === id);
check("researcher: Read allowed", resultOf("c1")?.status === "ok" && !requestOf("c1"));
check("researcher: Edit refused by its role", resultOf("c2")?.status === "denied" && resolvedBy("c2") === "roleDeny", `${resultOf("c2")?.status} ${resolvedBy("c2")}`);
check("researcher: Bash refused by its role", resultOf("c3")?.status === "denied" && resolvedBy("c3") === "roleDeny", `${resultOf("c3")?.status} ${resolvedBy("c3")}`);
check("writer: Edit inside the repository allowed", resultOf("c7")?.status === "ok" && !requestOf("c7"), `${resultOf("c7")?.status}`);
check("writer: Bash refused (the role has no such tool)", resultOf("c8")?.status === "denied" && resolvedBy("c8") === "roleDeny", `${resultOf("c8")?.status} ${resolvedBy("c8")}`);
for (const id of ["c4", "c5", "c9", "c10"]) check(`commit/push (${id}) refused by the hard stop for both roles`, resultOf(id)?.status === "denied" && resolvedBy(id) === "hardStop", `${resultOf(id)?.status} ${resolvedBy(id)}`);
check("reading a .env is a hard stop", resultOf("c6")?.status === "denied" && resolvedBy("c6") === "hardStop", `${resultOf("c6")?.status} ${resolvedBy("c6")}`);
const denied = ev.filter((e) => e.kind === "permission.request" && (e.options ?? []).join() === "deny");
check("every refused call names its actor role in agent_history", denied.length === 8 && denied.every((e) => !!e.intent?.actor?.role), `${denied.length} refused, roles ${denied.map((e) => e.intent?.actor?.role).join(",")}`);
check("the refused calls of the researcher carry the researcher, the writer's carry the writer", ["c2", "c3", "c4", "c5", "c6"].every((id) => requestOf(id)?.intent.actor.role === "researcher") && ["c8", "c9", "c10"].every((id) => requestOf(id)?.intent.actor.role === "writer"));
check("no error event in the run", !ev.some((e) => e.kind === "error"), ev.filter((e) => e.kind === "error").map((e) => e.message).join("; "));
notes.runEvents = ev.length;
// the run view shows the roles (DOM): open the run from the dock's list
const runEntry = () => qa("button, [role=button], [role=treeitem], li, a", agentsPanel()).find((el) => /mock-auto/.test(text(el)) && el.children.length < 12);
runEntry()?.click();
await waitFor(() => /researcher/.test(panelText()) && /writer/.test(panelText()), { what: "the role names in the run view", timeout: 20000 }).catch(() => undefined);
check("the run view names the delegated roles", /researcher/.test(panelText()) && /writer/.test(panelText()), panelText().slice(0, 400));
await snap("ro-run-delegation");

// ---- 10. a corrupt overlay: every role read-only, writes refused, the bytes kept ---------------------------------------------------------
await invoke("files_create_entry", { repoId: POS_ID, relPath: ".ro-cmd", kind: "file" }).catch(() => undefined);
const cmdFile = await invoke("files_read_file", { repoId: POS_ID, relPath: ".ro-cmd" }).catch(() => null);
if (cmdFile) await invoke("files_write_file", { repoId: POS_ID, relPath: ".ro-cmd", text: "corrupt", expectedMtimeMs: cmdFile.mtimeMs, reveal: false });
await waitFor(async () => (await invoke("files_read_file", { repoId: POS_ID, relPath: ".ro-ack" }).catch(() => null))?.text?.includes("corrupt"), { what: "the harness to damage the overlay", timeout: 20000 });
const status2 = await invoke("roles_status");
check("a corrupt overlay is reported with where the bytes went", status2.overlayCorrupt === true && !!status2.overlayBackup, JSON.stringify(status2).slice(0, 240));
groups = await invoke("roles_groups");
check("while it is corrupt every role is read-only", groups.filter((g) => !g.role.builtin).every((g) => g.role.permission === "readOnly"), groups.map((g) => `${g.name}:${g.role.permission}`).join(","));
const draft = (await invoke("roles_list")).find((r) => r.name === "writer");
check("while it is corrupt a write is refused with overlayCorrupt", (await rejected(invoke("roles_save", { role: { id: draft.id, name: draft.name, description: draft.description, model: draft.model, tools: draft.tools, systemPrompt: draft.systemPrompt, permission: "edit", permissionExplicit: true, confirmWrite: true } }))) === "overlayCorrupt");
await openSettings("Roles");
await waitFor(() => /roles/i.test(text(pane())) && qa('[role="alert"]', pane()).length > 0, { what: "the repair notice", timeout: 20000 }).catch(() => undefined);
check("the Roles table shows a repair notice for the corrupt overlay", qa('[role="alert"]', pane()).some((n) => /overlay|reset|repair/i.test(text(n))), qa('[role="alert"]', pane()).map((n) => text(n)).join(" | ").slice(0, 300));
await snap("ro-corrupt-overlay");
await press("Escape");
await invoke("roles_reset_overlay");
check("resetting the overlay restores a working roles layer", (await invoke("roles_status")).overlayCorrupt === false);

await invoke("roles_set_hidden", { name: "hidden-one", hidden: false });
await finish({ groups: notes.groups });

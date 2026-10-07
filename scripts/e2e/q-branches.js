// (q) Branches on the fixtures, like a user: New branch from the title-bar popup (the dirty tree refuses the checkout and says
// so), stash the ticked files of all four repos, switch from the popup, Switch all with a per-repo result list (switched /
// no such branch / failed on a dirty tree), stash Apply / Pop / Drop (typed confirmation dialog), Rollback with the backup
// notice, delete a branch with the confirmation dialog. git verifies the end state in run.sh (verify_q).
await waitForTree();
const [BE, AD, SV, POS] = FX.repoIds;
const pill = (name) => qa("button").find((b) => (b.getAttribute("aria-label") ?? "").startsWith(`${name}, branch`));
const popup = () => q(".bp");
const branchRow = (name) => qa('[role="option"]', popup() ?? document.body).find((o) => text(q(".bpl__name", o)) === name);
const openPopup = async (repoName) => {
  (await waitFor(() => pill(repoName), { what: `the ${repoName} branch pill` })).click();
  await waitFor(() => popup() && /tracking|Current/.test(text(popup())) && !q('[aria-label="Loading branches"]', popup()), { what: "the branch popup to load", timeout: 15000 });
};
const closePopup = async () => { if (popup()) { await press("Escape"); await waitFor(() => !popup(), { what: "the popup to close", timeout: 5000 }); } };
const branchesOf = async (id) => (await invoke("branches_list", { repoId: id })).local;
const stashRepos = () => qa(".stp__group", q('section[aria-label="Stash"]') ?? document.body).map((g) => text(q(".stp__repo .ui-truncate", g)));
const stashGroup = (name) => qa(".stp__group", q('section[aria-label="Stash"]') ?? document.body).find((g) => text(q(".stp__repo .ui-truncate", g)) === name);

// ---- New branch from the popup: the tree is dirty, so the checkout is refused and the toast says what happened ----------------------
await openPopup(BACKEND);
check("the popup lists the current branch with its upstream", /Current\s*sandbox/.test(text(popup())) && /origin\/sandbox/.test(text(popup())), text(popup()).slice(0, 160));
await clickButton("New branch…", popup());
let d = await waitDialog(/New branch/);
await typeInto(await waitFor(() => q("input", d), { what: "the branch name field" }), "e2e-feature");
check("Check out the new branch is on by default", q('[role="switch"]', d)?.getAttribute("aria-checked") === "true");
await clickButton("Create", d);
const refusal = await waitToast(/could not switch/i, "the dirty-tree refusal", 20000);
notes.refusal = `${refusal.title} | ${refusal.desc}`;
check("a dirty tree refuses the checkout and the toast names the repo", /shop-backend/.test(refusal.title) && /uncommitted|dirty|changes/i.test(refusal.desc), `${refusal.title} | ${refusal.desc}`);
check("the branch itself was created though", (await branchesOf(BE)).includes("e2e-feature"));
check("the backend is still on sandbox", FX.branches[BE] === "sandbox" && /branch sandbox/.test(pill(BACKEND).getAttribute("aria-label")), pill(BACKEND).getAttribute("aria-label"));
await snap("branch-dirty-refusal");
if (dialogsOpen().includes(d)) { await press("Escape", {}, q("input", d)); await dialogGone(d).catch(() => {}); }

// ---- Stash the ticked files of every repo -------------------------------------------------------------------------------------
await runCommand("Stash the ticked files");
await waitFor(() => stashRepos().length === 4, { what: "a stash in each of the four repos", timeout: 30000 });
check("Stash: every repo has one stash entry", stashRepos().sort().join(",") === ["shop-pos", "shop-backend", "admin", "shop-mobile"].sort().join(","), stashRepos().join(","));
await waitFor(async () => (await invoke("snapshot_get", { repoId: BE })).changes.filter((c) => c.kind !== "untracked").length === 0, { what: "the backend tree to be clean of tracked changes", timeout: 20000 });
check("Stash: the working trees lost their tracked changes", true);
await snap("branch-stashes");

// ---- Switch from the popup (the tree is clean now) ----------------------------------------------------------------------------
await openPopup(BACKEND);
await waitFor(() => branchRow("e2e-feature"), { what: "the new branch in the list" });
branchRow("e2e-feature").click();
const on = await waitToast(/shop-backend is on e2e-feature/, "the switch toast", 20000);
await waitFor(() => /branch e2e-feature/.test(pill(BACKEND)?.getAttribute("aria-label") ?? ""), { what: "the pill to show e2e-feature", timeout: 15000 });
check("Switch: the pill follows", true);
await closePopup();

// ---- Switch all with a per-repo result: admin has the branch, pos has it but a dirty tree, services lacks it ---------------------------
await invoke("branches_create", { repoId: AD, name: "e2e-feature" });
await invoke("branches_create", { repoId: POS, name: "e2e-feature" });
await waitFor(() => stashGroup("shop-pos"), { what: "the shop-pos stash group" });
await clickButton("Apply", stashGroup("shop-pos"));
await waitToast(/Stash applied/, "Stash applied (pos)");
await waitFor(() => stashGroup("shop-pos") && qa(".stp__row", stashGroup("shop-pos")).length === 1, { what: "the applied stash to stay in the list", timeout: 10000 });
check("Stash Apply: the stash stays in the list", true);
await waitFor(async () => (await invoke("snapshot_get", { repoId: POS })).changes.some((c) => c.kind !== "untracked"), { what: "the pos tree to be dirty again", timeout: 15000 });
await runCommand("Switch all repositories to a branch…");
d = await waitDialog(/Switch all repositories/);
await typeInto(await waitFor(() => q('input[aria-label="Branch name"]', d)), "e2e-feature");
await clickButton("Switch all", d);
const results = await waitFor(() => q('ul[aria-label="Result per repository"]'), { what: "the result list", timeout: 30000 });
const rowOf = (name) => qa("li", results).find((li) => text(li).includes(name));
notes.switchAll = qa("li", results).map(text);
check("Switch all: four rows, one per repository", qa("li", results).length === 4, qa("li", results).map(text).join(" | "));
check("Switch all: admin switched", /Switched/.test(text(rowOf("admin"))), text(rowOf("admin")));
check("Switch all: services has no such branch", /No such branch/.test(text(rowOf("shop-mobile"))), text(rowOf("shop-mobile")));
check("Switch all: the backend (already there) says so instead of 'No such branch'", /Already on it/.test(text(rowOf("shop-backend"))), text(rowOf("shop-backend")));
check("Switch all: pos failed on its dirty tree, with the reason", /Uncommitted changes/.test(text(rowOf("shop-pos"))) && text(rowOf("shop-pos")).length > 30, text(rowOf("shop-pos")));
check("Switch all: the dialog title and tally say what happened", /Switched to e2e-feature/.test(text(d)) && /1 failed/.test(text(d)), text(d).slice(0, 200));
await snap("branch-switch-all");
await clickButton("Done", d);
await dialogGone(d);

// ---- Stash Pop (services) and Drop (admin, typed confirmation dialog) ---------------------------------------------------------------
await clickButton("Pop", stashGroup("shop-mobile"));
await waitToast(/Stash popped/, "Stash popped");
await waitFor(() => !stashGroup("shop-mobile"), { what: "the services stash to leave the list" });
check("Stash Pop: the entry is gone and the changes are back", (await invoke("snapshot_get", { repoId: SV })).changes.length > 0);
await clickButton("Drop stash 0 of admin", stashGroup("admin"));
d = await waitDialog(/Drop this stash/);
await clickButton("Drop", d);
await waitToast(/Stash dropped/, "Stash dropped");
await waitFor(() => !stashGroup("admin"), { what: "the admin stash to leave the list" });
check("Stash Drop: gone after the confirmation", true);

// ---- Rollback: pos has tracked changes again (the applied stash); the dialog lists them, the toast names the backup ----------------------
const posFiles = (await invoke("snapshot_get", { repoId: POS })).changes.filter((c) => c.kind !== "untracked").map((c) => c.path);
const commitView = qa('[role="tab"], [role="radio"], button').find((b) => text(b) === "Commit" && !b.closest(".ui-toast"));
commitView?.click(); // back from the Stash view to the Changes tree
await waitFor(() => findRow(repoRowSel(FX.repoIds[0])), { what: "the Changes tree", timeout: 15000 });
for (const id of FX.repoIds) await untickRepo(id); // nothing ticked: the command acts on the selected file
await expandRow(repoRowSel(POS));
const frow = await waitFor(() => findRow(fileRowSel(POS, posFiles[0])), { what: `the row of ${posFiles[0]}` });
frow.click();
await sleep(200);
await runCommand("Roll back the ticked or selected files…");
d = await waitDialog(/Roll back 1 file\?/);
check("Rollback: the dialog lists the selected file and promises a backup", text(d).includes(posFiles[0].split("/").pop()) && /backup/i.test(text(d)), text(d).slice(0, 200));
await clickButton("Roll back", d);
const note = await waitToast(/Rolled back 1 file/, "the rollback notice", 20000);
check("Rollback: the notice shows where the backup is", /backup copy is saved in .*rollback/.test(note.desc), note.desc);
check("Rollback: the notice stays until dismissed (a Copy path action)", !!findButton("Copy path", note.el));
notes.backup = note.desc;
await snap("branch-rollback-notice");

// ---- Delete a branch: switch the backend back, then delete e2e-feature with the confirmation ---------------------------------------------------
await openPopup(BACKEND);
branchRow("sandbox").click();
await waitFor(() => /branch sandbox/.test(pill(BACKEND)?.getAttribute("aria-label") ?? ""), { what: "the backend back on sandbox", timeout: 15000 });
await openPopup(BACKEND);
await waitFor(() => branchRow("e2e-feature"), { what: "e2e-feature in the list" });
check("the live branch sandbox offers no Delete", !findButton("Delete sandbox", popup()));
findButton("Delete e2e-feature", popup()).click();
d = await waitDialog(/Delete e2e-feature\?/);
check("Delete: the dialog names the repo and says the remote is untouched", /shop-backend/.test(text(d)) && /remote branch is not touched/i.test(text(d)), text(d).slice(0, 220));
await clickButton("Delete", d);
await waitToast(/Deleted e2e-feature/, "Deleted");
check("Delete: the branch is gone", !(await branchesOf(BE)).includes("e2e-feature"));
await finish();

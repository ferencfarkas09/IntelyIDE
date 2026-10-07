// (c) Per-repo messages and "Commit and Push…" with two repos; the push dialog keeps repos without outgoing commits greyed and unticked.
await waitForTree();
const B = "shop-backend";
const A = "admin";
await untickRepo("shop-mobile");
await untickRepo("shop-pos");
await useMode("Per repo");

const field = async (name) => (await waitFor(() => findRow(`[role="treeitem"][aria-label="Commit message for ${name}"]`), { what: `message row of ${name}` })) && q(`textarea[aria-label="Commit message for ${name}"]`);
await typeInto(await field("shop-backend"), "e2e(backend): per-repo message");
await typeInto(await field("admin"), "e2e(admin): per-repo message");

await chooseMenuItem("More commit actions", "Commit and Push", q(".commit-panel__actions"));

// the commits go through, then the push dialog opens with every repo listed
const dialog = await waitFor(() => qa('[role="dialog"]').find((d) => q('[role="tree"][aria-label="Repositories and outgoing commits"]', d)), { what: "push dialog", timeout: 60000 });
await waitFor(() => qa("[data-key^='repo:']", dialog).length === 4, { what: "4 repos in the push dialog" });
const box = (name) => q(`input[aria-label="Push ${name}"]`, dialog);
const state = (name) => ({ checked: box(name)?.checked, disabled: box(name)?.disabled });
notes.dialog = Object.fromEntries(["shop-backend", "admin", "shop-mobile", "shop-pos"].map((n) => [n, state(n)]));
check("backend is ticked and enabled", state("shop-backend").checked && !state("shop-backend").disabled, JSON.stringify(state("shop-backend")));
check("admin is ticked and enabled", state("admin").checked && !state("admin").disabled, JSON.stringify(state("admin")));
check("services is greyed and unticked", !state("shop-mobile").checked && state("shop-mobile").disabled, JSON.stringify(state("shop-mobile")));
check("shop-pos is greyed and unticked", !state("shop-pos").checked && state("shop-pos").disabled, JSON.stringify(state("shop-pos")));
const adminRow = q("[data-key='repo:admin']", dialog);
check("admin shows the remapped target origin/sandbox", /origin\/sandbox/.test(text(adminRow)), text(adminRow));
// backend's commit list (repos with outgoing commits start expanded) and the changed files of the selected commit
if (!q("[data-key^='commit:shop-backend']", dialog)) q('[data-key="repo:shop-backend"] .ui-tree-row__chevron', dialog).click();
await waitFor(() => qa("[data-key^='commit:shop-backend']", dialog).length >= 2, { what: "backend commits" });
const commits = qa("[data-key^='commit:shop-backend']", dialog).map(text);
notes.backendCommits = commits;
check("backend lists 2 outgoing commits", commits.length === 2, commits.join(" | "));
check("newest commit shows the per-repo message", /e2e\(backend\): per-repo message/.test(commits[0] ?? ""), commits[0]);
qa("[data-key^='commit:shop-backend']", dialog)[0].click();
await waitFor(() => /orders\.js/.test(text(dialog)), { what: "changed files of the commit" });

await clickButton("Push (2 repos)", dialog);
await waitFor(() => !document.contains(dialog) || !qa('[role="dialog"]').includes(dialog), { what: "dialog to close", timeout: 60000 });
await waitFor(() => sheet() && /Push results/.test(text(sheet())) && Object.keys(sheetRows()).length >= 2 && !/Pushing|Queued/.test(Object.values(sheetRows()).join(" ")), { what: "push results", timeout: 60000 });
notes.sheet = sheetRows();
check("both pushes finished", Object.values(sheetRows()).filter((s) => /Pushed|Done/.test(s)).length === 2, JSON.stringify(sheetRows()));
await finish();

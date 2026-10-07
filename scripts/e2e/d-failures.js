// (d) A failing pre-commit hook in one repo and a non-fast-forward push in another: the others succeed, retry works.
await waitForTree();
await sharedMessage("e2e: failures message");
await chooseMenuItem("More commit actions", "Commit and Push", q(".commit-panel__actions"));

// the three repos whose commit worked get the push dialog; backend's hook failed
const dialog = await waitFor(() => qa('[role="dialog"]').find((d) => q('[role="tree"][aria-label="Repositories and outgoing commits"]', d)), { what: "push dialog", timeout: 60000 });
await waitFor(() => qa("[data-key^='repo:']", dialog).length === 4, { what: "4 repos in the push dialog" });
const rowsAfterCommit = sheetRows();
notes.afterCommit = rowsAfterCommit;
check("backend commit failed", rowsAfterCommit["shop-backend"] === "Failed", rowsAfterCommit["shop-backend"]);
check("the other three committed", ["admin", "shop-mobile", "shop-pos"].every((n) => rowsAfterCommit[n] === "Done"), JSON.stringify(rowsAfterCommit));
const backendRow = sheetRow("shop-backend");
check("the failure names the hook", /Pre-commit hook failed/.test(text(backendRow)), text(backendRow));
check("the hook output is shown", /eslint found 2 errors/.test(text(backendRow)), text(backendRow));
const box = (name) => q(`input[aria-label="Push ${name}"]`, dialog);
check("admin, services and shop-pos are ticked", ["admin", "shop-mobile", "shop-pos"].every((n) => box(n)?.checked), ["admin", "shop-mobile", "shop-pos"].map((n) => box(n)?.checked).join(","));
// shop-mobile is on main, a live branch: the push stays disabled until its name is typed
await typeInto(await waitFor(() => q('input[aria-label^="Type main to push shop-mobile"]', dialog), { what: "live-branch confirmation field" }), "main");
await clickButton("Push (3 repos)", dialog);
await waitFor(() => !qa('[role="dialog"]').includes(dialog), { what: "push dialog to close", timeout: 60000 });
await waitFor(() => /Push results/.test(text(sheet())) && !/Pushing|Queued/.test(Object.values(sheetRows()).join(" ")), { what: "push results", timeout: 60000 });
const afterPush = sheetRows();
notes.afterPush = afterPush;
check("services pushed", afterPush["shop-mobile"] === "Done", afterPush["shop-mobile"]);
check("shop-pos pushed", afterPush["shop-pos"] === "Done", afterPush["shop-pos"]);
check("admin push failed", afterPush["admin"] === "Failed", afterPush["admin"]);
const adminRow = sheetRow("admin");
check("admin failure says the remote has new commits", /Remote has new commits/.test(text(adminRow)), text(adminRow));
check("admin offers Pull then push", !!findButton("Pull then push", adminRow));

// retry the backend commit: the hook passes the second time, then the push dialog comes up again
await clickButton("Retry", sheetRow("shop-backend"), "Retry (backend)");
const dialog2 = await waitFor(() => qa('[role="dialog"]').find((d) => q('[role="tree"][aria-label="Repositories and outgoing commits"]', d)), { what: "push dialog after the retry", timeout: 60000 });
await waitFor(() => q('input[aria-label="Push shop-backend"]', dialog2)?.checked, { what: "backend ticked in the dialog" });
check("only backend is ticked after the retry", ["admin", "shop-mobile", "shop-pos"].every((n) => !q(`input[aria-label="Push ${n}"]`, dialog2)?.checked));
await clickButton("Push", dialog2);
await waitFor(() => !qa('[role="dialog"]').includes(dialog2), { what: "second push dialog to close", timeout: 60000 });
await waitFor(() => sheetRows()["shop-backend"] === "Done" && /Pushed|Up to date|New branch/.test(text(sheetRow("shop-backend"))), { what: "backend pushed", timeout: 60000 });

// admin: pull the other clone's commit, then push again
await clickButton("Pull then push", sheetRow("admin"));
await waitFor(() => sheetRows()["admin"] === "Done" && /Pushed|Up to date/.test(text(sheetRow("admin"))), { what: "admin pushed after the pull", timeout: 60000 });
notes.final = sheetRows();
check("everything is Done at the end", Object.values(sheetRows()).every((s) => s === "Done"), JSON.stringify(sheetRows()));
await finish();

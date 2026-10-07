// Shot tour on the failures fixture: the results sheet with a failed hook, a failed push and a retry offer.
await window.__e2e.resize(1440, 900);
await waitForTree();
await sharedMessage("e2e: failures message");
await chooseMenuItem("More commit actions", "Commit and Push", q(".commit-panel__actions"));
const dialog = await waitFor(pushDialog, { what: "push dialog", timeout: 60000 });
await waitFor(() => qa("[data-key^='repo:']", dialog).length === 4, { what: "4 repos" });
await sleep(300);
await typeInto(await waitFor(() => q('input[aria-label^="Type main to push shop-mobile"]', dialog), { what: "live-branch confirmation field" }), "main"); // services is on main, a live branch
await clickButton("Push (3 repos)", dialog);
await waitFor(() => !pushDialog(), { what: "dialog to close", timeout: 60000 });
await waitFor(() => /Push results/.test(text(sheet())) && sheetSettled(), { what: "push results", timeout: 60000 });
await sleep(500);
const shots = await both("results-failure");
// the expanded failure output of the backend commit
const backend = sheetRow("shop-backend");
const toggle = backend && qa("button", backend).find((b) => b.hasAttribute("aria-expanded"));
if (toggle) { toggle.click(); await sleep(400); shots.push(...(await both("results-output"))); }
notes.shots = shots;
notes.rows = sheetRows();
await finish();

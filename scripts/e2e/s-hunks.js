// (s) Hunk staging in the real window: select a file with three separate edits, open "Choose hunks to commit" from its Diff
// toolbar, un-pick the middle hunk, commit with a typed message. The commit goes through the temp-index path: run.sh checks in
// git that HEAD holds hunks one and three only, the working tree keeps all three, and only hunk two is left to commit.
await waitForTree();
const BE = "shop-backend";
const FILE = "src/lib/long.js";
for (const id of FX.repoIds) await untickRepo(id);
await setTick(fileRowSel(BE, FILE), "true", FILE);
const row = await waitFor(() => findRow(fileRowSel(BE, FILE)), { what: "the long.js row" });
row.click(); // select it: its diff opens in the centre
const hunkBtn = await waitFor(() => qa("button").find((b) => b.getAttribute("aria-label") === "Choose hunks to commit"), { what: "the 'Choose hunks to commit' button in the Diff toolbar", timeout: 20000 });
check("the Diff toolbar offers 'Choose hunks to commit'", true);
await snap("hunks-diff");
hunkBtn.click();
const tab = await waitFor(() => q(`section[aria-label="Hunks of ${FILE}"]`), { what: "the Hunks tab", timeout: 20000 });
await waitFor(() => qa('input[type="checkbox"][aria-label^="Include hunk"]', tab).length === 3, { what: "three hunks", timeout: 15000 });
const box = (n) => q(`input[type="checkbox"][aria-label="Include hunk ${n} in the commit"]`, tab);
check("three hunks, all included at first", [1, 2, 3].every((n) => box(n).checked), qa('input[type="checkbox"]', tab).map((b) => b.checked).join(","));
check("the headers name the old and new lines", qa(".ghunk__header", tab).every((h) => /^@@ -\d+/.test(text(h))), qa(".ghunk__header", tab).map(text).join(" | "));
box(2).click();
await waitFor(() => !box(2).checked && box(1).checked && box(3).checked, { what: "hunk two to be un-picked", timeout: 10000 });
check("un-picking hunk two leaves one and three included", true);
await waitFor(async () => tick(await findRow(fileRowSel(BE, FILE))) === "mixed", { what: "the file's tick to show a partial selection", timeout: 10000 }).catch(() => undefined);
notes.fileTick = tick(await findRow(fileRowSel(BE, FILE)));
check("the file's tick in the tree shows the partial selection (mixed)", notes.fileTick === "mixed", notes.fileTick);
await snap("hunks-partial");
await sharedMessage("e2e: hunks one and three");
check("the commit button counts one repo, one file", /1 repo, 1 file/.test(text(commitButton())), text(commitButton()));
commitButton().click();
await waitFor(sheetSettled, { what: "the commit result", timeout: 60000 });
check("the backend row says committed", /ommit|Done/.test(sheetRows()["shop-backend"] ?? ""), JSON.stringify(sheetRows()));
await snap("hunks-committed");
// the hunk that was not picked is still a change of the file
await waitFor(async () => (await invoke("snapshot_get", { repoId: BE })).changes.some((c) => c.path === FILE), { what: "long.js to stay a change after the partial commit", timeout: 20000 });
check("after the partial commit long.js is still a change (hunk two)", true);
const hunks = await invoke("file_hunks", { repoId: BE, path: FILE, source: "workingTree" }).catch((e) => ({ error: String(e?.message ?? e) }));
notes.hunksLeft = JSON.stringify(hunks).slice(0, 300);
await finish();

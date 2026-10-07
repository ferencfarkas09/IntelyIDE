// (o) Project tree on a fixture repo, like a user: New file / New folder via the context menu, a name that already exists
// and an invalid one, Rename (and the refusal while a tab is dirty), Move to Trash (confirm dialog; the app's own Trash dir
// under the harness), a Trash that fails (reported in a toast, not hidden), Reveal in Finder (logged under the harness).
await waitForTree();
await openRail("Project");
const proj = await waitFor(() => q('section[aria-label="Project"]'), { what: "the Project panel" });
await waitTreeItem(BACKEND, proj, 20000);
const rootRow = () => treeItem(BACKEND, proj);
const root = rootRow();
if (root.getAttribute("aria-expanded") !== "true") root.click();
await waitFor(() => treeItem("src", proj), { what: "the src folder below the backend root", timeout: 20000 });
check("the backend root lists its folders", !!treeItem("src", proj) && !!treeItem("package.json", proj), qa('[role="treeitem"]', proj).map((i) => text(i)).slice(0, 8).join(" | "));

// ---- New file --------------------------------------------------------------------------------------------------------
await chooseContext(rootRow, "New file…");
await answerPrompt(/New file/, "e2e-new.txt", "Create");
const created = await waitTreeItem("e2e-new.txt", proj);
check("New file: the row appears in the tree", !!created);
await waitFor(() => qa('[role="tab"]').some((t) => /e2e-new\.txt/.test(text(t))), { what: "the new file open in a tab", timeout: 10000 });
check("New file: it opens in the editor", true);
await snap("tree-new-file");

// ---- a name that exists, and an invalid one --------------------------------------------------------------------------------
await chooseContext(rootRow, "New file…");
let d = await waitDialog(/New file/);
await typeInto(q("input", d), "e2e-new.txt");
await clickButton("Create", d);
await waitToast(/already exists/i, "'already exists'");
check("New file: an existing name is refused with a toast", true, toastText());
await sleep(200);
await chooseContext(rootRow, "New file…");
d = await waitDialog(/New file/);
await typeInto(q("input", d), "a/b.txt");
await sleep(150);
check("New file: a name with a slash is flagged and Create stays disabled", !!findButton("Create", d)?.disabled, text(d).slice(0, 200));
await press("Escape", {}, q("input", d));
await dialogGone(d);

// ---- New folder ------------------------------------------------------------------------------------------------------
await chooseContext(rootRow, "New folder…");
await answerPrompt(/New folder/, "e2e-dir", "Create");
await waitTreeItem("e2e-dir", proj);
check("New folder: the row appears", true);

// ---- Rename ----------------------------------------------------------------------------------------------------------
// a dirty tab blocks it
const tabNow = () => qa('[role="tab"]').find((t) => /e2e-new\.txt/.test(text(t)));
const cm = await waitFor(() => q(".file-tab__cm .cm-content"), { what: "the editor of the new file" });
cm.focus();
document.execCommand("insertText", false, "hello from e2e\n");
await waitFor(() => !!q('[aria-label="Unsaved changes"]', tabNow() ?? document.body), { what: "the dirty marker", timeout: 5000 });
await chooseContext(() => treeItem("e2e-new.txt", proj), "Rename…");
await waitToast(/Save or close first/i, "'Save or close first'");
check("Rename: refused while the file has unsaved changes", true, toastText());
await press("s", { meta: true }, cm);
await waitFor(() => !q('[aria-label="Unsaved changes"]', tabNow() ?? document.body), { what: "the file to be saved", timeout: 10000 });
await chooseContext(() => treeItem("e2e-new.txt", proj), "Rename…");
await answerPrompt(/Rename/, "e2e-renamed.txt", "Rename");
await waitTreeItem("e2e-renamed.txt", proj);
await waitFor(() => !treeItem("e2e-new.txt", proj), { what: "the old name to disappear" });
check("Rename: the row shows the new name, the old one is gone", !!treeItem("e2e-renamed.txt", proj) && !treeItem("e2e-new.txt", proj));
await waitFor(() => qa('[role="tab"]').some((t) => /e2e-renamed\.txt/.test(text(t))), { what: "the tab to follow the rename", timeout: 10000 });
check("Rename: the open tab follows to the new name", !qa('[role="tab"]').some((t) => /e2e-new\.txt/.test(text(t))));

// ---- Reveal ----------------------------------------------------------------------------------------------------------
await chooseContext(() => treeItem("e2e-renamed.txt", proj), "Reveal in Finder");
await sleep(400);
check("Reveal in Finder raised no error toast", !toastList().some((t) => /Finder/.test(t.title)), toastText());

// ---- Move to Trash: a file (confirm dialog), and a failing one --------------------------------------------------------------
await chooseContext(() => treeItem("e2e-renamed.txt", proj), "Move to Trash…");
d = await waitDialog(/Move e2e-renamed\.txt to the Trash/);
check("Trash: the confirmation names the file and says it is restorable", /restore it from the Trash/i.test(text(d)), text(d).slice(0, 200));
await snap("tree-trash-confirm");
await clickButton("Move to Trash", d);
await dialogGone(d);
await waitFor(() => !treeItem("e2e-renamed.txt", proj), { what: "the trashed row to disappear", timeout: 10000 });
check("Trash: the row is gone and its tab closed", !qa('[role="tab"]').some((t) => /e2e-renamed\.txt/.test(text(t))));

// a file that vanished between the menu and the confirmation: the failure is a visible toast
await chooseContext(rootRow, "New file…");
await answerPrompt(/New file/, "e2e-ghost.txt", "Create");
await waitTreeItem("e2e-ghost.txt", proj);
await chooseContext(() => treeItem("e2e-ghost.txt", proj), "Move to Trash…");
d = await waitDialog(/Move e2e-ghost\.txt to the Trash/);
await invoke("files_trash_entry", { repoId: FX.repoIds[0], relPath: "e2e-ghost.txt" }); // gone behind the dialog's back
await clickButton("Move to Trash", d);
await waitToast(/Could not move e2e-ghost\.txt to the Trash/, "the Trash failure");
check("Trash: a failure is reported in a toast, not swallowed", toastList().some((t) => t.tone === "danger" && /Trash/.test(t.title)), toastText());
await waitFor(() => !treeItem("e2e-ghost.txt", proj), { what: "the vanished entry to leave the tree after the failed Trash", timeout: 8000 });
check("Trash: after the failure the tree drops the vanished entry", true);
notes.toastRect = JSON.stringify(q(".ui-toast")?.getBoundingClientRect());
await sleep(300);
await snap("tree-trash-failure");

// a folder with a file in it goes whole
await chooseContext(() => treeItem("e2e-dir", proj), "New file…");
await answerPrompt(/New file/, "inner.txt", "Create");
await waitTreeItem("inner.txt", proj);
await chooseContext(() => treeItem("e2e-dir", proj), "Move to Trash…");
d = await waitDialog(/Move e2e-dir to the Trash/);
check("Trash: a folder says everything in it moves", /everything in it/i.test(text(d)), text(d).slice(0, 200));
await clickButton("Move to Trash", d);
await dialogGone(d);
await waitFor(() => !treeItem("e2e-dir", proj), { what: "the trashed folder to disappear", timeout: 10000 });
check("Trash: the folder row is gone", true);
await finish();

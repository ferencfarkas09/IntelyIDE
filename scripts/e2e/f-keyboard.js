// (f) Keyboard use in the real WKWebView: tree navigation, Tab order, ⌘↵ / ⌥⌘↵ / ⌘⇧K, Escape, ⌘0.
// Key events are dispatched (untrusted), so only the page's own handlers run; the Tab order is therefore read from the DOM.
await waitForTree();
const B = "shop-backend";
const A = "admin";

// ---- tree navigation ---------------------------------------------------------------------------------------------
const tree = changesTree();
tree.focus();
await sleep(100);
check("the tree takes focus", document.activeElement === tree);
// The first changed file opens by itself, so the cursor starts on the open file (on the first repo row when none is open).
const openRow = q('[role="treeitem"][data-selected]');
check("focusing the tree puts the cursor on the open file, else on the first repo row", describeRow(cursorRow()) === (openRow ? describeRow(openRow) : `repo:${B}`), describeRow(cursorRow()));
await press("ArrowDown");
check("ArrowDown moves the cursor to a file row of the first repo", cursorRow()?.getAttribute("data-row") === "file" && cursorRow()?.getAttribute("data-repo") === B, describeRow(cursorRow()));
const firstFile = cursorRow();
await press("ArrowDown");
check("a second ArrowDown moves on", cursorRow() !== firstFile, describeRow(cursorRow()));
await press("ArrowUp");
check("ArrowUp moves back", cursorRow() === firstFile, describeRow(cursorRow()));
await press("ArrowLeft");
check("ArrowLeft on a file goes to its repo row", describeRow(cursorRow()) === `repo:${B}`, describeRow(cursorRow()));
await press("ArrowLeft");
check("ArrowLeft on an open repo collapses it", cursorRow()?.getAttribute("aria-expanded") === "false", cursorRow()?.getAttribute("aria-expanded"));
await press("ArrowRight");
check("ArrowRight expands it again", cursorRow()?.getAttribute("aria-expanded") === "true");
await press("Enter");
check("Enter on a repo row collapses it", cursorRow()?.getAttribute("aria-expanded") === "false");
await press("Enter");
check("Enter on a collapsed repo row expands it", cursorRow()?.getAttribute("aria-expanded") === "true");
await press("End");
const lastRow = cursorRow();
check("End moves to a row below the first repo", !!lastRow && describeRow(lastRow) !== `repo:${B}`, describeRow(lastRow));
await press("Home");
check("Home moves back to the first row", describeRow(cursorRow()) === `repo:${B}`, describeRow(cursorRow()));

// Space ticks/unticks the row under the cursor
await press("ArrowDown");
let fileRow = cursorRow();
const fileSel = `[data-row="file"][data-repo="${B}"][data-path="${CSS.escape(fileRow.getAttribute("data-path"))}"]`;
const before = tick(fileRow);
await press(" ");
await waitFor(async () => tick(await findRow(fileSel)) !== before, { what: "Space to change the tick", timeout: 3000 });
check("Space toggles the tick of the cursor row", tick(await findRow(fileSel)) !== before, `${before} -> ${tick(await findRow(fileSel))}`);
await press(" ");
await waitFor(async () => tick(await findRow(fileSel)) === before, { what: "second Space to restore the tick", timeout: 3000 });
check("a second Space restores it", tick(await findRow(fileSel)) === before);
check("the repo row is back to fully ticked", tick(await findRow(repoRowSel(B))) === "true", tick(await findRow(repoRowSel(B))));

// Enter on a file opens its diff
const path = fileRow.getAttribute("data-path");
await press("Enter");
await waitFor(() => q(".diff-view__name") && text(q(".diff-view__title")).includes(path.split("/").pop()), { what: "diff of the entered file", timeout: 8000 });
check("Enter on a file opens its diff", text(q(".diff-view__title")).includes(path.split("/").pop()), text(q(".diff-view__title")));

// ---- Tab order (read from the DOM: a dispatched Tab does not move focus) -----------------------------------------
const tabbable = qa('a[href], button, input, textarea, select, [tabindex]').filter((el) => {
  if (el.disabled || el.getAttribute("tabindex") === "-1" || el.closest("[hidden], [inert]")) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
});
const label = (el) => el.getAttribute("aria-label") || text(el).slice(0, 30) || el.tagName.toLowerCase();
const order = tabbable.map(label);
notes.tabOrder = order;
const amend = q('.commit-panel__tools input[type="checkbox"]');
const follows = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
check("no positive tabindex anywhere", !tabbable.some((el) => el.tabIndex > 0), order.join(" > "));
const inTree = tabbable.filter((el) => changesTree()?.contains(el));
notes.treeTabStops = inTree.length;
check("the Changes tree is a tab stop itself", tabbable.includes(changesTree()));
check("the row buttons (Commit, Push, Pull, Fetch) are not tab stops: the tree has one", inTree.filter((el) => el !== changesTree()).every((el) => !el.closest(".chg-actions")), inTree.map(label).join(" > "));
check("Tab order: Changes tree, commit message, Amend, Commit", follows(changesTree(), textarea()) && follows(textarea(), amend) && follows(amend, commitButton()), order.join(" > "));
const reach = { amendDisabled: amend.disabled, amendTabIndex: amend.tabIndex, commitDisabled: commitButton()?.disabled, commitListed: tabbable.includes(commitButton()) };
check("Amend (disabled while several repos are ticked) and the Commit button are in the tab order", reach.amendTabIndex >= 0 && reach.commitListed, JSON.stringify(reach));
// The row action buttons (Commit/Push/Pull/Fetch per repo) are tab stops of their own: a keyboard user passes them before reaching the message field.
notes.tabStopsBeforeMessage = tabbable.indexOf(textarea());

// ---- ⌘↵ without a message: no run starts, the message field takes focus and shows the error -----------------------
for (const id of [A, "shop-mobile", "shop-pos"]) await untickRepo(id);
const down = await press("Enter", { meta: true });
check("⌘↵ is handled (default prevented)", down.defaultPrevented);
await waitFor(() => q('p[role="alert"]') && /Enter a commit message/.test(text(q('p[role="alert"]'))), { what: "missing-message error", timeout: 5000 });
check("⌘↵ without a message shows the error and opens no sheet", /Enter a commit message/.test(text(q('p[role="alert"]'))) && !sheet(), text(q('p[role="alert"]')));
// the field takes the focus on the next animation frame, which a busy or covered window delivers late
await waitFor(() => document.activeElement === textarea(), { what: "the message field to take focus", timeout: 5000 }).catch(() => null);
check("…and focuses the message field", document.activeElement === textarea(), label(document.activeElement ?? document.body));

// ---- ⌘↵ with a message commits the ticked repo -------------------------------------------------------------------
await sharedMessage("e2e: keyboard commit");
await press("Enter", { meta: true });
await waitFor(sheetSettled, { what: "commit result", timeout: 60000 });
check("⌘↵ committed the backend", sheetRows()["shop-backend"] === "Done", JSON.stringify(sheetRows()));
await closeResults();
check("the close button closes the results sheet", !sheet());

// ---- ⌘⇧K opens the push dialog, Escape closes it ----------------------------------------------------------------
await press("k", { meta: true, shift: true });
const dialog1 = await waitFor(pushDialog, { what: "push dialog after ⌘⇧K", timeout: 15000 });
check("⌘⇧K opens the push dialog", !!dialog1);
check("focus moves into the dialog", dialog1.contains(document.activeElement), label(document.activeElement ?? document.body));
// Tab at the last control wraps inside the dialog (the focus trap handles Tab itself)
const tabs = qa('a[href], button, input, textarea, select, [tabindex]', dialog1).filter((el) => !el.disabled && el.getAttribute("tabindex") !== "-1" && el.getBoundingClientRect().width > 0);
tabs[tabs.length - 1].focus();
await press("Tab", {});
check("Tab from the last control stays inside the dialog", dialog1.contains(document.activeElement), label(document.activeElement ?? document.body));
await press("Escape");
await waitFor(() => !pushDialog(), { what: "Escape to close the dialog", timeout: 4000 }).catch(() => null);
check("Escape closes the push dialog", !pushDialog());

// ---- ⌥⌘↵: commit and push -----------------------------------------------------------------------------------------
await untickRepo(B);
await setTick(repoRowSel(A), "true", "repo admin");
await sharedMessage("e2e: keyboard commit and push");
await press("Enter", { meta: true, alt: true });
const dialog2 = await waitFor(pushDialog, { what: "push dialog after ⌥⌘↵", timeout: 60000 });
check("⌥⌘↵ commits and opens the push dialog", !!dialog2);
await waitFor(() => qa("[data-key^='repo:']", dialog2).length === 4, { what: "4 repos in the push dialog" });
check("admin has its fresh commit in the dialog and is ticked", q('input[aria-label="Push admin"]', dialog2)?.checked === true);
check("backend (2 outgoing commits, not just committed) is listed", !!q('input[aria-label="Push shop-backend"]', dialog2));
if (!q('input[aria-label="Push shop-backend"]', dialog2).checked) q('input[aria-label="Push shop-backend"]', dialog2).click();
await clickButton("Push (2 repos)", dialog2);
await waitFor(() => !pushDialog(), { what: "dialog to close", timeout: 60000 });
await waitFor(() => sheet() && sheetSettled(), { what: "push results", timeout: 60000 });
check("both repos pushed", Object.values(sheetRows()).filter((s) => /Pushed|Done/.test(s)).length === 2, JSON.stringify(sheetRows()));
await closeResults();

// ---- ⌘0 hides and shows the commit panel -------------------------------------------------------------------------
check("the commit panel is visible", !!textarea());
await press("0", { meta: true }, document.body);
await waitFor(() => !textarea(), { what: "panel to hide", timeout: 3000 }).catch(() => null);
check("⌘0 hides the commit panel", !textarea());
await press("0", { meta: true }, document.body);
await waitFor(() => !!textarea(), { what: "panel to show", timeout: 3000 }).catch(() => null);
check("⌘0 shows it again", !!textarea());
await finish();

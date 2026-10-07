// Shot tour on the default fixture: tree, diff (unified and split), About, hover/focus, per-repo messages, theme menu, push dialog, force-push confirmation, window sizes.
const B = "shop-backend";
const A = "admin";
const SV = "shop-mobile";
const shots = [];
const snap = async (name) => shots.push(...(await both(name)));

notes.size = await window.__e2e.resize(1440, 900);
await waitForTree();
await sleep(400);
await snap("tree");

// a file selected: its diff beside the list
const file = await waitFor(() => findRow(fileRowSel(B, "src/api/orders.js")), { what: "orders.js row" });
file.click();
await waitFor(() => q(".diff-view__host") && !q(".diff-view__host").hidden && q(".diff-view__host .cm-content"), { what: "diff", timeout: 15000 });
await sleep(600);
await snap("diff-1440x900");

// the split layout, then back to unified
const layoutOption = (name) => qa('[role="radio"]').find((r) => text(r) === name);
layoutOption("Split").click();
await waitFor(() => q(".diff-view__host .cm-mergeView"), { what: "split diff", timeout: 15000 });
await sleep(600);
await snap("diff-split");
layoutOption("Unified").click();
await waitFor(() => !q(".diff-view__host .cm-mergeView") && q(".diff-view__host .cm-content"), { what: "unified diff", timeout: 15000 });
await sleep(400);

// repo-row hover, and the keyboard cursor ring
const undo = forceHover(await findRow(repoRowSel(A)));
await sleep(150);
await snap("repo-hover");
undo();
changesTree().focus();
await press("ArrowDown", {}, changesTree());
await press("ArrowDown", {}, changesTree());
await snap("keyboard-focus");

// the Theme menu
const themeButton = qa("button").find((b) => /^Theme:/.test(b.getAttribute("aria-label") ?? ""));
themeButton.click();
await waitFor(() => qa('[role^="menuitem"]').length >= 3, { what: "theme menu" });
await sleep(200);
await snap("theme-menu");
await press("Escape");
await waitFor(() => qa('[role^="menuitem"]').length === 0, { what: "menu to close", timeout: 3000 }).catch(() => null);
document.activeElement?.blur(); // focus returned to the trigger, which would keep its tooltip and ring in the next shots
await sleep(300);

// the About dialog
qa("button").find((b) => b.getAttribute("aria-label") === "About IntelyIDE").click();
await waitFor(() => qa('[role="dialog"]').find((d) => /About IntelyIDE/.test(text(d))), { what: "About dialog" });
await sleep(500);
await snap("about");
await press("Escape");
await waitFor(() => !qa('[role="dialog"]').some((d) => /About IntelyIDE/.test(text(d))), { what: "About dialog to close", timeout: 3000 }).catch(() => null);
document.activeElement?.blur();
await sleep(300);

// window size pair
notes.small = await window.__e2e.resize(1100, 700);
await snap("diff-1100x700");
notes.size = await window.__e2e.resize(1440, 900);

// per-repo message mode
await useMode("Per repo");
const field = async (name) => (await waitFor(() => findRow(`[role="treeitem"][aria-label="Commit message for ${name}"]`), { what: `message row of ${name}` })) && q(`textarea[aria-label="Commit message for ${name}"]`);
await typeInto(await field("shop-backend"), "feat(orders): add coupon support\n\nValidates the code before it reaches the cart.");
await typeInto(await field("admin"), "fix: Árvíztűrő tükörfúrógép menü");
await sleep(300);
await snap("per-repo-message");
await useMode("Shared");

// commit + push: the push dialog with the protected branch of shop-mobile, then the force-push confirmation
await ticksOnly(SV);
await sharedMessage("chore: tidy up the services app");
await chooseMenuItem("More commit actions", "Commit and Push", q(".commit-panel__actions"));
const dialog = await waitFor(pushDialog, { what: "push dialog", timeout: 60000 });
await waitFor(() => qa("[data-key^='repo:']", dialog).length === 4, { what: "4 repos" });
await sleep(500);
await snap("push-dialog");
await typeInto(await waitFor(() => q('input[aria-label^="Type main to push shop-mobile"]', dialog), { what: "live-branch confirmation field" }), "main"); // services is on main, a live branch
await chooseMenuItem("More push actions", "Force push", dialog);
const force = await waitFor(() => qa('[role="alertdialog"]').find((d) => /Force push with lease/.test(text(d))), { what: "force dialog" });
await typeInto(await waitFor(() => q('input[aria-label^="Type main"]', force), { what: "typed confirmation" }), "ma");
await sleep(300);
await snap("force-confirm");
await clickButton("Cancel", force);
await waitFor(() => !force.isConnected || getComputedStyle(force).display === "none" || !qa('[role="alertdialog"]').includes(force), { what: "force dialog to close", timeout: 3000 }).catch(() => null);
await clickButton("Cancel", pushDialog());
await waitFor(() => !pushDialog(), { what: "push dialog to close", timeout: 5000 });
await sleep(300);
await snap("after-commit");
notes.shots = shots;
await finish();

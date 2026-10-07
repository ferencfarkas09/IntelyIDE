// (b) Tick files in two repos, one shared message, Commit: exactly the ticked files are committed (run.sh asserts it through git).
await waitForTree();
const B = "shop-backend";
const A = "admin";

// services and shop-pos: nothing ticked
await untickRepo("shop-mobile");
await untickRepo("shop-pos");

// backend: two tracked files stay out, two untracked ones (one with a non-ASCII name) go in
await setTick(fileRowSel(B, "src/lib/db.js"), "false");
await setTick(fileRowSel(B, "test/orders.test.js"), "false");
await expandRow(unversionedSel(B));
await setTick(fileRowSel(B, "src/api/receipts.js"), "true");
await setTick(fileRowSel(B, "docs/árvíztűrő-tükörfúrógép.md"), "true");

// admin: one tracked file stays out, the untracked folder with 10 files goes in (listed lazily)
await setTick(fileRowSel(A, "src/index.tsx"), "false");
await expandRow(unversionedSel(A));
await setTick(dirRowSel(A, "src/components/pages/loyalty/"), "true");

await sharedMessage("e2e: shared message");
const label = text(commitButton());
check("button counts 2 repos", /2 repos/.test(label), label);
notes.commitLabel = label;
commitButton().click();

await waitFor(() => sheet() && Object.keys(sheetRows()).length >= 2 && Object.values(sheetRows()).every((s) => !/Queued|Running|Committing|Preparing|Updating/.test(s)), { what: "commit results", timeout: 60000 });
const rows = sheetRows();
notes.sheet = rows;
check("backend committed", rows["shop-backend"] === "Committed" || rows["shop-backend"] === "Done" || /ommit/.test(rows["shop-backend"] ?? ""), rows["shop-backend"]);
check("admin committed", /ommit|Done/.test(rows["admin"] ?? ""), rows["admin"]);
check("only two repos in the results", Object.keys(rows).length === 2, Object.keys(rows).join(","));
// once the engine's snapshots arrive the committed files leave the tree
await waitFor(async () => text(q(`${repoRowSel(B)} .chg-count`)) === String(FX.counts[B] - 9 + 0), { what: "backend count to drop", timeout: 15000 }).catch(() => undefined);
notes.countsAfter = Object.fromEntries(FX.repoIds.map((id) => [id, text(q(`${repoRowSel(id)} .chg-count`))]));
await finish();

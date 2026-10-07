// (e) The guard: a never-add directory and a secret file cannot be ticked, selected through "Unversioned", or committed.
await waitForTree();
const B = "shop-backend";
for (const id of ["admin", "shop-mobile", "shop-pos"]) await untickRepo(id);

await expandRow(unversionedSel(B));
const env = await waitFor(() => findRow(fileRowSel(B, ".env")), { what: ".env row" });
const dump = await waitFor(() => findRow(dirRowSel(B, "dump_2026-09-30/")), { what: "dump_* row" });
check(".env is locked", env.getAttribute("aria-disabled") === "true" && rowBox(env).disabled, `${env.getAttribute("aria-disabled")} ${rowBox(env).disabled}`);
check("dump_* is locked", dump.getAttribute("aria-disabled") === "true" && rowBox(dump).disabled, `${dump.getAttribute("aria-disabled")} ${rowBox(dump).disabled}`);
check(".env shows a lock icon", !!q(".chg-lock", env));
rowBox(env).click();
rowBox(dump).click();
env.click();
dump.click();
await sleep(300);
check(".env stays unticked after clicks", tick(await findRow(fileRowSel(B, ".env"))) === "false");
check("dump_* stays unticked after clicks", tick(await findRow(dirRowSel(B, "dump_2026-09-30/"))) === "false");

// "select all unversioned" skips what is guarded
rowBox(await findRow(unversionedSel(B))).click();
await waitFor(async () => tick(await findRow(fileRowSel(B, "src/api/receipts.js"))) === "true", { what: "Unversioned to tick the allowed files" });
check(".env is still unticked after Unversioned was ticked", tick(await findRow(fileRowSel(B, ".env"))) === "false");
check("dump_* is still unticked after Unversioned was ticked", tick(await findRow(dirRowSel(B, "dump_2026-09-30/"))) === "false");
check("receipts.js got ticked", tick(await findRow(fileRowSel(B, "src/api/receipts.js"))) === "true");
check("the Hungarian-named file got ticked", tick(await findRow(fileRowSel(B, "docs/árvíztűrő-tükörfúrógép.md"))) === "true");

// the engine refuses a request that names guarded paths even if the UI is bypassed
let rejection;
try {
  await invoke("commit_start", { req: { runId: "e2e-bypass", repos: [{ repoId: B, files: [{ path: ".env", mode: "whole" }], message: "bypass", amend: false }], noVerify: false } });
} catch (e) {
  rejection = e;
}
check("commit_start rejects .env with guardBlocked", rejection?.code === "guardBlocked", JSON.stringify(rejection));
let rejectionDir;
try {
  await invoke("commit_start", { req: { runId: "e2e-bypass-dir", repos: [{ repoId: B, files: [{ path: "dump_2026-09-30/orders.json", mode: "whole" }], message: "bypass", amend: false }], noVerify: false } });
} catch (e) {
  rejectionDir = e;
}
check("commit_start rejects dump_*/ files with guardBlocked", rejectionDir?.code === "guardBlocked", JSON.stringify(rejectionDir));

await sharedMessage("e2e: guard");
const label = text(commitButton());
notes.commitLabel = label;
check("the commit counts only allowed files (9 tracked + 2 untracked)", /1 repo, 11 files/.test(label), label);
commitButton().click();
await waitFor(() => sheet() && sheetRows()["shop-backend"] && sheetRows()["shop-backend"] !== "Queued" && !/ing/.test(sheetRows()["shop-backend"]), { what: "commit result", timeout: 60000 });
check("backend committed", sheetRows()["shop-backend"] === "Done", sheetRows()["shop-backend"]);
await finish();

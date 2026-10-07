// (a) The tree shows the four repos with the expected change counts, branches and ahead/behind.
await waitForTree();
notes.workspace = await invoke("workspace_get");
notes.storage = Object.keys(localStorage);
const rows = {};
for (const id of FX.repoIds) {
  const row = q(repoRowSel(id));
  rows[id] = { count: text(q(".chg-count", row)), text: text(row) };
  check(`${id}: ${FX.counts[id]} changes`, rows[id].count === String(FX.counts[id]), `shows "${rows[id].count}"`);
  check(`${id}: branch ${FX.branches[id]}`, rows[id].text.includes(FX.branches[id]), rows[id].text);
}
check("4 repo rows", qa('[data-row="repo"]').length === 4);
const ahead = (id) => q(`${repoRowSel(id)} [aria-label*="ahead"]`)?.getAttribute("aria-label") ?? "";
check("backend and admin are 1 ahead", /^1\b/.test(ahead("shop-backend")) && /^1\b/.test(ahead("admin")), `${ahead("shop-backend")} / ${ahead("admin")}`);
check("services and shop-pos are in sync", ahead("shop-mobile") === "" && ahead("shop-pos") === "");
check("tracked files are ticked by default", tick(q(repoRowSel("shop-pos"))) === "true" || tick(q(repoRowSel("shop-pos"))) === "mixed", tick(q(repoRowSel("shop-pos"))));
check("window has the overlay title bar", !!q(".ui-titlebar"));
const fonts = [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family);
check("self-hosted fonts loaded", fonts.some((f) => /Inter/.test(f)), fonts.join(","));
// the strict CSP must not block the styles the components set inline
const inlineStyled = q('[data-row="repo"]');
check("inline styles work under the CSP", inlineStyled && getComputedStyle(inlineStyled).position === "absolute", inlineStyled && getComputedStyle(inlineStyled).position);

// the diff view loads real file contents through the engine (CodeMirror is a lazy chunk)
const B = "shop-backend";
(await findRow(fileRowSel(B, "src/api/orders.js"))).click();
const cm = await waitFor(() => q(".cm-editor") && /exports\.cancel/.test(text(q(".cm-editor"))) && q(".cm-editor"), { what: "diff of orders.js", timeout: 20000 }).catch(() => null);
check("selecting a file shows its diff", !!cm, text(q("main, .centre")).slice(0, 200));
// a secret file shows a placeholder, never its contents
await expandRow(unversionedSel(B));
(await findRow(fileRowSel(B, ".env"))).click();
await waitFor(() => !/exports\.cancel/.test(text(q(".centre, main"))), { what: "the diff to switch away" }).catch(() => undefined);
await sleep(500);
const shown = text(q(".centre, main"));
check("a secret file's contents are not shown", !/DATABASE_URL|postgres:/.test(shown), shown.slice(0, 200));
await finish({ rows });

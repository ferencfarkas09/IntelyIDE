// (lic) Open-source licenses view in the real window: command palette -> dialog, search, select a component, copy-only
// link policy, Escape closes, and the About dialog button opens the same view. No network: the data ships in the bundle.
await waitForTree();
const dialogs = () => qa('[role="dialog"]');
const licDialog = () => dialogs().find((d) => /Open-source licenses/.test(text(d)) && q('[role="listbox"]', d));

await press("p", { meta: true, shift: true });
const palette = await waitFor(() => q(".palette"), { what: "the command palette" });
const field = await waitFor(() => q('[role="combobox"]', palette), { what: "the palette search field" });
await typeInto(field, "open-source licenses");
await waitFor(() => /Show open-source licenses/.test(text(q('[role="option"]', palette))), { what: "the licenses command as first hit" });
check("the palette finds Show open-source licenses", /Show open-source licenses/.test(text(q('[role="option"]', palette))), text(q('[role="option"]', palette)));
await press("Enter", {}, field);
const dlg = await waitFor(licDialog, { what: "the licenses dialog", timeout: 20000 });
const rows = await waitFor(() => { const n = qa('[role="option"]', dlg).length; return n > 3 ? n : null; }, { what: "component rows" });
check("the list renders virtualized rows", rows > 3, String(rows));
check("the project row (GPL-3.0-or-later) is listed", /GPL-3\.0-or-later/.test(text(dlg)), text(dlg).slice(0, 200));

const search = q('input[aria-label="Search open-source components"]', dlg);
await typeInto(search, "serde");
await waitFor(() => /serde/i.test(text(q('[role="option"]', dlg) ?? document.body)), { what: "serde in the filtered list" });
const first = q('[role="option"]', dlg);
check("search narrows the list to serde", /serde/i.test(text(first)), text(first));
first.click();
const detail = await waitFor(() => q('[role="region"]', dlg), { what: "the detail pane" });
await waitFor(() => /MIT|Apache/.test(text(detail)), { what: "licence text in the detail pane" });
check("the detail shows the licence", /MIT|Apache/.test(text(detail)), text(detail).slice(0, 200));

await press("Escape", {}, dlg);
await waitFor(() => !licDialog(), { what: "the dialog to close" });
check("Escape closes the licenses dialog", !licDialog(), "still open");

// About -> Open-source licenses
const brand = await waitFor(() => qa("button").find((b) => /^About /.test(b.getAttribute("aria-label") ?? text(b))), { what: "the About brand button" });
brand.click();
const about = await waitFor(() => dialogs().find((d) => q(".about", d)), { what: "the About dialog" });
check("About states GPL-3.0-or-later and the any-later-version notice", /GPL-3\.0-or-later/.test(text(about)) && /any later version/.test(text(about)), text(about).slice(0, 200));
const btn = qa("button", about).find((b) => /Open-source licenses/.test(text(b)));
check("the Open-source licenses button is enabled", !!btn && !btn.disabled, String(btn?.disabled));
btn.click();
await waitFor(licDialog, { what: "the licenses dialog from About", timeout: 20000 });
check("About opens the licenses view", !!licDialog(), "no dialog");
await waitFor(() => !dialogs().some((d) => q(".about", d)), { what: "About to make way for the licenses view" });
check("About does not stay stacked under the licenses view", !dialogs().some((d) => q(".about", d)), String(dialogs().length));
for (let i = 0; i < 3 && dialogs().length; i++) { await press("Escape"); await sleep(300); }
await finish();

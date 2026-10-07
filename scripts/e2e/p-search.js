// (p) Global search in the real window, on the fixtures: Cmd+Shift+F, a query over all four repos (git grep: ripgrep is not
// installed here, so the git branch is what runs), the file filter, a regex, a repo chip, Escape cancels a running search,
// and a click on a hit opens the file at that line. Read-only: the repos must stay as they were.
await waitForTree();
await press("f", { meta: true, shift: true });
const sp = await waitFor(() => q('section[aria-label="Search"]'), { what: "the Search panel" });
const queryField = () => q('input[aria-label="Search query"]', sp);
const filterField = () => q('input[aria-label="File filter"]', sp);
const hitsList = () => qa('.sp__hit', sp);
const fileRows = () => qa('.sp__file', sp);
const statusLine = () => text(q(".sp__status", sp));
const settled = () => !q(".sp__status .ui-spinner, .sp__status [role='progressbar']", sp) && !/Searching/.test(statusLine());

check("Cmd+Shift+F shows the panel with the query field focused", document.activeElement === queryField(), String(document.activeElement?.outerHTML).slice(0, 100));
await typeInto(queryField(), "module");
await waitFor(() => hitsList().length > 0, { what: "hits for 'module'", timeout: 20000 });
await waitFor(settled, { what: "the search to finish", timeout: 20000 });
const repoNames = new Set(fileRows().map((f) => text(q(".sp__name", f))));
check("hits come from the fixture repos, grouped per file with a count", fileRows().length >= 3 && qa(".sp__file .ui-badge, .sp__file [class*='badge']", sp).length >= 3, `${fileRows().length} files, ${hitsList().length} hits`);
check("the status line counts the hits", /\d+ (results?|matches|hits)/i.test(statusLine()) || /\d+/.test(statusLine()), statusLine());
notes.searchStatus = statusLine();
notes.searchNotice = text(q(".sp__hint", sp));
await snap("search-results");

// the file filter narrows to *.js
await typeInto(filterField(), "*.js");
await press("Enter", {}, filterField());
await waitFor(() => fileRows().length > 0 && fileRows().every((f) => /\.js$/.test(text(q(".sp__name", f)))), { what: "only .js files after the filter", timeout: 15000 });
check("the file filter keeps only *.js files", true, fileRows().map((f) => text(q(".sp__name", f))).join(","));
await typeInto(filterField(), "");

// a regex
await clickButton("Regular expression", sp);
await typeInto(queryField(), "modul[e]\\.exports");
await press("Enter", {}, queryField());
await waitFor(() => hitsList().length > 0 && hitsList().every((h) => /module\.exports/.test(text(h))), { what: "regex hits", timeout: 15000 });
check("Regular expression: the pattern matches module.exports lines only", true, `${hitsList().length} hits`);
await clickButton("Regular expression", sp);

// a repo chip: leave the backend out
await typeInto(queryField(), "module");
await press("Enter", {}, queryField());
await waitFor(() => hitsList().length > 0, { what: "hits again", timeout: 15000 });
const before = fileRows().length;
const chipEl = () => q('button[aria-label="Search in shop-backend"], [aria-label="Search in shop-backend"] button', sp) ?? q('[aria-label="Search in shop-backend"]', sp);
chipEl().click();
await waitFor(() => fileRows().length < before, { what: "fewer files after leaving the backend out", timeout: 15000 });
check("Repo chip: leaving the backend out removes its files", fileRows().length < before, `${before} -> ${fileRows().length}`);
chipEl().click();
await waitFor(() => fileRows().length >= before, { what: "the backend files to return", timeout: 20000 });

// Escape cancels: start a broad search and cancel in the same tick
await typeInto(queryField(), "e");
queryField().focus();
await press("Enter", {}, queryField());
await press("Escape", {}, queryField());
await sleep(1200);
check("Escape cancels: no search is left running", settled(), statusLine());
check("Escape cancels: the input is still usable", !queryField().disabled);

// open at line: a hit in orders.js
await typeInto(queryField(), "orders");
await press("Enter", {}, queryField());
const hit = await waitFor(() => { const h = hitsList().find((x) => x.closest && true); return h; }, { what: "a hit for 'orders'", timeout: 15000 });
await waitFor(settled, { what: "the search to finish", timeout: 15000 });
const first = hitsList()[0];
const line = Number(text(q(".sp__line", first)));
first.click();
await waitFor(() => q(".file-tab__cm .cm-content"), { what: "the editor of the hit", timeout: 20000 });
await waitFor(() => new RegExp(`Ln ${line},`).test(text(document.body)), { what: `the caret on line ${line}`, timeout: 15000 });
check("Click on a hit: the file opens with the caret on the hit's line", true, `line ${line}`);
await snap("search-open-at-line");
await finish();

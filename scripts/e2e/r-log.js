// (r) The Log tool window on fixtures with 600 extra backend commits (the Log pages by 500): paging while scrolling, the author / search / repo filters,
// commit detail (files, copy id, cherry-pick button), the blame gutter toggle in the editor, file history. Read-only.
await waitForTree();
await openRail("Log");
const log = await waitFor(() => q('section[aria-label="Log"]'), { what: "the Log panel" });
const list = () => q('[role="listbox"][aria-label="Commits"]', log);
const scrollBox = () => q(".glog__scroll", log);
const content = () => q(".glog__content", log);
const totalHeight = () => parseFloat(content()?.style.height ?? "0");
const rowEls = () => qa('[role="option"]', log);
const subjects = () => rowEls().map((r) => text(q(".glog__subject", r)));
await waitFor(() => rowEls().length > 5, { what: "commits in the Log", timeout: 30000 });
await waitFor(() => !q('[aria-label="Loading commits"]', log), { what: "the first page", timeout: 30000 });

// ---- paging ----------------------------------------------------------------------------------------------------------
const h0 = totalHeight();
check("the first page is a window of the history, not all of it", h0 > 0, `content height ${h0}`);
let h = h0;
for (let i = 0; i < 40 && h <= h0; i++) {
  scrollBox().scrollTop = scrollBox().scrollHeight; // the end of what is loaded
  scrollBox().dispatchEvent(new Event("scroll"));
  await sleep(250);
  h = totalHeight();
}
check("scrolling to the end loads the next page (the list grows)", h > h0, `${h0} -> ${h}`);
scrollBox().scrollTop = 0;
scrollBox().dispatchEvent(new Event("scroll"));
await sleep(200);
await snap("log-paged");

// ---- filters ---------------------------------------------------------------------------------------------------------
const authorField = q('input[aria-label="Author"]', log);
await typeInto(authorField, "Bela");
await waitFor(() => rowEls().length > 0 && qa(".glog__author-col", log).every((a) => /Bela/.test(text(a))), { what: "only Bela's commits", timeout: 15000 });
check("Author filter: every visible row is by Bela", qa(".glog__author-col", log).every((a) => /Bela/.test(text(a))), qa(".glog__author-col", log).slice(0, 3).map(text).join(","));
await typeInto(authorField, "");
const searchField = q('input[aria-label="Search commits"]', log);
await typeInto(searchField, "item 7");
await waitFor(() => rowEls().length > 0 && subjects().every((s) => /item 7/.test(s)), { what: "only 'item 7' commits", timeout: 15000 });
check("Search: the list narrows to subjects with the text", subjects().length > 0 && subjects().every((s) => /item 7/.test(s)), subjects().slice(0, 4).join(" | "));
await typeInto(searchField, "");
await waitFor(() => rowEls().some((r) => !/item 7/.test(text(q(".glog__subject", r)))), { what: "the unfiltered list again", timeout: 15000 });
const chip = (name) => qa(".glog__chip", log).find((c) => text(c) === name);
chip("admin").click();
await waitFor(() => rowEls().length > 0 && qa(".glog__stripe", log).every((s) => s.getAttribute("title") === "admin"), { what: "only admin rows", timeout: 15000 });
check("Repository chip: only the admin repo's commits", qa(".glog__stripe", log).every((s) => s.getAttribute("title") === "admin"));
await clickButton("All", q('[role="group"][aria-label="Repositories"]', log));
await waitFor(() => qa(".glog__stripe", log).some((s) => s.getAttribute("title") !== "admin"), { what: "all repos again", timeout: 15000 });
// the date filter: a Select (button + listbox)
const dateSel = q('[aria-label="Date"]', log);
check("the Date filter is there", !!dateSel);

// ---- commit detail ---------------------------------------------------------------------------------------------------
chip("shop-backend").click();
await waitFor(() => rowEls().length > 0 && qa(".glog__stripe", log).every((s) => s.getAttribute("title") === "shop-backend"), { what: "backend rows", timeout: 15000 });
await typeInto(searchField, "feat: menu");
await waitFor(() => rowEls().length > 0 && subjects().every((s) => /feat: menu/.test(s)), { what: "the feature commit", timeout: 15000 });
rowEls()[0].click();
const detail = await waitFor(() => q('aside[aria-label="Commit details"]', log), { what: "the commit detail", timeout: 15000 });
const files = await waitFor(() => { const u = q('ul[aria-label="Changed files"]', detail); return u && qa("li", u).length > 0 ? u : null; }, { what: "the changed files of the commit", timeout: 15000 });
check("Commit detail: subject, author and the changed files", /feat: menu versioning/.test(text(detail)) && qa("li", files).length >= 1, text(detail).slice(0, 200));
check("Commit detail: Copy commit id, Cherry-pick and Rebase onto here are offered", !!findButton("Copy commit id", detail) && !!findButton("Cherry-pick", detail) && !!findButton("Rebase onto here", detail));
await snap("log-detail");
await typeInto(searchField, "");

// ---- blame gutter + file history in the editor ------------------------------------------------------------------------------
await press("p", { meta: true });
const qo = await waitFor(() => q('[role="combobox"][aria-label="File name"]'), { what: "quick open" });
await typeInto(qo, "package.json");
await waitFor(() => qa('[role="option"]', q("#qo-list") ?? document).length > 0, { what: "quick-open results" });
(qa('[role="option"]', q("#qo-list")).find((o) => /SB$/.test(text(o))) ?? q('[role="option"]', q("#qo-list"))).click();
await waitFor(() => q(".file-tab__cm .cm-content"), { what: "the editor", timeout: 20000 });
const blameBtn = await waitFor(() => qa("button").find((b) => /^Blame:/.test(text(b))), { what: "the Blame status item" });
check("Blame is off by default", /off/.test(text(blameBtn)));
blameBtn.click();
await waitFor(() => /Blame: on/.test(text(blameBtn)) && qa(".cm-blame-cell").length > 0, { what: "blame cells in the gutter", timeout: 20000 });
const cells = qa(".cm-blame-cell").map(text);
notes.blameCells = cells.slice(0, 3);
check("Blame on: the gutter shows who/what for the lines", cells.some((c) => c.length > 3), cells.slice(0, 3).join(" | "));
await snap("log-blame");
blameBtn.click();
await waitFor(() => /Blame: off/.test(text(blameBtn)) && qa(".cm-blame-cell").length === 0, { what: "blame off", timeout: 10000 });
check("Blame off: the gutter is gone again", true);
await runCommand("Show the history of the current file");
const hist = await waitFor(() => q('section[aria-label^="History of"]'), { what: "the file history", timeout: 20000 });
await waitFor(() => qa(".ghistory__row", hist).length >= 1, { what: "history rows", timeout: 20000 });
check("File history lists the commits that touched package.json", /package\.json/.test(hist.getAttribute("aria-label")) && qa(".ghistory__row", hist).length >= 1, `${qa(".ghistory__row", hist).length} rows`);
await snap("log-file-history");
await finish();

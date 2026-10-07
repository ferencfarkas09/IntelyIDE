// (l) The alpha modules in the real window, on a fixture: command palette, Settings dialog, Project tree + editor (open a
// file from quick open, edit, Cmd+S), branch popup, Log panel (real `git log`), terminal-less. Nothing is pushed.
await waitForTree();
const BACKEND = "shop-backend";
const railButton = (title) => qa("nav.rail button").find((b) => (b.getAttribute("aria-label") ?? "").startsWith(title));
const dialogs = () => qa('[role="dialog"]');

// ---- command palette ------------------------------------------------------------------------------------------------
await press("p", { meta: true, shift: true });
const palette = await waitFor(() => q(".palette"), { what: "the command palette" });
const field = await waitFor(() => q('[role="combobox"]', palette), { what: "the palette search field" });
check("Cmd+Shift+P opens the palette with commands listed", qa('[role="option"]', palette).length > 5, String(qa('[role="option"]', palette).length));
await typeInto(field, "open settings");
await waitFor(() => /Open settings/.test(text(q('[role="option"]', palette))), { what: "Open settings as the first hit" });
check("fuzzy search finds Open settings first", /Open settings/.test(text(q('[role="option"]', palette))), text(q('[role="option"]', palette)));
await press("Enter", {}, field);

// ---- Settings dialog ------------------------------------------------------------------------------------------------
const settings = await waitFor(() => q(".settings"), { what: "the Settings dialog from the palette" });
const sections = () => qa(".settings__item", settings).map((b) => text(b));
await waitFor(() => sections().length >= 8, { what: "the settings sections" });
for (const name of ["General", "Appearance", "Editor", "Providers", "Safety", "Keyboard", "About"]) check(`Settings has the ${name} section`, sections().includes(name), sections().join(","));
qa(".settings__item", settings).find((b) => text(b) === "Safety").click();
await waitFor(() => /Test jail/.test(text(q(".settings__pane", settings))), { what: "the Safety pane to show the E2E jail", timeout: 10000 });
check("Safety shows the active jail (the test jail here), read from the backend", /Test jail/.test(text(q(".settings__pane", settings))), text(q(".settings__pane", settings)).slice(0, 300));
qa(".settings__item", settings).find((b) => text(b) === "Providers").click();
await waitFor(() => /Claude/i.test(text(q(".settings__pane", settings))), { what: "the Providers pane", timeout: 15000 });
check("Providers lists the vendors without any key text", /Claude/.test(text(q(".settings__pane", settings))));
await press("Escape");
await waitFor(() => !q(".settings"), { what: "Escape to close Settings", timeout: 5000 });
await press(",", { meta: true });
await waitFor(() => q(".settings"), { what: "Cmd+, to open Settings" });
check("Cmd+, opens Settings", !!q(".settings"));
await press("Escape");
await waitFor(() => !q(".settings"), { what: "Settings to close", timeout: 5000 });

// ---- Project tree, quick open, editor, save -------------------------------------------------------------------------------
railButton("Project").click();
const proj = await waitFor(() => q('section[aria-label="Project"]'), { what: "the Project panel" });
await waitFor(() => qa('[role="treeitem"]', proj).length >= 4, { what: "the repositories in the Project tree", timeout: 20000 });
check("the Project tree lists the four fixture repos", FX.repoIds.length === 4 && ["shop-backend", "admin", "shop-mobile", "shop-pos"].every((n) => text(proj).includes(n)), text(proj).slice(0, 200));

await press("p", { meta: true });
const qo = await waitFor(() => q('[role="combobox"][aria-label="File name"]'), { what: "quick open" });
await typeInto(qo, "package.json");
await waitFor(() => qa('[role="option"]', q("#qo-list") ?? document).length > 0, { what: "quick-open results" });
const hit = qa('[role="option"]', q("#qo-list")).find((o) => /package\.json/.test(text(o)) && /SB$/.test(text(o))); // the repo badge text follows the name
check("quick open finds package.json of the backend", !!hit, qa('[role="option"]', q("#qo-list")).map(text).join(" | "));
(hit ?? q('[role="option"]', q("#qo-list"))).click();
const cm = await waitFor(() => q(".file-tab__cm .cm-content"), { what: "the editor", timeout: 20000 });
await waitFor(() => /shop-backend/.test(text(cm)), { what: "the file content in the editor" });
check("the editor shows the file from disk", /"name":"shop-backend"/.test(cm.textContent), cm.textContent.slice(0, 100));
check("a file tab opened next to Diff", qa('[role="tab"]').some((t) => /package\.json/.test(text(t))), qa('[role="tab"]').map(text).join(","));
cm.focus();
document.execCommand("insertText", false, "e2e-edit ");
await waitFor(() => /e2e-edit/.test(cm.textContent), { what: "the typed text in the editor" });
const tabEl = () => qa('[role="tab"]').find((t) => /package\.json/.test(text(t)));
const dirty = () => !!q('[aria-label="Unsaved changes"]', tabEl() ?? document.body);
await waitFor(dirty, { what: "the dirty marker on the tab", timeout: 5000 });
check("the edit marks the tab dirty", dirty());
await press("s", { meta: true }, cm);
await waitFor(() => !dirty(), { what: "the dirty marker to clear after Cmd+S", timeout: 10000 });
check("Cmd+S saves (the dirty marker clears)", !dirty());
await waitFor(async () => (await invoke("snapshot_get", { repoId: FX.repoIds[0] })).changes?.some((c) => c.path === "package.json"), { what: "package.json among the backend changes", timeout: 15000 });
check("the engine now sees package.json as changed", true);

// ---- branch popup ----------------------------------------------------------------------------------------------------
const pill = await waitFor(() => qa("button").find((b) => (b.getAttribute("aria-label") ?? "").startsWith(`${BACKEND}, branch`)), { what: "the backend branch pill" });
check("the title bar pill names the branch", /branch sandbox/.test(pill.getAttribute("aria-label")), pill.getAttribute("aria-label"));
pill.click();
const popup = await waitFor(() => q(".bp"), { what: "the branch popup" });
await waitFor(() => /tracking/.test(text(popup)), { what: "the branch popup to load", timeout: 15000 });
check("the popup shows the current branch and its upstream", /Current\s*sandbox/.test(text(popup)) && /origin\/sandbox/.test(text(popup)), text(popup).slice(0, 200));
check("the fixture has no other branch to list, and the popup says so instead of failing", /No other branches/.test(text(popup)), text(popup).slice(0, 200));
check("Switch all repositories… is offered", !!findButton("Switch all repositories…", popup));
findButton("New branch…", popup).click();
const nb = await waitFor(() => dialogs().find((d) => !d.classList.contains("bp") && /Check out the new branch/.test(text(d))), { what: "the New branch dialog" });
await typeInto(await waitFor(() => q("label input", nb), { what: "the name field" }), "e2e-branch");
const sw = q('[role="switch"]', nb);
check("the dialog offers 'Check out the new branch', on by default", sw?.getAttribute("aria-checked") === "true", sw?.outerHTML.slice(0, 120));
sw.click(); // the backend has tracked changes, so only create it
await waitFor(() => sw.getAttribute("aria-checked") === "false", { what: "the switch to turn off" });
await clickButton("Create", nb);
await waitFor(() => !dialogs().includes(nb) || !nb.isConnected, { what: "the dialog to close", timeout: 15000 });
await sleep(300);

// ---- Log panel -------------------------------------------------------------------------------------------------------
railButton("Log").click();
const log = await waitFor(() => q('section[aria-label="Log"]'), { what: "the Log panel" });
await waitFor(() => qa('[role="option"]', log).length >= 4, { what: "commits in the Log", timeout: 20000 });
check("the Log lists real commits of the fixture repos", /initial import/.test(text(log)), text(log).slice(0, 300));
const chipText = qa('[aria-label="Repositories"] button', log).map(text).join(" ");
check("the Log has a chip for each repository", ["shop-backend", "admin", "shop-mobile", "shop-pos"].every((n) => chipText.includes(n)), chipText);
qa('[role="option"]', log)[0].click();
await waitFor(() => qa('[role="option"][aria-selected="true"]', q('section[aria-label="Log"]') ?? document).length === 1, { what: "the clicked commit to be selected", timeout: 20000 });
check("clicking a commit selects it", true);
await finish();

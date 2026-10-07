// Shot tour of the alpha modules on the default fixture: editor with the Project tree, command palette, Settings (General,
// Providers, Safety), Log, branch popup, terminal, Agent mode (empty), at 1440x900. Every shot in dark and light.
// Nothing is committed or pushed; the editor only opens a file.
const shots = [];
const snap = async (name) => shots.push(...(await both(name)));
const railButton = (title) => qa("nav.rail button").find((b) => (b.getAttribute("aria-label") ?? "").startsWith(title));

notes.size = await window.__e2e.resize(1440, 900);
await waitForTree();
await sleep(400);

// Project tree + a file in the editor
railButton("Project").click();
await waitFor(() => qa('[role="treeitem"]', q('section[aria-label="Project"]') ?? document.createElement("div")).length >= 4, { what: "the Project tree", timeout: 20000 });
await press("p", { meta: true });
const qo = await waitFor(() => q('[role="combobox"][aria-label="File name"]'), { what: "quick open" });
await typeInto(qo, "orders.js");
await waitFor(() => qa('[role="option"]', q("#qo-list")).length > 0, { what: "results" });
await sleep(300);
await snap("quick-open");
qa('[role="option"]', q("#qo-list"))[0].click();
await waitFor(() => q(".file-tab__cm .cm-content"), { what: "the editor", timeout: 20000 });
await sleep(600);
await snap("editor");

// command palette
await press("p", { meta: true, shift: true });
await waitFor(() => q(".palette"), { what: "the palette" });
await typeInto(q('.palette [role="combobox"]'), "log");
await sleep(300);
await snap("palette");
await press("Escape");
await sleep(200);

// Settings
await press(",", { meta: true });
const dlg = await waitFor(() => q(".settings"), { what: "Settings" });
for (const name of ["General", "Providers", "Safety", "Integrations", "Keyboard"]) {
  (await waitFor(() => qa(".settings__item", dlg).find((b) => text(b) === name), { what: `${name} section` })).click();
  await sleep(700);
  await snap(`settings-${name.toLowerCase()}`);
}
await press("Escape");
await sleep(200);

// branch popup
const pill = qa("button").find((b) => (b.getAttribute("aria-label") ?? "").startsWith("shop-backend, branch"));
pill.click();
await waitFor(() => /tracking/.test(text(q(".bp") ?? document.body)), { what: "the branch popup" });
await sleep(300);
await snap("branch-popup");
await press("Escape");
await sleep(200);

// Log
railButton("Log").click();
await waitFor(() => qa('[role="option"]', q('section[aria-label="Log"]') ?? document).length >= 4, { what: "the Log", timeout: 20000 });
qa('[role="option"]', q('section[aria-label="Log"]'))[0].click();
await sleep(800);
await snap("log");

// terminal
railButton("Terminal")?.click();
await sleep(1500);
// the terminal follows the theme controller (not the attribute `both` sets), so switch through the Theme menu and restore System afterwards
for (const theme of ["Dark", "Light"]) {
  await chooseTheme(theme);
  await sleep(900);
  shots.push(await window.__e2e.screenshot("terminal"));
}
await chooseTheme("System");
await setTheme("dark");

// Agent mode, empty
qa('[role="radiogroup"][aria-label="Mode"] [role="radio"]').find((r) => text(r).startsWith("Agent")).click();
await waitFor(() => q('[data-testid="agent-workspace"]'), { what: "the Agent workspace", timeout: 20000 });
await sleep(800);
await snap("agent-mode");
notes.shots = shots;
await finish();

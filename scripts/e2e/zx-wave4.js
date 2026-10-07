// (zx) The wave-4 extras that need no agent: PR bridge, API contract and the Doctor, in the real window. Enable the two extras in
// Settings, check the palette gains their commands, open the PR tab (no gh call may run in the E2E jail: a notice instead of a list),
// open the API contract tab (the fixture backend has no swagger: a clear empty state, no crash) and read the Doctor in Settings > About.
// Nothing is written to the repos; the harness checks that.
await waitForTree();

async function paletteTitles(search) {
  await press("p", { meta: true, shift: true });
  const palette = await waitFor(() => q(".palette"), { what: "the command palette" });
  const field = await waitFor(() => q('[role="combobox"]', palette), { what: "the palette search field" });
  if (search) await typeInto(field, search);
  await sleep(300);
  return { palette, field, titles: () => qa('[role="option"]', palette).map(text) };
}

step("off by default");
let p = await paletteTitles("pull request");
check("no pull request command while the extra is off", !p.titles().some((t) => /Show pull requests/.test(t)), p.titles().join("|"));
await press("Escape");

step("enable");
await press(",", { meta: true });
const settings = await waitFor(() => q(".settings"), { what: "the Settings dialog" });
const item = (name) => qa(".settings__item", settings).find((b) => text(b) === name);
await waitFor(() => item("Pull requests") && item("API contract"), { what: "the PR and contract Settings sections" });
check("Settings lists Pull requests and API contract", !!item("Pull requests") && !!item("API contract"), qa(".settings__item", settings).map(text).join(","));
for (const [section, aria] of [["Pull requests", "Enable the pull request bridge"], ["API contract", "Enable the API contract tab"]]) {
  item(section).click();
  const sw = await waitFor(() => q(`[aria-label="${aria}"]`, settings), { what: `the ${section} switch` });
  sw.click();
  await waitFor(() => sw.getAttribute("aria-checked") === "true" || sw.checked === true, { what: `${section} switched on` });
}

step("doctor");
const about = qa(".settings__item", settings).find((b) => /^About/.test(text(b)));
check("Settings has an About section", !!about, "");
if (about) {
  about.click();
  await waitFor(() => /System checks|Doctor/i.test(text(settings)), { what: "the Doctor in About", timeout: 20000 });
  check("About shows the system checks", /System checks|Doctor/i.test(text(settings)), text(settings).slice(0, 200));
}
await press("Escape");
await waitFor(() => !q(".settings"), { what: "Settings to close", timeout: 5000 });

step("commands");
p = await paletteTitles("pull request");
await waitFor(() => p.titles().some((t) => /Show pull requests/.test(t)), { what: "the pull request command" });
check("the pull request commands appear after enabling", p.titles().some((t) => /Show pull requests/.test(t)) && p.titles().some((t) => /Create pull request/.test(t)), p.titles().join("|"));
await press("Enter", {}, p.field);
const prTab = await waitFor(() => q(".pr"), { what: "the Pull requests tab", timeout: 15000 });
check("the PR tab opens and shows a state, not an error stack", text(prTab).length > 10 && !/undefined|TypeError/.test(text(prTab)), text(prTab).slice(0, 200));

p = await paletteTitles("API contract");
await waitFor(() => p.titles().some((t) => /Open API contract/.test(t)), { what: "the contract command" });
await press("Enter", {}, p.field);
const bodyText = () => text(document.body);
await waitFor(() => /No API description found/.test(bodyText()), { what: "the contract tab content", timeout: 30000 });
check("the contract tab opens with a clear empty state (no swagger in the fixtures)", /No API description found/.test(bodyText()) && !/TypeError/.test(bodyText()), "");
await shot("wave4-contract");
await finish({});

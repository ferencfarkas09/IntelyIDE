// Shot tour of the workspace screens (shots.sh concatenates config.js, lib.js, shots-lib.js and this file; a registry fixture with Alpha open,
// like wsc): the title-bar switcher menu, the Manage dialog and the New workspace dialog in English and in Hungarian, then Close workspace
// (the page reloads) and the Welcome screen with the recent list, each in dark and in light. Screenshots come from the app's own
// e2e_screenshot only. Shots are named workspaces-<screen>-<en|hu>-<dark|light>.png.
const wsSwitcher = () => q("button.switcher");
const wsOpenMenu = async () => {
  if (wsSwitcher().getAttribute("aria-expanded") !== "true") wsSwitcher().click();
  await waitFor(() => qa('[role="menuitemradio"]').length > 0, { what: "the switcher menu" });
};
const wsItem = (re) => qa('[role="menuitem"], [role="menuitemradio"]').find((i) => re.test(text(i)));
const wsDialog = (re) => qa('[role="dialog"]').find((d) => re.test(text(q(".ui-dialog__title", d))));

/** The shell screens of one language: switcher, Manage, New workspace. */
async function shellShots(lang) {
  await window.__e2e.resize(1440, 900);
  await waitFor(() => q(".shell__body") && !q(".splash"), { what: "the workspace shell", timeout: 30000 });
  await sleep(700);
  step(`switcher ${lang}`);
  await wsOpenMenu();
  notes[`switcher-${lang}`] = await both(`switcher-${lang}`);
  const manage = wsItem(/^(Manage workspaces|Munkaterületek kezelése)/);
  const create = wsItem(/^(New workspace|Új munkaterület)/);
  if (!manage || !create) throw new Error("switcher items: " + qa('[role="menuitem"]').map((i) => text(i)).join(" | "));
  manage.click();
  const m = await waitFor(() => q(".manage"), { what: "the Manage dialog" }).catch(() => null);
  await sleep(500);
  notes[`manage-${lang}`] = await both(`manage-${lang}`);
  await press("Escape");
  await sleep(400);
  step(`new workspace ${lang}`);
  await wsOpenMenu();
  wsItem(/^(New workspace|Új munkaterület)/).click();
  await waitFor(() => q(".wsdlg"), { what: "the New workspace dialog" });
  await sleep(500);
  notes[`new-${lang}`] = await both(`new-workspace-${lang}`);
  await press("Escape");
  await sleep(400);
}

async function closeToWelcome(nextPhase) {
  currentPhase = nextPhase;
  expectReload();
  await wsOpenMenu();
  wsItem(/^(Close workspace|Munkaterület bezárása)/).click();
  await sleep(25000);
  throw new Error("the page did not reload after Close workspace");
}

async function welcomeShots(lang) {
  await window.__e2e.resize(1440, 900);
  await waitFor(() => q('[data-testid="welcome"]'), { what: "the Welcome screen", timeout: 30000 });
  await waitFor(() => !q('.recent__status[data-kind="checking"]'), { what: "the probes to settle", timeout: 20000 });
  await sleep(600);
  step(`welcome ${lang}`);
  notes[`welcome-${lang}`] = await both(`welcome-${lang}`);
  await window.__e2e.resize(900, 700);
  await sleep(300);
  notes[`welcome-narrow-${lang}`] = await both(`welcome-narrow-${lang}`);
}

await phase(0, async () => {
  await shellShots("en");
  localStorage.setItem("intely.locale", "hu");
  await reloadInto(1);
});
await phase(1, async () => {
  await shellShots("hu");
  await closeToWelcome(2);
});
await phase(2, async () => {
  await welcomeShots("hu");
  localStorage.setItem("intely.locale", "en");
  await reloadInto(3);
});
await phase(3, async () => {
  await welcomeShots("en");
  await finish();
});

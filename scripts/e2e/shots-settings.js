// Shot tour of the Settings screens Wave 5c touched (shots.sh concatenates config.js, lib.js, shots-lib.js and this file, on the default fixture):
//   1. the Settings sidebar                                                    (sidebar)
//   2. Settings > Remote (switch off), then the relay panel for "Your Cloudflare"  (remote, remote-cloud)
//   3. Settings > Database with the module on, top and Connections               (database, database-connections)
//   4. the New connection form                                                 (mongo-form)
// English first, then Hungarian (the page reloads); every shot in dark and light with the app's own e2e_screenshot (never a desktop
// capture). Shots are named settings-<shot>-<en|hu>-<dark|light>.png. Nothing is connected, saved or deployed: the form is only looked at.
// The window snapshot can lag a repaint behind the DOM (a half-switched theme, the previous section): settle before every frame.
async function both(name) {
  const files = [];
  for (const theme of ["dark", "light"]) {
    await setTheme(theme);
    await sleep(1200);
    await window.__e2e.screenshot(name); // a first snapshot primes the window: the next one is the current frame
    await sleep(600);
    files.push(await window.__e2e.screenshot(name));
  }
  await setTheme("dark");
  return files;
}

async function settingsShots(lang) {
  await window.__e2e.resize(1440, 900);
  await waitFor(() => q(".shell__body") && !q(".splash"), { what: "the workspace shell", timeout: 30000 });
  await sleep(700);

  step(`sidebar ${lang}`);
  await press(",", { meta: true });
  const settings = await waitFor(() => q(".settings"), { what: "Settings" });
  await sleep(500);
  notes[`probe-${lang}`] = { visibility: document.visibilityState, focus: document.hasFocus(), settings: !!q(".settings"), rect: q(".settings")?.getBoundingClientRect().toJSON(), lang: document.documentElement.lang, theme: document.documentElement.getAttribute("data-theme") };
  notes[`items-${lang}`] = qa(".settings__item", settings).map((b) => text(b));
  notes[`sidebar-${lang}`] = await both(`sidebar-${lang}`);

  const section = async (re, what) => {
    (await waitFor(() => qa(".settings__item", settings).find((b) => re.test(text(b))), { what })).click();
    await sleep(600);
  };

  step(`remote ${lang}`);
  await section(/^(Remote|Távoli|Távirányító)/, "the Remote section");
  await waitFor(() => q('.settings__pane [role="switch"]'), { what: "the Remote switch", timeout: 15000 });
  await sleep(500);
  notes[`remote-${lang}`] = await both(`remote-${lang}`);
  // "Your Cloudflare" only swaps the panel below: nothing is deployed or switched until the user asks for it
  qa('.settings__pane [role="radio"]').find((r) => /Cloudflare/.test(text(r)))?.click();
  await sleep(700);
  q(".settings__pane").scrollTop = 99999;
  await sleep(500);
  notes[`remote-cloud-${lang}`] = await both(`remote-cloud-${lang}`);
  q(".settings__pane").scrollTop = 0;

  step(`database ${lang}`);
  await section(/^(Database|Adatbázis)/, "the Database section");
  const sw = await waitFor(() => q('.settings__pane [role="switch"]'), { what: "the Database switch" });
  if (sw.getAttribute("aria-checked") !== "true") sw.click();
  await waitFor(() => q('.settings__pane [aria-label="Enable MongoDB Studio"], .settings__pane [role="switch"]') && /No connections|First|Connect your first|Nincs|Csatlakozz/.test(q(".settings__pane").innerText), { what: "the empty Connections list", timeout: 20000 });
  await sleep(500);
  notes[`database-${lang}`] = await both(`database-${lang}`);
  q(".settings__pane").scrollTop = 99999;
  await sleep(400);
  notes[`database-connections-${lang}`] = await both(`database-connections-${lang}`);

  step(`mongo form ${lang}`);
  const tile = await waitFor(() => qa(".settings__pane button").find((b) => /^\+?\s*(New connection|Új kapcsolat)/.test(text(b))), { what: "the New connection button" });
  tile.click();
  const form = await waitFor(() => q('[role="dialog"] #mgf-name'), { what: "the connection form", timeout: 15000 });
  await sleep(700);
  notes[`mongo-form-${lang}`] = await both(`mongo-form-${lang}`);
  await press("Escape");
  await sleep(400);
  await press("Escape");
  await sleep(300);
  // the switch goes back off: this tour leaves no setting behind in the fixture data dir either way
  if (sw.getAttribute("aria-checked") === "true") sw.click();
  await sleep(300);
  await press("Escape");
}

await phase(0, async () => {
  await settingsShots("en");
  localStorage.setItem("intely.locale", "hu");
  await reloadInto(1);
});
await phase(1, async () => {
  await settingsShots("hu");
  localStorage.setItem("intely.locale", "en");
  await finish();
});

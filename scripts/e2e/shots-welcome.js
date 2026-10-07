// Shot tour of the first-run Welcome screen (empty registry; shots.sh --only welcome): English and Hungarian, wide and narrow, dark and light.
await phase(0, async () => {
  await window.__e2e.resize(1440, 900);
  await waitFor(() => q('[data-testid="welcome"]'), { what: "the Welcome screen", timeout: 30000 });
  await sleep(600);
  notes.en = await both("firstrun-en");
  await window.__e2e.resize(900, 700);
  await sleep(300);
  notes.enNarrow = await both("firstrun-narrow-en");
  localStorage.setItem("intely.locale", "hu");
  await reloadInto(1);
});
await phase(1, async () => {
  await window.__e2e.resize(1440, 900);
  await waitFor(() => q('[data-testid="welcome"]'), { what: "the Welcome screen", timeout: 30000 });
  await sleep(600);
  notes.hu = await both("firstrun-hu");
  localStorage.setItem("intely.locale", "en");
  await finish();
});

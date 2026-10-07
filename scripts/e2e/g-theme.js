// (g) Theme switching and reduced motion. Phase 1 drives the Theme menu and leaves a non-default preference in the
// (isolated, persistent) web data store; phase 2 is a second launch on the same store and must come up with it.
// config.js defines PHASE (1 | 2). Both phases derive the stored preference the same way (the opposite of the system theme).
await waitForTree();
const systemDark = matchMedia("(prefers-color-scheme: dark)").matches;
const persisted = systemDark ? "light" : "dark"; // the opposite of what "system" resolves to, so a missing restore shows
notes.systemDark = systemDark;

if (PHASE === 1) {
  calmMotion();
  const start = themeState();
  notes.start = start;
  check("a fresh store starts on the system preference", start.pref === "system" && start.theme === (systemDark ? "dark" : "light"), JSON.stringify(start));
  const bgSystem = start.bg;

  await chooseTheme("Dark");
  const dark = themeState();
  check("Dark: data-theme dark, preference dark", dark.theme === "dark" && dark.pref === "dark", JSON.stringify(dark));
  check("Dark is stored in localStorage", dark.stored === "dark", dark.stored);
  await chooseTheme("Light");
  const light = themeState();
  check("Light: data-theme light, preference light", light.theme === "light" && light.pref === "light", JSON.stringify(light));
  check("Light is stored in localStorage", light.stored === "light", light.stored);
  check("the page background really changes between Dark and Light", dark.bg !== light.bg, `${dark.bg} vs ${light.bg}`);
  const lum = (css) => { const m = css.match(/\d+(\.\d+)?/g).map(Number); return (m[0] * 299 + m[1] * 587 + m[2] * 114) / 1000; };
  check("dark background is dark and light background is light", lum(dark.bg) < 90 && lum(light.bg) > 180, `${dark.bg} / ${light.bg}`);
  const textColor = async (t) => { document.documentElement.setAttribute("data-theme", t); await sleep(500); return getComputedStyle(q(".commit-panel__title") ?? document.body).color; };
  const lightText = await textColor("light"); const darkText = await textColor("dark");
  document.documentElement.setAttribute("data-theme", "light");
  check("text colours differ between the themes", lightText !== darkText, `${lightText} / ${darkText}`);
  await chooseTheme("System");
  const system = themeState();
  check("System follows prefers-color-scheme", system.pref === "system" && system.theme === (systemDark ? "dark" : "light") && system.bg === bgSystem, JSON.stringify(system));
  check("System is stored", system.stored === "system", system.stored);

  // the menu marks the active preference
  const trigger = qa("button").find((b) => /^Theme:/.test(b.getAttribute("aria-label") ?? ""));
  check("the Theme button names the active preference", /System/.test(trigger.getAttribute("aria-label")), trigger.getAttribute("aria-label"));

  await chooseTheme(persisted === "dark" ? "Dark" : "Light");
  const kept = themeState();
  check(`${persisted} is the preference left for the relaunch`, kept.pref === persisted && kept.stored === persisted, JSON.stringify(kept));
} else {
  const s = themeState();
  notes.afterRelaunch = s;
  check("the stored preference survived the relaunch", s.stored === persisted && s.pref === persisted, JSON.stringify(s));
  check("…and was applied before the first interaction", s.theme === persisted, JSON.stringify(s));
  // restore the default so the next run on a fresh store and the user's own app are not affected
  await chooseTheme("System");
  try { localStorage.clear(); } catch {}
  check("the store is clean again", themeState().stored === null || themeState().stored === "unavailable", themeState().stored);
}

calmMotion(false);
// ---- reduced motion ---------------------------------------------------------------------------------------------------
// The OS setting cannot be flipped from here. With it on, the live page is measured; with it off, the page's
// reduce rules are applied on top of the live page and must beat the components' own transition/animation durations.
notes.systemReducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const reduceRules = [];
for (const sheetObj of document.styleSheets) {
  let rules; try { rules = sheetObj.cssRules; } catch { continue; }
  const walk = (list) => { for (const r of list) { if (r instanceof CSSMediaRule && /prefers-reduced-motion:\s*reduce/.test(r.conditionText)) reduceRules.push(...[...r.cssRules].map((x) => x.cssText)); else if (r.cssRules) walk(r.cssRules); } };
  walk(rules);
}
notes.reducedMotionRules = reduceRules.length;
check("the stylesheets contain prefers-reduced-motion: reduce rules", reduceRules.length > 0, String(reduceRules.length));
const longest = (v) => Math.max(...v.split(",").map(parseFloat));
const moving = () => qa("*").filter((el) => { const cs = getComputedStyle(el); return longest(cs.transitionDuration) > 0.001 || longest(cs.animationDuration) > 0.001; });
if (notes.systemReducedMotion) {
  // The OS setting is on (as on the developer's machine): the live page is the proof.
  check("OS reduced motion is on and no element keeps a transition or animation", moving().length === 0, moving().slice(0, 5).map((el) => el.className).join(" | "));
  skip("emulated reduced motion", "the OS setting is on, so the rules were measured live instead of being applied on top");
} else {
  const animated = qa("*").filter((el) => { const cs = getComputedStyle(el); return longest(cs.transitionDuration) > 0.05 || longest(cs.animationDuration) > 0.05; });
  notes.animatedElements = animated.length;
  check("the page has animated elements to measure", animated.length > 0, String(animated.length));
  const forced = new CSSStyleSheet();
  forced.replaceSync(reduceRules.join("\n"));
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, forced];
  await frame();
  check("with the reduce rules applied no element keeps a transition or animation", moving().length === 0, moving().slice(0, 5).map((el) => el.className).join(" | "));
  document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== forced);
}
await finish();

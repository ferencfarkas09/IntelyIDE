// (t) Interactive rebase and cherry-pick on scripted fixture histories, like a user: reword / squash(fixup) / drop in the plan
// dialog, a conflicting rebase with Abort and with Continue (from the Log's banner), the live-branch refusal on main, and
// cherry-pick of a clean commit and of a clashing one (Abort). git verifies the history afterwards (verify_t).
await waitForTree();
const [BE, AD, SV] = FX.repoIds;
await openRail("Log");
const log = await waitFor(() => q('section[aria-label="Log"]'), { what: "the Log panel" });
await waitFor(() => qa('[role="option"]', log).length > 5, { what: "commits in the Log", timeout: 30000 });
const rebaseDlg = () => dialogsOpen().find((d) => /Interactive rebase/.test(text(d)));
const setSelect = (el, value) => { el.value = value; el.dispatchEvent(new Event("change", { bubbles: true })); };
const stepLi = (subject) => qa(".grebase__step", rebaseDlg()).find((li) => text(q(".grebase__subject", li)) === subject);
const actionSel = (subject) => q("select", stepLi(subject));
const openPlan = async (repoName, onto) => {
  await runCommand("Interactive rebase…");
  const d = await waitFor(rebaseDlg, { what: "the rebase dialog" });
  await waitFor(() => !q('input[aria-label="Rebase onto"]', d)?.disabled, { what: "the first (automatic) plan load to settle", timeout: 20000 }); // fields are disabled while it runs
  setSelect(q('select[aria-label="Repository"]', d), repoName);
  await typeInto(q('input[aria-label="Rebase onto"]', d), onto);
  await clickButton("Load commits", d);
  return d;
};

// ---- reword + squash + drop on the backend (branch topic) -------------------------------------------------------------------
let d = await openPlan(FX.repoIds[0], "sandbox");
await waitFor(() => qa(".grebase__step", d).length === 5, { what: "five commits in the plan", timeout: 20000 });
check("the plan lists the five topic commits, oldest first", qa(".grebase__subject", d).map(text).join(" | ") === "feat: alpha | feat: beta | fixup: beta typo | wip: drop me | feat: gamma", qa(".grebase__subject", d).map(text).join(" | "));
check("Rebase stays disabled until the plan changes", findButton("Rebase", d)?.disabled === true);
setSelect(actionSel("feat: alpha"), "reword");
const msgField = await waitFor(() => q("textarea", stepLi("feat: alpha")), { what: "the reword message field" });
await typeInto(msgField, "feat: alpha (reworded)");
setSelect(actionSel("fixup: beta typo"), "squash");
setSelect(actionSel("wip: drop me"), "drop");
await waitFor(() => qa(".grebase__result li", d).length === 3, { what: "three commits in the result preview" });
check("the Result preview shows three commits, one reworded, one squashed", /reword/.test(text(q(".grebase__result", d))) && /2 commits/.test(text(q(".grebase__result", d))), text(q(".grebase__result", d)));
await snap("rebase-plan");
await clickButton("Rebase", d);
await waitToast(/Rebase finished/, "Rebase finished", 60000);
await waitFor(() => !rebaseDlg(), { what: "the dialog to close", timeout: 10000 });
check("Rebase: finished, the dialog closed", true);
await waitFor(() => qa('[role="option"]', log).some((o) => /feat: alpha \(reworded\)/.test(text(o))), { what: "the reworded commit in the Log", timeout: 20000 });
check("the Log shows the rewritten history", !qa('[role="option"]', log).some((o) => /wip: drop me/.test(text(q(".glog__subject", o)))));

// ---- the live branch asks for its name -----------------------------------------------------------------------------------------
d = await openPlan(SV, "HEAD~2");
await waitFor(() => qa(".grebase__step", d).length === 2, { what: "two commits in the services plan", timeout: 20000 });
setSelect(actionSel("feat: s2"), "drop");
await clickButton("Rebase", d);
const typed = await waitFor(() => q('input[aria-label="Type main to confirm"]', d), { what: "the live-branch confirmation field", timeout: 20000 });
check("main is live: the dialog asks to type its name and says so", /live branch/.test(text(d)), text(d).slice(0, 300));
check("Rebase stays disabled until the name is typed", findButton("Rebase", d)?.disabled === true);
await typeInto(typed, "mai");
check("a wrong name keeps it disabled", findButton("Rebase", d)?.disabled === true);
await snap("rebase-live-refusal");
await clickButton("Close", d);
await waitFor(() => !rebaseDlg(), { what: "the dialog to close" });

// ---- a conflicting rebase: Abort, then again and Continue -------------------------------------------------------------------------
d = await openPlan(AD, "feature-light-design");
await waitFor(() => qa(".grebase__step", d).length === 1, { what: "one commit in the admin plan", timeout: 20000 });
setSelect(actionSel("feat: mine"), "reword");
await typeInto(await waitFor(() => q("textarea", stepLi("feat: mine"))), "feat: mine (reworded)");
await clickButton("Rebase", d);
await waitFor(() => findButton("Abort rebase", rebaseDlg() ?? document.body), { what: "the rebase to stop on the conflict", timeout: 60000 });
check("the conflicting rebase stops and the dialog offers Abort and Continue", !!findButton("Abort rebase", rebaseDlg()) && !!findButton("Continue", rebaseDlg()), text(rebaseDlg()).slice(0, 300));
check("the conflict names shared.txt", /shared\.txt/.test(text(rebaseDlg())), text(d).slice(0, 300));
await snap("rebase-conflict");
await clickButton("Abort rebase", rebaseDlg());
await waitToast(/Rebase aborted/, "Rebase aborted", 30000);
check("Abort: the branch is back where it was", true);
await invoke("snapshot_refresh", { repoId: AD });
// again, resolve in the file and continue from the Log banner
// Abort reloads the plan by itself
await waitFor(() => !q('input[aria-label="Rebase onto"]', rebaseDlg())?.disabled && qa(".grebase__step", rebaseDlg()).length === 1, { what: "the plan again", timeout: 20000 });
setSelect(actionSel("feat: mine"), "reword");
await typeInto(await waitFor(() => q("textarea", stepLi("feat: mine"))), "feat: mine (resolved)");
await clickButton("Rebase", d);
await waitFor(() => findButton("Abort rebase", rebaseDlg() ?? document.body), { what: "the conflict again", timeout: 60000 });
// Continue while the file is still conflicted is refused with the reason
await clickButton("Continue", rebaseDlg());
await waitFor(() => /still have conflicts/i.test(text(rebaseDlg() ?? document.body)), { what: "the refusal to continue", timeout: 20000 });
check("Continue is refused while the conflict is unresolved, with the reason", true);
// resolve in the working tree and stage it in the IDE's terminal, then Continue finishes the rebase
const out = await termRun(AD, "printf 'resolved\\n' > shared.txt && git add shared.txt");
notes.termOut = out.slice(-200);
await clickButton("Continue", rebaseDlg());
await waitToast(/Rebase finished/, "Rebase finished after Continue", 60000);
await waitFor(() => !rebaseDlg(), { what: "the dialog to close", timeout: 10000 });
check("Continue after staging the resolution finishes the rebase", true);

// ---- cherry-pick: a clean commit onto topic, then a clashing one (Abort) --------------------------------------------------------
const L = () => q('section[aria-label="Log"]');
const commitRow = (subject) => qa('[role="option"]', L()).find((o) => text(q(".glog__subject", o)) === subject);
if (!L()) await openRail("Log");
await waitFor(() => q('input[aria-label="Search commits"]', L() ?? document.body), { what: "the Log search field", timeout: 20000 });
const searchField = () => q('input[aria-label="Search commits"]', L());
await typeInto(searchField(), "other: clean");
await waitFor(() => commitRow("other: clean change"), { what: "the other branch's clean commit in the Log", timeout: 20000 });
commitRow("other: clean change").click();
const detail = await waitFor(() => q('aside[aria-label="Commit details"]', L()), { what: "the commit detail" });
await clickButton("Cherry-pick", detail);
await clickButton("Apply to current branch", detail).catch(async () => { const b = qa("button", detail).find((x) => /^Apply to/.test(text(x))); b.click(); });
await waitToast(/Cherry-picked|cherry-pick/i, "the cherry-pick toast", 30000).catch(() => undefined);
await sleep(600);
notes.cherryToasts = toastText().slice(0, 300);
await typeInto(searchField(), "other: clashing");
await waitFor(() => commitRow("other: clashing t1"), { what: "the clashing commit in the Log", timeout: 20000 });
commitRow("other: clashing t1").click();
const detail2 = await waitFor(() => q('aside[aria-label="Commit details"]', L()));
await clickButton("Cherry-pick", detail2);
const apply = await waitFor(() => qa("button", detail2).find((x) => /^Apply to/.test(text(x))), { what: "the Apply button" });
apply.click();
const banner = await waitFor(() => q(".glog__ops", L()), { what: "the cherry-pick conflict banner", timeout: 30000 });
check("a clashing cherry-pick stops and the Log banner offers Continue and Abort", !!findButton("Abort", banner) && !!findButton("Continue", banner), text(banner));
await snap("cherry-pick-conflict");
await clickButton("Abort", banner);
await waitFor(() => !q(".glog__ops", L()), { what: "the banner to clear after Abort", timeout: 30000 });
check("Abort: the banner is gone", true);
await finish();

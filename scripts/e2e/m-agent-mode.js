// (m) Agent mode with the mock provider through the real chain: switch the mode, start a run from the New run dialog, see it
// in Sessions, answer its permission request from the Needs-you inbox, finish, and check the run appears under review.
// Needs INTELY_MOCK_PROVIDER=1 (run.sh sets it). Nothing is written to the fixtures.
await waitForTree();
const modeRadio = (label) => qa('[role="radiogroup"][aria-label="Mode"] [role="radio"]').find((r) => text(r).startsWith(label));
check("Agent mode is available", modeRadio("Agent")?.getAttribute("aria-disabled") !== "true" && !modeRadio("Agent")?.disabled);
modeRadio("Agent").click();
const ws = await waitFor(() => q('[data-testid="agent-workspace"]'), { what: "the Agent workspace", timeout: 20000 });
check("the Agent workspace shows Sessions and the empty state", !!q('aside[aria-label="Agent sessions"]', ws) && /Pick a run or start a new one/.test(text(ws)), text(ws).slice(0, 200));

await clickButton("New run", ws);
const dlg = await waitFor(() => qa('[role="dialog"]').find((d) => /New agent run/.test(text(d))), { what: "the New agent run dialog" });
await roleMode(dlg);
const roles = qa('[role="radio"]', q('[aria-label="Role"]', dlg)).map((r) => text(r));
check("the dialog offers the mock roles and the Claude roles", roles.some((r) => r.startsWith("mock-tool-permission")) && roles.some((r) => r.startsWith("developer")), roles.join(" | ").slice(0, 300));
const wanted = await waitFor(() => qa('[role="radio"]', dlg).find((b) => text(b).startsWith("mock-tool-permission")), { what: "the mock role" });
wanted.click();
await waitFor(() => wanted.getAttribute("aria-checked") === "true", { what: "the role to be picked" });
await sleep(150);
for (const b of qa('[aria-label="Repositories"] button', dlg)) {
  const want = text(b).includes("shop-backend");
  if ((b.getAttribute("aria-pressed") === "true") !== want) b.click();
}
await sleep(100);
// The dialog opens in Automatic, which asks nothing: this scenario answers a permission request, so it runs in the role's own mode (Edit automatically).
check("the dialog opens in Automatic and offers the five modes", /Automatic/.test(text(q(".mode-card[aria-checked='true']", dlg))) && qa(".mode-card", dlg).length === 5, qa(".mode-card", dlg).map((c) => `${c.dataset.mode}:${c.getAttribute("aria-checked")}`).join(" "));
await pickMode(dlg, "edit");
await typeInto(q('textarea[aria-label="Prompt"]', dlg), "write a note");
await clickButton("Start run", dlg);
await waitFor(() => !dlg.isConnected || !qa('[role="dialog"]').includes(dlg), { what: "the dialog to close", timeout: 30000 });

const sessions = () => q('aside[aria-label="Agent sessions"]');
const inboxButton = () => qa("button", sessions()).find((b) => /^Inbox/.test(text(b)));
await waitFor(() => qa(".run-card", sessions()).length === 1, { what: "the run in Sessions", timeout: 30000 });
check("Sessions lists the new run with its role", /mock-tool-permission/.test(text(sessions())), text(sessions()).slice(0, 300));
const card = await waitFor(() => q('section[aria-label="Permission request"]', ws), { what: "the permission request", timeout: 30000 });
check("the run waits for me: the request names the file", /notes\.txt/.test(text(card)), text(card).slice(0, 200));
check("the Agent switch counts the request", /Agent\s*1/.test(text(modeRadio("Agent"))) || /1/.test(text(modeRadio("Agent"))), text(modeRadio("Agent")));
await shot("agent-mode-needs-you");

// answer from the inbox
inboxButton().click();
const inbox = () => q('section.inbox');
await waitFor(() => inbox() && q('section[aria-label="Permission request"]', inbox()), { what: "the Needs-you inbox with the request" });
check("the inbox shows the request with a button to open the run", /1 request/.test(text(inbox())) && qa("button", inbox()).some((b) => /Open run/.test(text(b))), text(inbox()).slice(0, 200));
await clickButton("Allow once", q('section[aria-label="Permission request"]', inbox()));
await waitFor(() => /Done|Ready/.test(text(sessions())), { what: "the run to finish", timeout: 60000 });
inboxButton().click(); // back to the run
await waitFor(() => /notes\.txt written/.test(text(ws)), { what: "the finished transcript", timeout: 30000 });
check("Allow once let the call through and the run finished", /Allowed once by you/.test(text(ws)) && /notes\.txt written/.test(text(ws)), text(ws).slice(0, 300));
check("the finished run is listed under Ready for review or Done", /Ready for review|Done|Finished/.test(text(sessions())), text(sessions()).slice(0, 300));
await shot("agent-mode-finished");
modeRadio("Editor").click();
await waitFor(() => !q('[data-testid="agent-workspace"]') || q('[data-testid="agent-workspace"]').offsetParent === null, { what: "Editor mode to hide the Agent workspace" });
check("switching back to Editor mode shows the Changes tree again", !!(await findRow(repoRowSel("shop-backend"))));
await finish();

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RULES } from "../../licenses/publish-scan.mjs";
import { loadForbidden, loadLocalRules, scanStrings } from "../lib/rules.mjs";
import { loadPlan, readmeShots, snippets } from "../make-readme-assets.mjs";

const FILE = fileURLToPath(new URL("../plan.json", import.meta.url));
const plan = JSON.parse(readFileSync(FILE, "utf8"));

// The README alt texts of (design notes: release-ci-spec) 6.6; the README writer copies them from plan.json.
const ALT = {
  "changes-tree": "IntelyIDE Changes view: four repositories in one tree, each file tagged with its repository and branch, with one commit message box for the checked files.",
  "push-confirm": "Push dialog for a live branch: the exact branch name must be typed before the Push button is enabled.",
  "diff-graph": "Split diff of a changed file next to the branch graph of the repository.",
  "agent-approval": "Agent chat with an approval drawer; the transcript shows that a git commit attempt by the agent was refused.",
  rewind: "Rewind view listing the snapshot taken before an agent run, with a Restore action per repository.",
  welcome: "Welcome screen listing recent workspaces with their repositories and buttons to open a folder or scan for repositories.",
};
const DISCLOSURE = "The screenshots show a fictional company on a generated demo workspace. The agent, approval and Rewind screens use a scripted demo provider, not a model; the window frame is drawn afterwards.";
const IDS = ["changes-tree", "commit", "hunks", "push-confirm", "diff-graph", "agent-approval", "rewind", "welcome", "remote", "mongo", "about", "palette", "appearance", "editor", "overview", "preview", "providers", "api-contract"];
// The six README shots of the original contract (exact alt texts above) plus the ones added later for the gallery.
const README_IDS = ["changes-tree", "push-confirm", "diff-graph", "agent-approval", "rewind", "welcome", "remote", "mongo", "palette", "appearance", "overview", "preview", "providers", "api-contract"];

test("plan has the shots of the spec in order, with unique ids and all fields", () => {
  assert.deepEqual(plan.shots.map((s) => s.id), IDS);
  assert.deepEqual(plan.shots.map((s) => s.order), IDS.map((_, i) => i + 1));
  for (const s of plan.shots) {
    for (const k of ["id", "order", "title", "alt", "caption", "scene", "readme", "hero", "hu", "requires", "blockedBy", "extras"]) assert.ok(k in s, `${s.id}.${k}`);
    assert.match(s.id, /^[a-z][a-z0-9-]*$/);
    assert.ok(s.alt.length > 10 && s.title && s.caption && s.scene);
    assert.ok(Array.isArray(s.requires));
    assert.equal(s.extras, !s.readme, `${s.id}: extras is the complement of readme`);
  }
});

test("README set: the six original ids keep their exact alt texts, the gallery ids have one of their own, one hero, and the disclosure", () => {
  const readme = plan.shots.filter((s) => s.readme);
  assert.deepEqual(readme.map((s) => s.id), README_IDS);
  for (const s of readme) {
    if (ALT[s.id]) assert.equal(s.alt, ALT[s.id], s.id);
    else assert.ok(s.alt.length > 20 && s.alt.endsWith("."), `${s.id}: alt text`);
  }
  assert.deepEqual(plan.shots.filter((s) => s.hero).map((s) => s.id), ["changes-tree"]);
  assert.equal(plan.disclosure, DISCLOSURE);
});

test("blockedBy is set on about and nowhere else", () => {
  assert.ok(plan.shots.find((s) => s.id === "about").blockedBy);
  assert.deepEqual(plan.shots.filter((s) => s.blockedBy).map((s) => s.id), ["about"]);
});

test("make-readme-assets reads the plan: one snippet per README shot with the plan alt texts", () => {
  const p = { disclosure: plan.disclosure, shots: plan.shots };
  assert.equal(readmeShots(p).length, README_IDS.length);
  const out = snippets(p).trimEnd().split("\n");
  assert.equal(out.length, README_IDS.length);
  assert.ok(out[0].includes('srcset="docs/screenshots/changes-tree-dark.png"') && out[0].includes('width="900"'));
  assert.equal(typeof loadPlan(FILE).disclosure, "string");
});

test("plan.json passes the project's publish-scan RULES and the shot rules, and holds no owner literal", () => {
  const text = readFileSync(FILE, "utf8");
  for (const r of RULES.filter((x) => !x.files)) {
    for (const [i, line] of text.split("\n").entries()) assert.ok(!r.re.test(line), `rule ${r.id} matches plan.json line ${i + 1}`);
  }
  const forbidden = loadForbidden();
  const err = scanStrings([{ field: "plan", text }], { shot: "", forbidden }).filter((f) => f.severity === "error");
  assert.deepEqual(err, []);
  const local = loadLocalRules();
  if (local) assert.deepEqual(scanStrings([{ field: "plan", text }], { shot: "", forbidden, local }).filter((f) => f.rule.startsWith("local:")), []);
});

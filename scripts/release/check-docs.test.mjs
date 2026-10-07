// node --test scripts/release/check-docs.test.mjs
// Fixture trees live under the system temp dir; nothing reads the network or runs git.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkDocs, detectHungarian, forbiddenWording, gatekeeperFindings, githubSlug, headingsOf, linksAndImages, main } from "./check-docs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "check-docs.mjs");
const REAL_SET = readFileSync(join(HERE, "public-set.json"), "utf8");

// Lines 16 and 17 of docs/safety.md as they were before the English rewrite (R7): Hungarian, partly without diacritics.
const SAFETY_HU = "| 7 | Agent kemény korlatok / policy | Az agentek tool-policyja es hard stop-jai. **Beta-H1 (irhato mod):** (a) *vedett utvonal argumentumkent barmely toolnal hard stop*: `.git/**`, `.husky`, `.claude`, az IDE state konyvtara, lockfile-ok neve barmely nem-olvaso program argumentumaban (`sort -o`, `awk -i inplace`, `xxd -r`, `git checkout-index --prefix`, `git checkout -- <lockfile>`, `python x.py .git/config`, interpreter-kod tokenjei), csak az olvaso programok (cat, head, tail, ls, grep, rg, sed -n, awk read, find, diff, ... kimeneti opcio nelkul) es az olvaso git alparancsok kivetelek; (b) *script-indirekcio feloldva*: `npm/pnpm/yarn run <script>` (+ `npm test|start`, `install` eletciklus-scriptek: preinstall/install/postinstall/prepare), `make <target>` (recept + prereqek), `bash/sh/source x.sh`, `./x.sh`, `node/python/ruby/perl x` — a script szoveget a policy atnezi; git iro ige vagy vedett utvonal = hard stop (`script.git-write`, `script.protected-path`, shell-scripteknel a teljes shell-elemzes), egyebkent **Ask, a feloldott szoveggel** (`exec.script`), es soha nem mentett allow; hook-telepitok (`husky install`, `lefthook install`, `pre-commit install`...) hard stop; (c) *alacsony kockazatu olvasas auto-allow* Edit/Auto szerepkorben: `ls, pwd, cat, head, wc, grep, rg`, `git status/log/diff/show/rev-parse/ls-files/blame`, `node --check <fajl>`, ha minden operandus a munkakonyvtarban van, nem titok es nem vedett, nincs atiranyitas fajlba, nincs glob/valtozo (`exec.low-risk-read`); (d) *path-jail*: `PolicyContext.strict_jail` (a host mindig bekapcsolja): a Write/Edit/NotebookEdit a futas repoin + a csak-olvashato attachment konyvtaron kivul **hard stop** (`fs.outside-jail`), nem Ask. **Best-effort** marad: egy modell altal inditott tetszoleges program nem zarhato be teljesen — ezert 8. reteg a mentoov. **Beta-H5:** (e) *shell iras exec-feluleti fajlra*: atiranyitas (`>`, `>>`, `>|`), `tee`, `cp`/`mv`/`install`/`ln`, `sed -i`, `perl -pi`, `awk -i inplace`, `dd of=` stb., amelynek celja exec-feluleti fajl (hook, lint-staged, `package.json`, eszkoz-konfig, CI) = Ask `exec.write-exec-surface` (\"executes code when you commit, push, install, lint, test or build\"), soha nem mentett allow; a vedett utak (`.git`, `.husky`) maradnak hard stop. (f) *Commit panel figyelmeztetes*: ha egy pipalt fajl exec-feluleti (`exec_surface_check` Tauri parancs, egyetlen forras: `policy::paths::exec_surface_flags`), nem blokkolo sav jelenik meg repo-jelvennyel es agent-jelolessel; elrejtheto, uj ilyen fajlnal visszater; a **Commit and Push** megerosito parbeszedet ker a fajlok listajaval (a human mindig folytathatja). | `crates/agent_core/src/policy/**`, `agent_host/src/run.rs` | `agent_core/tests/bypass.rs` (BLOCK +38 string, `SCRIPT_BLOCK` 33 string, `SCRIPT_ASK`, auto-allow es strict jail tesztek) |\n| 7b | **Git shim mindig** | A host minden claude session elott legyartja a PATH-elso `git` shimet (`shim::generate`; hiba = a futas nem indul), es a sidecar `edit` session-t `env.shimDir` nelkul visszautasit. A shim allow-lista (olvaso alparancsok + `git add <fajl>`); a policy hook fogja az abszolut utas `/usr/bin/git`-et. | `agent_gate/src/shim.rs`, `agent_host`, `sidecar/src/adapters/claude-sdk/session.ts` | `agent_gate tests/shim.rs`, `sidecar claude-units` |";
// The same idea in plain ASCII Hungarian (no accent at all): only the function-word rule can see it.
const ASCII_HU = "Ez a reteg csak akkor fut, ha a repo nem tartozik a fixture gyokerhez, es minden mas kivetel nincs, mint amit a tesztek mar lefednek.";
const ENGLISH = "The exec guard looks at the argument list before any process starts. It refuses mutating subcommands and any attempt to redirect the repository path.";

const made = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** A fixture tree with the real public-set.json and the given files. */
function tree(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "chkdocs-"));
  made.push(root);
  mkdirSync(join(root, "scripts/release"), { recursive: true });
  writeFileSync(join(root, "scripts/release/public-set.json"), REAL_SET);
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { dev: "x", "dev:app": "x", "release:test": "x" } }));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}
const run = (root, opts = {}) => checkDocs({ root, ...opts }).fails;
const rules = (fails) => fails.map((f) => f.rule);
const doc = (body, title = "Thing") => `# ${title}\n\nThis page explains the thing.\n\n${body}\n`;

describe("language detector", () => {
  it("flags the Hungarian rows of the old docs/safety.md (accented and ASCII)", () => {
    const r = detectHungarian(SAFETY_HU);
    assert.ok(r.lines.length >= 2, JSON.stringify(r.lines));
    assert.equal(r.flagged, true);
    assert.ok(r.ratio > 0.03);
  });

  it("flags ASCII Hungarian that has no accent at all", () => {
    assert.equal(/[áéíóöőúüű]/i.test(ASCII_HU), false);
    const r = detectHungarian(ASCII_HU);
    assert.deepEqual(r.lines.map((l) => l.reason), ["function-words"]);
  });

  it("flags two accented letters on one line and passes one", () => {
    assert.equal(detectHungarian("Ez egy kérdés: ő nem jött.").lines[0].reason, "accents");
    assert.equal(detectHungarian("The café is open").lines.length, 0);
  });

  it("passes English text", () => {
    const r = detectHungarian(`${ENGLISH}\n${ENGLISH}\n${ENGLISH}`);
    assert.deepEqual(r.lines, []);
    assert.equal(r.flagged, false);
  });

  it("ignores inline code", () => {
    assert.equal(detectHungarian("Run `az es nem egy hogy` to see it.").lines.length, 0);
  });

  it("flags a Hungarian doc through the checker and honours the per-file allowlist", () => {
    const body = `${SAFETY_HU}\n`;
    const bad = tree({ "docs/faq.md": doc(body) });
    assert.ok(rules(run(bad)).includes("language"));
    const allowed = tree({ "docs/i18n.md": doc(body) });
    assert.ok(!rules(run(allowed)).includes("language"));
    const ok = tree({ "docs/faq.md": doc(ENGLISH) });
    assert.ok(!rules(run(ok)).includes("language"));
  });

  it("--all-text also scans code files", () => {
    const root = tree({ "scripts/tool.mjs": `// ${ASCII_HU}\nexport {};\n` });
    assert.deepEqual(rules(run(root)), []);
    assert.ok(rules(run(root, { allText: true })).includes("language"));
  });
});

describe("forbidden wording", () => {
  const hit = (t) => forbiddenWording(t).map((x) => x.term);

  it("flags each forbidden word", () => {
    assert.deepEqual(hit("It is secure."), ["secure"]);
    assert.deepEqual(hit("Safe for everyone."), ["safe"]);
    assert.deepEqual(hit("A blazing fast tool."), ["blazing"]);
    assert.deepEqual(hit("It runs fully local."), ["fully local"]);
    assert.deepEqual(hit("Works 100% of the time."), ["100%"]);
    assert.deepEqual(hit("An unhackable design."), ["unhackable"]);
    assert.deepEqual(hit("Results are guaranteed."), ["guaranteed"]);
  });

  it("flags each forbidden phrase", () => {
    assert.deepEqual(hit("The agent cannot commit."), ["cannot commit"]);
    assert.deepEqual(hit("It will never commit anything."), ["never commit"]);
    assert.deepEqual(hit("Every run can be undone."), ["can be undone"]);
    assert.deepEqual(hit("We give you a guarantee."), ["guarantee"]);
    assert.deepEqual(hit("Agents are blocked from committing."), ["blocked from committing"]);
    assert.deepEqual(hit("It cannot push to main."), ["cannot push"]);
  });

  it("is satisfied by best-effort in the same sentence only", () => {
    assert.deepEqual(hit("Best-effort protections mean the agent cannot commit."), []);
    assert.deepEqual(hit("The agent cannot commit. Protections are best-effort."), ["cannot commit"]);
    assert.deepEqual(hit("The layers are best effort, not a guarantee."), []);
  });

  it("accepts a negated safe, secure or guarantee", () => {
    assert.deepEqual(hit("Write mode is not judged safe for unattended use."), []);
    assert.deepEqual(hit("There is no guarantee."), []);
    assert.deepEqual(hit("This is not a secure sandbox."), []);
    assert.deepEqual(hit("Write mode is judged safe."), ["safe"]);
  });

  it("does not see code, comments, link targets or look-alikes", () => {
    assert.deepEqual(hit("Run `secure` or\n```\nsafe\n```\n<!-- guarantee -->\n[docs](https://x.test/secure)"), []);
    assert.deepEqual(hit("A safety snapshot, a failsafe, safe-guard."), []);
  });

  it("keeps abbreviations inside one sentence", () => {
    assert.deepEqual(hit("Best-effort layers, e.g. the shim, mean it cannot commit by accident."), []);
  });

  it("reports a line and supports an explained allow marker only", () => {
    const withReason = tree({ "docs/faq.md": doc("<!-- check-docs: allow wording -- quoted from the licence -->\nThis is secure.") });
    assert.ok(!rules(run(withReason)).includes("forbidden-word"));
    const noReason = tree({ "docs/faq.md": doc("<!-- check-docs: allow wording -->\nThis is secure.") });
    assert.ok(rules(run(noReason)).includes("allow-marker-no-reason"));
    const plain = tree({ "docs/faq.md": doc("Intro.\n\nThis is secure.") });
    const f = run(plain).find((x) => x.rule === "forbidden-word");
    assert.equal(f.line, 7);
  });
});

describe("Gatekeeper-weakening advice", () => {
  const terms = (t, o) => gatekeeperFindings(t, o).map((x) => x.term);

  it("flags xattr, master-disable and the quarantine attribute anywhere", () => {
    assert.deepEqual(terms("xattr -d com.apple.quarantine App.app"), ["xattr", "quarantine"]);
    assert.deepEqual(terms("```\nspctl --master-disable\n```"), ["spctl --master-disable"]);
    assert.deepEqual(terms("open --no-quarantine"), ["quarantine"]);
  });

  it("flags sudo next to Gatekeeper tooling, and any sudo in the README", () => {
    assert.deepEqual(terms("sudo spctl --add App.app"), ["sudo"]);
    assert.deepEqual(terms("sudo xcode-select --install"), []);
    assert.deepEqual(terms("sudo xcode-select --install", { strictSudo: true }), ["sudo"]);
  });

  it("flags advice to disable Gatekeeper but not its negation or the verify commands", () => {
    assert.deepEqual(terms("Disable Gatekeeper and try again."), ["disable Gatekeeper"]);
    assert.deepEqual(terms("Choose Allow apps from anywhere."), ["allow apps from anywhere"]);
    assert.deepEqual(terms("Never disable Gatekeeper."), []);
    assert.deepEqual(terms("`spctl -a -vv /Applications/IntelyIDE.app` prints rejected for an ad-hoc build."), []);
  });

  it("is applied by the checker, hidden comments included", () => {
    const root = tree({ "docs/faq.md": doc("<!--\nxattr -d x\n-->") });
    assert.ok(rules(run(root)).includes("gatekeeper"));
  });
});

describe("markdown structure", () => {
  it("slugs headings like GitHub", () => {
    assert.equal(githubSlug("Is it right for you?"), "is-it-right-for-you");
    assert.equal(githubSlug("Status and known `limitations`"), "status-and-known-limitations");
    const hs = headingsOf("# A\n## B\n## B\n```\n# no\n```\n");
    assert.deepEqual(hs.map((h) => h.slug), ["a", "b", "b-1"]);
  });

  it("requires one H1 and no skipped level", () => {
    const two = tree({ "docs/faq.md": "# A\n\nPurpose of the page.\n\n# B\n" });
    assert.ok(rules(run(two)).includes("h1-count"));
    const skip = tree({ "docs/faq.md": doc("### Deep") });
    assert.ok(rules(run(skip)).includes("heading-skip"));
    const none = tree({ "docs/faq.md": "Purpose without a title.\n" });
    assert.ok(rules(run(none)).includes("h1-count"));
    assert.deepEqual(rules(run(tree({ "docs/faq.md": doc("## Fine\n\n### Fine too") }))), []);
  });

  it("requires a purpose sentence in docs", () => {
    assert.ok(rules(run(tree({ "docs/faq.md": "# T\n\n- list first\n" }))).includes("purpose"));
    assert.ok(rules(run(tree({ "docs/faq.md": "# T\n\n## Next\n" }))).includes("purpose"));
    assert.ok(!rules(run(tree({ "docs/faq.md": doc("x") }))).includes("purpose"));
  });

  it("flags owner home paths without echoing them, and passes generic examples", () => {
    const bad = tree({ "docs/faq.md": doc("See /Users/" + "jdoe/Projects/x for details.") });
    const f = run(bad).find((x) => x.rule === "owner-path");
    assert.ok(f);
    assert.equal(JSON.stringify(f).includes("jdoe"), false);
    assert.deepEqual(rules(run(tree({ "docs/faq.md": doc("Use /Users/" + "you/Projects/x or /Users/" + "example/p.") }))), []);
  });

  it("bare click-here link text is refused", () => {
    const root = tree({ "docs/faq.md": doc("[click here](faq.md) and [here](faq.md)") });
    assert.equal(rules(run(root)).filter((r) => r === "bare-link-text").length, 2);
  });
});

describe("links, anchors and images", () => {
  it("resolves relative links, anchors and nested badge links", () => {
    const root = tree({
      "README.md": "# R\n\nIntro sentence.\n\n[![Licence](https://img.test/l.svg)](LICENSE)\n\n## Install\n\nSee [faq](docs/faq.md#questions), [self](#install) and [dir](docs/).\n",
      LICENSE: "x",
      "docs/faq.md": doc("## Questions"),
    });
    assert.deepEqual(rules(run(root)), []);
  });

  it("reports a missing file, a missing anchor, a private doc and an escape from the root", () => {
    const root = tree({
      "README.md": "# R\n\nIntro.\n\n[a](docs/none.md) [b](docs/faq.md#nope) [c](docs/PROGRESS.md) [d](../up.md) [e](#gone)\n",
      "docs/faq.md": doc("## Questions"),
      "docs/PROGRESS.md": "# P\n",
    });
    assert.deepEqual(rules(run(root)).sort(), ["anchor-missing", "anchor-missing", "link-missing", "link-outside", "link-private"]);
  });

  it("ignores external links and finds HTML links, images and picture sources", () => {
    const text = '<a href="https://x.test">x</a> <a href="docs/faq.md">go</a>\n<picture><source media="(prefers-color-scheme: dark)" srcset="a-dark.png"><img src="a.png" alt="A" width="900"></picture>\n![ok](b.png) ![](c.png)';
    const { links, images } = linksAndImages(text);
    assert.deepEqual(links.map((l) => l.target), ["https://x.test", "docs/faq.md"]);
    const a = images.find((i) => i.src === "a.png");
    assert.equal(a.inPicture, true);
    assert.equal(a.darkSource, true);
    assert.deepEqual(a.srcset, ["a-dark.png"]);
    assert.equal(images.find((i) => i.src === "c.png").alt, "");
  });

  it("requires alt text", () => {
    const root = tree({ "docs/faq.md": doc("![](x.png)"), "docs/x.png": "" });
    assert.ok(rules(run(root)).includes("alt-missing"));
  });

  it("does not check code samples", () => {
    const root = tree({ "docs/faq.md": doc("```\n[a](nope.md)\n```\nAnd `[b](nope.md)` inline.") });
    assert.deepEqual(rules(run(root)), []);
  });
});

describe("commands and environment variables", () => {
  const files = {
    "crates/core/src/env.rs": 'const A: &str = "INTELY_READONLY";',
    "scripts/dev.sh": "#!/bin/sh\n",
    "scripts/release/maintainer/tool.mjs": "",
  };

  it("accepts package scripts, builtins, scripts paths and defined variables", () => {
    const root = tree({ ...files, "docs/building.md": doc("Run `pnpm dev:app`, `pnpm install`, `pnpm run dev`, `pnpm -C ui dev` and `scripts/dev.sh`.\nSet `INTELY_READONLY=1`.\n\n```\npnpm install --frozen-lockfile && pnpm release:test\n```") });
    assert.deepEqual(rules(run(root)), []);
  });

  it("flags unknown scripts, missing and non-public script paths, unknown variables, private doc references", () => {
    const root = tree({
      ...files,
      "docs/building.md": doc("Run `pnpm nonsense` or `pnpm run ghost`.\nUse `scripts/nothing.sh` and `scripts/release/maintainer/tool.mjs`.\nSet `INTELY_MADE_UP=1`.\nSee `docs/PROGRESS.md`."),
      "docs/PROGRESS.md": "# P\n",
    });
    const msgs = run(root).map((f) => `${f.rule}`);
    assert.deepEqual(
      [...new Set(msgs)].sort(),
      ["command-missing", "doc-ref-private", "env-unknown"],
    );
    assert.equal(msgs.filter((m) => m === "command-missing").length, 4);
  });

  it("skips placeholders", () => {
    const root = tree({ ...files, "docs/building.md": doc("Run `pnpm <script>`, `pnpm exec/dlx`, `scripts/<name>.sh` and `INTELY_*`.") });
    assert.deepEqual(rules(run(root)), []);
  });
});

describe("--release", () => {
  const rel = (root) => run(root, { release: true });

  it("flags unresolved markers only in release mode", () => {
    const body = "TODO write this.\n\nUse <your-token> here.\n\nVersion YYYY-MM-DD.\n\n## Signed builds (pending the packaging spec)\n\nOk.";
    const root = tree({ "docs/releasing.md": doc(body) });
    assert.deepEqual(rules(run(root)), []);
    const r = rel(root);
    assert.equal(r.filter((f) => f.rule === "unresolved").length, 4, JSON.stringify(r));
  });

  it("ignores placeholders in code and real HTML tags", () => {
    const root = tree({ "docs/releasing.md": doc("Name `IntelyIDE_<version>.dmg` and <kbd>Cmd</kbd>.\n\n```\n<placeholder> TODO\n```") });
    assert.deepEqual(rel(root), []);
  });

  it("checks the changelog date", () => {
    const text = "# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - YYYY-MM-DD\n\n### Added\n\n- Things.\n";
    const root = tree({ "CHANGELOG.md": text });
    assert.deepEqual(rules(run(root)), []);
    assert.ok(rules(rel(root)).includes("unresolved"));
    const good = tree({ "CHANGELOG.md": text.replace("YYYY-MM-DD", "2026-10-04") });
    assert.deepEqual(rel(good), []);
  });

  it("checks the changelog format", () => {
    const wrongFirst = tree({ "CHANGELOG.md": "# C\n\n## [0.1.0] - 2026-01-01\n\n## [Unreleased]\n" });
    assert.ok(rules(run(wrongFirst)).includes("changelog-format"));
    const order = tree({ "CHANGELOG.md": "# C\n\n## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n\n## [0.2.0] - 2026-02-01\n" });
    assert.ok(rules(run(order)).includes("changelog-format"));
    const section = tree({ "CHANGELOG.md": "# C\n\n## [Unreleased]\n\n### Misc\n" });
    assert.ok(rules(run(section)).includes("changelog-format"));
  });

  describe("README images against the screenshot manifest", () => {
    const png = Buffer.from("fake-png-bytes");
    const sha = createHash("sha256").update(png).digest("hex");
    const readme = (src) => `# IntelyIDE\n\nIntro sentence.\n\n![Changes tree](${src})\n`;
    const manifest = (over = {}) => JSON.stringify({ schema: 1, files: [{ file: "changes-tree-light.png", sha256: sha, reviewedSha256: sha, ...over }] }, null, 2) + "\n";
    const build = (extra = {}, src = "docs/screenshots/changes-tree-light.png") => {
      const root = tree({ "README.md": readme(src), ...extra });
      mkdirSync(join(root, "docs/screenshots"), { recursive: true });
      if (!extra.__skipPng) writeFileSync(join(root, "docs/screenshots/changes-tree-light.png"), png);
      return root;
    };

    it("passes when image, manifest hash and review agree", () => {
      assert.deepEqual(rel(build({ "docs/screenshots/MANIFEST.json": manifest() })), []);
    });

    it("is not checked without --release (the files may not exist yet)", () => {
      const root = tree({ "README.md": readme("docs/screenshots/later.png") });
      assert.deepEqual(rules(run(root)), []);
      assert.ok(rules(rel(root)).includes("image-missing"));
    });

    it("fails on a missing manifest, a missing entry, a stale hash and a missing review", () => {
      assert.ok(rules(rel(build())).includes("manifest"));
      assert.ok(rel(build({ "docs/screenshots/MANIFEST.json": JSON.stringify({ files: [] }) })).some((f) => f.rule === "manifest" && /not listed/.test(f.detail)));
      assert.ok(rel(build({ "docs/screenshots/MANIFEST.json": manifest({ sha256: "0".repeat(64) }) })).some((f) => /does not match/.test(f.detail ?? "")));
      assert.ok(rel(build({ "docs/screenshots/MANIFEST.json": manifest({ reviewedSha256: "" }) })).some((f) => /not been reviewed/.test(f.detail ?? "")));
    });

    it("--approve records the review and a re-shoot invalidates it", () => {
      const root = build({ "docs/screenshots/MANIFEST.json": manifest({ reviewedSha256: "" }) });
      const out = [];
      const sink = { write: (x) => out.push(x) };
      assert.equal(main(["--root", root, "--approve", "docs/screenshots/changes-tree-light.png"], { out: sink, err: sink }), 0);
      assert.match(out.join(""), /^approved /);
      assert.deepEqual(rel(root), []);
      assert.equal(main(["--root", root, "--approve", "docs/screenshots/changes-tree-light.png"], { out: sink, err: sink }), 0);
      assert.match(out.join(""), /already approved/);
      writeFileSync(join(root, "docs/screenshots/changes-tree-light.png"), "changed");
      assert.ok(rel(root).some((f) => /does not match/.test(f.detail ?? "")));
      assert.equal(main(["--root", root, "--approve", "docs/screenshots/changes-tree-light.png"], { out: sink, err: sink }), 3);
    });
  });
});

describe("command line", () => {
  const exec = (root, ...args) => spawnSync(process.execPath, [SCRIPT, "--root", root, ...args], { encoding: "utf8", env: { PATH: process.env.PATH } });

  it("prints FAIL lines and RESULT, exits 1 on violations and 0 when clean", () => {
    const bad = tree({ "docs/faq.md": doc("This is secure.") });
    let r = exec(bad);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL forbidden-word docs\/faq\.md:5 secure/);
    assert.match(r.stdout, /RESULT: VIOLATIONS/);
    r = exec(tree({ "docs/faq.md": doc("Fine text.") }));
    assert.equal(r.status, 0);
    assert.match(r.stdout, /RESULT: OK/);
  });

  it("--only checks one file but still resolves links against the tree", () => {
    const root = tree({ "docs/faq.md": doc("This is secure."), "docs/getting-started.md": doc("See [faq](faq.md) and [x](missing.md).") });
    const r = exec(root, "--only", "docs/getting-started.md", "--json");
    assert.equal(r.status, 1);
    const j = JSON.parse(r.stdout);
    assert.deepEqual(j.fails.map((f) => f.rule), ["link-missing"]);
    assert.equal(j.files, 1);
    assert.equal(exec(root, "--only", "docs/nothing.md").status, 3);
  });

  it("usage and environment problems exit 3", () => {
    const root = tree({});
    assert.equal(exec(root, "--bogus").status, 3);
    assert.equal(exec(root, "--only").status, 3);
    const noSet = mkdtempSync(join(tmpdir(), "chkdocs-"));
    made.push(noSet);
    assert.equal(exec(noSet).status, 3);
  });

  it("writes nothing (a clean run leaves the tree untouched)", () => {
    const root = tree({ "docs/faq.md": doc("Fine text.") });
    const before = readFileSync(join(root, "docs/faq.md"), "utf8");
    exec(root);
    assert.equal(readFileSync(join(root, "docs/faq.md"), "utf8"), before);
  });
});

// node --test scripts/release/check-readme.test.mjs
// Fixture trees under the system temp dir; no network, no git.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CLAIMS, NAV, NOT_AFFILIATED, PITCH, SECTIONS, checkReadme, main } from "./check-readme.mjs";
import { applyState } from "./readme-toggle.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "check-readme.mjs");
const REAL_SET = readFileSync(join(HERE, "public-set.json"), "utf8");

const made = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const BODY = {
  "Why IntelyIDE": "A feature that touches an API, an admin UI and a mobile app usually means three or four Git windows.\n\nIntelyIDE shows the changed files of every open repository in one Changes tree.",
  Features: "- Shared Changes tree.\n- Agents with Rewind and an approval drawer.\n- 53 languages.",
  "Is it right for you?": "For people who change several repositories for one piece of work.",
  "Safety model": "Layered, best-effort protections: policy hard stops do the real work and the git shim is a speed bump that an absolute path bypasses.",
  "Status and known limitations": "Stable. Write mode is not judged safe for unattended use.",
  Install: [
    "<!--dmg:available-->",
    "### macOS installer (DMG)",
    "1. Download the file for your Mac from the Releases page.",
    "2. First launch. <!--dmg:v:adhoc,developer-id-->Choose Open Anyway in Privacy & Security.<!--/dmg:v--><!--dmg:v:notarized-->It opens normally.<!--/dmg:v-->",
    "<!--/dmg:available-->",
    "<!--dmg:pending-->",
    "### macOS installer",
    "A macOS installer (DMG) will be attached to the Releases page when it has been verified. Until then, build from source.",
    "<!--/dmg:pending-->",
  ].join("\n"),
  "First run": "The installed app starts in normal mode. Run `pnpm dev:app` for a read-only session.",
  Requirements: "macOS 13.5 or later and git 2.30 or newer.",
  "Build from source": "Run `pnpm dev:app` after `pnpm install`.",
  Configuration: "Settings live in the application support folder.",
  Privacy: "No telemetry. See [privacy](docs/privacy.md).",
  FAQ: "See [the FAQ](docs/faq.md).",
  Documentation: "See [the index](docs/README.md).",
  Contributing: "See [CONTRIBUTING.md](CONTRIBUTING.md).",
  License: `GPL-3.0-or-later (GNU GPL version 3 or any later version), see [LICENSE](LICENSE).\n\n${NOT_AFFILIATED}`,
  Acknowledgements: "Tauri, SolidJS, Rust and Git.",
};

const STATUS_BOX = [
  "> [!NOTE]",
  "> IntelyIDE 1.0.1 is a stable release. The installed app starts in normal mode: like any Git client it can commit, push and save files in the repositories you open. The protections are layered and best-effort, not a guarantee. When started from source with `pnpm dev:app` it is read-only instead.",
].join("\n");

function readmeText(over = {}) {
  const sections = { ...BODY, ...(over.sections ?? {}) };
  const names = over.order ?? SECTIONS;
  const navLine = NAV.map((n) => `[${n}](#${n.toLowerCase().replace(/ /g, "-")})`).join(" · ");
  const head = over.head ?? [
    "# IntelyIDE",
    "",
    '<picture><source media="(prefers-color-scheme: dark)" srcset="assets/brand/lockup-horizontal-dark.svg"><img src="assets/brand/lockup-horizontal-light.svg" alt="IntelyIDE" width="360"></picture>',
    "",
    PITCH,
    "",
    navLine,
    "",
    "[![License](https://img.shields.io/badge/license-GPL--3.0--or--later-blue)](LICENSE) [![Status](https://img.shields.io/badge/status-stable-green)](#status-and-known-limitations) [![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)](#requirements)",
    "",
    STATUS_BOX,
    "",
  ].join("\n");
  return `${head}\n${names.map((n) => `## ${n}\n\n${sections[n] ?? "Text."}\n`).join("\n")}`;
}

/** A tree in which the README below passes. */
function tree({ readme = readmeText(), state = "none", files = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "chkreadme-"));
  made.push(root);
  const base = {
    "scripts/release/public-set.json": REAL_SET,
    "scripts/release/readme-state.json": `{ "dmg": "${state}" }\n`,
    "package.json": JSON.stringify({ scripts: { "dev:app": "x" } }),
    LICENSE: "x",
    "CONTRIBUTING.md": "# Contributing\n",
    "docs/privacy.md": "# Privacy\n\nWhat is stored.\n",
    "docs/faq.md": "# FAQ\n\nQuestions.\n",
    "docs/README.md": "# Docs\n\nIndex of the documentation.\n",
    "assets/brand/lockup-horizontal-light.svg": "<svg/>",
    "assets/brand/lockup-horizontal-dark.svg": "<svg/>",
    "crates/agent_gate/src/rewind.rs": "",
    "crates/agent_gate/src/shim.rs": "",
    "crates/core/src/jail.rs": "",
    "scripts/dev.sh": "",
    "scripts/release/verify-no-telemetry.mjs": "",
    README_PLACEHOLDER: undefined,
  };
  delete base.README_PLACEHOLDER;
  const all = { ...base, "README.md": readme, ...files };
  for (const [rel, content] of Object.entries(all)) {
    if (content === null) continue;
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  for (let i = 0; i < 53; i++) mkdirSync(join(root, "ui/src/i18n/locales", `l${i}`), { recursive: true });
  return root;
}
const check = (root, opts = {}) => checkReadme({ root, ...opts }).fails;
const fired = (fails) => [...new Set(fails.map((f) => f.rule))].sort();

describe("a conforming README", () => {
  it("passes in the shipped state (pending block visible)", () => {
    const root = tree({ readme: applyState(readmeText(), "none") });
    assert.deepEqual(check(root), []);
  });

  for (const state of ["adhoc", "developer-id", "notarized"]) {
    it(`passes in state ${state} when the toggle has been run`, () => {
      const root = tree({ readme: applyState(readmeText(), state), state });
      assert.deepEqual(check(root), []);
    });
  }

  it("exits 0 on the command line", () => {
    const root = tree({ readme: applyState(readmeText(), "none") });
    const r = spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /RESULT: OK/);
  });
});

describe("structure", () => {
  const none = (over) => tree({ readme: applyState(readmeText(over), "none") });

  it("requires the exact sections in order", () => {
    assert.deepEqual(fired(check(none({ order: SECTIONS.filter((s) => s !== "Privacy") }))), ["anchor-missing", "sections"].filter((r) => r === "sections"));
    const swapped = [...SECTIONS];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    assert.ok(check(none({ order: swapped })).some((f) => f.rule === "sections" && /out of order/.test(f.detail)));
    assert.ok(check(none({ order: [...SECTIONS, "Roadmap"] })).some((f) => f.rule === "sections" && /Roadmap/.test(f.detail)));
  });

  it("requires one H1 named IntelyIDE and no skipped levels", () => {
    assert.ok(fired(check(none({ head: "# Other\n\n" + PITCH + "\n" }))).includes("h1-text"));
    assert.ok(fired(check(none({ sections: { Features: "#### Deep\n\ntext" } }))).includes("heading-skip"));
    assert.ok(fired(check(none({ sections: { Features: "# Second H1" } }))).includes("h1-count"));
  });

  it("stays under 300 lines", () => {
    const long = Array.from({ length: 300 }, (_, i) => `- item ${i}`).join("\n");
    assert.ok(fired(check(none({ sections: { Features: long } }))).includes("length"));
  });

  it("requires the pitch, the logo picture, the navigation line and the status box", () => {
    const without = (text) => readmeText().replace(text, "");
    assert.ok(fired(check(tree({ readme: applyState(without(PITCH), "none") }))).includes("pitch"));
    assert.ok(fired(check(tree({ readme: applyState(without("assets/brand/lockup-horizontal-dark.svg"), "none") }))).includes("logo"));
    assert.ok(fired(check(tree({ readme: applyState(without("[Contributing](#contributing)"), "none") }))).includes("nav"));
    assert.ok(fired(check(tree({ readme: applyState(without(STATUS_BOX), "none") }))).includes("status-box"));
  });

  it("requires the status box to state the writable default and best-effort", () => {
    const box = (t) => readmeText().replace("The installed app starts in normal mode", t);
    assert.ok(check(tree({ readme: applyState(box("The installed app starts read-only"), "none") })).some((f) => f.rule === "status-box" && /writable/.test(f.detail)));
    const noBest = readmeText().replace("layered and best-effort", "layered");
    assert.ok(check(tree({ readme: applyState(noBest, "none") })).some((f) => f.rule === "status-box" && /best-effort/.test(f.detail)));
  });

  it("requires the licence strings and the not-affiliated sentence in the License section", () => {
    const lic = (t) => none({ sections: { License: t } });
    assert.equal(check(lic("GPL-3.0-or-later, any later version.")).filter((f) => f.rule === "license").length, 1);
    assert.equal(check(lic("MIT.")).filter((f) => f.rule === "license").length, 3);
  });
});

describe("images and badges", () => {
  const withBody = (head, state = "none") => tree({ readme: applyState(readmeText({ head }), state) });
  const HEAD = (extra = "", badges) =>
    readmeText().split("\n## Why IntelyIDE")[0].replace(
      /\[!\[License\][^\n]*/,
      badges ??
        "[![License](https://img.shields.io/badge/license-GPL-blue)](LICENSE) [![Status](https://img.shields.io/badge/status-stable-green)](#status-and-known-limitations) [![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)](#requirements)" + extra,
    );

  it("allows at most five badges and none of the banned kinds", () => {
    const five = " [![Release](https://img.shields.io/github/v/release/ferencfarkas09/IntelyIDE)](https://github.com/ferencfarkas09/IntelyIDE/releases) [![x](https://img.shields.io/badge/a-b-c)](LICENSE)";
    assert.deepEqual(fired(check(withBody(HEAD(five)))), []);
    const six = five + " [![y](https://img.shields.io/badge/c-d-e)](LICENSE)";
    assert.ok(fired(check(withBody(HEAD(six)))).includes("badges"));
    const banned = [" [![REUSE](https://api.reuse.software/badge/x)](LICENSE)", " [![stars](https://img.shields.io/github/stars/x/y)](LICENSE)", " [![coverage](https://img.shields.io/codecov/c/x)](LICENSE)"];
    for (const b of banned) assert.ok(check(withBody(HEAD(b))).some((f) => f.rule === "badges"), b);
  });

  it("requires the licence, status and platform badges", () => {
    const f = check(withBody(HEAD("", "[![License](https://img.shields.io/badge/license-GPL-blue)](LICENSE)")));
    assert.equal(f.filter((x) => x.rule === "badges").length, 2);
  });

  it("a workflow badge needs its workflow file", () => {
    const ci = " [![CI](https://github.com/ferencfarkas09/IntelyIDE/actions/workflows/ci.yml/badge.svg)](https://github.com/ferencfarkas09/IntelyIDE/actions/workflows/ci.yml)";
    assert.ok(check(withBody(HEAD(ci))).some((f) => f.rule === "badges" && /ci\.yml/.test(f.detail)));
    const root = tree({ readme: applyState(readmeText({ head: HEAD(ci) }), "none"), files: { ".github/workflows/ci.yml": "name: ci\n" } });
    assert.deepEqual(check(root), []);
  });

  it("a badge link target must resolve", () => {
    const f = check(withBody(HEAD("", "[![License](https://img.shields.io/badge/license-GPL-blue)](NOLICENSE) [![Status](https://x.test/status-stable)](#status-and-known-limitations) [![Platform](https://x.test/macOS)](#requirements)")));
    assert.ok(f.some((x) => x.rule === "link-missing"));
  });

  it("html images need alt text and width, and screenshots need a dark source", () => {
    const shot = (img, extra = "") => tree({ readme: applyState(readmeText({ sections: { Features: `${extra}${img}` } }), "none") });
    const good = '<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/a-dark.png"><img src="docs/screenshots/a-light.png" alt="Tree" width="900"></picture>';
    assert.deepEqual(check(shot(good)), []);
    assert.ok(fired(check(shot('<img src="docs/screenshots/a-light.png" alt="Tree" width="900">'))).includes("image-picture"));
    assert.ok(fired(check(shot(good.replace('alt="Tree"', 'alt=""')))).includes("alt-missing"));
    assert.ok(fired(check(shot(good.replace(' width="900"', '')))).includes("image-width"));
    assert.ok(fired(check(shot("![](x.svg)"))).includes("alt-missing"));
  });

  it("--release requires the screenshots to exist", () => {
    const img = '<picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/a-dark.png"><img src="docs/screenshots/a-light.png" alt="Tree" width="900"></picture>';
    const root = tree({ readme: applyState(readmeText({ sections: { Features: img } }), "none") });
    assert.deepEqual(check(root), []);
    assert.ok(fired(check(root, { release: true })).includes("image-missing"));
  });
});

describe("the DMG toggle", () => {
  it("fails when the visible block disagrees with the state file", () => {
    const root = tree({ readme: applyState(readmeText(), "adhoc"), state: "none" });
    assert.ok(check(root).some((f) => f.rule === "dmg-visible" && /disagrees/.test(f.detail)));
    const root2 = tree({ readme: applyState(readmeText(), "none"), state: "notarized" });
    assert.ok(fired(check(root2)).includes("dmg-visible"));
  });

  it("fails when both or neither block is visible", () => {
    assert.ok(check(tree({ readme: readmeText() })).some((f) => f.rule === "dmg-visible" && /exactly one/.test(f.detail)));
  });

  it("fails when the first-launch variant is wrong for the state", () => {
    // adhoc README while the state file says notarized, with the blocks themselves in agreement
    const root = tree({ readme: applyState(readmeText(), "adhoc"), state: "notarized" });
    assert.ok(fired(check(root)).includes("dmg-variant"));
  });

  it("fails on missing markers and on a bad state file", () => {
    const noMarkers = readmeText().replace("<!--dmg:pending-->", "");
    assert.ok(fired(check(tree({ readme: noMarkers }))).includes("dmg-markers"));
    assert.ok(fired(check(tree({ state: "yes" }))).includes("dmg-state"));
    assert.ok(fired(check(tree({ files: { "scripts/release/readme-state.json": "{ nope" } }))).includes("dmg-state"));
  });

  it("checks the hidden block too (hidden text is not an escape hatch)", () => {
    const sneaky = readmeText({ sections: { Install: BODY.Install.replace("Download the file", "Run xattr -d on the file, then download the file") } });
    assert.ok(fired(check(tree({ readme: applyState(sneaky, "none") }))).includes("gatekeeper"));
  });
});

describe("wording and claims", () => {
  const withFeature = (t, over = {}) => tree({ readme: applyState(readmeText({ sections: { Features: t } }), "none"), ...over });

  it("rejects the forbidden words and phrases and Gatekeeper advice", () => {
    for (const [text, rule] of [
      ["It is secure.", "forbidden-word"],
      ["It is blazing fast.", "forbidden-word"],
      ["100% private.", "forbidden-word"],
      ["The agent cannot commit.", "forbidden-phrase"],
      ["Every run can be undone.", "forbidden-phrase"],
      ["Run `sudo xcode-select --install`.", "gatekeeper"],
      ["Run xattr -cr on it.", "gatekeeper"],
    ]) {
      assert.ok(fired(check(withFeature(text))).includes(rule), text);
    }
  });

  it("accepts the same words next to best-effort", () => {
    assert.deepEqual(check(withFeature("Best-effort layers mean the agent cannot commit by accident.")), []);
  });

  it("rejects emoji and test counts but accepts ticks", () => {
    assert.ok(fired(check(withFeature("Fast \u{1F680}"))).includes("emoji"));
    assert.ok(fired(check(withFeature("Covered by 1,200 tests."))).includes("test-count"));
    assert.deepEqual(check(withFeature("Done ✓")), []);
  });

  it("a claim needs its evidence file", () => {
    const missing = withFeature("Agents get a Rewind snapshot.", { files: { "crates/agent_gate/src/rewind.rs": null } });
    assert.ok(check(missing).some((f) => f.rule === "claim-evidence" && /rewind/.test(f.detail)));
    assert.deepEqual(check(withFeature("Agents get a Rewind snapshot.")), []);
    assert.ok(CLAIMS.every((c) => c.evidence.length > 0));
  });

  it("the language count must match the locale folders", () => {
    assert.ok(check(withFeature("54 languages.")).some((f) => f.rule === "claim-evidence" && /53/.test(f.detail)));
    assert.deepEqual(check(withFeature("53 languages.")), []);
  });

  it("a starts-read-only sentence must name the launch that makes it so", () => {
    assert.ok(fired(check(withFeature("The app starts read-only."))).includes("claim-readonly"));
    assert.deepEqual(check(withFeature("From source, `pnpm dev:app` starts read-only.")), []);
  });
});

describe("command line", () => {
  it("exits 1 with FAIL lines for a bad README and 3 for a missing one or bad usage", () => {
    const root = tree({ readme: applyState(readmeText({ sections: { Features: "It is secure." } }), "none") });
    const r = spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL forbidden-word README\.md:\d+ secure/);
    assert.match(r.stdout, /RESULT: VIOLATIONS/);
    const empty = mkdtempSync(join(tmpdir(), "chkreadme-"));
    made.push(empty);
    mkdirSync(join(empty, "scripts/release"), { recursive: true });
    writeFileSync(join(empty, "scripts/release/public-set.json"), REAL_SET);
    assert.equal(spawnSync(process.execPath, [SCRIPT, "--root", empty]).status, 3);
    assert.equal(spawnSync(process.execPath, [SCRIPT, "--bogus"]).status, 3);
  });

  it("main() reports through injected streams and does not modify the tree", () => {
    const root = tree({ readme: applyState(readmeText(), "none") });
    const before = readFileSync(join(root, "README.md"), "utf8");
    let out = "";
    assert.equal(main(["--root", root, "--json"], { out: { write: (x) => void (out += x) }, err: { write: () => {} } }), 0);
    assert.equal(JSON.parse(out).ok, true);
    assert.equal(readFileSync(join(root, "README.md"), "utf8"), before);
  });
});

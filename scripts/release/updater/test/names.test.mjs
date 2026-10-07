// node --test scripts/release/updater/test
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as N from "../names.mjs";
import { REPO } from "./helpers.mjs";

describe("names.mjs", () => {
  it("builds the names of spec 4.6", () => {
    assert.equal(N.tagName("0.1.0"), "v0.1.0");
    assert.equal(N.artifactName("0.1.0", "x64"), "IntelyIDE_0.1.0_x64.app.tar.gz");
    assert.equal(N.artifactName("0.1.0", "aarch64"), "IntelyIDE_0.1.0_aarch64.app.tar.gz");
    assert.equal(N.feedKey("x64"), "darwin-x86_64");
    assert.equal(N.feedKey("aarch64"), "darwin-aarch64");
    assert.equal(N.downloadUrl("0.1.1", "x64"), "https://github.com/ferencfarkas09/IntelyIDE/releases/download/v0.1.1/IntelyIDE_0.1.1_x64.app.tar.gz");
    assert.deepEqual(N.feedUrls("stable"), ["https://ferencfarkas09.github.io/IntelyIDE/update/stable.json", "https://raw.githubusercontent.com/ferencfarkas09/IntelyIDE/main/site/data/update/stable.json"]);
    assert.equal(N.manifestName("x64"), "updater-manifest-x64.json");
  });

  it("refuses bad versions, arches and channels", () => {
    for (const v of ["v1.0.0", "1.0", "1.0.0+b", "01.0.0", "", "1.0.0-", "1.0.0-01", "x".repeat(65)]) assert.equal(N.isVersion(v), false, v);
    for (const v of ["0.1.0", "0.1.0-alpha.1", "10.20.30-rc.1", "1.0.0-0.3.7"]) assert.equal(N.isVersion(v), true, v);
    assert.throws(() => N.artifactName("1.0", "x64"));
    assert.throws(() => N.artifactName("1.0.0", "arm64"));
    assert.throws(() => N.feedUrls("beta"));
  });

  it("orders versions by SemVer precedence", () => {
    const chain = ["0.1.0-alpha.1", "0.1.0-alpha.2", "0.1.0-alpha.10", "0.1.0-rc.1", "0.1.0", "0.1.1-rc.1", "0.1.1"];
    for (let i = 0; i < chain.length - 1; i++) {
      assert.ok(N.compareVersions(chain[i], chain[i + 1]) < 0, `${chain[i]} < ${chain[i + 1]}`);
      assert.ok(N.compareVersions(chain[i + 1], chain[i]) > 0);
    }
    assert.equal(N.compareVersions("1.2.3", "1.2.3"), 0);
  });

  it("assigns channels: a release goes to stable and alpha, a pre-release to alpha only", () => {
    assert.deepEqual(N.channelsFor("0.1.1"), ["stable", "alpha"]);
    assert.deepEqual(N.channelsFor("0.2.0-alpha.3"), ["alpha"]);
    assert.equal(N.versionFitsChannel("0.2.0-rc.1", "stable"), false);
    assert.equal(N.versionFitsChannel("0.2.0-rc.1", "alpha"), true);
  });

  it("validateProjectLink: the hostile table", () => {
    const ok = [
      "https://github.com/ferencfarkas09/IntelyIDE/releases/tag/v0.1.1",
      "https://github.com/ferencfarkas09/IntelyIDE/issues/12",
      "https://ferencfarkas09.github.io/IntelyIDE/",
      "https://ferencfarkas09.github.io/IntelyIDE/docs/privacy",
    ];
    const bad = [
      "http://github.com/ferencfarkas09/IntelyIDE/x",
      "https://user@github.com/ferencfarkas09/IntelyIDE/x",
      "https://github.com:443/ferencfarkas09/IntelyIDE/x",
      "https://github.com/ferencfarkas09/IntelyIDE/../Other/x",
      "https://github.com/ferencfarkas09/IntelyIDE/%2e%2e/Other",
      "https://github.com/ferencfarkas09/IntelyIDE/a%2Fb",
      "https://github.com/ferencfarkas09/IntelyIDE/a%5Cb",
      "https://github.com/ferencfarkas09/IntelyIDE\\x",
      "https://github.com//ferencfarkas09/IntelyIDE/x",
      "https://github.com/ferencfarkas09/IntelyIDE//x",
      "https://github.com/ferencfarkas09/intelyide/x",
      "https://github.com/ferencfarkas09/IntelyIDE",
      "https://github.com/ferencfarkas09/IntelyIDEevil/x",
      "https://evilgithub.com/ferencfarkas09/IntelyIDE/x",
      "https://github.com.evil.com/ferencfarkas09/IntelyIDE/x",
      "https://ferencfarkas09.github.io/Other/x",
      "https://ferencfarkas09.github.io/IntelyIDE/./x",
      "https://raw.githubusercontent.com/ferencfarkas09/IntelyIDE/x",
      "javascript:alert(1)",
      "https://github.com/ferencfarkas09/IntelyIDE/x y",
      "",
    ];
    for (const u of ok) assert.equal(N.validateProjectLink(u), true, u);
    for (const u of bad) assert.equal(N.validateProjectLink(u), false, u);
  });

  it("validateProjectLink agrees with the table shared with the Rust and TS twins (crates/updater/tests/fixtures)", () => {
    const file = join(REPO, "crates/updater/tests/fixtures/project_links.json");
    if (!existsSync(file)) return;
    const { cases } = JSON.parse(readFileSync(file, "utf8"));
    const wrong = cases.filter((c) => N.validateProjectLink(c.url) !== c.ok).map((c) => `${c.url} want ${c.ok} (${c.why ?? ""})`);
    assert.deepEqual(wrong, []);
  });

  it("the site config agrees with the constants (gate G0)", () => {
    const c = JSON.parse(readFileSync(join(REPO, "site/site.config.json"), "utf8"));
    assert.equal(c.siteUrl, `https://${N.PAGES_HOST}`);
    assert.equal(c.basePath, N.PAGES_BASE_PATH);
    assert.equal(c.repoUrl, `https://github.com/${N.REPO_SLUG}`);
  });
});

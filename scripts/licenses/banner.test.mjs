import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SOURCE_PLACEHOLDER, legalBanner } from "./lib/banner.mjs";
import { LEGAL_BANNER } from "../../sidecar/build.config.mjs";

const POLICY_URL = JSON.parse(readFileSync(new URL("./policy.json", import.meta.url), "utf8")).sourceUrl;

test("the sidecar build embeds the banner with the policy source URL (RP1: no placeholder left)", () => {
  assert.equal(legalBanner({ component: "sidecar", sourceUrl: POLICY_URL }), LEGAL_BANNER);
  assert.ok(!LEGAL_BANNER.includes(SOURCE_PLACEHOLDER));
  assert.ok(legalBanner({ component: "relay" }).includes(SOURCE_PLACEHOLDER));
});

test("banner format with a source URL", () => {
  assert.equal(
    legalBanner({ component: "remote-web", sourceUrl: "https://github.com/ferencfarkas09/IntelyIDE" }),
    "/*! IntelyIDE remote-web - GPL-3.0-or-later - source: https://github.com/ferencfarkas09/IntelyIDE - third-party notices: THIRD_PARTY_LICENSES */",
  );
});

test("bad URLs and component names are rejected", () => {
  for (const sourceUrl of ["javascript:alert(1)", "http://example.com/x", "https://user:pw@example.com/x", "file:///etc/passwd", "https://example.com/a*/b", `https://example.com/${"a".repeat(220)}`, "not a url", ""]) {
    assert.throws(() => legalBanner({ component: "relay", sourceUrl }), TypeError, sourceUrl.slice(0, 30));
  }
  for (const component of ["", "Relay", "re lay", "relay*/", "../x", undefined, "a".repeat(40)]) {
    assert.throws(() => legalBanner({ component }), TypeError);
  }
});

test("the banner is a single line that cannot close its own comment early", () => {
  const b = legalBanner({ component: "relay", sourceUrl: "https://example.com/x" });
  assert.ok(!b.includes("\n"));
  assert.equal(b.indexOf("*/"), b.length - 2);
});

// SPDX-License-Identifier: GPL-3.0-or-later
// Tests of scripts/release/check-contacts.mjs on temporary git trees. No network, no git write outside the temp dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileAllowlist, findEmails, findPhones, findUrls, main, scanText, urlProblem } from "./check-contacts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ALLOW = JSON.parse(readFileSync(join(HERE, "contact-allowlist.json"), "utf8"));
const al = compileAllowlist(ALLOW);

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "contacts-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  return root;
}
function run(root, extra = []) {
  let out = "";
  let err = "";
  const code = main(["--root", root, "--set", join(HERE, "public-set.json"), "--allowlist", join(HERE, "contact-allowlist.json"), ...extra], { write: (s) => (out += s) }, { write: (s) => (err += s) });
  return { code, out, err };
}
const at = "@";

test("e-mail: only noreply, RFC 2606 names and ssh remotes pass", () => {
  assert.deepEqual(findEmails(`me${at}example.com a${at}b.example.org c${at}x.invalid d${at}h.test e${at}localhost.localdomain`, al), [`e${at}localhost.localdomain`]);
  assert.deepEqual(findEmails(`1+bot${at}users.noreply.github.com git${at}github.com:o/r.git`, al), []);
  assert.deepEqual(findEmails(`write to person${at}gmail.com`, al), [`person${at}gmail.com`]);
  assert.deepEqual(findEmails(`pkg${at}1.2.3 @scope/pkg logo${at}2x.png https://user:pw${at}host.net/x`, al), []);
  assert.deepEqual(findEmails(`mailto:a${at}corp.io`, al), [`a${at}corp.io`]);
});

test("phone: international and keyword lines are found, versions and dates are not", () => {
  assert.equal(findPhones("call +36 30 555 1212 now").length, 1);
  assert.equal(findPhones("Tel: 06 30 555 1212").length, 1);
  assert.equal(findPhones("[call](tel:+3612345678)").length, 1);
  assert.deepEqual(findPhones("version 1.2.3 released 2026-10-07 build 20261007123456"), []);
  assert.deepEqual(findPhones("order 06 30 555 1212 shipped"), []); // no contact keyword, no +country code
});

test("urls: hosts and github paths", () => {
  const p = (u) => urlProblem(findUrls(u)[0], al);
  assert.equal(p("https://intelyide.com/docs"), "");
  assert.equal(p("https://www.intelyhome.com"), "");
  assert.equal(p("https://github.com/ferencfarkas09/IntelyIDE/issues/1"), "");
  assert.equal(p("https://github.com/ferencfarkas09/IntelyIDE.git"), "");
  assert.match(p("https://github.com/ferencfarkas09/IntelyIDE-fork"), /not this repository/);
  assert.match(p("https://github.com/someone/else"), /not this repository/);
  assert.match(p("https://twitter.com/me"), /not on the allowlist/);
  assert.match(p("https://evilintelyide.com"), /not on the allowlist/);
  assert.match(p("https://intelyide.com.evil.org"), /not on the allowlist/);
  assert.equal(p("http://localhost:3000/x"), "");
  assert.equal(p("http://127.0.0.1:8080"), "");
  assert.equal(p("https://api.example.com/v1"), "");
  assert.equal(p("https://${host}/x"), "");
  assert.match(p("http://8.8.8.8/"), /IP address/);
  assert.equal(p("https://docs.anthropic.com/en/docs"), "");
});

test("allowlist: every third-party host needs a reason", () => {
  assert.throws(() => compileAllowlist({ own: { domains: [], githubPrefixes: [] }, thirdPartyHosts: { "a.com": "" } }), /reason/);
  assert.throws(() => compileAllowlist({}), /own/);
  for (const [h, why] of Object.entries(ALLOW.thirdPartyHosts)) assert.ok(why.length > 5, h);
  for (const h of Object.keys(ALLOW.thirdPartyHosts)) assert.ok(!/intely|happy/i.test(h), `${h} must not be a contact point of the owner`);
});

test("scanText reports line numbers and kinds", () => {
  const f = scanText(`ok\nmail bob${at}corp.io\nsee https://twitter.com/x and https://intelyide.com\n`, al);
  assert.deepEqual(f.map((x) => [x.line, x.kind]), [[2, "email"], [3, "url"]]);
});

test("main: clean tree exits 0", () => {
  const root = tree({ "README.md": "See https://intelyide.com and https://github.com/ferencfarkas09/IntelyIDE\n", "src/a.rs": `// ${"bot"}${at}users.noreply.github.com\n` });
  try {
    const r = run(root);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /RESULT: OK/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("main: findings exit 1 with file:line and text; skipped paths are ignored", () => {
  const root = tree({
    "CONTRIBUTING.md": `ok\nMail me: boss${at}corp.io\n`,
    "docs/faq.md": "Chat: https://discord.gg/abc\n",
    "ui/src/phone.ts": "// phone +36 20 555 1212\n",
    "pnpm-lock.yaml": `x: boss${at}corp.io\n`,
    "THIRD_PARTY_LICENSES.md": `boss${at}corp.io\n`,
    "ui/src/i18n/locales/de/x.json": `{"a":"boss${at}corp.io"}\n`,
    "ui/src/i18n/locales/hu/x.json": `{"a":"boss${at}corp.io"}\n`,
    "crates/x/tests/fixtures/f.txt": `boss${at}corp.io\n`,
    "crates/x/tests/t.rs": "const U: &str = \"https://evil.com/x\";\n",
  });
  try {
    const r = run(root);
    assert.equal(r.code, 1);
    assert.match(r.out, new RegExp(`^CONTRIBUTING\\.md:2: email: boss${at}corp\\.io`, "m"));
    assert.match(r.out, /^docs\/faq\.md:1: url: https:\/\/discord\.gg\/abc/m);
    assert.match(r.out, /^ui\/src\/phone\.ts:1: phone: \+36 20 555 1212/m);
    assert.match(r.out, /^ui\/src\/i18n\/locales\/hu\/x\.json:1: email/m);
    assert.ok(!/pnpm-lock|THIRD_PARTY|locales\/de|fixtures|tests\/t\.rs/.test(r.out), r.out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("main: environment problems exit 3", () => {
  assert.equal(run(join(tmpdir(), "does-not-exist-contacts")).code, 3);
  const root = mkdtempSync(join(tmpdir(), "contacts-nogit-"));
  try {
    assert.equal(run(root).code, 3); // not a git repository
    assert.equal(main(["--bogus"], { write() {} }, { write() {} }), 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

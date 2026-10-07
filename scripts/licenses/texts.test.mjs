import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectLicenseFiles, dedupeTexts, genericTemplate, safeUrl, secretScan, splitCopyright, textsForPackage, MAX_FILE_BYTES } from "./lib/texts.mjs";

const MIT = (head) => `MIT License\n\n${head}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.\n`;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lic-texts-"));
const put = (dir, name, body) => (fs.mkdirSync(dir, { recursive: true }), fs.writeFileSync(path.join(dir, name), body));

test("three MIT variants give one body and three copyright lines", () => {
  const root = tmp();
  const files = ["Copyright (c) 2019 Alice", "Copyright (c) 2021 Bob and Co.", "(c) 2022 Carol"].map((h, i) => {
    put(path.join(root, `p${i}`), "LICENSE", MIT(h));
    return collectLicenseFiles(path.join(root, `p${i}`))[0];
  });
  const d = dedupeTexts(files);
  assert.equal(d.texts.length, 1);
  assert.equal(d.copyright.length, 3);
  assert.ok(!/Alice|Bob|Carol/.test(d.texts[0].body));
});

test("CRLF, trailing whitespace and BSD 'All rights reserved' normalise to the same hash", () => {
  const a = splitCopyright("Copyright (c) 2020 X\r\nAll rights reserved.\r\n\r\nRedistribution and use.   \r\n");
  const b = splitCopyright("Copyright (c) 1999 Y\n\nRedistribution and use.\n");
  assert.equal(a.body, b.body);
  assert.deepEqual(a.copyright, ["Copyright (c) 2020 X"]);
});

test("Apache appendix template line is not touched (only the first 20 lines count)", () => {
  const body = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\nCopyright [yyyy] [name of copyright owner]\n";
  const r = splitCopyright(body);
  assert.ok(r.body.includes("Copyright [yyyy] [name of copyright owner]"));
  assert.deepEqual(r.copyright, []);
});

test("all LICENSE*/COPYING*/NOTICE* files are collected; NOTICE is kind notice; directories skipped", () => {
  const d = tmp();
  put(d, "LICENSE-MIT", "mit text");
  put(d, "LICENSE-APACHE", "apache text");
  put(d, "NOTICE", "notice text");
  put(d, "README.md", "readme");
  fs.mkdirSync(path.join(d, "LICENSE-DIR"));
  const f = collectLicenseFiles(d);
  assert.deepEqual(f.map((x) => x.file), ["LICENSE-APACHE", "LICENSE-MIT", "NOTICE"]);
  assert.equal(f.find((x) => x.file === "NOTICE").kind, "notice");
});

test("a symlinked LICENSE is rejected (exit 2) even when it points inside the package", () => {
  const d = tmp();
  put(d, "real.txt", "text");
  fs.symlinkSync(path.join(d, "real.txt"), path.join(d, "LICENSE"));
  assert.throws(() => collectLicenseFiles(d), (e) => e.code === "symlink" && e.exitCode === 2);
});

test("a symlink to a file outside the package is rejected without reading it", () => {
  const d = tmp();
  const outside = tmp();
  put(outside, "secret", "TOP SECRET CONTENT");
  fs.symlinkSync(path.join(outside, "secret"), path.join(d, "LICENSE"));
  assert.throws(() => collectLicenseFiles(d), (e) => e.code === "symlink" && !e.message.includes("TOP SECRET"));
});

test("an oversized file is rejected", () => {
  const d = tmp();
  put(d, "LICENSE", "a".repeat(MAX_FILE_BYTES + 1));
  assert.throws(() => collectLicenseFiles(d), (e) => e.code === "too_large" && e.exitCode === 2);
});

test("a body with a private-key block or a token pattern exits 2 without printing the value", () => {
  for (const [rule, body] of [
    ["private-key-block", "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----\n"],
    ["github-token", "token ghp_" + "a".repeat(36)],
    ["uri-credentials", "mongodb+srv://user:hunter2@cluster.example.net/db"],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop"],
  ]) {
    const d = tmp();
    put(d, "LICENSE", body);
    assert.throws(
      () => collectLicenseFiles(d),
      (e) => e.exitCode === 2 && e.code === "secret" && e.message.includes(rule) && !/hunter2|ghp_|MIIabc/.test(e.message),
      rule,
    );
  }
  assert.deepEqual(secretScan(MIT("Copyright (c) 2020 X")), []);
});

test("no files: generic template flagged generic; no template exits 2", () => {
  const pkg = tmp();
  const texts = tmp();
  put(texts, "MIT.txt", MIT(""));
  const ok = textsForPackage(pkg, { label: "p@1", chosen: ["MIT"], textsDir: texts });
  assert.equal(ok.generic, true);
  assert.equal(ok.texts.length, 1);
  assert.throws(() => textsForPackage(pkg, { label: "p@1", chosen: ["Zlib"], textsDir: texts }), (e) => e.code === "no_text" && e.exitCode === 2);
  assert.equal(genericTemplate("../etc/passwd", texts), null);
});

test("safeUrl: https only, hostname, no userinfo, max 200", () => {
  assert.equal(safeUrl("https://github.com/serde-rs/serde.git"), "https://github.com/serde-rs/serde");
  assert.equal(safeUrl("git+https://github.com/a/b.git"), "https://github.com/a/b");
  for (const bad of ["http://x.org", "javascript:alert(1)", "file:///etc/passwd", "https://user:pw@x.org/", "https://" + "a".repeat(210) + ".org", "not a url", undefined, 5]) {
    assert.equal(safeUrl(bad), undefined, String(bad));
  }
});

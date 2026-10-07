import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "sbom.mjs");
const FIX = join(HERE, "fixtures", "sbom");
const tmp = mkdtempSync(join(tmpdir(), "sbom-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const run = (args, env = {}) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
const gen = (name, extra = [], env = {}) => {
  const out = join(tmp, name);
  const r = run(["--index", join(FIX, "index.json"), "--version", "0.1.0", "--out", out, ...extra], env);
  return { r, out };
};

describe("sbom.mjs", () => {
  it("writes a structurally valid CycloneDX 1.5 document", () => {
    const { r, out } = gen("a.json", [], { SOURCE_DATE_EPOCH: "1760000000" });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(j.bomFormat, "CycloneDX");
    assert.equal(j.specVersion, "1.5");
    assert.match(j.serialNumber, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(j.version, 1);
    assert.deepEqual(j.metadata.component, {
      type: "application",
      "bom-ref": "intelyide",
      name: "IntelyIDE",
      version: "0.1.0",
      licenses: [{ license: { id: "GPL-3.0-or-later" } }],
    });
    assert.equal(j.metadata.timestamp, "2025-10-09T08:53:20.000Z");
    for (const c of j.components) {
      for (const k of ["type", "bom-ref", "name", "version", "purl"]) assert.ok(c[k], `${c.name}: ${k}`);
      assert.match(c.purl, /^pkg:(cargo|npm|generic)\//);
    }
    const keys = j.components.map((c) => [c.name, c.version, c.purl].join("\0"));
    assert.deepEqual(keys, [...keys].sort());
  });

  it("uses SOURCE_DATE_EPOCH as the only time value and omits it when unset", () => {
    const text = readFileSync(gen("t1.json", [], { SOURCE_DATE_EPOCH: "0" }).out, "utf8");
    assert.deepEqual([...text.matchAll(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g)].map((m) => m[0]), ["1970-01-01T00:00:00.000Z"]);
    const none = readFileSync(gen("t2.json").out, "utf8");
    assert.doesNotMatch(none, /\d{4}-\d{2}-\d{2}T/);
    assert.equal(gen("t3.json", [], { SOURCE_DATE_EPOCH: "abc" }).r.status, 2);
  });

  it("is byte-identical across two runs", () => {
    const env = { SOURCE_DATE_EPOCH: "1760000000" };
    assert.equal(readFileSync(gen("r1.json", [], env).out, "utf8"), readFileSync(gen("r2.json", [], env).out, "utf8"));
  });

  it("lists only what ships in the DMG and leaves out the not-bundled group", () => {
    const j = JSON.parse(readFileSync(gen("s.json").out, "utf8"));
    const names = j.components.map((c) => c.name);
    assert.ok(!names.includes("Claude Agent SDK"), "not distributed");
    assert.ok(!names.includes("relay-only"), "relay only");
    assert.deepEqual(names, ["@scope/pkg", "Node.js", "Sora", "both", "serde"]);
  });

  it("maps purls and licenses", () => {
    const j = JSON.parse(readFileSync(gen("p.json").out, "utf8"));
    const by = Object.fromEntries(j.components.map((c) => [c.name, c]));
    assert.equal(by["@scope/pkg"].purl, "pkg:npm/%40scope/pkg@1.2.3");
    assert.equal(by.serde.purl, "pkg:cargo/serde@1.0.0");
    assert.equal(by["Node.js"].purl, "pkg:generic/nodejs@24.13.0");
    assert.deepEqual(by.serde.licenses, [{ license: { id: "MIT" } }]);
    assert.deepEqual(by.both.licenses, [{ expression: "MIT AND Zlib" }]);
  });

  it("--release passes when bundle, pin and release json agree", () => {
    const { r } = gen("ok.json", ["--release", "--node-pin", join(FIX, "node-pin.json"), "--release-json", join(HERE, "fixtures", "site", "release-x64.json")]);
    assert.equal(r.status, 0, r.stderr);
  });

  it("--release fails when the Node component is missing", () => {
    const idx = JSON.parse(readFileSync(join(FIX, "index.json"), "utf8"));
    idx.components = idx.components.filter((c) => c.id !== "manual:nodejs");
    const f = join(tmp, "no-node.json");
    writeFileSync(f, JSON.stringify(idx));
    const r = run(["--index", f, "--version", "0.1.0", "--out", join(tmp, "x.json"), "--release", "--node-pin", join(FIX, "node-pin.json")]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Node component/);
  });

  it("--release fails when the Node version differs between bundle, pin and release json", () => {
    const pin = join(tmp, "pin.json");
    writeFileSync(pin, JSON.stringify({ schema: 1, version: "24.12.0" }));
    let r = gen("d1.json", ["--release", "--node-pin", pin]).r;
    assert.equal(r.status, 1);
    assert.match(r.stderr, /node-pin\.json/);
    r = gen("d2.json", ["--release", "--node-pin", join(FIX, "node-pin.json"), "--release-json", join(FIX, "release-x64-other-node.json")]).r;
    assert.equal(r.status, 1);
    assert.match(r.stderr, /release-x64-other-node\.json/);
    writeFileSync(pin, JSON.stringify({ schema: 1, version: "<24.x.y>" }));
    assert.equal(gen("d3.json", ["--release", "--node-pin", pin]).r.status, 1);
  });

  it("without --release a missing Node component is fine; usage errors exit 2", () => {
    assert.equal(run(["--version", "0.1.0"]).status, 2);
    assert.equal(run(["--bogus"]).status, 2);
    assert.equal(gen("v.json", ["--version", "1.0"]).r.status, 2);
  });
});

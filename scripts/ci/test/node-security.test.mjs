// node --test scripts/ci/test/node-security.test.mjs
// RC7: scripts/ci/node-security.mjs against a stubbed index.json and fixture node-pin.json files. No network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { analyse, parseVersion, readPin, run } from "../node-security.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../node-security.mjs");
const dir = mkdtempSync(join(tmpdir(), "nodesec-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const rel = (version, security = false, date = "2026-09-01") => ({ version, date, lts: false, security, files: [] });
const INDEX = [
  rel("v25.0.0", true),
  rel("v24.9.0", true, "2026-10-01"),
  rel("v24.8.0", false, "2026-09-20"),
  rel("v24.7.1", true, "2026-09-10"),
  rel("v24.7.0"),
  rel("v24.6.0", true, "2026-08-01"),
  rel("v22.20.0", true),
];
const pinFile = (name, body) => {
  const p = join(dir, name);
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  return p;
};
const indexFile = (name, body) => pinFile(name, body);
const capture = () => {
  const o = { out: [], err: [] };
  o.o = (s) => o.out.push(s);
  o.e = (s) => o.err.push(s);
  return o;
};
const stubFetch = (body, status = 200) => async () => ({ ok: status === 200, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });

describe("node-security", () => {
  it("reports every newer same-major release flagged security: true, and nothing from other majors or older releases", async () => {
    const pin = pinFile("pin-old.json", { schema: 1, version: "24.6.0" });
    const c = capture();
    const code = await run(["--pin", pin, "--index", "https://nodejs.org/dist/index.json"], { fetchImpl: stubFetch(INDEX), out: c.o, err: c.e, summaryPath: null });
    assert.equal(code, 1);
    const text = c.out.join("\n");
    assert.match(text, /SECURITY RELEASE v24\.7\.1 \(2026-09-10\)/);
    assert.match(text, /SECURITY RELEASE v24\.9\.0 \(2026-10-01\)/);
    assert.doesNotMatch(text, /v24\.8\.0 \(/, "a non-security release is not reported");
    assert.doesNotMatch(text, /SECURITY RELEASE v25|v22\./, "other major lines are not reported");
    assert.match(text, /newest on the 24\.x line: v24\.9\.0/);
  });

  it("reports nothing and exits 0 when the pin is current", async () => {
    const pin = pinFile("pin-cur.json", { version: "24.9.0" });
    const c = capture();
    const code = await run(["--pin", pin], { fetchImpl: stubFetch(INDEX), out: c.o, err: c.e, summaryPath: null });
    assert.equal(code, 0);
    assert.doesNotMatch(c.out.join("\n"), /SECURITY RELEASE/);
    assert.match(c.out.join("\n"), /ok: no newer security release/);
  });

  it("a newer release without the security flag is not a report (pin 24.7.1, newer 24.8.0 and 24.9.0 security)", async () => {
    const idx = [rel("v24.8.0"), rel("v24.7.1", true)];
    const c = capture();
    const code = await run(["--pin", pinFile("pin-b.json", { version: "24.7.1" })], { fetchImpl: stubFetch(idx), out: c.o, err: c.e, summaryPath: null });
    assert.equal(code, 0);
  });

  it("a network error exits 3 without throwing", async () => {
    const c = capture();
    const boom = async () => {
      throw new TypeError("fetch failed");
    };
    const code = await run(["--pin", pinFile("pin-n.json", { version: "24.6.0" })], { fetchImpl: boom, out: c.o, err: c.e, summaryPath: null });
    assert.equal(code, 3);
    assert.match(c.err.join("\n"), /cannot load the Node\.js release index/);
  });

  it("an HTTP error, invalid JSON and a non-array index all exit 3", async () => {
    for (const f of [stubFetch("", 503), stubFetch("<html>not json"), stubFetch({ not: "an array" })]) {
      const c = capture();
      const code = await run(["--pin", pinFile("pin-h.json", { version: "24.6.0" })], { fetchImpl: f, out: c.o, err: c.e, summaryPath: null });
      assert.equal(code, 3);
    }
  });

  it("refuses a non-https index URL without fetching", async () => {
    let called = false;
    const c = capture();
    const code = await run(["--pin", pinFile("pin-t.json", { version: "24.6.0" }), "--index", "http://nodejs.org/dist/index.json"], {
      fetchImpl: async () => {
        called = true;
        return { ok: true, status: 200, text: async () => "[]" };
      },
      out: c.o,
      err: c.e,
      summaryPath: null,
    });
    assert.equal(code, 3);
    assert.equal(called, false);
  });

  it("reads the pin from the fixture node-pin.json: placeholder, missing file and garbage exit 3", async () => {
    for (const body of [{ version: "<24.x.y chosen at gate G4>" }, "not json", { version: "24.x" }, {}]) {
      const c = capture();
      const code = await run(["--pin", pinFile("pin-bad.json", body)], { fetchImpl: stubFetch(INDEX), out: c.o, err: c.e, summaryPath: null });
      assert.equal(code, 3, JSON.stringify(body));
    }
    const c = capture();
    assert.equal(await run(["--pin", join(dir, "missing.json")], { fetchImpl: stubFetch(INDEX), out: c.o, err: c.e, summaryPath: null }), 3);
  });

  it("reads scripts/release/node-pin.json below --root by default", async () => {
    const root = join(dir, "root");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(root, "scripts/release"), { recursive: true });
    writeFileSync(join(root, "scripts/release/node-pin.json"), JSON.stringify({ version: "24.7.0" }));
    const c = capture();
    const code = await run(["--root", root], { fetchImpl: stubFetch(INDEX), out: c.o, err: c.e, summaryPath: null });
    assert.equal(code, 1);
    assert.match(c.out.join("\n"), /bundled Node\.js v24\.7\.0/);
  });

  it("reads a local index file given with --index (offline reproduction)", async () => {
    const c = capture();
    const code = await run(["--pin", pinFile("pin-l.json", { version: "24.9.0" }), "--index", indexFile("index.json", INDEX)], { out: c.o, err: c.e, summaryPath: null });
    assert.equal(code, 0);
  });

  it("ignores malformed index entries and neutralises network-derived text", async () => {
    const idx = [null, 5, { version: "v24.9.0\n::error::pwned", security: true }, { version: "v24.8.0", security: true, date: "::set-output\nx" }];
    const c = capture();
    const code = await run(["--pin", pinFile("pin-m.json", { version: "24.6.0" })], { fetchImpl: stubFetch(idx), out: c.o, err: c.e, summaryPath: null });
    assert.equal(code, 1);
    const text = c.out.join("\n");
    assert.doesNotMatch(text, /pwned|set-output/);
    assert.match(text, /v24\.8\.0 \(unknown date\)/);
  });

  it("writes an escaped job summary when GITHUB_STEP_SUMMARY is given", async () => {
    const summary = join(dir, "summary.md");
    const c = capture();
    await run(["--pin", pinFile("pin-s.json", { version: "24.6.0" })], { fetchImpl: stubFetch(INDEX), out: c.o, err: c.e, summaryPath: summary });
    const md = readFileSync(summary, "utf8");
    assert.match(md, /^### Node\.js security report/);
    assert.match(md, /SECURITY RELEASE v24\.9\.0/);
  });

  it("usage errors exit 2", async () => {
    const c = capture();
    assert.equal(await run(["--bogus"], { out: c.o, err: c.e, summaryPath: null }), 2);
    assert.equal(await run(["--pin"], { out: c.o, err: c.e, summaryPath: null }), 2);
  });

  it("pure helpers", () => {
    assert.deepEqual(parseVersion("v24.1.2"), [24, 1, 2]);
    assert.equal(parseVersion("24.1"), null);
    assert.equal(readPin('{"version":"24.6.0"}').text, "v24.6.0");
    const r = analyse(readPin('{"version":"24.7.0"}'), INDEX);
    assert.deepEqual(r.security.map((x) => x.version), ["v24.7.1", "v24.9.0"]);
    assert.equal(r.latest.version, "v24.9.0");
    assert.equal(r.pinKnown, true);
  });

  it("the CLI exits 3 (not a crash) for a missing pin, through a real process, with no network needed", () => {
    const r = spawnSync("node", [SCRIPT, "--pin", join(dir, "nope.json"), "--index", indexFile("index2.json", INDEX)], { encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /node-pin\.json not found/);
  });

  it("the CLI exits 1 through a real process against a local index", () => {
    const r = spawnSync("node", [SCRIPT, "--pin", pinFile("pin-cli.json", { version: "24.6.0" }), "--index", indexFile("index3.json", INDEX)], { encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /SECURITY RELEASE v24\.9\.0/);
  });
});

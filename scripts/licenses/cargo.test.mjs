import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRoot, inventory, loadMetadata, mergeMetadata, platformArgs, reachable, shippedCrates, withTexts } from "./lib/cargo.mjs";
import { LicenseToolError } from "./lib/env.mjs";

const fx = (n) => JSON.parse(fs.readFileSync(fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url)), "utf8"));
const FX_DIR = fileURLToPath(new URL("./fixtures/packages", import.meta.url));
const names = (m) => [...m.values()].map((c) => c.name).sort();

test("normal vs build vs dev edges: only normal edges ship", () => {
  const meta = fx("cargo-metadata.json");
  const shipped = names(shippedCrates(meta));
  assert.ok(shipped.includes("serde") && shipped.includes("ring"));
  assert.ok(!shipped.includes("cc"), "build dependency is not shipped");
  assert.ok(!shipped.includes("proptest"), "dev dependency is not shipped");
  assert.ok(!shipped.includes("app") && !shipped.includes("core"), "workspace crates are traversed, not listed");
});

test("cfg-filtered edge: a platform-filtered document drops openssl, the unfiltered one keeps it", () => {
  const all = fx("cargo-metadata.json");
  assert.ok(names(shippedCrates(all)).includes("openssl"));
  const filtered = JSON.parse(JSON.stringify(all));
  const core = filtered.resolve.nodes.find((n) => n.id.includes("#core@"));
  core.deps = core.deps.filter((d) => !["openssl", "windows-sys"].includes(d.name));
  const apple = names(shippedCrates(filtered));
  assert.ok(!apple.includes("openssl") && !apple.includes("windows-sys"));
  assert.ok(apple.includes("ring"));
});

test("optional-feature crate is marked optional", () => {
  const inv = inventory(fx("cargo-metadata.json"), fx("cargo-metadata-default.json"));
  assert.equal(inv.find((c) => c.name === "mongodb").optional, true);
  assert.equal(inv.find((c) => c.name === "serde").optional, undefined);
  assert.equal(inv.find((c) => c.name === "serde").id, "cargo:serde@1.0.228");
});

test("source URLs: crates.io for every crate, unsafe homepage dropped, repository fallback", () => {
  const m = shippedCrates(fx("cargo-metadata.json"));
  assert.equal(m.get("cargo:cssparser@0.35.0").sourceUrl, "https://crates.io/crates/cssparser/0.35.0");
  assert.equal(m.get("cargo:evil@0.1.0").homepage, undefined);
  assert.equal(m.get("cargo:serde@1.0.228").homepage, "https://github.com/serde-rs/serde");
});

test("root lookup by name or manifest dir; missing root is an environment error", () => {
  const meta = fx("cargo-metadata.json");
  assert.equal(findRoot(meta), findRoot(meta, { rootName: "app" }));
  assert.throws(() => findRoot(meta, { rootName: "nope" }), (e) => e instanceof LicenseToolError && e.exitCode === 3);
  assert.ok(reachable(meta, findRoot(meta)).size > 5);
});

test("multi-file crate like ring: all three licence files, no copyright lines in bodies", () => {
  const ring = shippedCrates(fx("cargo-metadata.json")).get("cargo:ring@0.17.14");
  const t = withTexts({ ...ring, dir: path.join(FX_DIR, "ring-0.17.14") }, { textsDir: "/nonexistent" });
  assert.deepEqual(t.texts.map((x) => x.title).sort(), ["LICENSE", "LICENSE-BoringSSL", "LICENSE-other-bits"]);
  assert.ok(t.copyright.some((c) => c.includes("Brian Smith")));
  assert.ok(t.texts.every((x) => !/^Copyright/m.test(x.body)));
  assert.equal(t.generic, false);
});

test("license_file fallback: crate without `license` is attention and includes the file", () => {
  const c = shippedCrates(fx("cargo-metadata.json")).get("cargo:licfile@0.1.0");
  assert.equal(c.expression, null);
  const t = withTexts({ ...c, dir: path.join(FX_DIR, "licfile-0.1.0") }, {});
  assert.equal(t.licenseFileFallback, true);
  assert.equal(t.attention, true);
  assert.equal(t.texts.length, 1);
});

test("missing crate source fails with exit 3 naming the crate", () => {
  const c = shippedCrates(fx("cargo-metadata.json")).get("cargo:serde@1.0.228");
  assert.throws(
    () => withTexts({ ...c, dir: "/nonexistent/serde" }, {}),
    (e) => e.exitCode === 3 && e.code === "source_missing" && /serde@1\.0\.228/.test(e.message),
  );
});

test("platformArgs: all means unfiltered", () => {
  assert.deepEqual(platformArgs("all"), []);
  assert.deepEqual(platformArgs(["a", "b"]), ["--filter-platform", "a", "--filter-platform", "b"]);
});

test("fallback: when two --filter-platform flags are rejected, one run per platform is merged", () => {
  const all = fx("cargo-metadata.json");
  const docFor = (drop) => {
    const d = JSON.parse(JSON.stringify(all));
    const core = d.resolve.nodes.find((n) => n.id.includes("#core@"));
    core.deps = core.deps.filter((x) => !drop.includes(x.name));
    return d;
  };
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, args]);
    const n = args.filter((a) => a === "--filter-platform").length;
    if (n === 2) return { status: 101, stdout: "", stderr: "error: unexpected argument\n" };
    const target = args[args.indexOf("--filter-platform") + 1];
    return { status: 0, stdout: JSON.stringify(target === "p1" ? docFor(["openssl", "windows-sys"]) : docFor(["windows-sys"])), stderr: "" };
  };
  const merged = loadMetadata({ root: "/x", platforms: ["p1", "p2"], run, env: {} });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(([c, a]) => c === "cargo" && a.includes("--offline") && a.includes("--locked")));
  const got = names(shippedCrates(merged));
  assert.ok(got.includes("openssl"), "union keeps the crate present on p2");
  assert.ok(!got.includes("windows-sys"));
});

test("cargo failure is an environment error with a masked first line", () => {
  const run = () => ({ status: 101, stdout: "", stderr: `error: no matching package in ${os.homedir()}/.cargo/registry\nmore\n` });
  assert.throws(
    () => loadMetadata({ root: "/x", platforms: "all", run, env: {} }),
    (e) => e.exitCode === 3 && !e.message.includes(os.homedir()) && !e.message.includes("more"),
  );
});

test("mergeMetadata dedupes packages and dependency edges", () => {
  const a = fx("cargo-metadata.json");
  const m = mergeMetadata([a, a]);
  assert.equal(m.packages.length, a.packages.length);
  const app = m.resolve.nodes.find((n) => n.id.includes("#app@"));
  assert.equal(app.deps.length, a.resolve.nodes.find((n) => n.id.includes("#app@")).deps.length);
});

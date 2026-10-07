import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoForbidden, declaredLicense, isFont, locatePackage, metafilePackages, parsePnpmLicenses, pnpmInventory, readPackageJson, sidecarInventory } from "./lib/npm.mjs";

const fx = (n) => JSON.parse(fs.readFileSync(fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url)), "utf8"));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lic-npm-"));
const put = (file, body) => (fs.mkdirSync(path.dirname(file), { recursive: true }), fs.writeFileSync(file, body));

/** A throwaway pnpm tree: node_modules/.pnpm/<dir>/node_modules/<name>/package.json */
function store(root, pkgs) {
  for (const [name, version, extra = "", license = "MIT"] of pkgs) {
    const dir = path.join(root, "node_modules", ".pnpm", `${name.replace("/", "+")}@${version}${extra}`, "node_modules", ...name.split("/"));
    put(path.join(dir, "package.json"), JSON.stringify({ name, version, license, homepage: "https://example.org/x", repository: { url: "git+https://github.com/a/b.git" } }));
    put(path.join(dir, "LICENSE"), "text");
  }
}

test("SDK present in a metafile fails, absent passes", () => {
  assert.doesNotThrow(() => assertNoForbidden(fx("metafile.json"), ["claude-agent-sdk", "claude-code"]));
  assert.throws(
    () => assertNoForbidden(fx("metafile-with-sdk.json"), ["claude-agent-sdk", "claude-code"]),
    (e) => e.exitCode === 2 && e.code === "forbidden_input",
  );
});

test("metafile inputs map to packages; own sources and workspace packages are ignored", () => {
  const base = tmp();
  const pk = metafilePackages(fx("metafile.json"), { baseDir: path.join(base, "sidecar") });
  assert.deepEqual(pk.map((p) => `${p.name}@${p.version}`), ["@agentclientprotocol/sdk@1.7.0", "zod@4.6.5"]);
  assert.ok(pk[0].dir.endsWith("node_modules/@agentclientprotocol/sdk"));
});

test("sidecarInventory reads licence data from the mapped directories and refuses a forbidden input", () => {
  const base = tmp();
  store(base, [["@agentclientprotocol/sdk", "1.7.0", "_zod@4.6.5", "Apache-2.0"], ["zod", "4.6.5"]]);
  const inv = sidecarInventory(fx("metafile.json"), { baseDir: path.join(base, "sidecar"), forbidden: ["claude-agent-sdk"] });
  assert.equal(inv[0].expression, "Apache-2.0");
  assert.equal(inv[0].sourceUrl, "https://github.com/a/b");
  assert.deepEqual(inv[0].shippedIn, ["sidecar"]);
  assert.throws(() => sidecarInventory(fx("metafile-with-sdk.json"), { baseDir: base, forbidden: ["claude-agent-sdk"] }), /forbidden/);
});

test("fontsource packages are classified as fonts", () => {
  assert.equal(isFont("@fontsource-variable/inter"), true);
  assert.equal(isFont("@fontsource/sora"), true);
  assert.equal(isFont("solid-js"), false);
  const list = parsePnpmLicenses(fx("pnpm-licenses.json"), "/x");
  assert.equal(list.find((p) => p.name.includes("inter")).kind, "font");
  assert.equal(list.find((p) => p.name === "solid-js").kind, "npm");
  assert.equal(list.find((p) => p.name === "dompurify").homepage, undefined, "javascript: homepage dropped");
  assert.equal(list.find((p) => p.name === "dompurify").expression, "(MPL-2.0 OR Apache-2.0)");
});

test("pnpm output without `paths` falls back to the .pnpm store", () => {
  const root = tmp();
  store(root, [["solid-js", "1.9.15"], ["@fontsource-variable/inter", "5.3.0"], ["dompurify", "3.4.16", "", "(MPL-2.0 OR Apache-2.0)"]]);
  const list = parsePnpmLicenses(fx("pnpm-licenses-nopaths.json"), root);
  assert.ok(list.every((p) => p.dir && fs.existsSync(p.dir)));
  assert.ok(locatePackage(root, "solid-js", "1.9.15").endsWith("node_modules/solid-js"));
  assert.equal(locatePackage(root, "solid-js", "9.9.9"), null);
});

test("pnpmInventory runs pnpm once per root with the right argv; a package outside node_modules is refused", () => {
  const root = tmp();
  store(root, [["solid-js", "1.9.15"], ["@fontsource-variable/inter", "5.3.0"], ["dompurify", "3.4.16"]]);
  const calls = [];
  const run = (cmd, args, o) => (calls.push([cmd, args, o.cwd]), { status: 0, stdout: JSON.stringify(fx("pnpm-licenses-nopaths.json")), stderr: "" });
  const inv = pnpmInventory({ root, run, env: {} });
  assert.equal(inv.length, 3);
  assert.deepEqual(calls[0], ["pnpm", ["licenses", "list", "--prod", "--json", "--long"], root]);

  const evil = { MIT: [{ name: "x", versions: ["1.0.0"], paths: [os.tmpdir()], license: "MIT" }] };
  assert.throws(() => pnpmInventory({ root, run: () => ({ status: 0, stdout: JSON.stringify(evil), stderr: "" }), env: {} }), (e) => e.code === "escape");
  assert.throws(() => pnpmInventory({ root, run: () => ({ status: 1, stdout: "", stderr: "ERR" }), env: {} }), (e) => e.exitCode === 3);
});

test("a root without production packages (pnpm prints plain text) gives an empty list", () => {
  const run = () => ({ status: 0, stdout: "No licenses in packages found\n", stderr: "" });
  assert.deepEqual(pnpmInventory({ root: tmp(), run, env: {} }), []);
});

test("declared licence shapes", () => {
  assert.equal(declaredLicense({ license: "MIT" }), "MIT");
  assert.equal(declaredLicense({ license: { type: "ISC" } }), "ISC");
  assert.equal(declaredLicense({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] }), "MIT OR Apache-2.0");
  assert.equal(declaredLicense({}), null);
  const d = tmp();
  put(path.join(d, "package.json"), JSON.stringify({ name: "n", version: "1.0.0", license: "SEE LICENSE IN README.md" }));
  assert.equal(readPackageJson(d).expression, "SEE LICENSE IN README.md");
});

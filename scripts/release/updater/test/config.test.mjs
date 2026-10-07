// check-updater-config.mjs (gate G21) against fixture trees, and print-pubkey.mjs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parseKeysRs } from "../lib/keys-rs.mjs";
import * as N from "../names.mjs";
import { PRIVATE_KEY_HEADER, REPO, UPD, cleanup, keysRs, makeKey, makeSignedAssets, run, tmp } from "./helpers.mjs";

after(cleanup);
const CHECK = join(UPD, "check-updater-config.mjs");
const PRINT = join(UPD, "print-pubkey.mjs");
const node = (script, args, opts) => run(process.execPath, [script, ...args], opts);

const GIT_ENV = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
function git(root, ...args) {
  return execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { env: GIT_ENV, encoding: "utf8" });
}

function good() {
  // Fixture keys carry an honest label; the gate refuses test-labelled keys, so use a neutral one.
  const mk = (role) => makeKey(role, { label: "" });
  const keys = [mk("Feed"), mk("FeedStandby"), mk("Artifact"), mk("Artifact")];
  return { keys, root: tree(keys) };
}

function endpointsRs() {
  return `pub const REPO_SLUG: &str = "${N.REPO_SLUG}";
pub const PRODUCT_NAME: &str = "${N.PRODUCT}";
pub const PAGES_HOST: &str = "${N.PAGES_HOST}";
pub const PAGES_BASE_PATH: &str = "${N.PAGES_BASE_PATH}";
pub const RAW_HOST: &str = "${N.RAW_HOST}";
pub const RAW_FEED_DIR: &str = "${N.RAW_FEED_DIR}";
pub const RELEASE_HOST: &str = "${N.RELEASE_HOST}";
pub const RELEASE_PATH_PREFIX: &str = "${N.RELEASE_PATH_PREFIX}";
pub const CDN_SUFFIX: &str = "${N.CDN_SUFFIX}";
pub const PROJECT_LINK_PREFIXES: [(&str, &str); 2] =
    [("github.com", "/ferencfarkas09/IntelyIDE/"), ("ferencfarkas09.github.io", "/IntelyIDE/")];
`;
}

function fingerprintsText(keys) {
  return keys.map((k) => `${k.role} ${k.id}`).join("\n") + "\n";
}

function tree(keys, { floor = 5, seq = 5 } = {}) {
  const root = tmp("upd-cfg-");
  const w = (rel, text) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  w("crates/updater/src/keys.rs", keysRs(keys, { floor }));
  w("crates/updater/src/endpoints.rs", endpointsRs());
  w("crates/updater/src/net.rs", `const UA: &str = "${N.USER_AGENT}";\n`);
  w("site/site.config.json", JSON.stringify({ siteUrl: `https://${N.PAGES_HOST}`, basePath: N.PAGES_BASE_PATH, repoUrl: `https://github.com/${N.REPO_SLUG}` }));
  w("site/data/update/stable.json", JSON.stringify({ seq }));
  w("ui/src/modules/updater/notes.ts", `const RULES = [["github.com", "/${N.REPO_SLUG}/"], ["${N.PAGES_HOST}", "${N.PAGES_BASE_PATH}/"]];\n`);
  w(".github/CODEOWNERS", ["/crates/updater/src/keys.rs", "/crates/updater/src/endpoints.rs", "/scripts/release/updater/", "/site/data/update/", "/.github/workflows/", "/.gitattributes"].map((p) => `${p} @owner`).join("\n") + "\n");
  w("SECURITY.md", `# Security\n\nUpdater keys:\n${fingerprintsText(keys)}`);
  w("README.md", "nothing secret here\n");
  return root;
}
const check = (root, args = []) => node(CHECK, ["--root", root, ...args]);

describe("check-updater-config.mjs", () => {
  it("passes a configured fixture tree", () => {
    const { root } = good();
    const r = check(root);
    assert.equal(r.status, 0, r.out);
    for (const n of ["keys", "floor", "fingerprints", "constants", "owners", "secrets"]) assert.match(r.stdout, new RegExp(`PASS ${n}`));
  });

  it("fails on placeholders (the file as U1 ships it) and a missing keys.rs", () => {
    const { root } = good();
    writeFileSync(join(root, "crates/updater/src/keys.rs"), "pub const TRUSTED_KEYS: &[TrustedKey] = &[\n    placeholder(Role::Feed),\n    placeholder(Role::FeedStandby),\n    placeholder(Role::Artifact),\n    placeholder(Role::Artifact),\n];\npub const INITIAL_FEED_FLOOR: u64 = 0;\n");
    const r = check(root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /placeholder key \(role Feed\)/);
    run("rm", [join(root, "crates/updater/src/keys.rs")]);
    assert.match(check(root).stderr, /keys\.rs does not exist/);
  });

  it("fails on a missing role, one Artifact key, a repeated key and a test-labelled key", () => {
    const k = [makeKey("Feed", { label: "" }), makeKey("FeedStandby", { label: "" }), makeKey("Artifact", { label: "" }), makeKey("Artifact", { label: "" })];
    const tryKeys = (keys) => check(tree(keys), []);
    assert.match(tryKeys([k[0], k[2], k[3]]).stderr, /no Feed-standby key/);
    assert.match(tryKeys([k[1], k[2], k[3]]).stderr, /no Feed key/);
    assert.match(tryKeys([k[0], k[1], k[2]]).stderr, /1 Artifact key/);
    assert.match(tryKeys([k[0], k[1], k[2], k[2]]).stderr, /appears twice/);
    const t = makeKey("Artifact"); // labelled "TEST throwaway"
    assert.match(tryKeys([k[0], k[1], k[2], t]).stderr, /labelled as a test key/);
  });

  it("fails when INITIAL_FEED_FLOOR is below the committed feed's seq", () => {
    const keys = good().keys;
    const root = tree(keys, { floor: 4, seq: 5 });
    const r = check(root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /INITIAL_FEED_FLOOR 4 is below/);
    assert.equal(check(tree(keys, { floor: 5, seq: 5 })).status, 0);
    assert.equal(check(tree(keys, { floor: 9, seq: 5 })).status, 0);
  });

  it("fails when the published fingerprints are missing, differ, or list another key", () => {
    const { root, keys } = good();
    const sec = join(root, "SECURITY.md");
    writeFileSync(sec, "# Security\n");
    assert.match(check(root).stderr, /no "Role KEYID/);
    writeFileSync(sec, fingerprintsText(keys.slice(0, 3)));
    assert.match(check(root).stderr, /is not listed/);
    writeFileSync(sec, fingerprintsText(keys) + "Artifact 0011223344556677\n");
    assert.match(check(root).stderr, /not in keys\.rs/);
    writeFileSync(sec, keys.map((k) => `${k.role} ${k.id} sha256:${"0".repeat(64)}`).join("\n"));
    assert.match(check(root).stderr, /fingerprint of .* differs/);
    run("rm", [sec]);
    assert.match(check(root).stderr, /published fingerprint list is required/);
    const list = join(tmp(), "list.txt");
    writeFileSync(list, fingerprintsText(keys));
    assert.equal(check(root, ["--fingerprints", list]).status, 0);
  });

  it("compares the key set with the previous tag (fixture git repository); rotation needs --allow-rotation and overlap", () => {
    const { root, keys } = good();
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "fixture");
    git(root, "tag", "v0.1.0");
    assert.equal(check(root, ["--prev-tag", "v0.1.0"]).status, 0);
    assert.match(check(root, ["--prev-tag", "v9.9.9"]).stderr, /cannot read/);

    // swap the CI Artifact key for a new one, keep the spare: a legitimate rotation
    const fresh = makeKey("Artifact", { label: "" });
    const rotated = [keys[0], keys[1], keys[3], fresh];
    writeFileSync(join(root, "crates/updater/src/keys.rs"), keysRs(rotated, { floor: 5 }));
    writeFileSync(join(root, "SECURITY.md"), fingerprintsText(rotated));
    const swapped = check(root, ["--prev-tag", "v0.1.0"]);
    assert.equal(swapped.status, 1);
    assert.match(swapped.stderr, /differs from the previous release tag/);
    const allowed = check(root, ["--prev-tag", "v0.1.0", "--allow-rotation"]);
    assert.equal(allowed.status, 0, allowed.out);
    assert.match(allowed.stdout, /rotation allowed/);

    // a total replacement keeps nothing: refused even with the flag
    const all = [makeKey("Feed", { label: "" }), makeKey("FeedStandby", { label: "" }), makeKey("Artifact", { label: "" }), makeKey("Artifact", { label: "" })];
    writeFileSync(join(root, "crates/updater/src/keys.rs"), keysRs(all, { floor: 5 }));
    writeFileSync(join(root, "SECURITY.md"), fingerprintsText(all));
    const total = check(root, ["--prev-tag", "v0.1.0", "--allow-rotation"]);
    assert.equal(total.status, 1);
    assert.match(total.stderr, /keeps no Artifact key/);
    assert.match(total.stderr, /keeps no Feed or Feed-standby key/);
  });

  it("fails when endpoints.rs, names.mjs, site.config.json and the UI link rule disagree", () => {
    const { root } = good();
    const ep = join(root, "crates/updater/src/endpoints.rs");
    const orig = readFileSync(ep, "utf8");
    writeFileSync(ep, orig.replace("raw.githubusercontent.com", "raw.example.com"));
    assert.match(check(root).stderr, /RAW_HOST = "raw\.example\.com"/);
    writeFileSync(ep, orig.replace("pub const CDN_SUFFIX", "pub const CDN_X"));
    assert.match(check(root).stderr, /no const CDN_SUFFIX/);
    writeFileSync(ep, orig.replace('("github.com", "/ferencfarkas09/IntelyIDE/")', '("github.com", "/Other/")'));
    assert.match(check(root).stderr, /PROJECT_LINK_PREFIXES lacks/);
    writeFileSync(ep, orig);
    writeFileSync(join(root, "crates/updater/src/net.rs"), "// no user agent\n");
    assert.match(check(root).stderr, /User-Agent/);
    writeFileSync(join(root, "crates/updater/src/net.rs"), `const UA: &str = "${N.USER_AGENT}";\n`);
    writeFileSync(join(root, "site/site.config.json"), JSON.stringify({ siteUrl: "https://example.org", basePath: "/x", repoUrl: "https://github.com/a/b" }));
    const r = check(root);
    assert.match(r.stderr, /siteUrl/);
    assert.match(r.stderr, /basePath/);
    assert.match(r.stderr, /repoUrl/);
    writeFileSync(join(root, "site/site.config.json"), JSON.stringify({ siteUrl: `https://${N.PAGES_HOST}`, basePath: N.PAGES_BASE_PATH, repoUrl: `https://github.com/${N.REPO_SLUG}` }));
    writeFileSync(join(root, "ui/src/modules/updater/notes.ts"), "const x = 1;\n");
    assert.match(check(root).stderr, /notes\.ts lacks/);
  });

  it("fails when CODEOWNERS leaves a trust path uncovered; a parent directory pattern covers", () => {
    const { root } = good();
    const co = join(root, ".github/CODEOWNERS");
    writeFileSync(co, "/crates/updater/src/keys.rs @o\n");
    const r = check(root);
    assert.match(r.stderr, /does not cover \/crates\/updater\/src\/endpoints\.rs/);
    assert.match(r.stderr, /\/\.github\/workflows\//);
    writeFileSync(co, "/crates/updater/ @o\n/scripts/release/updater/ @o\n/site/data/update/ @o\n/.github/ @o\n/.gitattributes @o\n");
    assert.equal(check(root).status, 0, check(root).out);
  });

  it("fails when a private-key-looking string or a *.key file is in the tree (docs/ is exempt)", () => {
    const { root } = good();
    // built from parts so this test file never contains the needle itself
    const needle = PRIVATE_KEY_HEADER;
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs/notes.md"), `the text ${needle} is explained here\n`);
    assert.equal(check(root).status, 0, "docs/ may name the text");
    writeFileSync(join(root, "scripts-leak.txt"), needle);
    assert.match(check(root).stderr, /scripts-leak\.txt: contains a private-key-looking string/);
    run("rm", [join(root, "scripts-leak.txt")]);
    writeFileSync(join(root, "leak-b64.txt"), Buffer.from(needle).toString("base64"));
    assert.match(check(root).stderr, /leak-b64\.txt/);
    run("rm", [join(root, "leak-b64.txt")]);
    writeFileSync(join(root, "artifact.key"), "x");
    assert.match(check(root).stderr, /artifact\.key: a \*\.key file/);
  });

  it("--artifact: the key that signed it must be an Artifact key of the set", () => {
    const rel = makeSignedAssets({ artifactKey: makeKey("Artifact", { label: "" }) });
    const keys = [makeKey("Feed", { label: "" }), makeKey("FeedStandby", { label: "" }), rel.artifactKey, makeKey("Artifact", { label: "" })];
    const root = tree(keys);
    const ok = check(root, ["--artifact", rel.assets.x64]);
    assert.equal(ok.status, 0, ok.out);
    const stranger = tree([keys[0], keys[1], makeKey("Artifact", { label: "" }), makeKey("Artifact", { label: "" })]);
    assert.match(check(stranger, ["--artifact", rel.assets.x64]).stderr, /does not verify against the Artifact keys/);
  });
});

describe("keys.rs parser", () => {
  it("reads the placeholder form shipped by U1 and the pasted form, ignoring comments", () => {
    const k = makeKey("Feed", { label: "" });
    const p = parseKeysRs(`// TrustedKey { id: "no" }\npub const TRUSTED_KEYS: &[TrustedKey] = &[\n    placeholder(Role::Feed),\n    TrustedKey { id: Cow::Borrowed("${k.id}"), public_b64: Cow::Borrowed("${k.pubB64}"), role: Role::Feed }, // note\n];\npub const INITIAL_FEED_FLOOR: u64 = 1_000;\n`);
    assert.equal(p.keys.length, 2);
    assert.equal(p.keys[0].placeholder, true);
    assert.equal(p.keys[1].id, k.id);
    assert.equal(p.floor, 1000);
  });

  it("a // inside a base64 key does not truncate it", () => {
    const p = parseKeysRs('pub const TRUSTED_KEYS: &[TrustedKey] = &[\n TrustedKey { id: "AAAAAAAAAAAAAAAA", public_b64: "ab//cd==", role: Role::Artifact },\n];\n');
    assert.equal(p.keys[0].publicB64, "ab//cd==");
  });

  it("the shipped crates/updater/src/keys.rs parses as four placeholders", () => {
    const p = parseKeysRs(readFileSync(join(REPO, "crates/updater/src/keys.rs"), "utf8"));
    assert.deepEqual(p.keys.map((x) => [x.role, x.placeholder]), [["Feed", true], ["FeedStandby", true], ["Artifact", true], ["Artifact", true]]);
  });
});

describe("print-pubkey.mjs", () => {
  it("prints the key id, the keys.rs line and the publication line; refuses private material", () => {
    const k = makeKey("Feed", { label: "" });
    const d = tmp();
    const f = join(d, "feed.key.pub");
    writeFileSync(f, k.pubB64 + "\n");
    const r = node(PRINT, [f, "--role", "Feed"]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, new RegExp(`key id\\s+${k.id}`));
    assert.ok(r.stdout.includes(`TrustedKey { id: Cow::Borrowed("${k.id}"), public_b64: Cow::Borrowed("${k.pubB64}"), role: Role::Feed },`));
    assert.match(r.stdout, new RegExp(`Feed ${k.id} sha256:[0-9A-F]{64}`));
    // the printed line round-trips through the parser
    const line = r.stdout.split("\n").find((l) => l.includes("TrustedKey {"));
    assert.equal(parseKeysRs(`pub const TRUSTED_KEYS: &[TrustedKey] = &[\n${line}\n];`).keys[0].id, k.id);
    const priv = join(d, "k");
    writeFileSync(priv, Buffer.from(`${PRIVATE_KEY_HEADER}\nRWR`).toString("base64"));
    assert.equal(node(PRINT, [priv]).status, 1);
    assert.equal(node(PRINT, []).status, 2);
    assert.equal(node(PRINT, [f, "--role", "Nope"]).status, 2);
  });
});

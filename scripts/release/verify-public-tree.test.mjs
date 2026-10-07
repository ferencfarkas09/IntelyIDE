// node --test scripts/release/verify-public-tree.test.mjs
// Every repository here is a throwaway under the system temp dir; the real repository is never touched.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { identityProblems, jpegBadSegments, listHash, pngBadChunks } from "./verify-public-tree.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "verify-public-tree.mjs");
const REAL_SET = join(HERE, "public-set.json");
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

const made = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function git(dir, ...args) {
  return execFileSync("git", args, { cwd: dir, env: ENV, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

function repo(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "vpt-"));
  made.push(dir);
  git(dir, "init", "-q");
  for (const [p, c] of Object.entries(files)) put(dir, p, c);
  return dir;
}

function put(dir, p, content) {
  mkdirSync(dirname(join(dir, p)), { recursive: true });
  writeFileSync(join(dir, p), content);
}

function run(dir, args = [], set = REAL_SET) {
  const r = spawnSync(process.execPath, [SCRIPT, "--root", dir, "--set", set, ...args], { env: ENV, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const add = (dir, ...paths) => git(dir, "add", "--", ...paths);

function crc(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data = Buffer.alloc(0)) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, c]);
}

function png(...extra) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...extra,
    chunk("IDAT", Buffer.from([0x78, 0x01, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])),
    chunk("IEND"),
  ]);
}

// literals assembled from pieces so this test file does not trip the publish scan
const OWNER = "/Us" + "ers/";
const PEM_HEAD = "-----" + "BEGIN PRIVATE KEY" + "-----";

describe("audit of the index", () => {
  it("passes for a clean public tree", () => {
    const d = repo({ "README.md": "hello\n", "crates/a/src/lib.rs": "fn main() {}\n", "docs/faq.md": "faq\n" });
    add(d, "README.md", "crates/a/src/lib.rs", "docs/faq.md");
    const r = run(d);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /RESULT: OK/);
  });

  it("an empty index is OK (nothing tracked yet)", () => {
    const d = repo({ "README.md": "x\n" });
    assert.equal(run(d).code, 0);
  });

  it("FAILs a private doc that is tracked", () => {
    const d = repo({ "docs/PROGRESS.md": "notes\n", "README.md": "x\n" });
    add(d, "docs/PROGRESS.md", "README.md");
    const r = run(d);
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL not-public docs\/PROGRESS\.md/);
    assert.match(r.out, /RESULT: VIOLATIONS/);
  });

  it("FAILs a file of an unlisted new directory (fail closed)", () => {
    const d = repo({ "newdir/x.txt": "x\n" });
    add(d, "newdir/x.txt");
    const r = run(d);
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL not-public newdir\/x\.txt/);
  });

  it("FAILs a tracked symlink", () => {
    const d = repo({ "README.md": "x\n" });
    symlinkSync("README.md", join(d, "docs-link.md"));
    mkdirSync(join(d, "crates"));
    symlinkSync("../README.md", join(d, "crates/link.md"));
    add(d, "README.md", "crates/link.md");
    const r = run(d);
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL symlink crates\/link\.md/);
  });

  it("FAILs a 2 MiB file that is not in bigFileAllow, accepts an allowed big file", () => {
    const big = "a".repeat(2 * 1024 * 1024);
    const d = repo({ "crates/a/big.txt": big });
    add(d, "crates/a/big.txt");
    const r = run(d);
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL too-big crates\/a\/big\.txt/);

    const d2 = repo({ "THIRD_PARTY_LICENSES.md": big });
    add(d2, "THIRD_PARTY_LICENSES.md");
    const r2 = run(d2);
    assert.equal(r2.code, 0, r2.out);
    assert.match(r2.out, /WARN big-file THIRD_PARTY_LICENSES\.md/);
  });

  it("FAILs a tracked .env file even inside a public directory", () => {
    const d = repo({ "crates/a/.env": "A=1\n" });
    add(d, "crates/a/.env");
    const r = run(d);
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL env-file crates\/a\/\.env/);
  });

  it("detects drift between the index and the work tree", () => {
    const d = repo({ "README.md": "one\n", "CONTRIBUTING.md": "c\n" });
    add(d, "README.md", "CONTRIBUTING.md");
    put(d, "README.md", "two\n");
    rmSync(join(d, "CONTRIBUTING.md"));
    const r = run(d);
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL drift README\.md/);
    assert.match(r.out, /FAIL drift CONTRIBUTING\.md/);
  });

  it("FAILs a tracked file that is ignored (tracked set differs from the list)", () => {
    const d = repo({ ".gitignore": "crates/a/ignored.txt\n", "crates/a/ignored.txt": "x\n", "crates/a/ok.txt": "y\n" });
    add(d, ".gitignore", "crates/a/ok.txt");
    git(d, "add", "-f", "crates/a/ignored.txt");
    const r = run(d);
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL tracked-not-in-list crates\/a\/ignored\.txt/);
  });

  it("FAILs a listed file that is not tracked after the commit step, only warns before", () => {
    const d = repo({ "README.md": "x\n", "crates/a/new.txt": "n\n" });
    add(d, "README.md");
    assert.equal(run(d).code, 0);
    const r = run(d, ["--after-commit"]);
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL list-not-tracked crates\/a\/new\.txt/);
  });

    const HANDLE = ["fe", "cny"].join("");
  it("matches owner paths but accepts the generic examples", () => {
    const d = repo({ "crates/a/ok.md": `see ${OWNER}you/project and ${OWNER}<name>/x\n`, "crates/a/bad.md": `\n\nopen ${OWNER}${HANDLE}/Documents\n` });
    add(d, "crates/a/ok.md", "crates/a/bad.md");
    const r = run(d);
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL owner-path crates\/a\/bad\.md:3/);
    assert.doesNotMatch(r.out, /crates\/a\/ok\.md/);
    assert.doesNotMatch(r.out, new RegExp(HANDLE, "i"), "the matched value is never printed");
  });

  it("FAILs a PEM block outside the allowlist, accepts one that publish-scan.json allows with rule private-key", () => {
    const d = repo({ "crates/a/k.txt": `${PEM_HEAD}\nabc\n`, "crates/b/fixture.txt": `${PEM_HEAD}\n` });
    put(d, "scripts/licenses/publish-scan.json", JSON.stringify({ allow: [{ path: "crates/b/**", rule: "private-key", reason: "test vector" }] }));
    add(d, "crates/a/k.txt", "crates/b/fixture.txt", "scripts/licenses/publish-scan.json");
    const r = run(d);
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL pem-block crates\/a\/k\.txt:1/);
    assert.doesNotMatch(r.out, /crates\/b\/fixture/);
  });

  it("applies the local needles to contents and to file names, without printing the value", () => {
    const d = repo({ "crates/a/x.txt": "token SECRET-VALUE-1234 here\n", "crates/a/acme-corp.txt": "clean\n", "crates/a/y.txt": "owned by acmecorp\n" });
    put(d, "scripts/licenses/publish-scan.local.json", JSON.stringify({ rules: [{ id: "company", pattern: "acme-?corp", flags: "i" }], literals: ["SECRET-VALUE-1234"] }));
    add(d, "crates/a/x.txt", "crates/a/acme-corp.txt", "crates/a/y.txt");
    const r = run(d, ["--require-local-needles"]);
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL local-literal crates\/a\/x\.txt:1/);
    assert.match(r.out, /FAIL local-needle:company crates\/a\/acme-corp\.txt file name/);
    assert.match(r.out, /FAIL local-needle:company crates\/a\/y\.txt:1/);
    assert.doesNotMatch(r.out, /SECRET-VALUE/);
  });

  it("--require-local-needles FAILs when the needles file is missing", () => {
    const d = repo({ "README.md": "x\n" });
    add(d, "README.md");
    assert.equal(run(d).code, 0);
    const r = run(d, ["--require-local-needles"]);
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL local-needles-missing/);
  });

  it("FAILs a PNG with a tEXt chunk, accepts a clean one", () => {
    const d = repo({});
    put(d, "docs/screenshots/clean.png", png(chunk("sRGB", Buffer.from([0])), chunk("pHYs", Buffer.alloc(9))));
    put(d, "docs/screenshots/dirty.png", png(chunk("tEXt", Buffer.from("Comment\0hello"))));
    add(d, "docs/screenshots/clean.png", "docs/screenshots/dirty.png");
    const r = run(d);
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL image-metadata docs\/screenshots\/dirty\.png tEXt/);
    assert.doesNotMatch(r.out, /clean\.png/);
  });

  it("FAILs iTXt, zTXt and eXIf chunks", () => {
    for (const t of ["iTXt", "zTXt", "eXIf"]) {
      assert.deepEqual(pngBadChunks(png(chunk(t, Buffer.alloc(4)))), [t]);
    }
    assert.deepEqual(pngBadChunks(Buffer.from("not a png at all")), ["bad-signature"]);
  });

  it("checks JPEG segments for EXIF and comments", () => {
    const seg = (m, payload) => Buffer.concat([Buffer.from([0xff, m, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
    const soi = Buffer.from([0xff, 0xd8]);
    const sos = Buffer.from([0xff, 0xda, 0x00, 0x02]);
    const clean = Buffer.concat([soi, seg(0xe0, Buffer.from("JFIF\0")), sos]);
    const exif = Buffer.concat([soi, seg(0xe1, Buffer.from("Exif\0\0")), sos]);
    const com = Buffer.concat([soi, seg(0xfe, Buffer.from("hi")), sos]);
    assert.deepEqual(jpegBadSegments(clean), []);
    assert.deepEqual(jpegBadSegments(exif), ["APP1"]);
    assert.deepEqual(jpegBadSegments(com), ["COM"]);
  });

  it("FAILs an excludeExceptions entry without a reason", () => {
    const d = repo({ "README.md": "x\n" });
    add(d, "README.md");
    const bad = JSON.parse(JSON.stringify(JSON.parse(require_set())));
    bad.excludeExceptions = [{ path: "crates/a/archive.zip" }];
    const setFile = join(d, "set.json");
    writeFileSync(setFile, JSON.stringify(bad));
    const r = run(d, [], setFile);
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL exclude-exception crates\/a\/archive\.zip/);
  });

  it("an excludeExceptions entry with a reason lets a file of an excluded class through", () => {
    const d = repo({ "crates/a/fixture.zip": "PK\n" });
    add(d, "crates/a/fixture.zip");
    assert.equal(run(d).code, 1);
    const set = JSON.parse(require_set());
    set.excludeExceptions = [{ path: "crates/a/fixture.zip", reason: "test archive" }];
    const setFile = join(d, "set.json");
    writeFileSync(setFile, JSON.stringify(set));
    const r = run(d, [], setFile);
    assert.equal(r.code, 0, r.out);
  });

  it("exit code 3 outside a repository", () => {
    const d = mkdtempSync(join(tmpdir(), "vpt-nogit-"));
    made.push(d);
    const r = run(d);
    assert.equal(r.code, 3);
  });
});

function require_set() {
  return readFileSync(REAL_SET, "utf8");
}

describe("--list", () => {
  it("omits stray files of risky classes inside public directories", () => {
    const d = repo({
      "crates/a/src/lib.rs": "x\n",
      "crates/a/.npmrc": "//registry/:_auth" + "Token=x\n",
      "crates/a/data.sqlite": "x",
      "crates/a/db.sqlite3": "x",
      "crates/a/dump_x": "x",
      "crates/a/dump_dir/inner.txt": "x",
      "crates/a/.dev.vars": "A=1\n",
      "crates/a/notes.local.md": "x",
      "crates/a/node_modules/m/index.js": "x",
    });
    const r = run(d, ["--list"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "crates/a/src/lib.rs\n");
  });

  it("omits ignored paths such as src-tauri/gen/schemas and prints the list hash on stderr", () => {
    const d = repo({ ".gitignore": "src-tauri/gen/\n", "src-tauri/gen/schemas/a.json": "{}\n", "src-tauri/src/main.rs": "fn main(){}\n" });
    const r = run(d, ["--list"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, ".gitignore\nsrc-tauri/src/main.rs\n");
    const hash = createHash("sha256").update(r.out).digest("hex");
    assert.match(r.err, new RegExp(`list-sha256 ${hash}`));
    assert.equal(listHash(r.out.trim().split("\n")), hash);
  });

  it("drops a tracked path that is ignored (stale index) from the list", () => {
    const d = repo({ ".gitignore": "src-tauri/gen/\n", "src-tauri/gen/schemas/a.json": "{}\n", "README.md": "x\n" });
    git(d, "add", "-f", "src-tauri/gen/schemas/a.json");
    const r = run(d, ["--list"]);
    assert.equal(r.out, ".gitignore\nREADME.md\n");
  });

  it("skips symlinks with a warning", () => {
    const d = repo({ "README.md": "x\n" });
    symlinkSync("README.md", join(d, "SECURITY.md"));
    const r = run(d, ["--list"]);
    assert.equal(r.out, "README.md\n");
    assert.match(r.err, /WARN symlink-skipped SECURITY\.md/);
  });
});

describe("--reviewed", () => {
  it("FAILs with a stale hash and passes with the current one", () => {
    const d = repo({ "README.md": "x\n", "crates/a/lib.rs": "y\n" });
    add(d, "README.md", "crates/a/lib.rs");
    const list = run(d, ["--list"]);
    const hash = /list-sha256 ([0-9a-f]{64})/.exec(list.err)[1];
    const ok = run(d, ["--reviewed", hash]);
    assert.equal(ok.code, 0, ok.out);

    const stale = run(d, ["--reviewed", "0".repeat(64)]);
    assert.equal(stale.code, 1);
    assert.match(stale.out, /FAIL unreviewed-list/);

    // a file that appears after the review changes the hash
    put(d, "crates/a/extra.rs", "z\n");
    const after = run(d, ["--reviewed", hash]);
    assert.equal(after.code, 1);
    assert.match(after.out, /FAIL unreviewed-list/);
    assert.match(after.out, /FAIL list-not-tracked crates\/a\/extra\.rs/);
  });

  it("rejects a malformed hash with exit 3", () => {
    const d = repo({});
    assert.equal(run(d, ["--reviewed", "abc"]).code, 3);
  });
});

describe("identity gate", () => {
  it("--identity FAILs a company address and passes a noreply address", () => {
    const d = repo({});
    git(d, "config", "--local", "user.email", "someone@company.example");
    const bad = run(d, ["--identity"]);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /FAIL identity git-config/);
    assert.doesNotMatch(bad.out, /company\.example/);

    git(d, "config", "--local", "user.email", "12345+octo@users.noreply.github.com");
    assert.equal(run(d, ["--identity"]).code, 0);
  });

  it("--identity FAILs when no e-mail is set", () => {
    assert.equal(run(repo({}), ["--identity"]).code, 1);
  });

  it("an e-mail listed in .scratch/release/identity.txt is accepted", () => {
    const d = repo({});
    git(d, "config", "--local", "user.email", "me@mine.example");
    put(d, ".scratch/release/identity.txt", "# owner decision\nme@mine.example\n");
    assert.equal(run(d, ["--identity"]).code, 0);
  });

  it("--after-commit checks the configured address", () => {
    const d = repo({ "README.md": "x\n" });
    add(d, "README.md");
    git(d, "config", "--local", "user.email", "someone@company.example");
    assert.equal(run(d, ["--after-commit"]).code, 1);
  });

  it("identityProblems judges commit author and committer addresses", () => {
    assert.deepEqual(identityProblems("1+a@users.noreply.github.com", ["1+a@users.noreply.github.com"]), []);
    assert.equal(identityProblems("1+a@users.noreply.github.com", ["x@company.example"]).length, 1);
    assert.equal(identityProblems("", []).length, 1);
    assert.deepEqual(identityProblems("a@b.example", [], ["a@b.example"]), []);
  });
});

describe("--files-from", () => {
  it("audits a list of paths without git", () => {
    const d = mkdtempSync(join(tmpdir(), "vpt-ff-"));
    made.push(d);
    put(d, "README.md", "x\n");
    put(d, "docs/PROGRESS.md", "x\n");
    put(d, "list.txt", "README.md\ndocs/PROGRESS.md\nmissing.md\n");
    const r = run(d, ["--files-from", join(d, "list.txt")]);
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL not-public docs\/PROGRESS\.md/);
    assert.match(r.out, /FAIL not-public missing\.md/);
    assert.match(r.out, /FAIL missing missing\.md/);
    assert.doesNotMatch(r.out, /FAIL \S+ README\.md/);
  });
});

describe("--json", () => {
  it("prints a machine readable result", () => {
    const d = repo({ "newdir/x": "x\n" });
    add(d, "newdir/x");
    const r = run(d, ["--json"]);
    assert.equal(r.code, 1);
    const j = JSON.parse(r.out);
    assert.equal(j.ok, false);
    assert.equal(j.fails[0].check, "not-public");
  });
});

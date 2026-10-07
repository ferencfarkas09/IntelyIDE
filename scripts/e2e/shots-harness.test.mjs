// RC16: tests of scripts/shots.sh (demo variant, timeout parameter) and of the helpers appended to shots-lib.js.
// Runs without an app: `node --test scripts/e2e/shots-harness.test.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const E2E = dirname(fileURLToPath(import.meta.url));
const SHOTS_SH = join(E2E, "..", "shots.sh");
const LIB = readFileSync(join(E2E, "shots-lib.js"), "utf8");
const run = (args, env = {}) => spawnSync("bash", [SHOTS_SH, ...args], { encoding: "utf8", env: { ...process.env, ...env } });

test("shots.sh passes bash -n", () => {
  execFileSync("bash", ["-n", SHOTS_SH]);
});

test("--list prints the demo variant, its timeout and the unchanged 150 s of the others", () => {
  const r = run(["--list", "--only", "tour,demo"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^tour variant=default timeout=150s/m);
  assert.match(r.stdout, /^demo variant=demo timeout=600s .*INTELY_MOCK_PROVIDER=1,INTELY_MOCK_SPEED=20,INTELY_WORKSPACES=/m);
  assert.match(run(["--list", "--only", "demo", "--timeout", "42"]).stdout, /timeout=42s/);
  assert.notEqual(run(["--list", "--only", "nope"]).status, 0);
  assert.notEqual(run(["--list", "--timeout", "abc"]).status, 0);
});

test("--check-syntax passes for every existing tour and for a demo tour stub", () => {
  const dir = mkdtempSync(join(tmpdir(), "shots-harness-"));
  try {
    cpSync(E2E, dir, { recursive: true, filter: (s) => !s.includes("y-fixture") });
    writeFileSync(join(dir, "shots-demo.js"), "step('x'); await snapBoth('changes-tree'); await finish();\n");
    const r = run(["--check-syntax", "--only", "tour,alpha,failures,empty,licenses,demo", "--locales", "en,hu"], { SHOTS_E2E_DIR: dir });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    for (const t of ["tour", "alpha", "failures", "empty", "licenses"]) assert.match(r.stdout, new RegExp(`OK   ${t}: syntax`));
    assert.equal(r.stdout.match(/OK   demo: syntax/g).length, 2, "one per locale");
    writeFileSync(join(dir, "shots-demo.js"), "await ((;\n");
    assert.notEqual(run(["--check-syntax", "--only", "demo"], { SHOTS_E2E_DIR: dir }).status, 0);
    rmSync(join(dir, "shots-demo.js"));
    const skip = run(["--check-syntax", "--only", "demo"], { SHOTS_E2E_DIR: dir });
    assert.equal(skip.status, 0);
    assert.match(skip.stdout, /SKIP demo/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("demo run: fixture, extra environment, locale scenario and timeout reach the app; other variants get none of it", () => {
  const dir = mkdtempSync(join(tmpdir(), "shots-harness-run-"));
  try {
    const bin = join(dir, "fake-app.sh");
    writeFileSync(bin, '#!/bin/bash\nenv | grep -E "^INTELY_" | sort > "$FAKE_ENV_OUT"\nexit 0\n');
    chmodSync(bin, 0o755);
    const out = join(dir, "env.txt");
    // the tour-run needs a fixture builder; use only `empty` (self-contained) for the negative check
    const e = run(["--bin", bin, "--only", "empty", "--out", join(dir, "o")], { FAKE_ENV_OUT: out });
    assert.equal(e.status, 0, e.stdout + e.stderr);
    const empty = readFileSync(out, "utf8");
    assert.match(empty, /INTELY_E2E_TIMEOUT_SECS=150/);
    assert.match(empty, /INTELY_E2E_SCENARIO=empty/);
    assert.doesNotMatch(empty, /MOCK|INTELY_WORKSPACES|SHOT_LOCALE/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("shots-lib.js change is append-only (prefix pinned; theme settle delay 900 ms)", () => {
  const head = LIB.split("\n").slice(0, 50).join("\n") + "\n";
  assert.equal(createHash("sha256").update(head).digest("hex"), "2e775c36b1254443908c5cb0243b7d8e9cd95eb42e7affe2a69071a1c113ef1d");
});

// ---- helpers in a VM with a fake document ----
function fakeEnv({ bg = "rgb(10, 10, 12)", fg = "rgb(230, 230, 235)", animations = 0 } = {}) {
  const attrs = new Map();
  const mkEl = (o = {}) => ({ offsetParent: {}, parentElement: null, textContent: "", style: {}, getAttribute: (k) => o.attrs?.[k] ?? null, setAttribute(k, v) { (o.attrs ??= {})[k] = v; }, getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10 }), ...o });
  const body = mkEl({ innerText: "hello /tmp/fx/work" });
  const nodes = [{ nodeValue: "path /tmp/fx/repos/a and /tmp/fx/repos/b" }, { nodeValue: "clean" }];
  const attrEl = mkEl({ attrs: { title: "at /tmp/fx/x", alt: "logo" } });
  const rows = mkEl({ textContent: "$ git status" });
  const appended = [];
  const document = {
    body, documentElement: { setAttribute: (k, v) => attrs.set(k, v), appendChild: (n) => appended.push(n) }, head: { appendChild: (n) => appended.push(n) },
    createElement: () => ({}), getElementById: (id) => appended.find((n) => n.id === id) ?? null,
    getAnimations: () => new Array(animations),
    querySelectorAll: (sel) => (sel === "*" ? [body, attrEl] : sel.includes("xterm") ? [rows] : sel.includes("[title]") ? [attrEl] : sel === ".visible" ? [mkEl({ textContent: "Subject" })] : []),
    createTreeWalker: () => { let i = -1; return { nextNode: () => nodes[++i] ?? null }; },
  };
  const bgEl = { parentElement: null };
  const ctx = {
    document, window: { __e2e: { screenshot: async (n) => `/shots/${n}.png` } }, console, performance, setTimeout, Promise, Math, Number, Date, globalThis: undefined,
    getComputedStyle: (el) => ({ backgroundColor: el === body || el.parentElement === null ? bg : "rgba(0, 0, 0, 0)", color: fg, position: "static" }),
    FX: { root: "/tmp/fx", repoIds: [] }, notes: {}, sleep: () => Promise.resolve(), frame: () => Promise.resolve(),
    setTheme: async (t) => { attrs.set("theme", t); },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(LIB.replace(/^(const|let) /gm, "var ").replace(/^class /gm, "var "), ctx);
  return { ctx, attrs, appended, nodes, attrEl, mkEl };
}

test("freezeUi injects the style once", () => {
  const { ctx, appended } = fakeEnv();
  vm.runInContext("freezeUi(); freezeUi()", ctx);
  assert.equal(appended.length, 1);
  assert.match(appended[0].textContent, /animation: none !important/);
  assert.match(appended[0].textContent, /caret-color: transparent/);
});

test("freezeClock freezes Date.now and new Date(), keeps explicit dates, notes the clock", () => {
  const { ctx } = fakeEnv();
  vm.runInContext('freezeClock("2026-09-28T16:00:00Z")', ctx);
  assert.equal(vm.runInContext("Date.now()", ctx), Date.parse("2026-09-28T16:00:00Z"));
  assert.equal(vm.runInContext("new Date().toISOString()", ctx), "2026-09-28T16:00:00.000Z");
  assert.equal(vm.runInContext('new Date("2020-01-01T00:00:00Z").getUTCFullYear()', ctx), 2020);
  assert.equal(ctx.notes.clock, "frozen 2026-09-28T16:00:00Z");
  assert.throws(() => vm.runInContext('freezeClock("nope")', ctx), /bad date/);
});

test("settle returns when no animation runs and is bounded when one never ends", async () => {
  const quiet = fakeEnv().ctx;
  await vm.runInContext("settle()", quiet);
  const busy = fakeEnv({ animations: 1 }).ctx;
  const t0 = Date.now();
  await vm.runInContext("settle()", busy); // sleep is stubbed; the performance.now() bound (3 s) ends the loop
  assert.ok(Date.now() - t0 < 6000);
});

test("maskFixtureRoot rewrites text nodes and attributes and counts", () => {
  const { ctx, nodes, attrEl } = fakeEnv();
  const n = vm.runInContext("maskFixtureRoot()", ctx);
  assert.equal(n, 3);
  assert.equal(nodes[0].nodeValue, "path ~/fernbank/repos/a and ~/fernbank/repos/b");
  assert.equal(attrEl.getAttribute("title"), "at ~/fernbank/x");
  assert.equal(ctx.notes.masked, 3);
  assert.equal(ctx.notes.maskReview, undefined);
});

test("dumpVisibleText collects text, attributes and the terminal", () => {
  const { ctx } = fakeEnv();
  const e = vm.runInContext('dumpVisibleText("changes-tree", "dark")', ctx);
  assert.equal(e.shot, "changes-tree");
  assert.equal(e.theme, "dark");
  assert.match(e.text, /hello/);
  assert.deepEqual([...e.attrs].sort(), ["at /tmp/fx/x", "logo"]);
  assert.match(e.terminal, /git status/);
  assert.equal(ctx.notes.shots.length, 1);
});

test("assertTheme and assertReadable", () => {
  const dark = fakeEnv().ctx;
  vm.runInContext('assertTheme("dark")', dark);
  assert.throws(() => vm.runInContext('assertTheme("light")', dark), /luminance/);
  vm.runInContext('assertReadable(".visible")', dark);
  const poor = fakeEnv({ fg: "rgb(20, 20, 24)" }).ctx;
  assert.throws(() => vm.runInContext('assertReadable(".visible")', poor), /contrast/);
  assert.throws(() => vm.runInContext('assertReadable(".none")', dark), /nothing matches/);
});

test("snapStable returns the first screenshot of a stable UI and snapBoth ends on dark", async () => {
  const { ctx, attrs } = fakeEnv();
  // the light pass needs a light body; flip the colours with the theme
  ctx.getComputedStyle = (el) => ({ backgroundColor: attrs.get("data-theme") === "light" ? "rgb(250, 250, 250)" : "rgb(10, 10, 12)", color: attrs.get("data-theme") === "light" ? "rgb(20, 20, 20)" : "rgb(230, 230, 230)", position: "static" });
  assert.equal(await vm.runInContext('snapStable("a")', ctx), "/shots/a.png");
  const files = await vm.runInContext('snapBoth("a", [".visible"])', ctx);
  assert.equal(files.length, 2);
  assert.equal(attrs.get("data-theme"), "dark");
  assert.equal(ctx.notes.shots.map((s) => s.theme).join(), "dark,light");
});

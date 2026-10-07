// Generator tests on a synthetic world in a mktemp directory: fake cargo/pnpm (injected `run`), fake sidecar metafile,
// no network, no real Cargo.lock or pnpm-lock.yaml, no write outside the temp directory.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./gen.mjs";

const policy = JSON.parse(fs.readFileSync(fileURLToPath(new URL("./policy.json", import.meta.url)), "utf8"));
const OUT = { md: "THIRD_PARTY_LICENSES.md", index: "ui/src/shell/licenses/data/index.json", texts: "ui/src/shell/licenses/data/texts.json" };

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const MIT_TEXT = "Copyright (c) 2020 Someone\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software.\n";

/** A tiny repo: 1 app crate, a few registry crates, three pnpm roots and a fake sidecar bundle. */
function makeWorld(opts = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gen-world-")));
  write(path.join(root, "REUSE.toml"), `version = 1\n\n[[annotations]]\npath = "**"\nprecedence = "aggregate"\nSPDX-FileCopyrightText = "2026 ${policy.copyrightHolder}"\nSPDX-License-Identifier = "GPL-3.0-or-later"\n`);
  write(path.join(root, "LICENSES/GPL-3.0-or-later.txt"), "GNU GENERAL PUBLIC LICENSE\nVersion 3\n");
  write(path.join(root, "Cargo.lock"), "# lock v1\n");
  for (const r of [".", "remote-web", "remote-relay"]) write(path.join(root, r, "pnpm-lock.yaml"), `lock ${r}\n`);
  write(path.join(root, "sidecar/package.json"), JSON.stringify({ name: "sidecar", devDependencies: { "@anthropic-ai/claude-agent-sdk": "9.9.9" } }));
  write(path.join(root, "sidecar/dist/index.js"), "// built earlier\n");

  const crates = opts.crates ?? [
    { name: "serde", version: "1.0.0", license: "MIT OR Apache-2.0", files: { "LICENSE-MIT": MIT_TEXT } },
    { name: "openssl", version: "0.10.0", license: "Apache-2.0", files: {}, onlyAll: true },
    { name: "mongodb", version: "3.0.0", license: "Apache-2.0", files: {}, optional: true },
  ];
  const pkg = (c) => ({
    name: c.name, version: c.version, id: `registry+https://x#${c.name}@${c.version}`, source: "registry+https://x", license: c.license, license_file: null,
    homepage: null, repository: null, manifest_path: path.join(root, "registry", `${c.name}-${c.version}`, "Cargo.toml"),
  });
  for (const c of crates) {
    const dir = path.join(root, "registry", `${c.name}-${c.version}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const [f, t] of Object.entries(c.files)) write(path.join(dir, f), t);
  }
  const app = { name: "app", version: "0.0.0", id: "path+file:///w/app#app@0.0.0", source: null, license: "GPL-3.0-or-later", license_file: null, homepage: null, repository: null, manifest_path: path.join(root, "src-tauri/Cargo.toml") };
  const doc = (list) => ({
    packages: [app, ...list.map(pkg)],
    resolve: { root: null, nodes: [{ id: app.id, deps: list.map((c) => ({ pkg: pkg(c).id, name: c.name, dep_kinds: [{ kind: null, target: null }] })) }, ...list.map((c) => ({ id: pkg(c).id, deps: [] }))] },
  });
  const metaAll = doc(crates.filter((c) => !opts.dropAll));
  const metaDef = doc(crates.filter((c) => !c.optional));

  // pnpm: root has solid-js, remote-web has noble; relay has nothing
  const solid = path.join(root, "node_modules/solid-js");
  write(path.join(solid, "package.json"), JSON.stringify({ name: "solid-js", version: "1.0.0", license: "MIT" }));
  write(path.join(solid, "LICENSE"), MIT_TEXT);
  const noble = path.join(root, "remote-web/node_modules/@noble/hashes");
  write(path.join(noble, "package.json"), JSON.stringify({ name: "@noble/hashes", version: "2.0.0", license: "MIT" }));
  write(path.join(noble, "LICENSE"), MIT_TEXT.replace("Someone", "Paul"));
  const font = path.join(root, "node_modules/@fontsource-variable/inter");
  write(path.join(font, "package.json"), JSON.stringify({ name: "@fontsource-variable/inter", version: "5.0.0", license: "OFL-1.1" }));
  write(path.join(font, "LICENSE"), "Copyright 2016 The Inter Project Authors\n\nThis Font Software is licensed under the SIL Open Font License, Version 1.1.\n");
  const pnpmOut = {
    ".": { MIT: [{ name: "solid-js", versions: ["1.0.0"], paths: [solid], homepage: "https://solidjs.com" }], "OFL-1.1": [{ name: "@fontsource-variable/inter", versions: ["5.0.0"], paths: [font] }] },
    "remote-web": { MIT: [{ name: "@noble/hashes", versions: ["2.0.0"], paths: [noble] }] },
  };

  // sidecar bundle input: one inlined Apache-2.0 package
  const acp = path.join(root, "sidecar/node_modules/.pnpm/acp@1.0.0/node_modules/acp");
  write(path.join(acp, "package.json"), JSON.stringify({ name: "acp", version: "1.0.0", license: "Apache-2.0" }));
  write(path.join(acp, "LICENSE"), "Apache License\nVersion 2.0, January 2004\n");
  const inputs = { "src/index.ts": {}, "node_modules/.pnpm/acp@1.0.0/node_modules/acp/index.js": {}, ...(opts.inputs ?? {}) };

  const calls = [];
  const run = (cmd, args, { cwd } = {}) => {
    calls.push({ cmd, args, cwd });
    if (cmd === "cargo") return { status: 0, stdout: JSON.stringify(args.includes("--all-features") ? metaAll : metaDef), stderr: "" };
    if (cmd === "pnpm") {
      const rel = path.relative(root, cwd) || ".";
      const out = pnpmOut[rel];
      return { status: 0, stdout: out ? JSON.stringify(out) : "No licenses were found\n", stderr: "" };
    }
    return { status: 127, stdout: "", stderr: "unexpected tool" };
  };
  // platform filter simulation: "only on all targets" crates disappear when a --filter-platform flag is present
  const filteringRun = (cmd, args, o) => {
    const r = run(cmd, args, o);
    if (cmd === "cargo" && args.includes("--filter-platform")) {
      const j = JSON.parse(r.stdout);
      const drop = new Set(crates.filter((c) => c.onlyAll).map((c) => `${c.name}@${c.version}`));
      const keep = (p) => !drop.has(`${p.name}@${p.version}`);
      j.packages = j.packages.filter(keep);
      const ids = new Set(j.packages.map((p) => p.id));
      j.resolve.nodes = j.resolve.nodes.filter((n) => ids.has(n.id)).map((n) => ({ ...n, deps: n.deps.filter((d) => ids.has(d.pkg)) }));
      return { ...r, stdout: JSON.stringify(j) };
    }
    return r;
  };
  const sink = { out: [], err: [] };
  const deps = { root, run: filteringRun, buildMetafile: async () => ({ inputs, baseDir: path.join(root, "sidecar") }), say: (s) => sink.out.push(s), warn: (s) => sink.err.push(s) };
  return { root, calls, deps, sink, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");
const gen = (w, args = []) => main(args, w.deps);

test("two runs are byte identical and outputs carry no machine paths", async () => {
  const w = makeWorld();
  try {
    assert.equal(await gen(w, ["--out-root", w.root]), 0, w.sink.err.join("\n"));
    const first = Object.values(OUT).map((f) => read(w.root, f));
    assert.equal(await gen(w, ["--out-root", w.root]), 0);
    assert.deepEqual(Object.values(OUT).map((f) => read(w.root, f)), first);
    for (const t of first) assert.ok(!/\/Users\/|\.cargo|\.pnpm|gen-world-/.test(t), "machine path leaked");
    assert.ok(Buffer.byteLength(first[1]) + Buffer.byteLength(first[2]) < policy.maxBundleBytes);
  } finally {
    w.cleanup();
  }
});

test("components: ids, platform filter, optional flag, SDK only under Not distributed, fonts renamed", async () => {
  const w = makeWorld();
  try {
    assert.equal(await gen(w), 0, w.sink.err.join("\n"));
    const index = JSON.parse(read(w.root, OUT.index));
    const ids = index.components.map((c) => c.id);
    assert.ok(ids.includes("cargo:serde@1.0.0") && ids.includes("npm:solid-js@1.0.0") && ids.includes("font:inter@5.0.0") && ids.includes("manual:claude-agent-sdk"));
    assert.ok(!ids.includes("cargo:openssl@0.10.0"), "openssl absent on the Apple set");
    assert.equal(index.components.find((c) => c.name === "mongodb").optional, true);
    assert.equal(index.components.find((c) => c.name === "serde").chosen[0], "MIT");
    const sdk = index.components.find((c) => c.id === "manual:claude-agent-sdk");
    assert.equal(sdk.distributed, false);
    assert.equal(sdk.version, "9.9.9", "version comes from sidecar/package.json");
    assert.deepEqual(index.components.filter((c) => !c.distributed).map((c) => c.id).sort(), ["manual:claude-agent-sdk", "manual:claude-cli"]);
    assert.deepEqual(index.components.find((c) => c.name === "acp").shippedIn, ["sidecar"]);
    const md = read(w.root, OUT.md);
    const shippedPart = md.slice(md.indexOf("## Components by license"));
    assert.ok(!shippedPart.split("## License texts")[0].includes("Claude Agent SDK"));
    assert.ok(md.slice(md.indexOf("## Not distributed"), md.indexOf("## Components by license")).includes("Claude Agent SDK"));
    assert.equal(index.project.license, "GPL-3.0-or-later");
    assert.ok(index.project.textIds.length === 1);
    // platform flags: two --filter-platform for darwin
    const cargoCalls = w.calls.filter((c) => c.cmd === "cargo");
    assert.ok(cargoCalls.every((c) => c.args.includes("--offline") && c.args.includes("--locked")));
    assert.ok(cargoCalls.some((c) => c.args.filter((a) => a === "--filter-platform").length === 2));
  } finally {
    w.cleanup();
  }
});

test("--platform all keeps the all-target crate and warns about openssl (V6)", async () => {
  const w = makeWorld();
  try {
    assert.equal(await gen(w, ["--platform", "all"]), 0);
    assert.ok(JSON.parse(read(w.root, OUT.index)).components.some((c) => c.name === "openssl"));
    assert.ok(w.sink.err.join("\n").includes("V6"));
    assert.ok(w.calls.filter((c) => c.cmd === "cargo").every((c) => !c.args.includes("--filter-platform")));
  } finally {
    w.cleanup();
  }
});

test("a crate with several license files keeps them, a dual-licensed one resolves OR by the prefer list", async () => {
  const w = makeWorld({ crates: [{ name: "ringy", version: "1.0.0", license: "Apache-2.0 AND ISC", files: { LICENSE: "Copyright 2015 Brian\n\nISC text A\n", "LICENSE-BoringSSL": "BoringSSL text B\n", "LICENSE-other-bits": "other bits C\n" } }] });
  try {
    assert.equal(await gen(w), 0, w.sink.err.join("\n"));
    const c = JSON.parse(read(w.root, OUT.index)).components.find((x) => x.name === "ringy");
    assert.equal(c.textIds.length, 3);
    assert.deepEqual(c.chosen, ["Apache-2.0", "ISC"]);
    assert.equal(c.verdict, "attention");
  } finally {
    w.cleanup();
  }
});

test("--check: clean after generation, exit 1 after a lockfile change, names the drift", async () => {
  const w = makeWorld();
  try {
    assert.equal(await gen(w), 0);
    assert.equal(await gen(w, ["--check"]), 0);
    write(path.join(w.root, "remote-web/pnpm-lock.yaml"), "changed\n");
    w.sink.err.length = 0;
    assert.equal(await gen(w, ["--check"]), 1);
    assert.ok(w.sink.err.join("\n").includes("drift"));
    // a new component shows up by id, never as a file dump
    w.cleanup();
    const w2 = makeWorld({ crates: [{ name: "serde", version: "1.0.0", license: "MIT", files: { LICENSE: MIT_TEXT } }] });
    try {
      assert.equal(await gen(w2), 0);
      const idx = path.join(w2.root, OUT.index);
      const j = JSON.parse(fs.readFileSync(idx, "utf8"));
      j.components = j.components.filter((c) => c.name !== "serde");
      fs.writeFileSync(idx, JSON.stringify(j));
      assert.equal(await gen(w2, ["--check"]), 1);
      assert.ok(w2.sink.err.join("\n").includes("+cargo:serde@1.0.0"));
    } finally {
      w2.cleanup();
    }
  } finally {
    w.cleanup();
  }
});

test("policy failures exit 2 and name component and expression", async () => {
  for (const [license, expect] of [["GPL-2.0-only", "GPL-2.0-only"], ["AGPL-3.0-only", "AGPL"], ["LGPL-2.1-only", "LGPL"], ["SEE LICENSE IN README.md", "see-license"], ["Weird-1.0", "Weird-1.0"]]) {
    const w = makeWorld({ crates: [{ name: "bad", version: "1.0.0", license, files: { LICENSE: MIT_TEXT } }] });
    try {
      assert.equal(await gen(w), 2, license);
      const msg = w.sink.err.join("\n");
      assert.ok(msg.includes("bad@1.0.0") && msg.includes(expect), msg);
    } finally {
      w.cleanup();
    }
  }
});

test("the Claude Agent SDK among the sidecar bundle inputs fails with exit 2", async () => {
  const w = makeWorld({ inputs: { "node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@9.9.9/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs": {} } });
  try {
    assert.equal(await gen(w), 2);
    assert.ok(w.sink.err.join("\n").includes("forbidden component"));
  } finally {
    w.cleanup();
  }
});

test("a secret inside a license file exits 2 without printing the value", async () => {
  const token = `ghp_${"a1B2c3D4e5".repeat(4)}`;
  const w = makeWorld({ crates: [{ name: "leaky", version: "1.0.0", license: "MIT", files: { LICENSE: `${MIT_TEXT}\n${token}\n` } }] });
  try {
    assert.equal(await gen(w), 2);
    assert.ok(!w.sink.err.join("\n").includes(token));
  } finally {
    w.cleanup();
  }
});

test("--out-root and --out inside a real repository or outside the project exit 3", async () => {
  const w = makeWorld();
  const prevProtected = process.env.INTELY_PROTECTED_DIRS;
  process.env.INTELY_PROTECTED_DIRS = ["/Users/example/Projects/shop-backend", "/Users/example/Projects/admin", "/Users/example/Projects/shop-mobile", "/Users/example/Projects/shop-pos"].join(":");
  try {
    for (const bad of ["/Users/example/Projects/shop-backend/x", "/Users/example/Projects/admin", "/Users/example/Projects/shop-mobile/out", "/Users/example/Projects/shop-pos/out", "/etc/intely-out"]) {
      assert.equal(await gen(w, ["--out-root", bad]), 3, bad);
      assert.equal(await gen(w, ["--component", "relay", "--out", bad]), 3, bad);
    }
    assert.ok(!fs.existsSync("/etc/intely-out"));
  } finally {
    if (prevProtected === undefined) delete process.env.INTELY_PROTECTED_DIRS;
    else process.env.INTELY_PROTECTED_DIRS = prevProtected;
    w.cleanup();
  }
});

test("a run never touches sidecar/dist", async () => {
  const w = makeWorld();
  try {
    const file = path.join(w.root, "sidecar/dist/index.js");
    const before = fs.statSync(file);
    await gen(w);
    const after = fs.statSync(file);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(fs.readFileSync(file, "utf8"), "// built earlier\n");
    assert.deepEqual(fs.readdirSync(path.join(w.root, "sidecar/dist")), ["index.js"]);
  } finally {
    w.cleanup();
  }
});

test("an unexplained Rust crate count change with an unchanged Cargo.lock exits 2", async () => {
  const w = makeWorld();
  try {
    assert.equal(await gen(w), 0);
    const md = path.join(w.root, OUT.md);
    fs.writeFileSync(md, fs.readFileSync(md, "utf8").replace(/Shipped Rust crates: \d+/, "Shipped Rust crates: 999"));
    assert.equal(await gen(w), 2);
    assert.ok(w.sink.err.join("\n").includes("unexplained"));
    assert.equal(await gen(w, ["--accept-count-change"]), 0);
    // a changed lockfile explains a changed count
    fs.writeFileSync(md, fs.readFileSync(md, "utf8").replace(/Shipped Rust crates: \d+/, "Shipped Rust crates: 999"));
    write(path.join(w.root, "Cargo.lock"), "# lock v2\n");
    assert.equal(await gen(w), 0);
  } finally {
    w.cleanup();
  }
});

test("--component writes a banner-led notice for remote-web and for the empty relay", async () => {
  const w = makeWorld();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "gen-out-"));
  try {
    assert.equal(await gen(w, ["--component", "remote-web", "--out", out]), 0, w.sink.err.join("\n"));
    const web = fs.readFileSync(path.join(out, "THIRD_PARTY_LICENSES.remote-web.txt"), "utf8");
    assert.ok(web.startsWith("IntelyIDE remote-web - GPL-3.0-or-later - source: "));
    assert.ok(web.includes("@noble/hashes 2.0.0") && web.includes("Permission is hereby granted"));
    assert.equal(await gen(w, ["--component", "relay", "--out", out]), 0);
    const relay = fs.readFileSync(path.join(out, "THIRD_PARTY_LICENSES.relay.txt"), "utf8");
    assert.ok(relay.startsWith("IntelyIDE relay - GPL-3.0-or-later") && relay.includes("ships no third-party code"));
    // deterministic
    assert.equal(await gen(w, ["--component", "remote-web", "--out", out]), 0);
    assert.equal(fs.readFileSync(path.join(out, "THIRD_PARTY_LICENSES.remote-web.txt"), "utf8"), web);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    w.cleanup();
  }
});

test("bad arguments exit 3", async () => {
  const w = makeWorld();
  try {
    for (const args of [["--bogus"], ["--platform", "linux"], ["--component", "nope", "--out", "/tmp/x"], ["--component", "relay"], ["--out", "/tmp/x"], ["--out-root"]]) {
      assert.equal(await gen(w, args), 3, args.join(" "));
    }
  } finally {
    w.cleanup();
  }
});

test("the generator child environment holds no credentials", async () => {
  const { scrubbedEnv } = await import("./lib/env.mjs");
  const env = scrubbedEnv({ base: { PATH: "/bin", HOME: "/h", NPM_TOKEN: "x", GITHUB_TOKEN: "y", AWS_SECRET_ACCESS_KEY: "z", CARGO_REGISTRIES_X_TOKEN: "q", LC_ALL: "C" } });
  assert.ok(!Object.keys(env).some((k) => /TOKEN|KEY|SECRET/i.test(k) || k.startsWith("CARGO_REGISTRIES_")));
  assert.equal(env.npm_config_userconfig, "/dev/null");
  assert.equal(env.CARGO_NET_OFFLINE, "true");
});

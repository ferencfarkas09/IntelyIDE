// Shared test kit for the updater release scripts: throwaway keys per role, a JS signer that
// writes the same files `tauri signer sign` writes, fixture apps/tarballs. Nothing here touches a
// real key, the network or the repository.
import { createHash, generateKeyPairSync, randomBytes, sign as edSign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const UPD = join(HERE, "..");
export const REPO = join(UPD, "../../..");

const made = [];
export function tmp(prefix = "upd-") {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}
export function cleanup() {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** A throwaway Ed25519 key in minisign layout. `label` goes into the public comment (TEST marker by default). */
export function makeKey(role, { label = "TEST throwaway" } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pk = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const idBytes = randomBytes(8);
  const id = Buffer.from(idBytes).reverse().toString("hex").toUpperCase();
  const pubText = `untrusted comment: minisign public key: ${id}${label ? ` (${label})` : ""}\n${Buffer.concat([Buffer.from("Ed"), idBytes, pk]).toString("base64")}\n`;
  const pubB64 = Buffer.from(pubText).toString("base64");
  function signFile(bytes, { file, version, timestamp = 1791135405, comment, legacy = false } = {}) {
    const sig = edSign(null, legacy ? Buffer.from(bytes) : createHash("blake2b512").update(bytes).digest(), privateKey);
    const tc = comment ?? [`timestamp:${timestamp}`, `file:${file}`, ...(version ? [`version:${version}`] : [])].join("\t");
    const global = edSign(null, Buffer.concat([sig, Buffer.from(tc)]), privateKey);
    const text = `untrusted comment: signature from tauri secret key\n${Buffer.concat([Buffer.from(legacy ? "Ed" : "ED"), idBytes, sig]).toString("base64")}\ntrusted comment: ${tc}\n${global.toString("base64")}\n`;
    return Buffer.from(text).toString("base64");
  }
  return { role, id, pubB64, pk: Buffer.from(pk), signFile };
}

/** keys.rs text in the layout of spec 4.7 for a list of keys. */
export function keysRs(keys, { floor = 0 } = {}) {
  const lines = keys.map((k) => `    TrustedKey { id: Cow::Borrowed("${k.id}"), public_b64: Cow::Borrowed("${k.pubB64}"), role: Role::${k.role} },`);
  return `pub const TRUSTED_KEYS: &[TrustedKey] = &[\n${lines.join("\n")}\n];\npub const INITIAL_FEED_FLOOR: u64 = ${floor};\n`;
}

export function run(cmd, args, { cwd, env, input } = {}) {
  const r = spawnSync(cmd, args, { cwd, env: env ?? process.env, input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** A minimal fixture IntelyIDE.app (plain files, no signature needed for tarball tests). */
export function makeApp(dir, { name = "IntelyIDE.app", version = "0.1.1", arch = "x64", size = 1300 * 1024, extra } = {}) {
  const app = join(dir, name);
  mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
  mkdirSync(join(app, "Contents/Resources"), { recursive: true });
  writeFileSync(join(app, "Contents/Info.plist"), `<plist><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>\n`);
  writeFileSync(join(app, "Contents/MacOS/IntelyIDE"), randomBytes(size));
  chmodSync(join(app, "Contents/MacOS/IntelyIDE"), 0o755);
  writeFileSync(join(app, "Contents/Resources/build.json"), JSON.stringify({ version, arch }) + "\n");
  extra?.(app);
  return app;
}

/** Install a fake executable named `name` in a new directory and return that directory. */
export function fakeBin(files) {
  const dir = tmp("upd-bin-");
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

export const SENTINEL_KEY = "SENTINEL-KEY-0123456789abcdef";
export const SENTINEL_PW = "SENTINEL-PW-fedcba9876543210";

/**
 * Builds a complete throwaway release in a temp dir: fixture apps -> tarballs (the real
 * make-updater-artifacts.sh --tarball-only) -> JS-signed with an Artifact key. Returns paths and keys.
 */
export function makeSignedAssets({ version = "0.1.1", arches = ["x64"], artifactKey = makeKey("Artifact") } = {}) {
  const root = tmp("upd-rel-");
  const assets = {};
  for (const arch of arches) {
    const d = join(root, arch);
    mkdirSync(d, { recursive: true });
    const app = makeApp(d, { version, arch });
    const r = run("bash", [join(UPD, "make-updater-artifacts.sh"), "--app", app, "--arch", arch, "--version", version, "--out", d, "--tarball-only"]);
    if (r.status !== 0) throw new Error(`make-updater-artifacts failed: ${r.out}`);
    const name = `IntelyIDE_${version}_${arch}.app.tar.gz`;
    const tar = join(d, "updater", name);
    writeFileSync(`${tar}.sig`, artifactKey.signFile(readFileSync(tar), { file: name, version }) + "\n");
    assets[arch] = tar;
  }
  return { root, assets, artifactKey };
}

/** The first line of a private minisign key file, built from parts so no source file contains it. */
export const PRIVATE_KEY_HEADER = ["untrusted comment: rsign", ["encrypted", "secret", "key"].join(" ")].join(" ");

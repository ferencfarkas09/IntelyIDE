// After `vite build`: sign the bundle manifest (format v2, (design notes: remote-cloudflare-spec) 4.5) with the relay package's script. The Ed25519 key lives OFF the repo
// and off Cloudflare: INTELY_BUNDLE_KEY=<pem path>. Without it a build for local testing gets a throwaway key in a temp dir
// (printed, never reused), so a local dist always carries a manifest the phone can show and the service worker can verify.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const key = process.env.INTELY_BUNDLE_KEY ?? join(mkdtempSync(join(tmpdir(), "intely-bundle-key-")), "bundle-ed25519.pem");
const args = [join(here, "../../remote-relay/scripts/sign-bundle.mjs"), "--dist", dist, "--key", key];
if (!process.env.INTELY_BUNDLE_KEY) args.push("--gen-key");
if (process.env.INTELY_BUNDLE_SEQ) args.push("--seq", process.env.INTELY_BUNDLE_SEQ); // default: the clock in seconds
const r = spawnSync(process.execPath, args, { stdio: "inherit" });
if (!process.env.INTELY_BUNDLE_KEY) console.log("(throwaway signing key: local test build only; set INTELY_BUNDLE_KEY for a real one)");
process.exit(r.status ?? 1);

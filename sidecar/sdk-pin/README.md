# Agent SDK pin

IntelyIDE does **not** ship the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`): it is Anthropic software under
Anthropic's terms, not part of IntelyIDE, and it is not bundled into `sidecar/dist` (see
`docs/licensing-spec.md` section 6). The sidecar loads it at run time with `src/sdk.ts` (`loadSdk`).

| File | Purpose |
|---|---|
| `package.json` | the SDK and its three peers, each at one exact version (same as `sidecar/package.json` devDependency and `SDK_PIN` in `src/sdk.ts`) |
| `package-lock.json` | npm lockfile v3: every entry has a `resolved` URL on `registry.npmjs.org` and a sha512 `integrity`; the eight platform binaries are listed as `optional` and never installed |
| `tree.sha256` | `sha256  relative/path` for every file of the installed tree (`package.json`, `package-lock.json`, `node_modules/**`; npm's own `node_modules/.bin` and `.package-lock.json` are not part of it), sorted bytewise |
| `hash-tree.mjs` | prints or checks that manifest (`node sidecar/sdk-pin/hash-tree.mjs <dir>` / `--check <dir>`) |

`sidecar/test/sdk-pin.test.ts` fails when the four pin locations drift apart or the lock loses a registry URL or integrity.

## Where the SDK comes from

1. **Source checkout** (development, tests, building from source): `sidecar/node_modules/@anthropic-ai/claude-agent-sdk`
   from `pnpm install`, found by explicit path from the sidecar's own location. Its `package.json` version must be
   exactly the pin; the pnpm lockfile is the integrity source.
2. **Packaged build** (the macOS app; `docs/release-packaging-spec.md` 5.5): `~/Library/Application Support/IntelyIDE/sdk`,
   created by the in-app installer or by hand (below). Before anything is imported the directory must be owned by the user, not writable by group or
   others, not reached through a symlink, contain only regular files and directories, and **every file must match
   `tree.sha256`** (no extra, no missing, no changed file). Nothing else is searched and **no environment variable
   changes the location**. A tree that fails the check is refused with `sdk_unverified`; there is no fallback.

Which of the two applies is decided by where the sidecar file lives, not by the environment or a setting: a path inside
`<name>.app/Contents/Resources/` (`isPackagedPath` in `src/sdk.ts`) is the packaged app. In packaged mode the
source-checkout lookup is skipped entirely, so a `Resources/node_modules/@anthropic-ai/claude-agent-sdk` tree (which has
no tree hash) is never imported, whatever its version. The pin manifest is read from `Resources/sdk-pin/tree.sha256`.
Tests inject `packaged` and `sidecarDir` through `LoadOptions`; production code calls `loadSdk()` without options
(`test/sdk-loader.test.ts` asserts that). The previous state directory name `IntelySwitchIDE` is not read; the one-time
migration of an existing dev install is done by the app at startup (`docs/release-packaging-spec.md` 5.6).

If the SDK is missing, of another version, unverified or broken, no Claude session starts (the hooks that enforce the
commit/push hard stops live in that path, so there is no CLI-only fallback). The provider is still reported as installed
when the `claude` CLI exists, with `message` = `sdk_missing: ...` / `sdk_incompatible: ...` / `sdk_unverified: ...` /
`sdk_broken: ...`. Rewind, the git shim and the other providers are unaffected.

## Setting up a packaged install by hand

```sh
mkdir -m 700 "$HOME/Library/Application Support/IntelyIDE/sdk"
cp sidecar/sdk-pin/package.json sidecar/sdk-pin/package-lock.json "$HOME/Library/Application Support/IntelyIDE/sdk/"
npm ci --ignore-scripts --omit=optional --prefix "$HOME/Library/Application Support/IntelyIDE/sdk"
node sidecar/sdk-pin/hash-tree.mjs --check "$HOME/Library/Application Support/IntelyIDE/sdk"
```

`hash-tree.mjs --check` must print `tree matches`. Run it from a source checkout (the manifest sits beside the script);
a packaged app carries `sdk-pin/` as a bundle resource next to the sidecar (`../sdk-pin/tree.sha256`), and its in-app
installer (`docs/release-packaging-spec.md` 5.5) produces the same tree without npm.

## Changing the pin (a human, deliberately)

1. Edit the version in `sidecar/package.json`, `sdk-pin/package.json` (the SDK and its peers) and `SDK_PIN` in `src/sdk.ts`.
2. In an empty temporary directory: copy `package.json`, run `npm install --package-lock-only --ignore-scripts`, review
   the lock diff, then `npm ci --ignore-scripts --omit=optional` there.
3. Verify provenance: `npm audit signatures` in that directory.
4. Copy the new `package-lock.json` here, regenerate the manifest: `node sidecar/sdk-pin/hash-tree.mjs <that directory> > sidecar/sdk-pin/tree.sha256`.
5. Re-run `scripts/enforcement-suite.mjs --record ...` against the new SDK (the enforcement book is keyed by the CLI version, not the SDK version: decision D17) and `pnpm --filter @intely/sidecar test`.
6. If the pinned version is withdrawn from npm, the old pin and its recorded proof stay valid until the new one is verified.

## Provenance of the files committed today (read this)

The first `package-lock.json` and `tree.sha256` were **derived offline** from the installed pnpm tree of the checkout
(`pnpm-lock.yaml` integrity values, the package files in the pnpm store). That derivation has since been checked
against the real thing: `npm ci --ignore-scripts --omit=optional` (npm 10.9.4, Node 22) in an empty directory with
that lock reproduced `tree.sha256` exactly, 6666 files, and `npm ci` accepts the integrity hash of every tarball.

The pin was then refreshed once, by hand, for three security releases in the tree (body-parser 2.4.0, fast-uri 3.1.9, qs
6.17.0): only those three entries of the lock changed, and the manifest was regenerated from the `npm ci` tree of the new
lock (6669 files, changes only in those three packages and in `package-lock.json`).

It was refreshed a second time for the security advisories of the pinned peers: `@modelcontextprotocol/sdk` 1.31.0 to 1.32.1
(four advisories, all fixed in 1.32.0; 1.32.1 is the same code plus documentation), `zod` 4.6.5 to 4.6.7 (fixed in 4.6.6) and the
transitive `ip-address` 10.7.3 to 10.7.4 (the first fixed version; `express-rate-limit` asks for `^10.2.0`). The Agent SDK itself
stays at 0.3.287 and its peer ranges (`@modelcontextprotocol/sdk ^1.29.0`, `zod ^4.0.0`) are met, so no `overrides` entry is needed.
Again only those lock entries changed (npm computed them, the entries were merged into the committed lock), `npm ci` accepted every
tarball, `npm audit` on that tree reports 0 vulnerabilities, and the manifest was regenerated from the `npm ci` tree (6669 files;
changes only in those three packages and in `package.json` and `package-lock.json`).

Still open: `npm audit signatures` (step 3 above, release gate G2) has **not** been run on the new tree, because the machine that
made the change could not download the registry's signing keys. A human has to run it once (`npm ci --ignore-scripts
--omit=optional` in a directory holding `package.json` and `package-lock.json`, then `npm audit signatures`) and look at the result.
A wrong manifest fails closed (`sdk_unverified`); it cannot make the loader accept a different tree.

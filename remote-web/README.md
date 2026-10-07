# remote-web

Phone PWA of IntelyIDE Remote (design: `docs/remote-plan.md`). Solid + Vite; design tokens and kit parts are imported from `../ui/src`; mobile additions live in `src/styles/mobile.css` and `src/ui/` (BottomSheet, TabBar, PullToRefresh). Served by `../remote-relay`; talks Noise (`@noble/*`, pinned) to the Mac gateway through it. Local only: nothing here is deployed or contacts a real service.

## Commands
```
pnpm install --ignore-workspace   # own lockfile
pnpm build                        # tsc, vite build, then signs dist/bundle.json (INTELY_BUNDLE_KEY=<pem outside the repo>, else a throwaway key)
pnpm test                         # vitest: Noise interop vs snow, session, transcript, wire
pnpm e2e                          # wrangler dev (loopback) + headless Chrome 390x844 + fake Mac; needs a fresh `pnpm build`
```
Noise vectors: `test/vectors/noise.json` is produced by `crates/remote/tests/noise_vectors.rs` (`INTELY_WRITE_VECTORS=1 cargo test -p intely-remote --test noise_vectors`).

## Screens
S0 onboarding/pairing (QR scan via BarcodeDetector, paste of the pairing link, SAS, bundle hash), S1 Home, S2 run detail, S3 permission card, S4 question card, S5 composer, S7 devices and settings, S9 revoked. Not built: S6 new run, S8 morning brief, passkey step-up (placeholder sheet), plan-approval card.

## Manual checks that need a real iPhone (R0)
- Add to Home Screen, open the installed app, pair with the in-app QR scan (camera in standalone mode).
- Short manual code alone is not enough in this build (it carries no room or key): paste the whole pairing link.
- Web Push: subscribe, delivery to a locked phone, tap deep link, re-subscribe on open (needs VAPID keys on the relay and `public/push-config.json`).
- Passkey step-up (WebAuthn in standalone) and Face ID lock.
- Socket behaviour after airplane mode, background/foreground, real-network latency.
- Compare the build hash on S0/S7 with Settings > Remote on the Mac after every update.
- Service worker verification and the pinned key on a real iOS device (not proven by the automated tests).
- Service worker offline start (verified only structurally here).

## Known limits
CSP omits `require-trusted-types-for` (Solid builds templates with innerHTML); `script-src 'self'` has no inline/eval. The phone app verifies the Ed25519 signature of `bundle.json` against the public key pinned at pairing (see `docs/remote-cloudflare.md`); this protects against partial deploys and CDN faults, not against a hostile Worker or a stolen Cloudflare login, because the same party can replace the service worker script. The first-load hash compare at pairing stays the root of trust.

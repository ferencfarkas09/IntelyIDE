# remote-relay

Cloudflare Worker + SQLite-backed Durable Object (`Room`) for IntelyIDE Remote (design: `docs/remote-plan.md` 2.3, 2.6, 2.7, 6.2).
It is a dumb, untrusted pipe: it forwards **ciphertext it cannot read**, checks **hashed bearer tokens**, offers a tiny plaintext control layer (presence, notify, ack), stores one encrypted snapshot and a bounded encrypted queue, sends content-free Web Push, and serves the PWA bundle. It never logs payloads (`observability` is off, no `console.*`).

Status: runs and is tested **only locally** (`wrangler dev --local` on 127.0.0.1); no test or build step ever contacts Cloudflare, Apple or Google. The checked-in config holds no account id, route or remote binding. Deployment is done by the IDE (Settings > Remote, `docs/remote-cloudflare-spec.md`) onto the **user's own** Cloudflare account, from a generated config; the manual route below stays valid for people who prefer the CLI.

## Layout
| Path | What |
|---|---|
| `src/index.ts` | Worker: routes `/r/<roomId>/{create,ws,stat}`, `/api/status`, `/api/bundle`, `/api/health`; cheap early rejects, then the per-IP join limiter; everything else is a static asset |
| `src/room.ts` | `Room` DO: hibernating sockets (`acceptWebSocket`, attachments, auto ping/pong), SQLite tables, queue, snapshot, pairing, revoke/wipe, push trigger |
| `src/limiter.ts` | `JoinLimiter` DO (one per hashed IP, in-memory window) |
| `src/push.ts` | VAPID (ES256) + RFC 8291 payload encryption, endpoint allow-list; off unless all VAPID secrets exist |
| `scripts/` | `bundle-lib.mjs` (format v2 reference implementation), `sign-bundle.mjs`, `verify-bundle.mjs`, `gen-bundle-key.mjs` (Ed25519, key kept off Cloudflare), `gen-vapid.mjs` |
| `templates/_headers` | CSP and friends to copy into `remote-web/dist` |
| `tests/` | `unit.test.mjs`, `relay.test.mjs`, `push.test.mjs` (spawn `wrangler dev` on loopback, fake Mac and fake phone) |

## Wire protocol (relay level; Noise runs inside the binary frames)
Connect: `wss://<host>/r/<roomId>/ws` with subprotocols `intely.v1, <credential>`; the credential is `mac.<macToken>`, `dev.<deviceId>.<deviceToken>` or `pair.<oneTimeToken>` (subprotocol, never the URL, so tokens stay out of access logs). Tokens: 32 to 128 chars of `[A-Za-z0-9_-]`. Every auth failure answers a plain 401. A client should send the text `ping` right after open and every 25 s (answered by the runtime without waking the DO).

Create the room first: `PUT /r/<roomId>/create` with `Authorization: Bearer <macToken>` (first writer wins; same token again is 200; 403 taken; 410 wiped). The roomId is 22+ base64url chars (128 bit).

| Frame | Direction | Meaning |
|---|---|---|
| binary, raw | phone -> relay | ciphertext for the Mac (queued while the Mac is offline, except pairing sockets) |
| binary `[1][idLen][deviceId][ct]` | Mac -> relay | ciphertext to one phone (`idLen` 0 = all phones) |
| binary `[1][0][qid u32][idLen][deviceId][ct]` | relay -> Mac | ciphertext from a phone; `qid` 0 = live, else queued and must be acked |
| binary, raw | relay -> phone | ciphertext |
| text `hello`, `presence`, `peer`, `queued`, `undelivered`, `ok`, `err`, `snapshot` | relay -> client | control, plaintext, no content |
| text `dev.add {id,hash}`, `dev.revoke {id}`, `pair.open {hash,ttlMs}`, `snapshot.put {data,rev,force?}`, `notify {kind,collapseKey?}`, `ack {upTo}`, `room.wipe` | Mac -> relay | control (hashes are `sha256` hex of the token) |
| text `snapshot.get`, `push.sub {sub}`, `bye` | phone -> relay | control |

## Limits (all in `src/config.ts`)
Binary frame 64 KB (over it: close 1009); control frame 8 KB; snapshot 128 KB decoded, rewritten at most every 10 s (2 s floor with `force` for a Needs-you change); queue 100 frames / 1 MB / 10 min TTL (full = `queueFull`, nothing dropped silently); 1 Mac + 5 phones (a newer socket for the same identity replaces the older one, close 4000); 16 devices; per-socket rate 200 (Mac) / 60 (phone) frames per 10 s, then soft `rate` error and close 1008 after 3 strikes; notify 20/min; per-IP join/create attempts `JOIN_RATE_PER_MIN` (default 30) answered 429; pairing token single use, at most 120 s. Revoke closes the device socket with 4401, `room.wipe` closes everything with 4410 and leaves a tombstone.

## Run and test locally (no login, no network service)
```
cd remote-relay
pnpm install --ignore-workspace      # own lockfile, wrangler pinned to 4.147.0
pnpm typecheck
pnpm test:unit                        # pure functions, seconds
pnpm test                             # starts wrangler dev on loopback three times, about 2 minutes on the Intel laptop
pnpm dev                              # wrangler dev --local on 127.0.0.1:8787 (needs ../remote-web/dist to exist)
```
The tests use `--persist-to` in a temp dir, strip all `CLOUDFLARE_*` variables, turn wrangler metrics off, and refuse a non-loopback host (`INTELY_REMOTE_STAGING=1` is the explicit override). What they prove: token rejection, byte-exact ciphertext passthrough both ways, addressed/broadcast, pairing (single use, expiry), presence, queue replay until ack, queue/frame/rate limits, snapshot limits, revoke < 2 s, wipe, 5-phone cap, **hibernation** (the DO constructor re-runs after idle, sockets and state survive), and that the persisted SQLite files and the server log never contain the plaintext marker while the ciphertext is stored byte-exact. The push test runs against a loopback HTTP server standing in for the push service and decrypts the payload with an independent RFC 8291 receiver.

## Status endpoint
`GET /api/status` (no credential needed) answers from the Worker alone, with `cache-control: no-store`:
```json
{ "ok": true, "auth": false, "relay": { "version": "0.0.0", "protocol": "intely.v1", "codeHash": null, "stamp": null },
  "bundle": { "hash": "<64 hex or null>" }, "push": { "configured": false }, "now": 1790000000000 }
```
`relay.codeHash` and `relay.stamp` echo the optional vars `RELAY_CODE_HASH` and `RELAY_STAMP` (the deploy tooling writes them into the generated config; plain `[A-Za-z0-9:_.-]` up to 128 characters, else `null`). No Durable Object is called and no room data is returned.
The Mac proves ownership with the credential it already holds: `Authorization: Bearer <mac room token>` plus `x-intely-room: <room id>`. A request with both in the right shape costs one limiter check and one Room check (the same cost as `/r/<room>/stat`); when the Room accepts the token the answer has `"auth": true` and `"do": { "ok": true }` (a `JoinLimiter.ping()` result reused for 60 s per isolate). A wrong token, an unknown room and no token all look the same (`auth: false`, no `do`). Anything of the wrong shape never reaches a Durable Object.

Early rejects: on `/r/<room>/{ws,create,stat}` a wrong method, a missing WebSocket upgrade, a missing or malformed subprotocol credential or a missing or malformed bearer token is answered by the Worker with the same status the Room would give (404, 401, 400), before the limiter Durable Object and the Room are billed.

## Signed PWA bundle, format v2 (`docs/remote-cloudflare-spec.md` 4.5)
`remote-web` builds into `../remote-web/dist` (its `postbuild` signs with a throwaway key for local builds). To sign by hand:
```
node scripts/gen-bundle-key.mjs --out ~/Library/Application\ Support/<private dir>/bundle-ed25519.pem      # once; prints the public key + fingerprint
node scripts/sign-bundle.mjs --dist ../remote-web/dist --key <that pem> [--seq <n>] [--json]            # --seq defaults to the clock in seconds
node scripts/verify-bundle.mjs --dist ../remote-web/dist --pub <pinned public key> [--min-seq <n>]
```
`dist/bundle.json` is `{ v: 2, files: [{path, sha256, size}], manifestSha256, seq, builtAt, sig, pubkey }`. The signature covers `"intely-bundle-v2\n" + manifestSha256 + "\n" + seq` (domain separation; `seq` is strictly increasing per key, so a phone can refuse an older signed build). `builtAt` is informational and not signed. v1 files (signature over the bare hash) are refused unless `--allow-v1`, which exists for tests only. The full format, the file-walk order and the verification order (`format`, `v1Refused`, `keyMismatch`, `hashMismatch`, `badSignature`, `rollback`) are documented in `scripts/bundle-lib.mjs`; `tests/fixtures/bundle-v2/vectors.json` holds the committed cross-implementation vectors (regenerate with `node tests/fixtures/bundle-v2/generate.mjs`; it uses PUBLIC test keys).

The Worker serves the manifest at `GET /api/bundle` (hash in `x-bundle-hash`) and as `/bundle.json`. The private key must stay off Cloudflare (the IDE keeps its own key in the Keychain and signs in Rust; the scripts are for custom-URL users and for the vectors). The phone pins the public key at pairing, and the Mac shows the expected hash. A signed bundle does not protect against someone who controls the Worker or the Cloudflare login (they also control `sw.js`); see the trust model in the spec.

## Deploy by hand (optional; needs your Cloudflare account)
1. Decide the hostname first (passkeys and the PWA origin bind to it): `*.workers.dev` for the MVP, or a domain/subdomain you own (then add a `routes` entry or custom domain in `wrangler.jsonc`). Changing it later means re-pairing.
2. `pnpm wrangler login` (interactive, your account with 2FA). Do not put an API token in the repo or CI. Optionally set `account_id` in `wrangler.jsonc`.
3. Free plan is enough for one user (SQLite DOs are available on Free); plan on Paid ($5/month) only if the daily cap is ever hit.
4. VAPID push keys: `node scripts/gen-vapid.mjs`, then `pnpm wrangler secret put VAPID_PRIVATE_KEY`, `... VAPID_PUBLIC_KEY`, `... VAPID_SUBJECT` (`mailto:you@example.com`). Without them `notify` answers `push: disabled`. The public key is also given to the PWA for `pushManager.subscribe`.
5. Build, sign and verify the PWA (previous section), then `pnpm wrangler deploy`.
6. Smoke test with the Mac client pointed at the new host, then pair a phone. Delete the workers.dev subdomain or the Worker to switch Remote off for good.
Never set `PUSH_ALLOW_LOOPBACK` in production; it exists for tests only.

## Not covered tonight (manual device checks, R0)
Everything that needs a device or a real service: Web Push delivery to a locked iPhone and tap-to-open, Home Screen install, in-app QR scan, passkey assertion, iOS socket behaviour after airplane mode, Apple/FCM acceptance of the VAPID/aes128gcm request, p50 latency on the real network. Also unverified: behaviour on real Cloudflare (this was only run on local workerd 2026-10-01), billing numbers from `docs/remote-plan.md` 6.2, and the quirk below.

Observed local quirk: if a socket never sent anything (not even `ping`), a server-initiated close (revoke, replace) completes only when the DO is evicted (~10 s). Clients therefore send `ping` immediately after open; the Noise handshake does the same job in practice.

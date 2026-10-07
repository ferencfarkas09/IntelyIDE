# IntelyIDE Remote: gateway, relay contract, manual device checks

What the Remote gateway in `crates/remote` (Tauri-free) does, with glue in `src-tauri/src/modules/remote.rs`, data API `ui/src/ipc/remote.ts`. `cargo test -p intely-remote` (use `-j 2`; the rekey test in `tests/noise.rs` sends 65 539 messages and takes about 35 s in debug).

## What exists
| Piece | Where |
|---|---|
| Agent seams | `agent_core`: `EventLog::read_from/last_seq` (default methods + contract assertions), `bus.rs` (`EventBus`, append-before-publish), `hub.rs` (`AgentHub`, `Origin`, `Eligibility`, `PendingTable` with first-answer-wins, forged-answer errors, `reopen`), `projection.rs` (run status reducer). Tests: `agent_core/tests/remote_seams.rs` |
| Noise | `noise.rs`: `Noise_IKpsk2_25519_ChaChaPoly_SHA256` (pairing), `Noise_IK_...` (reconnect), prologue pins version, rekey every 65 536 messages, SAS from the handshake hash |
| Pairing | `pairing.rs`, `gateway.rs`: 128-bit one-time code (PSK = SHA-256 of a domain tag + code), 60 s, burned after 3 failed attempts or on first proof, 6-digit SAS confirmed on the Mac, new device `view`, passkey self-attested inside the pairing channel |
| Registry, audit, identity | `devices.rs` (HMAC-protected `devices.json`, verified every 30 s, tamper stops Remote), `audit.rs` (hash chain, head hash in the secret store, crash-heal, explicit `reset_after_tamper`), `identity.rs` (key, room id, relay token rotate on revoke-all/panic) |
| Policy | `policy.rs`: the 4.1 table as one `match` (`verdict`), strict `low` allow-list, `eligibility()` re-computed with the broker at card time and at answer time (stricter wins), state-dir and protected paths are `desktopOnly` |
| Gateway | `gateway.rs` (sync core), `runner.rs` (async loop), `slot.rs` (`RemoteSlot`: one thread, one runtime, zero cost off), `transport.rs` (trait, loopback), `relay_ws.rs` (outbound relay client; refuses non-local hosts unless the host was acknowledged in Settings > Remote > Custom URL or the wizard (`remote.trust.allowedHosts`), or `INTELY_REMOTE_STAGING=1` for tests; never in read-only or test mode) |
| Wire | `wire.rs`: versioned JSON, `deny_unknown_fields`, `opId` idempotency, step-up proof type; `redact.rs`: no `raw`, no thinking text, secrets/URLs/env lines/PEM masked, tool output head+tail 4 KB, diffs only via `diff.get`, secret-file tool output hidden, bidi/invisible characters escaped |
| Limits | `limits.rs`: prompts 10/min, answers 30/min, starts 3/h, 5 pending per run, fatigue (10 approvals/10 min or 5 taps/60 s -> step-up 15 min), anomaly demotion, re-auth window (default 12 h) |
| Step-up | `stepup.rs`: WebAuthn ES256 assertion verified in Rust (rpIdHash, UP+UV, counter, challenge bound to request + intent hash, origin) |
| Sidecar | `settings.ts` now injects `disableRemoteControl: true` into the inline settings of every Claude run (it was missing); test in `sidecar/test/claude-units.test.ts`; `pnpm --filter @intely/sidecar build` refreshes `dist` |

## Relay contract the client assumes (`remote-relay/src/{frames,room,index}.ts`)
`PUT /r/<roomId>/create` (Bearer macToken) then WebSocket `/r/<roomId>/ws` with subprotocols `intely.v1, mac.<token>`. Mac -> relay binary `[1][idLen][deviceId][ciphertext]`; relay -> Mac `[1][0][qid u32 BE][idLen][deviceId][ciphertext]` (qid != 0 is acknowledged with `{"t":"ack","upTo":qid}`). Text control: `dev.add{id,hash}`, `dev.revoke{id}`, `pair.open{hash,ttlMs}`, `notify{kind,collapseKey}`, `room.wipe`. Hashes are SHA-256 hex of the token string; the pairing credential `pair.<token>` is derived from the same one-time code as the PSK, so the phone needs only the code. Frames inside the ciphertext start with a tag byte (`noise::tag`): 1 pair-init, 2 pair-resp, 3 ik-init, 4 ik-resp, 5 data, 6 reset (plaintext, Mac -> phone, "no session, redo the handshake").

## Own relay on Cloudflare
Deploying and using your own relay, the signed phone app build and the live apply of the relay address are described in `docs/remote-cloudflare.md`. The relay address and the expected build hash apply without a restart; the expected hash comes from the signed `bundle.json` of the deployed build. Nothing there has been run against a real Cloudflare account by the project.

## Known limits (honest)
- Hard stops for Claude stay best effort; Remote adds no structural claim. E2E holds against an honest-code passive relay only until the native shell.
- Not built: Web Push payload encryption, morning brief, snapshot upload to the relay, keep-awake assertion, per-run view-only, second Mac, collapsing of identical repeated asks, QR rendering (the offer carries the fragment text; the UI renders it).
- `start` from the phone is wired (step-up, 3/h) but `HostHub::start_run` answers `unavailable` until run templates exist (planned).
- Long run logs: `read_from` on the JSONL log reads the whole file; a planned SQLite log would index it.
- The Tauri `HostHub` rebuilds the policy context from run metadata (first repo = cwd), without role deny lists, MCP set or saved allows: stricter than the host, never looser.
- Noise interop vectors with the JS bundle are not produced yet; `phone.rs` is the executable reference.

## Manual device checks (not run by the project: no iPhone, no Cloudflare, no Web Push)
1. `pnpm dev` in `remote-relay` (wrangler dev --local), Settings > Remote: relay `ws://127.0.0.1:8787`, Enable.
2. Open the PWA on the iPhone through a quick tunnel (test only), Add to Home Screen, Pair device on the Mac, scan the QR in the app or type the manual code, compare the 6 digits and the bundle hash, accept as `view`.
3. Start a Haiku run; the transcript appears on the phone in under 1 s; kill the relay, restart it: the phone resumes with no gap and no duplicate.
4. Promote the phone to `reply` on the Mac; approve a `git status` card with one tap; `npm install` asks for Face ID; `git commit` shows "Blocked by policy"; answer an AskUserQuestion; send a follow-up; Stop.
5. Answer the same card on the Mac and the phone at once: one wins, the other says "answered on Mac".
6. Revoke the phone on the Mac: the phone shows "removed" within 2 s. Pair again, press Panic: everything revoked, Remote off, new room id.
7. Airplane mode, then back: the phone reconnects. Lock the phone, trigger a Needs-you: push arrives and opens the card.
8. Passkey assertion in standalone mode verifies on the Mac; record whether `getUserMedia` works in the Home Screen app.
9. Not probed: Claude's own `enableRemoteControl`. Runs carry `disableRemoteControl: true`.

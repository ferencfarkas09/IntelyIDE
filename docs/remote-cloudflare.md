# Remote on your own Cloudflare account

How to run the IntelyIDE Remote relay on your own Cloudflare account, or on any relay you trust, from Settings > Remote. The gateway and relay contract are in `docs/remote-gateway.md`.

Nothing in this guide has been verified against a real Cloudflare account by the project. Every check in the evidence section below is empty until you run it and paste the result. All automated tests use a fake wrangler and loopback fixtures.

## What you get, and what you have to trust

| Statement | Truth |
|---|---|
| Message content is end-to-end encrypted (Noise) between your Mac and your phone | Yes, against a relay that runs honest code and only forwards. |
| The relay sees metadata | Room id, timing, sizes, IP addresses, push endpoints. Never content. |
| The relay serves the phone app's JavaScript | Yes. Whoever controls the Worker or your Cloudflare login can ship hostile code to your phone. That code could read what the phone decrypts and approve actions in your name. This stays true until a native phone app exists. |
| What the signed build adds | The signing key stays in the Mac Keychain, never on Cloudflare. After pairing, the phone pins the public key (it arrives through the encrypted pairing channel from the Mac, not through the relay). A swapped file, a partial deploy or a CDN fault gives a build the phone's service worker refuses, and the Mac can check the live relay against the same key. |
| What the signed build does not add | No protection against a stolen Cloudflare login or a hostile Worker: whoever controls the Worker also controls the service worker script. The Mac check is best effort; a server can show the real files to the check and different ones to the phone. |
| You are the operator | Use two-factor authentication on the Cloudflare account. |
| Public address | Anyone can send requests to your `workers.dev` address. Junk traffic counts against the caps (see costs). |

## Where the settings are

Settings > Remote > Relay. A segmented control chooses the mode:

- **This Mac only**: a relay running on this Mac (loopback only). Phones outside your network cannot reach it.
- **My Cloudflare**: your own Worker. Shows the address, status, phone app build, last deploy and the Manage menu. Before a relay exists it shows the button `Set up on my Cloudflare account`.
- **Custom URL**: a relay run by you elsewhere, or by someone you trust.

Changing the mode only changes the panel. Nothing is switched until you press `Use this relay now`. Opening the page spawns no process and makes no network call.

## Starting the app so the relay tools work

`pnpm dev:app` starts read-only, and in read-only mode the relay group is grey: the banner says "Read-only mode: nothing here can contact Cloudflare. Start with INTELY_CLOUD=1 to enable the relay tools only."

- `INTELY_CLOUD=1 pnpm dev:app` (also `pnpm dev:app -- --cloud`) turns the relay tools on and nothing else. Your real repos stay jailed: no commit, push or file writes.
  - "The relay tools" includes the relay connection of Remote: with the flag, Remote can reach a relay on a `wss://` host other than your own machine, but only a host you acknowledged (the flag acknowledges nothing). Without the flag, read-only mode refuses that connection too. What a paired phone may ask your Mac to do is unchanged and still runs under the read-only jail.
- `INTELY_WRITABLE=1` also enables the relay tools, but it also unlocks commit, push and file writes on your real repos and agent writes. Use `INTELY_CLOUD=1` instead.
- Test mode (`INTELY_E2E`) always wins: only a fake wrangler inside the fixture folder and loopback addresses work.

## Setting up your own relay (wizard)

The wizard has seven steps. Back is possible until Deploy starts. Closing the dialog while a command runs asks "Stop the running step?".

1. **Prerequisites.** Rows: keys can be stored durably (macOS Keychain), relay kit found (the `remote-relay` and `remote-web` folders; deploying works from a source checkout), Wrangler installed at the pinned version, node and pnpm found, phone app built. If the kit is missing the step says so and stops. `Prepare` runs `pnpm install` in both folders and builds the phone app. It downloads packages from the npm registry and sends nothing to Cloudflare.
2. **Sign in.** Either "Sign in with Cloudflare (recommended)" or "Use an API token".
   - Sign in opens your browser through `wrangler login`. The sign-in address is shown as text only. "This Mac has no browser (SSH or remote desktop)" switches to the device flow.
   - `wrangler login` asks for broad permissions on your whole account and stores a refresh token in a plain file in your home folder. A token scoped to Workers Scripts: Edit on one account is the more cautious choice if you use two-factor authentication or run agents that can write. The token is stored in the Keychain and the field is cleared at once.
   - If you have several accounts you must choose one.
3. **Name and options.** The Worker name defaults to `intely-relay-` plus 12 random hex characters. Rules: lowercase letters, digits and dashes, up to 63 characters, no dash at the start or end. Short custom names get a "guessable" warning. The `Push notifications` switch generates push keys and sets three secrets after the deploy; notifications never contain content. You need a workers.dev subdomain on the account; the deploy cannot register one unattended.
4. **Review.** Shows the exact command, the environment variable names (never values), the account, the Worker, the address, what will be created or replaced (Worker, two Durable Object classes, static files, secrets), the phone app build hash and the signing key fingerprint, and the costs notice. To enable `Deploy` you tick "I understand this creates or replaces a Worker and its Durable Objects in the account shown above." and type the Worker name exactly. The command shown is the one the app holds in a one-time plan with a five minute expiry: the deploy only runs when it presents that plan and the typed name, so a call that skipped the review, replayed it or let it expire does nothing. The same applies to Rollback and Remove. If the dry run cannot list the modules that would be uploaded, the review says so and you must tick a second box before it will deploy. Deploy, redeploy, rotation, rollback, remove and forget are each written to `cloud-audit.jsonl` in the app data folder (a hash chain of Worker name and outcome, no secrets) before they start. If a Worker with that name exists and was not created by this app, or the relay kit has uncommitted changes, you must also type an overwrite phrase.
5. **Deploy.** A step list (stage and sign, generate config, deploy, read the address, push secrets, wait for the relay, verify the build, record) with masked command output. `Stop` ends the step. Failed idempotent steps offer `Retry from this step`.
6. **Verify and use.** Shows reachable, version, Durable Objects, push configured, and the build verdict. `Use this relay now` is disabled unless the verdict is "Signed and matching". If paired phones exist and the host changes, a dialog says "Switching relay hosts unpairs your phones" and the button is `Unpair phones and switch`. With Remote on, the old room is wiped first; with Remote off, the old room, device hashes and push subscriptions stay on the old Worker until it is removed.
7. **Done.** Shortcut to pair a phone.

When a relay profile already exists the wizard opens on the Manage menu instead.

## Manage menu

| Item | What it does |
|---|---|
| Update / redeploy | Wizard at the review step. `Update available` appears when the relay code or the local build differs from the deployed one. |
| Rotate signing key | The new key is prepared next to the current one and only becomes the active key after the next deploy and the relay check succeed; if they fail the current key stays and the rotation stays pending ("Roll back the signing key rotation" removes it). Every paired phone must be paired again once the key switches. |
| Rotate push keys | Prepared the same way; the next deploy with push on ships it. Until then pushing the old secrets again is refused. Phones re-subscribe the next time they open the app. |
| Rotate relay identity (panic) | Revokes all phones, new keys, wipes the room. |
| Replace API token | Overwrites the stored token. This app cannot revoke the old one: delete it in the Cloudflare dashboard. |
| Sign out of wrangler | Runs `wrangler logout` on this Mac. The Worker keeps running. |
| Stop using this relay | Back to "This Mac only". The profile is kept and the Worker keeps running, with its room and push subscriptions. Optional: wipe the room first. |
| Roll back the relay | Runs `wrangler rollback` after a confirmation. The recorded build may then differ from the live one; the status shows it. |
| Forget this relay | Removes the profile, signing key, token and push keys from this Mac. Does not touch Cloudflare. |
| Remove from Cloudflare | Hidden until the manual check M8 passed (setting `remote.cloud.removeEnabled`). Until then remove the Worker by hand, see below. |
| If the relay or a key was compromised | The runbook below. |

### If the relay or a key was compromised

Do these in order. The first two work from this Mac.

1. Press Panic in Settings > Remote: it revokes every phone, rotates the keys and wipes the room.
2. Manage > Rotate signing key, then redeploy and pair your phones again.
3. In the Cloudflare dashboard delete or replace the Worker.
4. Sign out and revoke OAuth sessions in the dashboard, and sign out of wrangler here.
5. Delete the API token in the dashboard and create a new scoped one if you use token mode.

### Removing the Worker by hand

Open the Cloudflare dashboard, Workers and Pages, select the Worker, and delete it. The documentation describes deleting Durable Object data only through a `deleted_classes` migration; whether deleting the Worker removes that data is not settled (check M8). Until you have checked it, assume the stored room data and push subscriptions may remain.

## Custom URL

Enter a `wss://` host name (no IP address, no user name, path, query or fragment; `ws://` is only allowed for a relay on this Mac). Optionally enter the build public key (43 characters, from the person who signed the phone app build). `Check` asks the relay for its status and, with a key, checks the build. Without a key the result says "Code source not verified: the build hash is only what the host showed." You must tick "I operate or trust this host to serve the phone app and to see connection metadata." and type the host name. Then `Use this relay now` switches live.

## Costs and limits

The Settings page shows a table generated from `crates/relay_deploy/src/limits.rs` with its check date; the guide does not repeat the numbers so they cannot drift. Plain facts:

- On the Free plan, once a daily cap is used up the relay stays unreachable until 00:00 UTC. Nothing is charged. This Mac counts messages sent today and warns at half of 100,000.
- Not settled in the Cloudflare documentation: whether the Free daily Durable Object cap counts WebSocket messages 20 to 1. In the worst case a steady stream of 4 messages per second uses the cap in about 7 hours.
- Anyone on the internet can send requests to your workers.dev address. On a paid plan junk traffic can cost money and there is no spend cap: set a billing notification in the dashboard.
- Phone app file requests do not wake the Worker or the Durable Object.
- This is an estimate, not a guarantee. Wrangler does not warn you before a cap is hit.

## Messages you may see

Errors are shown in the wizard with these meanings: not signed in, choose an account, no workers.dev subdomain (register one in the dashboard, then try again), missing permission (Workers Scripts: Edit on that account), invalid or taken Worker name, review expired (review again), another step is running, network error, timeout (use the no-browser sign-in), deploy failed (nothing applied), push secrets failed (the relay works without push; retry later), relay did not answer (new addresses can take a minute), served build differs from the deployed one (look at your Cloudflare account), invalid signature, host not acknowledged, switching hosts unpairs phones (confirm first), Keychain locked, Keychain unavailable so nothing was generated, rate limited, account unverified, local sign-in port busy, Cloudflare limit reached, offline, relay kit has uncommitted changes, clock far from the last signed build. An interrupted deploy shows "The last deploy did not finish. Check the Cloudflare dashboard or deploy again; repeating it does no harm."

## Safety notes

- No agent can call these commands; they are webview only. The agent hard stops also refuse wrangler in any spelling, `api.cloudflare.com` requests and the wrangler credential and log folders (best effort, see `docs/safety.md`). After an OAuth sign-in the credential file is readable by any shell with write access, so token mode with one account is recommended if you run writable agents.
- The Mac talks to Cloudflare only through the project-pinned wrangler, plus plain HTTPS requests to your own relay.
- Everything outward-facing needs a click; read-only mode forbids all of it unless `INTELY_CLOUD=1`.

## Evidence (fill in yourself; empty means not verified)

Run these on a throwaway Cloudflare account on the Free plan with two-factor authentication on, and paste the result. Nothing is claimed before.

| Step | What to check | Date | Result |
|---|---|---|---|
| M1 | Whether `wrangler deploy --dry-run` needs no login and accepts `preview_urls: false` | | |
| M2 | Output and exit code of a non-interactive deploy with no workers.dev subdomain | | |
| M3 | `wrangler delete`: prompt, `--force`, behaviour with Durable Object data | | |
| M4 | Whether `secret put` works before the first deploy | | |
| M5 | `whoami --json` fields; `deployments list --name` for missing and existing Workers | | |
| M6 | Minimal token permission set for the first deploy | | |
| M7 | `WRANGLER_LOG_PATH`, `login --use-keyring` in the pinned version | | |
| M8 | Removal of Durable Object data (`deleted_classes` migration, then delete) | | |
| M9 | Token restricted to Workers Scripts: Edit on one account | | |
| M10 | Rotate signing key, push keys, relay identity: phones re-pair or re-subscribe as stated | | |
| M11 | Switch the relay host with phones paired: unpair confirmation, re-pair, passkeys re-registered | | |
| M12 | Free-cap behaviour for a day: frame counter against the dashboard's request counts | | |
| M13 | Restart the unsigned dev build: the signing key survives or the Keychain-unavailable refusal appears | | |
| M14 | Whether `wrangler logout` revokes at Cloudflare; whether wrangler ignores `.env` and `.dev.vars` in its folder; metrics and update-check opt-outs | | |
| iPhone | Home Screen install, pairing, locked-phone push, service worker behaviour on a real iOS device | | |

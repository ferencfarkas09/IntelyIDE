# registry

A Cloudflare Worker with a D1 database. It keeps the name and email address of people who register in IntelyIDE, their newsletter choice, and the details of the computers they run the app on, so that the owner of the project can see how many people use it, on what kind of machines and where.

The app registers a person only after they agreed on the first-start screen. Nothing is sent before that, and the person can look at everything stored about them in Settings and delete it there (`docs/privacy.md`).

## What is stored

| Table | Column | What | Why |
|---|---|---|---|
| `users` | `email`, `name` | what the person typed, the address in lower case | to know who registered; the newsletter goes to this address |
| `users` | `consent_notice`, `consent_at` | the version (a date) of the privacy notice the person agreed to, and when | proof of the agreement |
| `users` | `newsletter_status` | `none`, `pending` (confirmation mail sent), `subscribed`, `unsubscribed`, `failed` | the newsletter is asked for with an unticked box and confirmed by mail (double opt-in) |
| `installs` | `machine_hash` | the fingerprint of the computer: a SHA-256 made in the app from the machine id of the operating system, hashed again here with a secret (`PEPPER`) | to count computers, not registrations; it cannot be turned back into the machine id |
| `installs` | `token_hash` | SHA-256 of the token the app keeps | so the app can refresh and delete its own record; the token itself is never stored |
| `installs` | `os`, `os_version`, `arch`, `cpu_cores`, `ram_gb`, `locale`, `tz` | the kind of machine | what to support and test on |
| `installs` | `app_version`, `first_seen`, `last_seen`, `launches` | which version, since when, last start, number of starts (counted once an hour at most) | how many people use which version |
| `installs` | `country`, `region`, `city` | the coarse place Cloudflare derives from the request | where the users are |

Not stored: the IP address (it is read for the rate limit as the input of a salted hash, kept for a day), hardware ids, user names of the operating system, repository names, file names, prompts, answers or any content of the work. There is no tracking of what the person does in the app.

Computers not seen for `RETENTION_DAYS` (730) are deleted by a daily job, and so are people left with no computer and no newsletter. The newsletter itself is handled by Brevo (below).

## Routes

The app (JSON, `no-store`, request bodies up to 4 KiB, per-address limits in ten-minute windows):

| Route | What |
|---|---|
| `POST /v1/register` | `{ name, email, consent: { storage: true, newsletter, notice }, appVersion, device: { id, os, osVersion, arch, cpuCores, ramGb, locale, tz } }`. Stores the person and the computer and answers `{ token, notice, newsletter }`. The token is shown once. The same computer registering again replaces its token. `consent.storage` must be `true`. |
| `POST /v1/ping` | `Authorization: Bearer <token>`, `{ appVersion, device }` without the id. The app started: refreshes version and details. |
| `GET /v1/me` | Everything stored about this computer and its person. |
| `POST /v1/newsletter` | `{ subscribe: boolean }`: ticks or unticks the newsletter later. |
| `POST /v1/forget` | Removes this computer. When it was the person's last one, the person and the newsletter contact go too. |
| `GET /v1/health` | `{ ok, notice }` |

The owner (`/admin`, needs `ADMIN_TOKEN`, at least 24 characters; without it the whole admin side answers 404): a page with the numbers (people, computers, active in 7 and 30 days, by system, architecture, app version, country, place, memory, newsletter status, computers per person), a searchable list of people, the computers of one person with a button that deletes the person (and the newsletter contact), and a CSV export (cells that start with `=`, `+`, `-` or `@` are quoted so a spreadsheet does not run them). Put Cloudflare Access in front of `/admin*` as the first lock; the token is the second.

## Newsletter (Brevo, double opt-in)

With `NEWSLETTER_PROVIDER` set to `brevo`, a ticked box makes the Worker ask Brevo to send a confirmation mail (`POST /v3/contacts/doubleOptinConfirmation`). Brevo adds the address to the list only when the person clicks the link, and puts an unsubscribe link in every campaign. The daily job asks Brevo who confirmed or left and updates `newsletter_status`; a request nobody answered for 14 days lapses. Unticking in Settings takes the address off the list, deleting the last computer erases the contact. Nobody who did not tick the box is sent anything. With `NEWSLETTER_PROVIDER` at `none` the choice is stored and nothing leaves the Worker.

`pnpm brevo:setup` creates the list "IntelyIDE users" and the confirmation template in your Brevo account (see the header of `scripts/brevo-setup.mjs`); it leaves every other list and template alone. Use a sender address on your own domain with SPF and DKIM set up.

## Deploy (once)

```
cd registry
pnpm install --ignore-workspace
pnpm exec wrangler login
pnpm exec wrangler d1 create intelyide-registry --jurisdiction eu    # copy the database_id it prints into wrangler.jsonc, under d1_databases
pnpm migrate:remote
pnpm exec wrangler secret put PEPPER          # at least 16 random characters, never changed later (it keys the fingerprint hash; without it the Worker answers 503)
pnpm exec wrangler secret put ADMIN_TOKEN     # at least 24 characters
BREVO_API_KEY=... pnpm brevo:setup --sender-email news@your-domain --sender-name IntelyIDE   # optional; then set the three vars it prints and:
pnpm exec wrangler secret put BREVO_API_KEY
pnpm deploy
```

`pnpm deploy` also serves the Worker on `registry.intelyhome.com` (`routes` in `wrangler.jsonc`): the app has that host built in, so the zone must be in your account and the name must not have a DNS record yet. Do not use `api.intelyhome.com`; that is the IntelyOpti API. Check it with `curl https://registry.intelyhome.com/v1/health`, which answers `{"ok":true,"notice":"..."}`. Then set `Cloudflare Access` for `/admin*` (Zero Trust > Access > Applications); leave `/v1/*` open, the app calls it.

The privacy notice the app shows has a version, `NOTICE_VERSION` (a date). When the text changes, change the date in the app and here together; the app asks again for consent when the date of its notice is newer than the one it stored.

## Run and test locally (no login)

```
cd registry
pnpm install --ignore-workspace
pnpm typecheck
pnpm test             # the handlers against real SQLite (node:sqlite), Brevo faked; seconds
pnpm migrate:local && pnpm dev   # wrangler dev --local on 127.0.0.1:8788, with a local D1
```

`wrangler dev` takes variables for the secrets: `pnpm dev --var ADMIN_TOKEN:<24+ characters> --var PEPPER:x`. The local `cf` place is a placeholder, not your location.

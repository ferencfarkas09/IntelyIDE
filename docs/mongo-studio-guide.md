# MongoDB Studio: user guide

MongoDB Studio is a read-only database browser inside IntelyIDE. This guide explains how to set it up, what it stores and what to do when a connection fails. It never writes to a database: there is no insert, update, delete, index build, raw command or JavaScript shell.

## 1. Enabling
1. Settings > Database > switch "MongoDB Studio" on. It is off by default and, while off, nothing runs: no thread, no socket, no Keychain read, no temp file, no `ssh`.
2. The Database item appears in the left rail. With no connection yet you see "Connect your first database".
3. If the switch is disabled with "This build does not include the database module", the app was built without the cargo feature. The cargo feature `mongo-studio` (`mongo-studio = ["dep:intely-mongo"]` in `src-tauri/Cargo.toml`) is in the default features of `src-tauri`, and `scripts/build-release.sh` passes it explicitly; a build with `--no-default-features` has no database module.
4. Turning the switch off closes every connection and tunnel, drops cursors and drafts, and closes the studio tabs.

## 2. Starting points (first-run wizard or "New connection")
| Starting point | What you do |
|---|---|
| MongoDB Atlas | Paste the `mongodb+srv://` string from Atlas > Connect > Drivers. Replace `<password>` in the field that gets focus (the placeholder is never used as a password). Atlas needs your current IP in Network Access. |
| This computer or Docker | Click "Look for MongoDB on this computer" (probes 127.0.0.1 ports 27017-27019, only when you click). If nothing is found it shows `docker run -d --name mongo-try -p 127.0.0.1:27017:27017 mongo:7`. |
| A server on my network | Host list, replica set name, authentication, optional TLS. |
| Through an SSH server | Bastion details first, then the database host as the bastion sees it. |
| I have a connection string | Paste it; the form fills in and the pasted text is replaced by a masked version. |

The wizard tags the connection from the host: loopback is Local, anything else is Production. You can change the tag; lowering it on an existing connection needs the connection name typed. Test the connection (the step list shows where it stops and why), then Save. A read-only database user is still recommended: the tip card after saving has a copyable `createUser` snippet.

### The form, in short
Tabs: Connection (fields or connection string, replica set, read preference), Authentication (SCRAM, X.509, PLAIN; the password is write-only and "Save in the Keychain" decides whether it is stored), TLS (automatic, on, off; PEM CA file; PEM client certificate with an optional key passphrase; "Skip all certificate checks" as a last resort), Tunnel, Advanced (compression, timeouts, allow-listed extra options), Safety, AI. Not supported: AWS IAM, Kerberos, OIDC, PKCS#12 certificates, client-side encryption; options that need them are listed as unsupported instead of being dropped silently.

### Production and loudness
Any non-loopback host, any `+srv` host and any tunnel is Production-level whatever the tag says. Production-level connections show a permanent bar "PRODUCTION . read-only . host" in every collection tab, a red tab stripe and a red chip in the title bar. A user that can write shows the writer banner. To treat a host as non-production, type the host name in Safety (the tag you chose still shows). Skipping certificate checks needs the typed connection name and is refused at the Production level.

## 3. SSH tunnel
Uses your own `/usr/bin/ssh` (owned by root, OpenSSH 8.4 or newer for password and passphrase modes). macOS and Linux only.
1. Tunnel tab: SSH server. Fill host (or an alias from `~/.ssh/config`), port, user, and auth: SSH agent, key file (optional passphrase) or password.
2. Add the database hosts the bastion may reach (`host:port`); they are pre-filled from the host list. After a successful test "Discover members" offers the replica set members.
3. First test: the host-key dialog shows the SHA256 fingerprint. Compare it with the one your administrator gave you, then "Trust and connect". A changed key is never trusted from the UI: use "Forget the saved key" (type the host) only if the server was re-keyed on purpose.
4. A bastion behind another hop: put `ProxyJump` in `~/.ssh/config` and keep "Use my ~/.ssh/config" on; the dialog can then verify only the bastion itself (run `ssh <host>` once in a terminal if it cannot scan).
5. Passwords and passphrases are never on a command line or in the environment. SRV and TXT name lookups still happen on this computer, outside the tunnel.
6. If the master `ssh` dies (sleep, network change, `kill`), the card shows "SSH tunnel ended" and Reconnect. Nothing reconnects by itself.
Alternative: run your own `ssh -D 1080 ...` and choose SOCKS5 proxy in the Tunnel tab.

## 4. Groups, favourites, import and export
- Group (one level, 40 characters) and the favourite star are set in the form header or the card menu; they are cosmetic and need no confirmation.
- Export (manager header or card menu): choose profiles, "Include SSH tunnel settings" (default on), "Include file paths" (default off). The native save dialog is opened by the app. Passwords and passphrases are never exported, nor are signatures, overrides or relaxed-TLS settings. File name `intely-mongo-profiles.json`.
- Import: native open dialog, then a dry-run preview with warnings and every outbound endpoint (databases, bastion, proxy). Imported profiles are read-only, AI off, no override, no relaxed TLS, tagged at least Production when they use a tunnel, and show "Password needed". The first connect of one with a tunnel, proxy, PLAIN, TLS off or remote host asks a confirm listing the endpoints. A plain text file with one `mongodb://` or `mongodb+srv://` URI per line also works (their passwords go straight to the Keychain).
- Limits: 200 profiles, 50 URI lines, 1 MiB.

## 5. AI find and presets
AI find keeps its privacy model: AI is off per connection until you turn it on (typed connection name); P0 sends nothing, P1 sends field names, types, counts and indexes, P1+ adds low-cardinality value sets; you can preview the exact bytes before the first send; the answer is only a draft you run yourself. It needs Node and the Claude CLI (the AI tab says whether they are found). Per connection you can add glossary pairs and deny fields (removing a deny field needs the typed name).

The preset decides the AI prompt and wording. New connections use the generic preset (no Hungarian text, time zone from your computer). A second, optional preset exists for an integration with a business backend: it uses a Hungarian prompt and glossary, Hungarian sample prompts and a list of tenant field-name candidates. It is off by default (Settings > Database); when it is switched on, new connections default to it. Connections saved by an older build are read with that preset and keep their behaviour; change it under AI.

## 6. Where things are stored, reset and uninstall
| What | Where |
|---|---|
| Secrets (database password, key passphrase, SSH password or passphrase, proxy password) | macOS Keychain, the service `com.intelyhome.intelyide.mongo` (secrets stored by earlier versions under `hu.happygastro.intelyswitchide.mongo` are read once and copied; the old items are left in place), one item `sec.<profile id>` per connection; also `tamper-key`, `rev.<id>` and, for connections saved by older builds, `uri.<id>`. Other systems: kept in memory for the session only (Settings says so and disables "Save in the Keychain") |
| Connections (no secrets) | `~/Library/Application Support/IntelyIDE/settings.json`, namespace `mongo` (host names, user names and file paths are in there; the signature protects the safety fields) |
| Trusted SSH host keys | `~/Library/Application Support/IntelyIDE/mongo_known_hosts` (your own `~/.ssh/known_hosts` is read, never edited) |
| Tunnel bookkeeping | `~/Library/Application Support/IntelyIDE/mongo-ssh.pids` |
| Audit of reads (no bodies, no URIs) | `~/Library/Application Support/IntelyIDE/mongo-audit.jsonl` (+ `.1`, `.2`) |
| Tunnel control socket (only while a tunnel is up) | `intely-ssh-<uid>-<random>` directory, mode 0700, below `$TMPDIR` (or `/tmp`) |

- The folder `IntelyIDE` in the paths above is the planned name; version 1.0.1 still uses `IntelySwitchIDE` there (see [privacy.md](privacy.md)).
- Delete one connection: the card menu removes its Keychain item (and its saved host key only if no other connection uses the same bastion).
- Forget everything: Settings > Database > Reset: type `RESET`; it closes everything, deletes all connections and every Keychain item of the service, `mongo_known_hosts`, `mongo-ssh.pids` and stale tunnel directories; "also delete the audit log" is a separate tick. It works while Studio is off.
- Uninstall by hand: Keychain Access, search `intelyide` and `intelyswitchide`, delete the items whose service ends in `.mongo` (the `intelyswitchide` ones are the old items of earlier versions); remove the files above; `ls -d "$TMPDIR"/intely-ssh-* /tmp/intely-ssh-*` should be empty (after a crash the next tunnel open sweeps orphans).

## 7. When something fails
The test shows the step that failed and a likely cause with fixes. Common ones: Atlas "no suitable servers" means your IP is missing in Network Access or the cluster is paused; authentication failures on Atlas often need auth database `admin`; TLS "unknown issuer" needs the CA file (PEM); "host name does not match" means use the name on the certificate or a tunnel; "signed in, but cannot list databases" means type the database name. "Technical details" has the scrubbed raw text. The error codes are defined in `crates/mongo/src/error.rs`.

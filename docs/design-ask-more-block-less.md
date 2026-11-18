# Design: ask more, block less (draft for review)

Status: Phase 1 design, no policy code. Base: `main` at 7ac4e62 (1.15.0). This note is the review copy of the draft pull request; it is replaced by the updated `docs/safety.md` tables in Phase 2.

The owner's request (after 1.15.0, often in Bypass): when the agent wants something that is not clearly safe, **ask** instead of refusing; answers **allow once**, **allow like this for the session**, **allow everything for the session**; and in Bypass, far less ends in a hard stop. The hard limits ("agents can edit but never commit or push") do not move.

## 1. Evidence: what refuses today

Harness: `crates/agent_core/tests/zz_corpus_probe.rs` (ignored test) runs `crates/agent_core/tests/fixtures/ask_corpus.txt` (732 calls: package managers, node/python, git reads, local git, the forbidden git writes, docker, curl/wget, make/cargo/go/xcodebuild, brew, sed/awk/jq, find/xargs, rm/mv/cp inside and outside, chmod, ssh, redirects, pipes, subshells, here-docs, `cd` chains, `sh -c`, env prefixes, package scripts, test runners, dev servers, simulators/adb, `open`, `kill`, and the file/web/other tools) through `decide` in all five modes, with the production context (`strict_jail` on except Bypass, a state dir, `/tmp` scratch, `stops_askable`). Run: `INTELY_CORPUS=… INTELY_CORPUS_OUT=out.tsv cargo test -p intely-agent-core --test zz_corpus_probe -- --ignored`.

| Mode | Allow | Ask | Deny | Deny + card (tier 2) |
|---|---|---|---|---|
| Plan | 71 | 11 | 649 | 1 |
| Ask | 3 | 576 | 151 | 2 |
| Accept edits | 73 | 506 | 151 | 2 |
| Automatic | 489 | 0 | 241 | 2 |
| Bypass | 577 | 0 | 153 | 2 |

Of the 666 ordinary developer calls (the deliberate attack lines removed), **Automatic refuses 177 (27%)** and **Bypass refuses 89 (13%)**. The Bypass refusals that a developer hits are mostly false positives or low-regret, not the hard limits; the rest of "everything is blocked" comes from three structural causes the corpus cannot show: a **resumed Bypass run restarts as Automatic** (by design), **capped repository roles are held read-only** in Automatic and Bypass (`delegate.read-only` for every edit of such a helper), and in Automatic the **Claude CLI's own prompts** that are not on the measured list end as `cli.prompt-denied` (`Contains command_substitution`, `find -delete`, `..` traversal, a path outside its directories).

### Ranked: what a normal developer hits (frequency in the corpus, then judgement)

| # | Rule | Automatic | Bypass | Typical command |
|---|---|---|---|---|
| 1 | `exec.auto.outside-jail` | 33 | allow | `cd .. && ls`, `cat ~/Downloads/data.csv`, `rm -rf ~/Library/Developer/Xcode/DerivedData`, `cp dist/app.js ../other/public/` |
| 2 | `read.never-read` (shell, project `.env`) | 26 (all modes) | same | `cp .env.example .env`, `ls -la .env*`, `diff .env.example .env`, `test -f .env \|\| cp …`, `chmod 600 .env`, a script that copies `.env.example` |
| 3 | `fs.protected` / `fs.protected-arg` (lockfiles) | 20 (all modes) | same | `rm package-lock.json && npm install`, `rm yarn.lock && yarn`, `rm Cargo.lock`, `git checkout package-lock.json`, `jq '.packages' package-lock.json` (a read) |
| 4 | `exec.auto.unjudgeable` | 17 | allow | `kill $(lsof -t -i:3000)`, `npx eslint $(git diff --name-only)`, `pushd`, `eval "$(fnm env)"` |
| 5 | `exec.auto.destructive` | 13 | allow | `git restore src/x.ts`, `git checkout -- .`, `git clean -fd`, `find . -name '*.pyc' -delete`, `chmod -R 755 .` |
| 6 | `exec.auto.network` | 11 | allow | `curl http://localhost:3000/health`, `nc -z localhost 5432`, `ssh host ls`, `rsync … host:` |
| 7 | `fs.outside-jail` (file tools, Ask/Edit/Auto) | 2 | allow | Write/Edit into a sibling repository or `/tmp` (Ask/Edit) |
| 8 | `read.auto.outside` | 6 | allow | Read/Glob/Grep of a sibling repository, `~/Downloads`, `/etc/hosts` |
| 9 | `cli.prompt-denied` | live runs | n/a | see above |
| 10 | `delegate.read-only` (capped role) | every edit | every edit | a helper from a repository role file whose permission was never set |
| 11 | `exec.proc-env` | 2 | same | `ps -ef \| grep node` (false positive: a dashed `-e` lists all processes on macOS and Linux) |
| 12 | `other.state-change` | 4 | same | `ScheduleWakeup`, `CronCreate`, `Workflow` (no ultracode), `EnterWorktree` |
| 13 | `exec.auto.env-override` | 3 | allow | `NODE_OPTIONS=--max-old-space-size=4096 npm run build`, `PYTHONPATH=. pytest`, `TMPDIR=… npm test` |
| 14 | `gh.*` reads | 1 | same | `gh auth status`, `gh repo view`, `gh release list` (false positives) |
| 15 | `git.merge/rebase/cherry-pick` `--abort` | 3 | same | after the person started a merge |
| 16 | `git.stash` | 4 | same | `git stash`, `git stash pop` (agents use it to test "before my change") |
| 17 | `wrangler.*`, `exec.system-secrets` | 5 | same | `wrangler dev`, `osascript -e 'tell application "Simulator" to quit'`, `security find-identity -p codesigning` |
| 18 | `net.auto.private-host`, `other.subagent`, `other.auto.unknown-tool` | 1 each | allow | WebFetch `http://localhost:3000`, an unlisted sub-agent type, a tool newer than the pin |

### Gaps found (allowed today in every mode, against the hard limits)

| Command | Today | Why it is a hard limit | Proposal |
|---|---|---|---|
| `git reset --soft HEAD~1`, `git reset HEAD~3`, `--mixed/--keep/--merge <rev>`, `git reset origin/main` | allow (Auto, Bypass) | moves the branch: rewrites history | tier 1 `git.reset-move` (a `git reset` with a revision other than `HEAD`; `git reset`, `git reset -- f`, `git reset HEAD f` stay allowed) |
| `git gc --prune=now`, `git prune` | allow | destroys recovery points (like `git reflog expire`, already blocked) | tier 1 `git.prune` |
| `echo '* * * * * x' \| crontab -`, `crontab file` | allow | persistence (cron is on the persistence list of `docs/safety.md`) | tier 1 under `BYPASS_KEEPS.persistence` |

## 2. Every refusing rule, today, and its proposed tier

Columns: Plan / Ask / Accept edits / Automatic / Bypass. `D` refusal, `Q` asks (attended card), `C` refusal with a 1.15 card (tier 2), `A` allow, `-` cannot happen. Tier: **1** stays a hard stop in every mode (no answer lifts it); **2** becomes askable with a card in every mode (Plan: reads only); **3** allowed in Bypass (false positive or low risk) while Automatic asks with a card instead of refusing; **R** a configuration or protocol refusal that stays (the reason says what to change; asking would not help); **F** a false positive fixed in the analyser for every mode.

| Rule ids | P/A/E/Au/B today | Example | Why it exists (source) | Tier |
|---|---|---|---|---|
| `git.commit push tag update-ref cherry-pick rebase merge pull am revert notes replace commit-tree send-pack receive-pack fast-import filter-branch filter-repo send-email subtree citool gui svn cvsexportcommit http-push instaweb daemon web--browse http-backend imap-send` | D/D/D/D/D | `git push`, `git commit -am x` | the product promise; `GIT_HARD_VERBS`, `hardstop.rs` | 1 |
| `git.merge/rebase/cherry-pick/am` with only `--abort` (and `--quit`) | D/D/D/D/D | `git merge --abort` | same verb family | **2** (once only): returns to the state before the person's merge; `--continue`/`--skip` stay 1 (they commit) |
| `git.stash` (push, pop, apply, bare) | D/D/D/D/D | `git stash; npm test; git stash pop` | rewrites the working tree and the stash list | **Q3** (proposed 2, once only); `drop`, `clear` stay 1 |
| `git.reset-hard git.branch git.remote git.config git.reflog git.symbolic-ref git.fetch-local git.fetch-refspec git.lfs-push git.credential git.exec-option git.xargs git.binary-copy git.intely-refs git.add-all add-root add-glob add-magic add-xargs add-pathspec-file` | D/D/D/D/D | `git branch -D x`, `git add -A`, `git config user.email` | refs, identity, remotes, staging everything (`confirm.rs` table) | 1 |
| new `git.reset-move`, `git.prune`, cron install | A/Q/Q/A/A | see gaps | history and persistence | **1 (new)** |
| `gh.repo gh.release gh.auth gh.secret gh.ssh-key gh.gpg-key gh.pr(create merge close reopen review) gh.workflow gh.alias gh.config gh.api(write)` | D/D/D/D/D | `gh pr create` | remote state, tokens | 1; **F** for reads: `gh repo view/list/clone`, `gh release list/view/download`, `gh auth status` without `--show-token` |
| `env.git-override env.loader-override env.path-override shim.token hooks.install alias.git-write remote.git-write inline.git-write script.git-write` | D/D/D/D/D | `LD_PRELOAD=x ls`, `ssh h 'git push'` | git tricks, loader injection (`LOADER_ENV_EXACT`) | 1 |
| `script.protected-path` | D/D/D/D/D | a script that writes `.git/hooks` | a grant cannot vouch for a script | 1 |
| `pm.publish` | D/D/D/D/D | `npm publish`, `npm login` | registry state | 1 |
| `exec.raw-text` (Bypass only) | -/-/-/-/D | `eval "$(x)"; git push` | text scan of what cannot be parsed | 1 |
| `exec.too-long exec.catastrophic exec.system-secrets` | D/D/D/D/D | `rm -rf ~`, `security find-generic-password` | wipes, Keychain, system scripting | 1 |
| `exec.proc-env` | D/D/D/D/D | `ps eww 1`, `ps -E` | other processes' environments hold secrets | 1; **F** for a dashed `-e` (`ps -ef`, `ps -eo pid,comm`): all processes, not the environment |
| `wrangler.*` (10 ids) | D/D/D/D/D | `npx wrangler deploy` | Cloudflare credentials and deployment | 1 (unchanged; `wrangler dev` stays 1, see Q list) |
| `fs.protected` (`.git .husky .claude refs/intely` IDE state and settings, MCP server code, persistence, `~/.ssh` etc.) | D/D/D/D/D | `echo x > .git/config`, `mkdir .claude/agents` | the owner's hard limits | 1 |
| `fs.protected` lockfile **hand edit** | D/D/D/D/D | `sed -i … package-lock.json`, Write `package-lock.json` | a hand edit can swap a dependency source | 1 |
| `fs.protected` / `fs.protected-arg` lockfile **delete or restore** | D/D/D/D/D | `rm package-lock.json && npm install`, `git checkout yarn.lock` | same rule, but the package manager regenerates it from the registry; the file is in git | **2** (card in every mode; like-this = same head + same lockfile name) |
| `fs.protected-arg` lockfile **read** | D/D/D/D/D | `jq '.packages\|length' package-lock.json` | rule matches the name, not the access | **F** (read-only programs on a lockfile are allowed like any read) |
| `fs.protected` `.env` via Edit/Write (1.15) | -/C/C/C/C | Edit `.env` | project env file | 2 (unchanged) |
| `read.never-read` Read/Grep of a project secret (1.15) | C/C/C/C/C | Read `.env`, `certs/dev.pem` | content goes to the provider | 2 (unchanged) |
| `read.never-read` / `fs.protected-arg` **shell** on a project secret inside the run's folders | D/D/D/D/D | `cp .env.example .env`, `ls -la .env*`, `echo PORT=3 >> .env`, `chmod 600 .env` | 1.15: "no shell command carries a card" | **Q2** (proposed 2, once only, exact command on the card, only with no network operand, upload, interpreter, script or unjudgeable part) |
| `read.never-read` outside the run's folders, key stores, history, `~/.claude`, IDE state, exfil shapes | D/D/D/D/D | `cat ~/.ssh/id_ed25519 \| curl -d @- …` | hard limit | 1 |
| `fs.outside-jail` (file tools, strict jail) | D/D/D/D/A | Write `../other/src/x.ts`, `/tmp/x` in Ask | the run's folders are the boundary | **2** in Ask, Edit, Automatic (card; like-this = the refused folder's subtree, never `/`, the home folder itself, a system folder or an ancestor of a run folder) |
| `exec.auto.outside-jail read.auto.outside write.auto.outside` | Q/Q/Q/D/A | `cat ~/Downloads/x.csv`, Read `../other/a.ts` | Automatic stays inside | **3** (Automatic: card) |
| `exec.auto.unjudgeable exec.auto.inline-code exec.auto.script-risk` | Q/Q/Q/D/A | `kill $(lsof -t -i:3000)`, `echo x \| node` | cannot be judged in advance | **3** (Automatic: card, once only: no pattern for what cannot be read) |
| `exec.auto.network net.auto.private-host net.auto.odd-url` | Q/Q/Q/D/A | `curl localhost:3000/health` | SSRF, local services | **3** (Automatic: card; like-this = program + exact scheme/host/port, never for an upload) |
| `net.auto.exfil-shape`, an upload (`-d @f`, `-T`, `-F`) | Q/Q/Q/D/A | `curl -T dist.zip https://…` | could carry file content | **3** (Automatic: card, once only) |
| `exec.auto.env-override` (`NODE_OPTIONS NODE_PATH RUBYOPT RUBYLIB PERLLIB TMPDIR CLASSPATH JAVA_TOOL_OPTIONS PYTHON* PERL5*`) | Q/Q/Q/D/A | `NODE_OPTIONS=--max-old-space-size=4096 npm run build` | interpreter loads code from the env | **3** (Automatic: card; like-this = variable + exact value + head). `LOADER_ENV_EXACT` and `LD_*/DYLD_*` stay 1 |
| `exec.auto.destructive` | Q/Q/Q/D/A | `git restore f`, `git clean -fd`, `find -delete` | discards uncommitted work (Rewind holds it) | **3** (Automatic: card; like-this = head within the run folder) |
| `other.auto.unknown-tool other.subagent` | Q/Q/Q/D/A | an unpinned tool, unlisted sub-agent | cannot be judged | **3** (Automatic: card; like-this = tool name / sub-agent type) |
| `other.state-change` | Q/Q/Q/D/D | `ScheduleWakeup`, `CronCreate`, `Workflow`, `Artifact`, `PushNotification` | publishes or acts outside the run | **2** (card in Automatic and Bypass; like-this = tool name); `EnterWorktree`/`ExitWorktree`/`RemoteTrigger` stay 1 (isolation, remote runs) |
| `cli.prompt-denied` (1.15 list) | -/-/-/C/- | `Contains brace with quote character` | CLI's own heuristics | 2 (unchanged; Bypass answers them already) |
| `cli.prompt-denied` (other reasons, Automatic) | -/-/-/D/- | `Contains command_substitution`, `find -delete`, `..` traversal, outside its dirs | CLI last-resort guard | **3** (card once; like-this = exact reason, as 1.15); the sensitive-file prompt stays 1 |
| `delegate.read-only` (capped role) | -/-/-/D/D | a repository role file without a set permission | a ceiling, not a grant | **Q5** (proposed R) |
| `mcp.args-unjudgeable mcp.protected-arg delegate.isolation workflow.isolation` | D/D/D/D/D | worktree isolation | boundary | 1 |
| `role.read-only role.deny-list role.tool-not-allowed other.read-only other.enter-plan other.exit-plan-delegate delegate.background delegate.model delegate.nested delegate.cap delegate.unknown-type delegate.unknown-actor workflow.input workflow.override workflow.evasion workflow.nested mcp.policy-deny mcp.unlisted-tool mcp.not-in-set mcp.delegate mcp.resource-server mcp.unknown peer.off peer.delegate peer.unknown peer.ask-unattended exec.unparseable write.no-path` | per role/config | `mcp.policy-deny` = the person set Deny | configuration or protocol | R (unchanged) |
| `policy.ask-in-unattended policy.cli-mode-drift fail-closed` | internal | | fail closed | R |
| Ordinary asks `exec.ask exec.script exec.unparseable exec.write-exec-surface write.ask write.outside write.exec-surface read.outside net.ask net.no-url net.odd-url net.exfil-shape mcp.ask peer.ask other.unknown other.exit-plan workflow.ask` | Ask/Edit cards | `npm test` in Ask | attended modes | unchanged; gain the new scopes |

## 3. Mechanism

* **One path, the 1.15 one.** A newly askable refusal is still `Deny` from `decide` with `confirm: ConfirmOffer` (new kinds `command` and `tool`); the gate already turns such a refusal into a card in every mode (hook `ask`, then `canUseTool`, then the host's grant, then Rust judges again). The verdict set of the unattended modes stays `{Allow, Deny}`; an old sidecar, the phone, a run on a server and a run with no window (`stops_askable` false: scheduled, IntelyFIX without a window) keep refusing as today.
* **Grants are consulted only where an Ask or an Automatic refusal is produced**, after every hard stop, role rule and MCP guard. A tier-1 rule returns before any grant is read; a tier-2 stop reads only its own once grant. This is what makes "never covers a hard stop" structural, not a promise of the matcher.
* **The host does not trust the card** (unchanged): at the click it judges the call again, derives the pattern itself and refuses a pattern that differs (`rulesMoved`).

## 4. Answer scopes

| Answer | Wire (`PermissionDecision`) | Grant in `PolicyContext` | Covers | Ends | Phone |
|---|---|---|---|---|---|
| Allow once | `allowOnce` | `{tool_id}` | this one call | used | ordinary Ask cards: yes (today); stop cards: no |
| Allow like this for this session | `allowRun` (relabelled) | `Like { actor role, pattern }` | the same actor (lead, or one role) and a call that matches the pattern exactly; never a tier-1 or tier-2 stop | Stop, run closed, idle reclaim, resume, any mode switch to a stricter mode | no (`answerOnComputer`) |
| Allow everything for this session | `allowEverything` (new) + `confirmBroad` | `Everything` | every card of tier 3 and every ordinary Ask, for the lead and its helpers; never tier 1, never tier 2 (Q1), never a role ceiling or tool list | Stop, run closed, resume, any mode switch, the chip's revoke | no |
| Deny (with a note) | `deny` + feedback | none | the agent gets "declined" plus the note, and is told not to look for a way around it (1.15 text) | n/a | yes |

**"Like this", exactly.** A pattern is derived by Rust from the analysed call, shown on the card in words and as the exact pattern (`npm run test` in `~/code/app`), and matched by exact word equality on the analyser's unquoted words:

* Shell: only when the command parses with no issue (no `$( )`, backticks, `eval`, unknown variable), every program word is a literal bare name (no `/`, ASCII only), and no simple command is a shell, `env`, `sudo`, `xargs`, `nohup`, `time`, `timeout`, `exec`, `command`, `builtin`, `source`/`.`, or an interpreter with inline or piped code. Head = program plus its first non-option word for programs with subcommands (`git restore`, `docker compose`, `cargo test`, `xcrun simctl`, `npm run <script>` = 3 words); for an interpreter, program plus the exact canonical script path (`node scripts/gen.mjs`), never a wildcard. A trailing pipe into plain filters (`grep head tail wc sort uniq cut tr`) is allowed; `&&`, `;`, `||` chains match only when every part matches a pattern of the session. `dir` = the canonical folder the command runs in (after a literal `cd`), and every path operand must resolve (symlinks followed, `..` folded) inside `dir`'s subtree, or for an outside-folder card inside the refused folder's subtree.
* Network: the program head plus exact scheme, host and port; never for an upload or an exfil-shape URL.
* Env override: the variable name and its exact value plus the head.
* File tools: read family (Read, Glob, Grep) or write family (Edit, Write, MultiEdit, NotebookEdit) plus the folder subtree; never `/`, the home folder itself, a system folder or an ancestor of a run folder.
* Other tools: the tool name (or sub-agent type). CLI prompts: the exact reason (1.15).
* Never derived: tier 1, tier 2, `sh -c`/`bash -c` bodies, inline code, unjudgeable commands, uploads. Those cards offer only "Allow once" and "Deny".

**Existing scopes.** "Allow always in this session" (`SavedAllow`: exec prefix allowlist, net host, MCP tool, write inside, peer) becomes the "like this" of those cards: same data, one button, one label, and it now ends on Stop like the 1.15 grant (a behaviour change: today it survives Stop). "Always for role + repo" is never offered (the host refuses it with `optionNotOffered`); the button is removed. The 1.15 "Allow all secret files in this run" keeps its own second-click button. In-memory only, nothing to migrate.

**The chip.** While `Everything` holds, the run header shows "Accepting everything this session" with a one-click revoke (`revoke_session_grants`), in en and hu. Granting it needs a second click on a plain warning ("the agent can then run, write and fetch anything that is not a hard stop, without asking, until you press Stop"); the host refuses it without `confirmBroad`.

**Audit.** `permission.request` carries `confirm { kind, rule, scope, like }`; `permission.resolved` carries `grant: once | like | all` and the pattern. A call lifted later by a standing grant writes the same pair (`ovr-…`, `by: saved`) with the grant and pattern; the run summary lists "You allowed `npm run test` in app for this session" and "You accepted everything in this session (N calls)".

**Who can answer.** Unchanged rules: a stop card is allowed only by a click in the main window on this computer; the phone sees it as "answer on the computer". The phone cannot give "like this" or "everything" on any card.

## 5. Tests an adversary would try (Phase 2 must pin each)

| Attack | Expected |
|---|---|
| Grant `npm run test`, then `npm run test; git push`, `npm run test && rm -rf ~`, `npm run test > ~/.zshrc` | tier 1 first: refused |
| `npm run test-evil`, `npm run t*`, `npm run "$X"`, `env A=1 npm run test`, `\npm`, `command npm`, `/usr/bin/npm`, `NPM run test`, Cyrillic `npм` | no match: card again |
| `npm run 'test'`, `npm run te""st` | same words: match (no widening) |
| `npm run test \| sh`, `npm run test \| node` | no match (pipe into a shell or interpreter) |
| `cd ~/other && npm run test`, a symlink `src/l -> ~` then `cat src/l/x` | folder mismatch: card again |
| Grant `~/Downloads`, then `~/Downloads/../.ssh/x`, `~/Downloads/l -> ~/.ssh` | resolved first: tier 1 |
| Grant `curl localhost:3000`, then `:3001`, `-d @.env`, the same URL with a user-info part that names another host, `-T f` | no match / tier 1 |
| Grant `node scripts/a.js`, then the agent edits `a.js` to push | the script is scanned on every call: `script.git-write` |
| `sh -c 'npm run test'`, `bash -lc …` | no pattern is ever derived for a shell body |
| `Everything`, then `git push`, `cat ~/.ssh/x`, Write `.claude/settings.json`, `LD_PRELOAD=…` | tier 1: refused |
| `Everything`, then Read `.env` | tier 2 card (Q1) |
| A tool input that carries `stopGrants`, `confirmBroad`, a pattern | ignored: grants come only from the host |
| The agent writes the IDE state, `.claude/`, settings | tier 1 |
| A helper agent after the lead's "like this" | not covered (per role); `Everything` covers helpers but not a read-only ceiling |
| An answer after Stop, a click racing Stop, a stale card after a mode switch | `unknownRequest` / `rulesMoved`; grants cleared |
| Resume | no grant survives; Bypass resumes as Automatic |
| Phone answers "like this" or "everything" | refused, audited `answer.desktop-only` |
| Differential corpus | every tier-1 line denies in all five modes under {no grant, once for another call, every like-this pattern the corpus derives, everything}; the only verdict changes are the listed tier 2/3 and F rows |

## 6. Open questions for the owner

1. Does "Allow everything" also lift tier-2 cards (a project secret file, deleting a lockfile)? Proposed: **no**.
2. Shell commands on the project's own `.env` (`cp .env.example .env`, `ls -la .env*`, `echo X >> .env`, `chmod 600 .env`): a once-only card with the exact command (reverses the 1.15 "no shell on secrets" rule, only without network, upload, interpreter or script)? Proposed: **yes**.
3. `git stash`, `git stash pop`, `git stash apply`: once-only card (`drop`, `clear` stay hard stops)? Proposed: **yes**.
4. In Automatic, an unanswered card falls back to today's refusal after 3 minutes, so a run nobody watches keeps going? Proposed: **yes**.
5. Capped repository roles (read-only in Automatic and Bypass): keep the refusal that points to Settings > Roles, no card? Proposed: **yes, keep**.
6. Close the three gaps above (`git reset <rev>`, `git gc --prune`/`git prune`, `crontab` install) as hard stops in this pull request? Proposed: **yes**.

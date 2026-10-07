# Git/disk assertions of the click-through scenarios o..w. Sourced by run.sh (needs gcheck, r, rem, head_of, status_of,
# snapshot_state, no_leftovers and the scenario variables $FX, $BEFORE, $HEAD0_*, $WORK).

verify_o() {
  local trash="$FX/data/Trash"
  gcheck "backend: every file and folder the scenario made is gone from the repo" "" "$(ls "$FX/repos/shop-backend" | grep -E '^e2e-' || true)"
  gcheck "all four repos are back to the pre-scenario state (HEAD, status)" "$BEFORE" "$(snapshot_state)"
  gcheck "the Trash dir received the renamed file (with the edit), the ghost and the folder" "e2e-dir e2e-ghost.txt e2e-renamed.txt|hello from e2e" "$(ls "$trash" 2>/dev/null | sort | tr '\n' ' ' | sed 's/ $//')|$(cat "$trash/e2e-renamed.txt" 2>/dev/null | head -1)"
  gcheck "the Trash dir holds the folder's inner file" "inner.txt" "$(ls "$trash/e2e-dir" 2>/dev/null | tr '\n' ' ' | sed 's/ $//')"
  gcheck "Reveal in Finder was logged for the renamed file (no Finder window under the harness)" "e2e-renamed.txt" "$(tail -1 "$FX/data/reveal.log" 2>/dev/null | xargs -I{} basename {})"
  no_leftovers
}

verify_q() {
  gcheck "backend: back on sandbox, e2e-feature deleted" "sandbox|" "$(r backend symbolic-ref --short HEAD)|$(r backend branch --list e2e-feature | tr -d ' *')"
  gcheck "backend: HEAD did not move" "$HEAD0_backend" "$(head_of backend)"
  gcheck "backend: its stash is still there (one entry)" "1" "$(r backend stash list | wc -l | tr -d ' ')"
  gcheck "admin: the switch-all put it on e2e-feature" "e2e-feature" "$(r admin symbolic-ref --short HEAD)"
  gcheck "admin: the dropped stash is gone" "0" "$(r admin stash list | wc -l | tr -d ' ')"
  gcheck "services: still on main, no e2e-feature branch (the branch did not exist)" "main|" "$(r services symbolic-ref --short HEAD)|$(r services branch --list e2e-feature | tr -d ' *')"
  gcheck "services: the popped stash is gone and the changes are back" "0 yes" "$(r services stash list | wc -l | tr -d ' ') $([ -n "$(status_of services | grep -v '^??')" ] && echo yes || echo no)"
  gcheck "pos: the failed switch left it on SHOP-260; the applied stash is still listed" "SHOP-260 1" "$(r pos symbolic-ref --short HEAD) $(r pos stash list | wc -l | tr -d ' ')"
  gcheck "pos: the rollback reverted exactly one tracked file (the rest stay modified)" "yes" "$([ "$(status_of pos | grep -vc '^??')" -ge 1 ] && echo yes || echo no)"
  gcheck "the rollback backup was written under the harness data dir (not the real app data)" "yes" "$([ -n "$(find "$FX/data/rollback" -type f 2>/dev/null | head -1)" ] && echo yes || echo no)"
  gcheck "nothing was pushed" "$REMOTE_BACKEND0 $REMOTE_ADMIN_SANDBOX0 $REMOTE_SERVICES0 $REMOTE_POS0" "$(rem backend rev-parse refs/heads/sandbox) $(rem admin rev-parse refs/heads/sandbox) $(rem services rev-parse refs/heads/main) $(rem pos rev-parse refs/heads/SHOP-260)"
  no_leftovers
}

verify_p() {
  gcheck "search is read-only: HEAD and status of all four repos unchanged" "$BEFORE" "$(snapshot_state)"
  no_leftovers
}

# r: 600 more commits on the backend (two authors) so the Log has to page; the tree stays as it is (same tree in every commit).
setup_r() {
  python3 - "$FX/repos/shop-backend" <<'PY' | GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null git -C "$FX/repos/shop-backend" fast-import --quiet --force
import sys, time
now = int(time.time()) - 400 * 60
out = []
for i in range(1, 601):
    who = ("Anna Tester", "anna@example.test") if i % 2 else ("Bela Tester", "bela@example.test")
    msg = f"bulk: item {i}\n"
    out.append("commit refs/heads/sandbox")
    out.append(f"author {who[0]} <{who[1]}> {now + i * 60} +0000")
    out.append(f"committer {who[0]} <{who[1]}> {now + i * 60} +0000")
    out.append(f"data {len(msg)}\n{msg}")
    if i == 1:
        out.append("from refs/heads/sandbox^0")
    out.append("")
sys.stdout.write("\n".join(out) + "\n")
PY
}
verify_r() {
  gcheck "the Log is read-only: status of all four repos unchanged" "$(echo "$BEFORE" | awk '{print $1,$3}')" "$(snapshot_state | awk '{print $1,$3}')"
  gcheck "backend HEAD unchanged" "$(echo "$BEFORE" | sed -n 1p | awk '{print $2}')" "$(head_of backend)"
  no_leftovers
}

# s: a 60-line tracked file with three well-separated edits in the backend (three hunks)
setup_s() {
  local f="$FX/repos/shop-backend/src/lib/long.js" i
  for i in $(seq 1 60); do echo "const line$i = $i;"; done > "$f"
  r backend add src/lib/long.js
  r backend -c user.name=Fixture -c user.email=fixture@example.test commit -q -m "chore: long file" -- src/lib/long.js
  sed -i.bak -e 's/^const line3 = 3;$/const line3 = "hunk-one";/' -e 's/^const line30 = 30;$/const line30 = "hunk-two";/' -e 's/^const line57 = 57;$/const line57 = "hunk-three";/' "$f"
  rm -f "$f.bak"
}
verify_s() {
  local f=src/lib/long.js
  gcheck "backend: one partial commit on top, with the typed message" "e2e: hunks one and three|1" "$(msg_of_head backend)|$(r backend rev-list --count "$HEAD0_backend..HEAD")"
  gcheck "backend: the commit holds hunk one and three of long.js, not hunk two" "1 0 1" "$(r backend show HEAD:$f | grep -c 'hunk-one') $(r backend show HEAD:$f | grep -c 'hunk-two') $(r backend show HEAD:$f | grep -c 'hunk-three')"
  gcheck "backend: the commit touches only long.js" "M	$f" "$(files_of_head backend)"
  gcheck "backend: the working tree still has all three edits" "1 1 1" "$(grep -c hunk-one "$FX/repos/shop-backend/$f") $(grep -c hunk-two "$FX/repos/shop-backend/$f") $(grep -c hunk-three "$FX/repos/shop-backend/$f")"
  gcheck "backend: what is left to commit of long.js is exactly hunk two" "1 0 0" "$(r backend diff HEAD -- $f | grep -c '^+.*hunk-two') $(r backend diff HEAD -- $f | grep -c '^+.*hunk-one') $(r backend diff HEAD -- $f | grep -c '^+.*hunk-three')"
  gcheck "backend: the nine other tracked changes were not committed, plus the left-over hunk" "10" "$(status_of backend | grep -vc '^??' | tr -d ' ')"
  gcheck "other repos untouched" "$(echo "$BEFORE" | sed -n '2,4p')" "$(snapshot_state | sed -n '2,4p')"
  no_leftovers
}

# t: clean, scripted histories in three fixture repos (the UI does the rewriting)
gi() { local k="$1"; shift; r "$k" -c user.name=Fixture -c user.email=fixture@example.test "$@"; }
mkc() { # <repo> <file> <content> <message>
  printf '%s\n' "$3" > "$FX/repos/$(repo_dir "$1")/$2"; gi "$1" add "$2"; gi "$1" commit -q -m "$4"
}
setup_t() {
  local k
  for k in backend admin services; do gi $k reset -q --hard; gi $k clean -qfd; done
  # backend: topic = alpha, beta, a fixup of beta, a wip commit, gamma on top of sandbox; `other` has a clean and a clashing commit
  gi backend checkout -q -b other
  mkc backend o.txt other "other: clean change"
  mkc backend t1.txt clash "other: clashing t1"
  gi backend checkout -q sandbox
  gi backend checkout -q -b topic
  mkc backend t1.txt one "feat: alpha"
  mkc backend t2.txt two "feat: beta"
  mkc backend t2.txt two-fixed "fixup: beta typo"
  mkc backend t3.txt three "wip: drop me"
  mkc backend t4.txt four "feat: gamma"
  # admin: `conf` and its base branch both change shared.txt
  mkc admin shared.txt base "chore: shared base"
  gi admin checkout -q -b conf
  mkc admin shared.txt mine "feat: mine"
  gi admin checkout -q feature-light-design
  mkc admin shared.txt theirs "feat: theirs"
  gi admin checkout -q conf
  # services: main (a live branch) gets two commits
  mkc services s1.txt one "feat: s1"
  mkc services s2.txt two "feat: s2"
}

verify_t() {
  local be="$FX/repos/shop-backend" ad="$FX/repos/admin"
  gcheck "backend: topic holds the rewritten history plus the cherry-picked commit (alpha reworded, beta squashed, wip dropped)" "other: clean change|feat: gamma|feat: beta|feat: alpha (reworded)|feat: menu versioning|chore: initial import|" "$(r backend log --format=%s topic | tr '\n' '|')"
  gcheck "backend: still on topic" "topic" "$(r backend symbolic-ref --short HEAD)"
  gcheck "backend: the squash kept the fixed t2.txt, the dropped t3.txt is gone, the cherry-picked o.txt is there" "two-fixed|absent|other" "$(cat "$be/t2.txt")|$([ -e "$be/t3.txt" ] && echo present || echo absent)|$(cat "$be/o.txt")"
  gcheck "backend: the clashing cherry-pick was aborted: t1.txt is still alpha's" "one" "$(cat "$be/t1.txt")"
  gcheck "backend: no rebase or cherry-pick state is left" "" "$(ls "$be/.git" | grep -E '^(CHERRY_PICK_HEAD|REBASE_HEAD|rebase-merge|rebase-apply|sequencer)$' | tr '\n' ' ')"
  gcheck "backend: the clean tree has no change left" "" "$(r backend status --porcelain=v1 | tr '\n' '|')"
  gcheck "backend: the other branch is untouched" "other: clashing t1|other: clean change" "$(r backend log --format=%s -2 other | tr '\n' '|' | sed 's/|$//')"
  gcheck "admin: conf finished the rebase (Continue) on top of theirs, with the reworded message and the resolution" "conf|feat: mine (resolved)|feat: theirs|resolved" "$(r admin symbolic-ref --short HEAD)|$(r admin log --format=%s -2 | tr '\n' '|' | sed 's/|$//' | sed 's/|/|/')|$(cat "$ad/shared.txt")"
  gcheck "admin: no rebase state is left (git itself keeps a stale REBASE_HEAD after a finished conflicted rebase)" "" "$(ls "$ad/.git" | grep -E '^(rebase-merge|rebase-apply)$' | tr '\n' ' ')"
  gcheck "services: the live branch main was not rewritten (the refusal held)" "feat: s2|feat: s1|chore: initial import|" "$(r services log --format=%s | tr '\n' '|')"
  gcheck "pos: untouched" "$HEAD0_pos" "$(head_of pos)"
  no_leftovers
}

verify_u() {
  gcheck "backend: the typed command wrote its result inside the repo" "hello-42-e2e" "$(head -1 "$FX/repos/shop-backend/term-out-1.txt" 2>/dev/null)"
  gcheck "the shell of the closed tab was dead when the second terminal asked" "alive dead" "$(cat "$FX/repos/admin/term-alive-1.txt" 2>/dev/null) $(cat "$FX/repos/admin/term-alive-2.txt" 2>/dev/null)"
  gcheck "backend: nothing but the shell's own files is new (no tracked change, same HEAD)" "$HEAD0_backend" "$(head_of backend)"
  gcheck "services and pos untouched" "$(echo "$BEFORE" | sed -n '3,4p')" "$(snapshot_state | sed -n '3,4p')"
  gcheck "no terminal shell of the app is left with a fixture repo as its working directory" "" "$(lsof -a -d cwd -c zsh -c bash 2>/dev/null | grep "$FX/repos" | head -1 || true)"
}

# v: the Claude config dir is a fixture dir with two role files, so Roles > Save never reaches ~/.claude
real_agents_listing() { ls -l "$HOME/.claude/agents" 2>/dev/null | shasum | cut -c1-12; }
setup_v() {
  REAL_AGENTS0="$(real_agents_listing)"
  mkdir -p "$FX/claude-config/agents"
  printf -- '---\nname: developer\ndescription: Fixture developer role\nmodel: sonnet\ntools: Read, Edit, Write, Bash\n---\nYou are the fixture developer.\n' > "$FX/claude-config/agents/developer.md"
  printf -- '---\nname: reviewer\ndescription: Fixture reviewer role\nmodel: sonnet\ntools: Read, Grep\n---\nYou are the fixture reviewer.\n' > "$FX/claude-config/agents/reviewer.md"
  cp "$FX/claude-config/agents/developer.md" "$FX/developer.md.orig"
}
verify_v() {
  gcheck "Roles Save changed the fixture's developer.md (not identical to the original)" "different" "$(cmp -s "$FX/claude-config/agents/developer.md" "$FX/developer.md.orig" && echo same || echo different)"
  gcheck "the old role file was backed up under the data dir" "yes" "$([ -n "$(find "$FX/data/role-backups" -type f 2>/dev/null | head -1)" ] && echo yes || echo no)"
  gcheck "the backup holds the original content" "yes" "$(grep -rqs 'You are the fixture developer' "$FX/data/role-backups" && echo yes || echo no)"
  gcheck "the real ~/.claude/agents was not touched (listing hash)" "$REAL_AGENTS0" "$(real_agents_listing)"
  gcheck "Rewind restored the file edited after the run (no db.js text from the scenario left)" "0" "$(grep -c 'edited after the run' "$FX/repos/shop-backend/src/lib/db.js")"
  gcheck "backend HEAD unchanged" "$HEAD0_backend" "$(head_of backend)"
  gcheck "the secret never reached settings.json" "0" "$(grep -c 'sk-ant-e2e' "$FX/data/settings.json" 2>/dev/null || true)"
  no_sidecar_left
  no_leftovers
}

verify_w() {
  gcheck "Join recorded a host, not a browser window and not the URL (it carries a token)" "yes" "$([ -s "$FX/data/opened-urls.log" ] && ! grep -q 'token\|#\|http' "$FX/data/opened-urls.log" && echo yes || echo no)"
  gcheck "the token was never written to settings.json" "0" "$(grep -c "$MOCK_TOKEN" "$FX/data/settings.json" 2>/dev/null || true)"
  gcheck "no repo HEAD moved" "$(echo "$BEFORE" | awk '{print $2}' | tr '\n' ' ')" "$(for k in backend admin services pos; do printf '%s ' "$(head_of $k)"; done)"
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null; MOCK_PID=""
  [ -n "${CTL_PID:-}" ] && kill "$CTL_PID" 2>/dev/null; CTL_PID=""
}

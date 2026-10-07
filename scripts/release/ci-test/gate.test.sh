#!/usr/bin/env bash
# Tests of scripts/release/gate.sh, the gate scripts and scripts/ci/cargo-test.sh ((design notes: release-ci-spec) 12.4, RC3).
# Fake pnpm, cargo and with-build-lock.sh on PATH (fixtures/gate); every tree under test is built under mktemp -d;
# no credential, no network, no cargo build, no vitest. The real checkout is only read (G05 and the git-verb scan).
#
#   bash scripts/release/ci-test/gate.test.sh        prints `SUMMARY gate.test.sh pass=N fail=M skip=K`
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
GATE="$REPO/scripts/release/gate.sh"
FIX="$HERE/fixtures/gate"
CARGO_TEST="$REPO/scripts/ci/cargo-test.sh"

T_PASS=0 T_FAIL=0 T_SKIP=0
t_ok() { T_PASS=$((T_PASS + 1)); echo "ok - $1"; }
t_fail() { T_FAIL=$((T_FAIL + 1)); echo "not ok - $1${2:+ ($2)}"; }
t_skip() { T_SKIP=$((T_SKIP + 1)); echo "skip - $1${2:+ ($2)}"; }
t_eq() { if [ "$2" = "$3" ]; then t_ok "$1"; else t_fail "$1" "expected '$2', got '$3'"; fi; }
t_has() { case "$2" in *"$3"*) t_ok "$1" ;; *) t_fail "$1" "missing '$3'" ;; esac; }
t_hasnt() { case "$2" in *"$3"*) t_fail "$1" "found '$3'" ;; *) t_ok "$1" ;; esac; }
t_rc() { if [ "$2" = "$3" ]; then t_ok "$1"; else t_fail "$1" "exit code $3, expected $2"; fi; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/intely-gate-test.XXXXXX")" || exit 1
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/home" "$TMP/logs"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

NODE_DIR="$(dirname "$(command -v node)")"
TPATH="$FIX/fake-bin:$NODE_DIR:/usr/bin:/bin:/usr/sbin:/sbin"
BASH_UNDER_TEST="${BASH_UNDER_TEST:-bash}"

printf '[]\n' >"$TMP/kr-empty.json"
ROOT_OK="$TMP/root-ok"
mkdir -p "$ROOT_OK"
printf '{"name":"fixture","version":"0.1.0","scripts":{}}\n' >"$ROOT_OK/package.json"

# rg <gate.sh args...>: runs gate.sh in a scrubbed environment; sets OUT and RC.
# RG_EXTRA (array) holds extra NAME=value pairs; T_ROOT, T_KR, T_TOOLS override the defaults.
RG_EXTRA=()
rg() {
  local tools=()
  [ -n "${T_TOOLS:-}" ] && tools=("GATE_TOOLS=$T_TOOLS")
  OUT="$(env -i HOME="$TMP/home" PATH="$TPATH" TMPDIR="$TMP" \
    GATE_ROOT="${T_ROOT:-$ROOT_OK}" GATE_LOG_ROOT="$TMP/logs" GATE_KNOWN_RED="${T_KR:-$TMP/kr-empty.json}" \
    GATE_LOCK_SCRIPT="$FIX/lock/with-build-lock.sh" FAKE_LOG="$TMP/fake.log" FAKE_LOCK_LOG="$TMP/lock.log" \
    FAKE_ENV_DUMP="$TMP/env.dump" FAKE_STATE="$TMP/cargo.state" \
    GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null \
    ${tools[@]+"${tools[@]}"} ${RG_EXTRA[@]+"${RG_EXTRA[@]}"} \
    "$BASH_UNDER_TEST" "$GATE" "$@" 2>&1)"
  RC=$?
}
reset() { RG_EXTRA=(); T_ROOT=""; T_KR=""; T_TOOLS=""; rm -f "$TMP/fake.log" "$TMP/lock.log" "$TMP/env.dump" "$TMP/cargo.state"; }

sj_path() { printf '%s\n' "$OUT" | sed -n 's/^summary: //p' | tail -1; }
# step_status <gate> <step name>: PASS|FAIL|SKIP|none, read from the summary.json of the last run.
step_status() {
  node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const g=s.gates.find(x=>x.id===process.argv[2]);const t=g&&g.steps.find(x=>x.name===process.argv[3]);console.log(t?t.status:"none")' "$(sj_path)" "$1" "$2"
}
gate_line() { printf '%s\n' "$OUT" | grep "^GATE $1 " | head -1; }
gate_ids() { printf '%s\n' "$OUT" | sed -n 's/^GATE \(G[0-9][0-9]\) .*/\1/p' | tr '\n' ' '; }
mk_git() { # <dir>: a fixture work tree with everything added to the index (blobs exist, nothing committed)
  (cd "$1" && git init -q . && git add -A . >/dev/null 2>&1)
}
wr() { mkdir -p "$(dirname "$1")"; printf '%s\n' "$2" >"$1"; }

# --- list, usage, profiles -------------------------------------------------------------------------------------------
reset
rg --list
t_rc "--list exits 0" 0 "$RC"
ok=1
for n in $(seq 1 21); do id="$(printf 'G%02d' "$n")"; case "$OUT" in *"$id "*) ;; *) ok=0; echo "# missing $id" ;; esac; done
t_eq "--list names G01..G21" 1 "$ok"
t_has "--list shows the profiles" "$OUT" "ci-release"

rg --nonsense
t_rc "unknown argument exits 2" 2 "$RC"
rg --fast --full
t_rc "two profiles exit 2" 2 "$RC"
rg --only G99
t_rc "unknown gate exits 2" 2 "$RC"
T_ROOT="$TMP/does-not-exist" rg --fast
t_rc "missing tree exits 3" 3 "$RC"

reset
rg --fast --dry-run
t_eq "--fast gates" "G01 G02 G03 G06 G07 G08 G09 G10 G14 G16 G17 G18 " "$(gate_ids)"
rg --full --dry-run
t_eq "--full gates" "G01 G02 G03 G04 G05 G06 G07 G08 G09 G10 G11 G12 G13 G14 G16 G17 G18 G20 " "$(gate_ids)"
rg --release --dry-run --keep-going
t_eq "--release gates" "G01 G02 G03 G04 G05 G06 G07 G08 G09 G10 G11 G12 G13 G14 G16 G17 G18 G19 G20 G21 " "$(gate_ids)"
rg --ci-js --dry-run
t_eq "--ci-js gates" "G02 G03 G09 G11 " "$(gate_ids)"
rg --ci-gates --dry-run
t_eq "--ci-gates gates" "G01 G06 G07 G08 G10 G13 G14 G16 G17 G18 " "$(gate_ids)"
rg --ci-rust --dry-run
t_eq "--ci-rust gates" "G04 G05 G20 " "$(gate_ids)"
rg --ci-release --dry-run
t_eq "--ci-release gates" "G01 G06 G07 G08 G10 G14 G17 G19 G21 " "$(gate_ids)"
rg --fast --e2e /nonexistent/bin --dry-run
t_has "--e2e adds G15" "$(gate_ids)" "G15"
t_has "G15 runs the documented subset" "$OUT" "--only a,b,c,d,e,g,g2,h,i,l,m,s,lic,cf,cf2"
rg --only G15
t_has "G15 without --e2e is a SKIP" "$(gate_line G15)" "SKIP"

# --- dry run, failure, fail-fast, keep-going, --only ------------------------------------------------------------------
reset
rg --only G02 --dry-run
t_rc "--dry-run exits 0" 0 "$RC"
t_has "--dry-run prints the commands" "$OUT" "DRY G02 tsc ui"
t_has "--dry-run shows the build lock wrapper" "$OUT" "with-build-lock.sh nice -n 10 pnpm"
t_eq "--dry-run runs nothing" "no" "$([ -s "$TMP/fake.log" ] && echo yes || echo no)"

reset
RG_EXTRA=("FAKE_FAIL=@intely/ui exec tsc")
rg --only G02
t_rc "a failing gate exits 1" 1 "$RC"
t_has "a failing gate prints FAIL" "$(gate_line G02)" "FAIL"
t_has "a failing gate names the failed step" "$OUT" "failed step: tsc ui"
logline="$(printf '%s\n' "$OUT" | sed -n 's/^  log: //p' | head -1)"
t_has "a failing gate names its log" "$logline" "G02.log"
t_has "the log holds the command output" "$(cat "$logline" 2>/dev/null)" "fake pnpm: failing on request"

reset
RG_EXTRA=("FAKE_FAIL=@intely/ui exec tsc")
rg --only G02,G11
t_hasnt "fail-fast stops after the first failing gate" "$(cat "$TMP/fake.log")" "ui build"
t_has "fail-fast says so" "$OUT" "stopping at the first failure"
reset
RG_EXTRA=("FAKE_FAIL=@intely/ui exec tsc")
rg --keep-going --only G02,G11
t_rc "--keep-going still exits 1" 1 "$RC"
t_has "--keep-going runs the later gates" "$(cat "$TMP/fake.log")" "--filter @intely/ui build"
t_has "--keep-going prints both gates" "$(gate_ids)" "G11"

reset
rg --only G11
t_eq "--only selects exactly the named gate" "G11 " "$(gate_ids)"
t_rc "a passing gate exits 0" 0 "$RC"

# --- the known-red registry ------------------------------------------------------------------------------------------
entry() { printf '[{"gate":"%s","step":"%s","reason":"fixture reason","decision":"decision-x","owner":"owner-test-task","since":"2026-10-04"}]\n' "$1" "$2"; }
entry G07 "licenses:check" >"$TMP/kr-fast.json"
entry G07 "licenses:check --release" >"$TMP/kr-rel.json"
entry G07 "licenses:verify" >"$TMP/kr-other.json"

for prof in --fast --full; do
  reset
  RG_EXTRA=("FAKE_FAIL=licenses:check")
  T_KR="$TMP/kr-fast.json" rg "$prof" --only G07
  t_rc "known-red passes in $prof" 0 "$RC"
  t_has "known-red prints KNOWN-RED in $prof" "$(gate_line G07)" "KNOWN-RED"
done
reset
RG_EXTRA=("FAKE_FAIL=licenses:check")
T_KR="$TMP/kr-rel.json" rg --release-rehearsal --only G07
t_rc "known-red passes in --release-rehearsal" 0 "$RC"
t_has "rehearsal prints KNOWN-RED" "$(gate_line G07)" "KNOWN-RED"
t_has "rehearsal prints the remaining reds table" "$OUT" "Remaining reds"
t_has "the remaining reds table has the owner" "$OUT" "owner-test-task"
reset
RG_EXTRA=("FAKE_FAIL=licenses:check")
T_KR="$TMP/kr-rel.json" rg --release --only G07
t_rc "known-red is ignored by --release" 1 "$RC"
t_has "--release prints FAIL" "$(gate_line G07)" "FAIL"
reset
RG_EXTRA=("FAKE_FAIL=licenses:check")
T_KR="$TMP/kr-rel.json" rg --ci-release --only G07
t_rc "known-red is ignored by --ci-release" 1 "$RC"
reset
RG_EXTRA=("FAKE_FAIL=licenses:check")
T_KR="$TMP/kr-other.json" rg --fast --only G07
t_has "an entry for another step does not hide the failure" "$(gate_line G07)" "FAIL"

reset
T_KR="$TMP/kr-fast.json" rg --fast --only G07
t_rc "a stale known-red entry fails the run" 1 "$RC"
t_has "a stale entry is named" "$OUT" "stale known-red entry G07 / licenses:check"
reset
T_KR="$TMP/kr-rel.json" rg --release --only G07
t_rc "the registry (and its staleness) is irrelevant for --release" 0 "$RC"

printf '[{"gate":"G07","step":"x"}]\n' >"$TMP/kr-bad.json"
reset
T_KR="$TMP/kr-bad.json" rg --check-registry
t_rc "--check-registry rejects an entry without owner and reason" 1 "$RC"
T_KR="$TMP/kr-empty.json" rg --check-registry
t_rc "--check-registry accepts an empty list" 0 "$RC"
printf '[{"gate":"G77","step":"x","reason":"r","decision":"d","owner":"o","since":"2026-10-04"}]\n' >"$TMP/kr-gate.json"
T_KR="$TMP/kr-gate.json" rg --check-registry
t_rc "--check-registry rejects an unknown gate" 1 "$RC"
T_KR="$REPO/scripts/release/known-red.json" rg --check-registry
t_rc "the committed registry is valid" 0 "$RC"

# --- heavy commands, jobs, environment scrub, step summary ------------------------------------------------------------
reset
rg --only G11
t_has "heavy commands go through with-build-lock.sh" "$(cat "$TMP/lock.log" 2>/dev/null)" "nice -n 10 pnpm --filter @intely/ui build"
t_has "locally cargo gets 2 jobs" "$(cat "$TMP/env.dump")" "CARGO_BUILD_JOBS=2"
reset
RG_EXTRA=("CI=true")
rg --only G11
t_eq "no build lock in CI" "no" "$([ -s "$TMP/lock.log" ] && echo yes || echo no)"
t_has "the command still ran in CI" "$(cat "$TMP/fake.log")" "--filter @intely/ui build"
t_has "CI gets 3 jobs" "$(cat "$TMP/env.dump")" "CARGO_BUILD_JOBS=3"

reset
RG_EXTRA=(INTELY_X=canary1 APPLE_X=canary2 GH_TOKEN=canary3 GITHUB_TOKEN=canary4 NPM_TOKEN=canary5 NODE_AUTH_TOKEN=canary6 CARGO_REGISTRY_TOKEN=canary7 AWS_SECRET_ACCESS_KEY=canary8 TAURI_SIGNING_PRIVATE_KEY=canary9 CLOUDFLARE_API_TOKEN=canary10 ANTHROPIC_API_KEY=canary11 SENTRY_AUTH_TOKEN=canary12 KEEP_ME=visible)
rg --only G11
dump="$(cat "$TMP/env.dump" 2>/dev/null)"
leak=0
for c in canary1 canary2 canary3 canary4 canary5 canary6 canary7 canary8 canary9 canary10 canary11 canary12; do case "$dump" in *"$c"*) leak=1 ;; esac; done
t_eq "no secret-bearing variable reaches a step" 0 "$leak"
t_has "other variables are kept" "$dump" "KEEP_ME=visible"
t_hasnt "the gate runner does not echo the canaries" "$OUT" "canary"

reset
RG_EXTRA=("GITHUB_STEP_SUMMARY=$TMP/step.md")
rm -f "$TMP/step.md"
rg --only G11
t_has "the step summary has the table" "$(cat "$TMP/step.md" 2>/dev/null)" "| G11 |"
rg --only G11 --dry-run >/dev/null
t_has "the summary names the profile" "$(cat "$TMP/step.md" 2>/dev/null)" "Gates \\(fast\\)"

# --- no git write, no network, no install in the gate scripts ----------------------------------------------------------
files=("$REPO/scripts/release/gate.sh" "$REPO"/scripts/release/gates/* "$REPO/scripts/ci/cargo-test.sh" "$REPO/scripts/ci/js-gates.sh" "$REPO/scripts/ci/build-smoke.sh")
verbs='commit|push|add|stash|reset|checkout|restore|tag|rm|mv|merge|rebase|pull|fetch|clone|init|clean|cherry-pick|revert|apply|am|switch|worktree|update-ref|branch|config|gc|prune|symbolic-ref|remote'
hits="$(grep -nE "(^|[^A-Za-z0-9_.-])git[[:space:]]+(-[^[:space:]]+[[:space:]]+)*($verbs)([[:space:]]|\$)" "${files[@]}" 2>/dev/null | grep -v ':[0-9]*:[[:space:]]*#' || true)"
t_eq "no shell gate script runs a git write verb" "" "$hits"
node_hits="$(cat "$REPO"/scripts/release/gates/*.mjs | grep -oE 'git\([a-z]+, \["[a-z-]+"' | sed -E 's/.*\["//; s/"//' | sort -u | grep -vxE 'ls-files|cat-file' || true)"
t_eq "node helpers call only read-only git subcommands" "" "$node_hits"
net="$(grep -nE '(^|[^A-Za-z-])(curl|wget|npm (i|install)|pnpm (i|install|add)|brew install|pip install|cargo install)([[:space:]]|$)' "${files[@]}" 2>/dev/null | grep -v ':[0-9]*:[[:space:]]*#' || true)"
t_eq "no gate script downloads or installs anything" "" "$net"

# --- upstream scripts that other tasks own: SKIP outside the release profiles, FAIL inside ------------------------------
mkdir -p "$TMP/tools-empty/scripts"
reset
T_TOOLS="$TMP/tools-empty" rg --fast --only G17
t_has "G17 is a SKIP without its upstream script" "$(gate_line G17)" "SKIP"
t_rc "a skipped gate does not fail the run" 0 "$RC"
T_TOOLS="$TMP/tools-empty" rg --release --only G17
t_has "G17 fails without its upstream script in --release" "$(gate_line G17)" "FAIL"
T_TOOLS="$TMP/tools-empty" rg --ci-release --only G21
t_has "G21 fails without its upstream script in --ci-release" "$(gate_line G21)" "FAIL"
T_TOOLS="$TMP/tools-empty" rg --fast --only G13
t_has "G13 is a SKIP without its upstream script" "$(gate_line G13)" "SKIP"

reset
rg --fast --only G18
t_eq "G18 skips a missing public script outside the release profiles" "SKIP" "$(step_status G18 release:check-docs)"
t_eq "G18 still checks the read-only claim" "PASS" "$(step_status G18 'no read-only start claim')"
rg --release --only G18
t_eq "G18 fails a missing public script in --release" "FAIL" "$(step_status G18 release:check-docs)"

reset
rg --full --only G20
t_has "G20 is a SKIP until dev-hooks exists" "$(gate_line G20)" "SKIP"
rg --release --only G20
t_has "G20 fails in --release without the dev-hooks feature" "$(gate_line G20)" "FAIL"
mkdir -p "$TMP/root-hooks/src-tauri"
printf '[package]\nname="x"\n[features]\ndev-hooks = []\n' >"$TMP/root-hooks/src-tauri/Cargo.toml"
T_ROOT="$TMP/root-hooks" rg --full --only G20
t_has "G20 runs both release-cfg checks" "$(cat "$TMP/fake.log")" "check -p intely-switch-ide"
t_has "G20 passes the dev-hooks feature to the second one" "$(cat "$TMP/fake.log")" "--features dev-hooks"
t_has "G20 uses its own target dir" "$(cat "$TMP/env.dump" 2>/dev/null; cat "$TMP/lock.log")" "target-gates"

reset
rg --ci-gates --only G08
t_has "G08 in --ci-gates without a base is a SKIP" "$(gate_line G08)" "SKIP"

# --- G12 cargo-deny ----------------------------------------------------------------------------------------------------
mkdir -p "$TMP/root-deny"
printf '[graph]\n' >"$TMP/root-deny/deny.toml"
reset
RG_EXTRA=(FAKE_CARGO_MODE=nodeny)
T_ROOT="$TMP/root-deny" rg --full --only G12
t_has "G12 skips locally without cargo-deny" "$(gate_line G12)" "SKIP"
RG_EXTRA=(FAKE_CARGO_MODE=nodeny CI=true)
T_ROOT="$TMP/root-deny" rg --full --only G12
t_has "G12 fails in CI without cargo-deny" "$(gate_line G12)" "FAIL"
reset
T_ROOT="$TMP/root-deny" rg --full --only G12
t_has "G12 does not fetch locally" "$(cat "$TMP/fake.log")" "deny --locked check --disable-fetch"
reset
RG_EXTRA=(CI=true)
T_ROOT="$TMP/root-deny" rg --full --only G12
t_hasnt "G12 fetches in CI" "$(grep 'check' "$TMP/fake.log" | tail -1)" "--disable-fetch"

# --- G01 versions and tags ---------------------------------------------------------------------------------------------
V="$TMP/vroot"
cp -R "$HERE/fixtures/version" "$V"
bump_out="$(node "$REPO/scripts/release/bump-version.mjs" 0.1.0 --root "$V" --no-cargo-check --date 2026-10-04 2>&1)" || echo "# bump: $bump_out"
reset
T_ROOT="$V" rg --fast --only G01
t_rc "G01 passes on a consistent tree" 0 "$RC"
for tag in v0.1.0 v0.1.0-rc.1 v0.1.0-rc.12; do
  reset
  T_ROOT="$V" rg --fast --only G01 --tag "$tag"
  t_rc "G01 accepts the tag $tag" 0 "$RC"
done
for tag in v0.1.0-rc.0 v0.1.0-rc v0.1.0-beta.1 v0.1.1 0.1.0; do
  reset
  T_ROOT="$V" rg --fast --only G01 --tag "$tag"
  t_rc "G01 refuses the tag $tag" 1 "$RC"
done
reset
T_ROOT="$V" rg --release --only G01 --tag v0.1.0-rc.1
t_rc "G01 --release passes with a dated changelog and an rc tag" 0 "$RC"
cp -R "$V" "$TMP/vroot-pre"
sed -i.bak 's/"version": "0.1.0"/"version": "0.1.0-alpha.1"/' "$TMP/vroot-pre/src-tauri/tauri.conf.json"
reset
T_ROOT="$TMP/vroot-pre" rg --fast --only G01
t_rc "G01 refuses a pre-release suffix in tauri.conf.json" 1 "$RC"
t_eq "the three-integer step is the one that fails" "FAIL" "$(step_status G01 'tauri version is X.Y.Z')"

# --- G05 bindings drift ------------------------------------------------------------------------------------------------
if command -v rsync >/dev/null 2>&1; then
  B="$TMP/bind"
  wr "$B/ui/src/bindings.ts" "export type A = 1;"
  wr "$B/ui/src/bindings/files.ts" "export type F = 2;"
  wr "$B/packages/protocol/src/generated/api.ts" "export type P = 3;"
  wr "$B/package.json" '{"name":"fixture","scripts":{}}'
  h0="$(cat "$B/ui/src/bindings.ts" "$B/ui/src/bindings/files.ts" "$B/packages/protocol/src/generated/api.ts" | shasum -a 256)"
  reset
  T_ROOT="$B" rg --full --only G05
  t_rc "G05 passes when the generators change nothing" 0 "$RC"
  t_has "G05 ran both generators" "$(cat "$TMP/fake.log")" "protocol:gen"
  reset
  RG_EXTRA=("FAKE_MUTATE=ui/src/bindings.ts")
  T_ROOT="$B" rg --full --only G05
  t_rc "G05 detects a changed generated file" 1 "$RC"
  t_has "G05 names the drifted file" "$(cat "$(printf '%s\n' "$OUT" | sed -n 's/^  log: //p' | head -1)")" "ui/src/bindings.ts"
  h1="$(cat "$B/ui/src/bindings.ts" "$B/ui/src/bindings/files.ts" "$B/packages/protocol/src/generated/api.ts" | shasum -a 256)"
  t_eq "G05 leaves the tracked files byte-identical locally" "$h0" "$h1"
  reset
  RG_EXTRA=("FAKE_MUTATE=ui/src/bindings.ts" "CI=true")
  T_ROOT="$B" rg --full --only G05
  t_rc "G05 in CI (in place) detects the same drift" 1 "$RC"
else
  t_skip "G05 tests" "rsync is not installed"
fi

# --- G16 tree hygiene, G19 prerequisites -------------------------------------------------------------------------------
H="$TMP/hyg"
wr "$H/README.md" "x"
wr "$H/pnpm-workspace.yaml" $'packages:\n  - ui\nallowBuilds:\n  esbuild: true'
mk_git "$H"
reset
T_ROOT="$H" rg --fast --only G16
t_rc "G16 passes on a clean tree" 0 "$RC"

H2="$TMP/hyg-env"; cp -R "$H" "$H2"; wr "$H2/.env" "A=1"; wr "$H2/.env.example" "A="; (cd "$H2" && git add -f .env .env.example)
reset; T_ROOT="$H2" rg --fast --only G16
t_eq "G16 fails a tracked .env" "FAIL" "$(step_status G16 'no tracked .env file')"
for nm in config/production.env .envrc; do
  H2b="$TMP/hyg-env2"; rm -rf "$H2b"; cp -R "$H" "$H2b"; wr "$H2b/$nm" "A=1"; (cd "$H2b" && git add -f "$nm")
  reset; T_ROOT="$H2b" rg --fast --only G16
  t_eq "G16 fails a tracked $nm" "FAIL" "$(step_status G16 'no tracked .env file')"
done
H3="$TMP/hyg-ex"; cp -R "$H" "$H3"; wr "$H3/.env.example" "A="; (cd "$H3" && git add .env.example)
reset; T_ROOT="$H3" rg --fast --only G16
t_rc "G16 allows .env.example" 0 "$RC"
H4="$TMP/hyg-dist"; cp -R "$H" "$H4"; wr "$H4/ui/dist/a.js" "x"; (cd "$H4" && git add -f ui/dist/a.js)
reset; T_ROOT="$H4" rg --fast --only G16
t_eq "G16 fails a tracked dist directory" "FAIL" "$(step_status G16 'no tracked scratch or build directory')"
H5="$TMP/hyg-big"; cp -R "$H" "$H5"; dd if=/dev/zero of="$H5/big.bin" bs=1048576 count=6 2>/dev/null; (cd "$H5" && git add big.bin)
reset; T_ROOT="$H5" rg --fast --only G16
t_eq "G16 fails a tracked file over 5 MB" "FAIL" "$(step_status G16 'no tracked file over 5 MB')"
H6="$TMP/hyg-allow"; cp -R "$H" "$H6"; wr "$H6/pnpm-workspace.yaml" $'packages:\n  - ui\nallowBuilds:\n  esbuild: true\n  sharp: true'
reset; T_ROOT="$H6" rg --fast --only G16
t_eq "G16 fails an extra allowBuilds entry" "FAIL" "$(step_status G16 'allowBuilds is exactly esbuild')"

P="$TMP/prereq"
wr "$P/README.md" "x"
wr "$P/src-tauri/Cargo.toml" $'[package]\nname = "x"\n[features]\ndev-hooks = []'
wr "$P/scripts/release/forbidden-strings.txt" "token"
wr "$P/scripts/release/node-pin.json" '{"version":"24.1.0"}'
wr "$P/crates/agent_core/src/policy/enforcement.rs" "pub sdk_version: String,"
wr "$P/crates/agent_core/src/policy/paths.rs" "// the sdk state directory is protected"
wr "$P/crates/agent_core/src/policy/sdk_tests.rs" "fn protected_sdk_dir_is_hard_stopped() {}"
wr "$P/crates/core/src/workspace.rs" "fn seed() {}"
mk_git "$P"
reset
T_ROOT="$P" rg --release --only G19
t_rc "G19 passes on a fixture tree that satisfies all six checks" 0 "$RC"
reset
T_ROOT="$P" rg --fast --only G19
t_has "G19 is a SKIP outside the release profiles" "$(gate_line G19)" "SKIP"

mut() { # <name> <step that must fail> <shell snippet run in the copy>
  local d="$TMP/prereq-$1"
  rm -rf "$d"; cp -R "$P" "$d"
  (cd "$d" && eval "$3" && git add -A . >/dev/null 2>&1)
  reset; T_ROOT="$d" rg --release --only G19
  t_rc "G19 fails when $1" 1 "$RC"
  t_eq "G19 names the broken check for: $1" "FAIL" "$(step_status G19 "$2")"
}
mut "dev-hooks is not declared" "feature dev-hooks declared" "sed -i.bak '/dev-hooks/d' src-tauri/Cargo.toml && rm src-tauri/Cargo.toml.bak"
mut "node-pin.json is missing" "forbidden-strings and node-pin exist" "rm scripts/release/node-pin.json"
mut "node-pin.json has a placeholder" "forbidden-strings and node-pin exist" "echo '{\"version\":\"<fill>\"}' > scripts/release/node-pin.json"
mut "sdk_version is gone" "EnforcementKey has sdk_version" "echo 'pub x: u8,' > crates/agent_core/src/policy/enforcement.rs"
mut "the hard-stop test is gone" "SDK directory is protected" "rm crates/agent_core/src/policy/sdk_tests.rs"
mut "workspace.rs has a home path" "workspace.rs has no home path" "printf 'const P: &str = \"/%s/someone/x\";\n' Users >> crates/core/src/workspace.rs"
mut "PROGRESS.md is tracked" "private files are not tracked" "mkdir -p docs && echo x > docs/PROGRESS.md"

# --- cargo-test.sh -----------------------------------------------------------------------------------------------------
ct() { # <mode>: runs cargo-test.sh with the fake cargo; sets OUT, RC; the call counter is in $TMP/cargo.state
  rm -f "$TMP/cargo.state" "$TMP/fake.log"
  OUT="$(env -i HOME="$TMP/home" PATH="$TPATH" TMPDIR="$TMP" FAKE_CARGO_MODE="$1" GATE_KNOWN_FLAKY="${2-env::flaky_one env::always_bad}" FAKE_STATE="$TMP/cargo.state" FAKE_LOG="$TMP/fake.log" bash "$CARGO_TEST" 2>&1)"
  RC=$?
}
ct pass
t_rc "cargo-test passes when cargo passes" 0 "$RC"
t_has "cargo-test runs the workspace, locked, without fail-fast" "$(cat "$TMP/fake.log")" "test --workspace --locked -j 2 --no-fail-fast"
ct flaky
t_rc "a flaky test does not fail cargo-test" 0 "$RC"
t_has "a flaky test is reported" "$OUT" "FLAKY env::flaky_one"
t_has "only the failed test is re-run" "$(cat "$TMP/fake.log")" "-- --exact env::flaky_one"
ct fail
t_rc "a test failing twice fails cargo-test" 1 "$RC"
t_has "a test failing twice is named" "$OUT" "FAILED-TWICE env::always_bad"
ct fail ""
t_rc "a failing test that is not on the known-flaky list fails at once" 1 "$RC"
t_has "an unknown failure is named" "$OUT" "FAILED env::always_bad"
t_eq "an unknown failure is not re-run" 1 "$(cat "$TMP/cargo.state")"
ct vacuous
t_rc "a re-run that runs nothing is not a pass" 1 "$RC"
ct compile
t_eq "a build error is not re-run" 1 "$(cat "$TMP/cargo.state")"
if [ "$RC" -ne 0 ]; then t_ok "a build error fails cargo-test"; else t_fail "a build error fails cargo-test"; fi

reset
RG_EXTRA=(FAKE_CARGO_MODE=flaky GATE_KNOWN_FLAKY=env::flaky_one)
rg --full --only G04
t_rc "G04 passes with a flaky test" 0 "$RC"
t_has "G04 reports the flaky test" "$OUT" "FLAKY"
reset
RG_EXTRA=(FAKE_CARGO_MODE=fail)
rg --full --only G04
t_rc "G04 fails with a real failure" 1 "$RC"

# --- portability: macOS ships bash 3.2 ----------------------------------------------------------------------------------
if [ -x /bin/bash ] && /bin/bash -c '[ "${BASH_VERSINFO[0]}" -lt 4 ]'; then
  reset
  BASH_UNDER_TEST=/bin/bash rg --only G11
  t_rc "gate.sh runs under bash 3.2" 0 "$RC"
  BASH_UNDER_TEST=/bin/bash rg --list
  t_rc "gate.sh --list runs under bash 3.2" 0 "$RC"
else
  t_skip "bash 3.2 run" "/bin/bash is not 3.x here"
fi

# --- strict profiles do not accept absent workflows or a SKIP (verifier findings) -------------------------------------
reset
rg --release --only G10
t_eq "G10 fails in --release when the workflow files are absent" "FAIL" "$(step_status G10 required-workflows)"
rg --fast --only G10
t_eq "G10 has no such step in --fast" "none" "$(step_status G10 required-workflows)"
WF="$TMP/root-wf"; rm -rf "$WF"; mkdir -p "$WF/.github/workflows"; printf '{"name":"fixture","version":"0.1.0","scripts":{}}\n' >"$WF/package.json"
for f in ci.yml release.yml codeql.yml audit.yml; do : >"$WF/.github/workflows/$f"; done
reset; T_ROOT="$WF" rg --release --only G10
t_eq "G10 required-workflows passes when the four files exist" "PASS" "$(step_status G10 required-workflows)"
reset
rg --full --only G12
t_rc "a skipped gate is accepted in --full" 0 "$RC"
rg --release --only G12
t_rc "a skipped gate fails --release" 1 "$RC"
t_has "the skip is named" "$OUT" "skipped in a release run"

echo "SUMMARY gate.test.sh pass=$T_PASS fail=$T_FAIL skip=$T_SKIP"
[ "$T_FAIL" -eq 0 ]

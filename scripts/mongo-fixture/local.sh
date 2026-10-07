#!/usr/bin/env bash
# Docker-free fixture matrix: REAL mongod processes (the official Community Server tarball, no installer) plus a user-level sshd.
#   local.sh up       start everything, seed it, print `export INTELY_MONGO_*` lines on stdout
#   local.sh env      print the same lines again
#   local.sh down     stop every process this script started and delete the temp directory (idempotent)
#   local.sh status   one line per process (name, pid, alive)
#   local.sh e2e-up   only ONE standalone mongod with the three-document `fakeshop.orders` the e2e scenarios x2/x3 expect from
#                     scripts/e2e/fake-mongod.mjs; prints {"ready":true,"port":N,"version":"..."} (use INTELY_MATRIX_TAG=e2e, then `down`)
# Same output contract as matrix.sh (INTELY_MONGO_FX_*), plus INTELY_MONGO_TEST_URI and INTELY_MONGO_AUTH_* for the older
# suites (golden, server, studio, studio_ai). `matrix.sh up|env|down` delegates here when INTELY_MATRIX_BACKEND=local.
#
# The mongod binary comes from .scratch/mongodb/current/bin (git-ignored; see (design notes: mongo-live-report) for how it was fetched and
# verified) or INTELY_MONGOD_DIR. Nothing else is needed: no brew, no sudo, no PATH change, no launchd, no Docker.
# Safety: every server binds 127.0.0.1 on a random port in 30000-40000; data, logs, TLS keys, the ssh host key and a private HOME for
# mongosh live below ONE mktemp directory that `down` removes; passwords are random per run, travel in the environment of
# mongosh (never on a command line) and are written only to that directory's env file (mode 0600).
#   up : INTELY_MATRIX_TAG (default w5), INTELY_MLOCAL_BIG (documents in intely_test_big.events, default 300000, 0 = skip),
#        INTELY_MLOCAL_RS_NODES (default 3), INTELY_MLOCAL_HAPPY (dir of the Happy-shaped NDJSON, default .scratch/mongo-fixture-data-m0,
#        made by seed.mjs when missing), INTELY_MLOCAL_SSH=0 to skip the sshd, INTELY_MLOCAL_SSH_PW=0 to skip the password ssh server
#        (ssh-password-server.mjs, needs the `ssh2` node module: INTELY_MLOCAL_SSH2_DIR=<a node_modules folder that has it>).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
TAG="${INTELY_MATRIX_TAG:-w5}"
PTR="${TMPDIR:-/tmp}/intely-mlocal-$TAG.ptr"
MONGOD_DIR="${INTELY_MONGOD_DIR:-$ROOT/.scratch/mongodb/current}"
MONGOD="$MONGOD_DIR/bin/mongod"
MONGOSH="${INTELY_MONGOSH:-/usr/local/bin/mongosh}"
DB=shop

log() { printf 'mlocal: %s\n' "$*" >&2; }

# ---- helpers ----------------------------------------------------------------------------------------------------------------

base_dir() { [ -f "$PTR" ] && cat "$PTR" || true; }

# A free random loopback port in 30000-40000 that is not one of the ports given as arguments.
rport() {
  node -e '
    const net = require("net");
    const used = new Set(process.argv.slice(1).map(Number));
    (async () => { for (;;) {
      const p = 30000 + Math.floor(Math.random() * 10001);
      if (used.has(p)) continue;
      const ok = await new Promise((r) => { const s = net.createServer(); s.once("error", () => r(false)); s.listen(p, "127.0.0.1", () => s.close(() => r(true))); });
      if (ok) { console.log(p); return; }
    } })();' "$@"
}

rand() { openssl rand -hex "${1:-12}"; }

# Stops every process listed in $1/pids (only if its command line still names the directory), then deletes the directory.
stop_and_delete() {
  local base="$1" name pid cmd i
  case "$base" in ""|/|"$HOME"|"$HOME/"|"${TMPDIR:-/tmp}"|"${TMPDIR:-/tmp}/") log "refusing to clean '$base'"; return 2;; esac
  case "$(basename "$base")" in intely-mlocal.*) ;; *) log "refusing to clean '$base' (not one of ours)"; return 2;; esac
  if [ -f "$base/pids" ]; then
    while read -r name pid; do
      [ -n "${pid:-}" ] || continue
      cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
      case "$cmd" in *"$base"*) kill -TERM "$pid" 2>/dev/null || true;; esac
    done < "$base/pids"
    for i in $(seq 1 60); do
      local alive=0
      while read -r name pid; do
        [ -n "${pid:-}" ] || continue
        cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
        case "$cmd" in *"$base"*) alive=1;; esac
      done < "$base/pids"
      [ "$alive" = 0 ] && break
      [ "$i" = 30 ] && { while read -r name pid; do cmd="$(ps -p "${pid:-0}" -o command= 2>/dev/null || true)"; case "$cmd" in *"$base"*) kill -KILL "$pid" 2>/dev/null || true;; esac; done < "$base/pids"; }
      sleep 0.5
    done
  fi
  rm -rf "$base"
  rm -f "$PTR"
}

# mongosh with a private HOME (history, logs, telemetry cache stay in the temp directory) and no rc file.
msh() { HOME="$BASE/home" MONGOSH_DISABLE_TELEMETRY=1 "$MONGOSH" --quiet --norc "$@"; }

# start_mongod <name> <port> <mongod args...>
start_mongod() {
  local name="$1" port="$2"; shift 2
  mkdir -p "$BASE/db/$name" "$BASE/log"
  "$MONGOD" --dbpath "$BASE/db/$name" --bind_ip 127.0.0.1 --port "$port" --nounixsocket --logpath "$BASE/log/$name.log" \
    --wiredTigerCacheSizeGB 0.25 --setParameter diagnosticDataCollectionEnabled=false "$@" >/dev/null 2>"$BASE/log/$name.err" &
  echo "$name $!" >> "$BASE/pids"
  wait_log "$name"
}

wait_log() { # name: waits for the "Waiting for connections" line
  local i
  for i in $(seq 1 120); do
    grep -q 'Waiting for connections' "$BASE/log/$1.log" 2>/dev/null && return 0
    local pid; pid="$(awk -v n="$1" '$1==n{p=$2} END{print p}' "$BASE/pids")"
    kill -0 "$pid" 2>/dev/null || { log "$1 exited early:"; tail -n 5 "$BASE/log/$1.err" "$BASE/log/$1.log" 2>/dev/null | cut -c1-300 >&2; return 1; }
    sleep 0.5
  done
  log "timeout waiting for $1"; return 1
}

stop_one() { # name: SIGTERM and wait (a restart with other flags)
  local pid; pid="$(awk -v n="$1" '$1==n{p=$2} END{print p}' "$BASE/pids")"
  kill -TERM "$pid" 2>/dev/null || true
  local i; for i in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  kill -KILL "$pid" 2>/dev/null || true
  sed -i.bak "/^$1 /d" "$BASE/pids"; rm -f "$BASE/pids.bak"
  rm -f "$BASE/log/$1.log"
}

load() { # port db dir colls [indexes] [extra mongosh args...]
  local port="$1" dbn="$2" dir="$3" colls="$4" idx="${5:-0}"; shift 5 || shift $#
  MLP_DB="$dbn" MLP_DIR="$dir" MLP_COLLS="$colls" MLP_INDEXES="$idx" msh --host 127.0.0.1 --port "$port" "$@" --file "$HERE/local/load-ndjson.js" >&2
}

export_line() { printf "export %s='%s'\n" "$1" "$2" >> "$BASE/env.sh"; }

# ---- commands ---------------------------------------------------------------------------------------------------------------

cmd="${1:-}"
case "$cmd" in
  env)
    b="$(base_dir)"; [ -n "$b" ] && [ -f "$b/env.sh" ] || { log "nothing is up (run: local.sh up)"; exit 1; }
    cat "$b/env.sh"; exit 0;;
  status)
    b="$(base_dir)"; [ -n "$b" ] && [ -f "$b/pids" ] || { log "nothing is up"; exit 0; }
    while read -r name pid; do kill -0 "$pid" 2>/dev/null && echo "$name $pid alive" || echo "$name $pid dead"; done < "$b/pids"; exit 0;;
  down)
    b="$(base_dir)"
    if [ -z "$b" ]; then log "nothing to remove"; exit 0; fi
    stop_and_delete "$b" && log "stopped every process and removed $b"; exit 0;;
  up|e2e-up) ;;
  *) echo "usage: local.sh up|e2e-up|env|down|status" >&2; exit 2;;
esac

[ -x "$MONGOD" ] || { echo "local: skipped: no mongod at $MONGOD (see docs/mongo-live-report.md, 'Getting mongod')" >&2; exit 3; }
[ -x "$MONGOSH" ] || { echo "local: skipped: no mongosh at $MONGOSH" >&2; exit 3; }

old="$(base_dir)"; [ -n "$old" ] && { log "removing the previous fixture $old"; stop_and_delete "$old" || true; }
BASE="$(mktemp -d "${TMPDIR:-/tmp}/intely-mlocal.XXXXXX")"
BASE="$(cd "$BASE" && pwd -P)"
chmod 700 "$BASE"
printf '%s\n' "$BASE" > "$PTR"; chmod 600 "$PTR"
mkdir -p "$BASE/home" "$BASE/tls" "$BASE/ssh" "$BASE/seed" "$BASE/log" "$BASE/db"
: > "$BASE/pids"; : > "$BASE/env.sh"; chmod 600 "$BASE/env.sh"
trap 'rc=$?; if [ "$rc" -ne 0 ]; then log "up failed (exit $rc); cleaning up"; stop_and_delete "$BASE" || true; fi' EXIT
trap 'exit 130' INT TERM

VERSION="$("$MONGOD" --version | sed -n '1s/db version v//p')"
log "mongod $VERSION, base $BASE"
if [ "$cmd" = e2e-up ]; then
  P="$(rport)"
  start_mongod standalone "$P"
  msh --host 127.0.0.1 --port "$P" --eval 'db.getSiblingDB("fakeshop").orders.insertMany([{_id:1,status:"paid",total:42},{_id:2,status:"open",total:17},{_id:3,status:"paid",total:99}])' >/dev/null
  trap - EXIT
  printf '{"ready":true,"port":%s,"version":"%s"}\n' "$P" "$VERSION"
  exit 0
fi
export_line INTELY_MONGO_FX_BACKEND local
export_line INTELY_MONGO_FX_MONGOD_VERSION "$VERSION"
export_line INTELY_MONGO_FX_DIR "$BASE"
export_line INTELY_MONGO_FX_DB "$DB"

# ---- data ------------------------------------------------------------------------------------------------------------------
log "seed data"
node "$HERE/seed-generic.mjs" --out "$BASE/seed" >&2
HAPPY="${INTELY_MLOCAL_HAPPY:-$ROOT/.scratch/mongo-fixture-data-m0}"
if [ ! -f "$HAPPY/orders.ndjson" ]; then HAPPY="$BASE/happy"; node "$HERE/seed.mjs" --out "$HAPPY" >&2; fi
HAPPY_DB=intely_test_happy
HAPPY_COLLS=restaurants,users,products,customers,orders
# `legacy` holds DbPointer, Undefined, Symbol...: mongosh's JS BSON cannot store those faithfully, so the official Rust driver loads it
# (crates/mongo/examples/fx_load.rs, built on demand into CARGO_TARGET_DIR)
FX_LOAD="${INTELY_FX_LOAD:-${CARGO_TARGET_DIR:-$ROOT/target}/debug/examples/fx_load}"
if [ ! -x "$FX_LOAD" ]; then
  log "building the fixture loader (cargo build --example fx_load)"
  (cd "$ROOT" && "$ROOT/scripts/with-build-lock.sh" nice -n 10 cargo build -q -p intely-mongo --features mongo --example fx_load -j 2) >&2
fi
[ -x "$FX_LOAD" ] || { log "no fx_load binary at $FX_LOAD"; exit 1; }
BIG="${INTELY_MLOCAL_BIG:-300000}"

KEYPASS="$(bash "$HERE/tls.sh" "$BASE/tls")"
SUBJECT="$(cat "$BASE/tls/subject.txt")"
export_line INTELY_MONGO_FX_TLS_DIR "$BASE/tls"
export_line INTELY_MONGO_FX_TLS_KEY_PASS "$KEYPASS"
export_line INTELY_MONGO_FX_X509_SUBJECT "$SUBJECT"
TLS_ARGS=(--tlsMode requireTLS --tlsCertificateKeyFile "$BASE/tls/server.pem" --tlsCAFile "$BASE/tls/ca.pem")
MSH_TLS=(--tls --tlsCAFile "$BASE/tls/ca.pem")

USED=()
P_STANDALONE="$(rport)"; USED+=("$P_STANDALONE")
P_AUTH="$(rport "${USED[@]}")"; USED+=("$P_AUTH")
P_TLS="$(rport "${USED[@]}")"; USED+=("$P_TLS")
P_TLSW="$(rport "${USED[@]}")"; USED+=("$P_TLSW")
P_X509="$(rport "${USED[@]}")"; USED+=("$P_X509")
P_COMP="$(rport "${USED[@]}")"; USED+=("$P_COMP")

# 1. standalone, no auth: the shop dataset, the Happy-shaped dataset (INTELY_MONGO_TEST_URI) and the big collection
log "standalone :$P_STANDALONE"
start_mongod standalone "$P_STANDALONE"
load "$P_STANDALONE" "$DB" "$BASE/seed" products,customers,orders
load "$P_STANDALONE" "$HAPPY_DB" "$HAPPY" "$HAPPY_COLLS" 1
"$FX_LOAD" "mongodb://127.0.0.1:$P_STANDALONE/" "$HAPPY_DB" "$HAPPY" legacy >&2
if [ "$BIG" != 0 ]; then MLP_BIG="$BIG" msh --host 127.0.0.1 --port "$P_STANDALONE" --file "$HERE/local/big.js" >&2; fi
export_line INTELY_MONGO_FX_STANDALONE_PORT "$P_STANDALONE"
export_line INTELY_MONGO_TEST_URI "mongodb://127.0.0.1:$P_STANDALONE/$HAPPY_DB"
export_line INTELY_MONGO_BIG_URI "mongodb://127.0.0.1:$P_STANDALONE/intely_test_big"

# 2. SCRAM-SHA-256 auth: users created while the server is still open on localhost, then restarted with --auth
log "auth :$P_AUTH"
PW_ROOT="$(rand)"; PW_RO="$(rand)"; PW_RESTRICT="$(rand)"; PW_ANY="$(rand)"
start_mongod auth "$P_AUTH"
load "$P_AUTH" "$DB" "$BASE/seed" products,customers,orders
load "$P_AUTH" "$HAPPY_DB" "$HAPPY" "$HAPPY_COLLS" 1
"$FX_LOAD" "mongodb://127.0.0.1:$P_AUTH/" "$HAPPY_DB" "$HAPPY" legacy >&2
MLP_DB="$HAPPY_DB" MLP_DB2="$DB" MLP_PW_ROOT="$PW_ROOT" MLP_PW_RO="$PW_RO" MLP_PW_RESTRICT="$PW_RESTRICT" MLP_PW_ANY="$PW_ANY" \
  msh --host 127.0.0.1 --port "$P_AUTH" --file "$HERE/local/users.js" >&2
stop_one auth
start_mongod auth "$P_AUTH" --auth
export_line INTELY_MONGO_FX_AUTH_PORT "$P_AUTH"
export_line INTELY_MONGO_FX_AUTH_ROOT_PW "$PW_ROOT"
export_line INTELY_MONGO_FX_AUTH_RO_PW "$PW_RO"
export_line INTELY_MONGO_FX_AUTH_RESTRICTED_PW "$PW_RESTRICT"
export_line INTELY_MONGO_FX_AUTH_ANYREAD_PW "$PW_ANY"
# the older suites (server.rs, studio.rs) read full URIs; the users hold read on both seeded databases
export_line INTELY_MONGO_AUTH_PORT "$P_AUTH"
export_line INTELY_MONGO_AUTH_DB "$HAPPY_DB"
export_line INTELY_MONGO_AUTH_ROOT "mongodb://root:$PW_ROOT@127.0.0.1:$P_AUTH/admin"
export_line INTELY_MONGO_AUTH_RO "mongodb://ro:$PW_RO@127.0.0.1:$P_AUTH/$HAPPY_DB?authSource=admin"
export_line INTELY_MONGO_AUTH_RESTRICTED "mongodb://restricted:$PW_RESTRICT@127.0.0.1:$P_AUTH/$HAPPY_DB?authSource=admin"
export_line INTELY_MONGO_AUTH_ANYREAD "mongodb://anyread:$PW_ANY@127.0.0.1:$P_AUTH/$HAPPY_DB?authSource=admin"

# 3. replica set rs0 (three loopback members by default), reachable by its replicaSet name
NODES="${INTELY_MLOCAL_RS_NODES:-3}"
log "replica set rs0 ($NODES members)"
RS_PORTS=()
for i in $(seq 1 "$NODES"); do
  p="$(rport "${USED[@]}")"; USED+=("$p"); RS_PORTS+=("$p")
  start_mongod "rs$i" "$p" --replSet rs0 --oplogSize 64
done
MEMBERS=""
for i in "${!RS_PORTS[@]}"; do MEMBERS="$MEMBERS${MEMBERS:+,}{_id:$i,host:'127.0.0.1:${RS_PORTS[$i]}',priority:$((i == 0 ? 2 : 1))}"; done
msh --host 127.0.0.1 --port "${RS_PORTS[0]}" --eval "rs.initiate({_id:'rs0',members:[$MEMBERS]})" >/dev/null
for _ in $(seq 1 120); do
  msh --host 127.0.0.1 --port "${RS_PORTS[0]}" --eval 'db.hello().isWritablePrimary' 2>/dev/null | grep -q true && break
  sleep 1
done
msh --host 127.0.0.1 --port "${RS_PORTS[0]}" --eval 'db.hello().isWritablePrimary' 2>/dev/null | grep -q true || { log "no primary elected"; exit 1; }
load "${RS_PORTS[0]}" "$DB" "$BASE/seed" products,customers,orders
export_line INTELY_MONGO_FX_RS_PORT "${RS_PORTS[0]}"
export_line INTELY_MONGO_FX_RS_PORTS "$(IFS=,; echo "${RS_PORTS[*]}")"
export_line INTELY_MONGO_FX_RS_NAME rs0

# 4. TLS with a CA file (client certificate optional), and one whose server certificate is for another name
log "tls :$P_TLS / wrong-name :$P_TLSW"
start_mongod tls "$P_TLS" "${TLS_ARGS[@]}" --tlsAllowConnectionsWithoutCertificates
load "$P_TLS" "$DB" "$BASE/seed" products,customers,orders 0 "${MSH_TLS[@]}"
export_line INTELY_MONGO_FX_TLS_PORT "$P_TLS"
start_mongod tlswrong "$P_TLSW" --tlsMode requireTLS --tlsCertificateKeyFile "$BASE/tls/server-wrong.pem" --tlsCAFile "$BASE/tls/ca.pem" --tlsAllowConnectionsWithoutCertificates
export_line INTELY_MONGO_FX_TLS_WRONG_PORT "$P_TLSW"

# 5. X.509: client certificate required, one $external user for the subject of client.pem
log "x509 :$P_X509"
MSH_X=("${MSH_TLS[@]}" --tlsCertificateKeyFile "$BASE/tls/client.pem")
start_mongod x509 "$P_X509" "${TLS_ARGS[@]}"
load "$P_X509" "$DB" "$BASE/seed" products,customers,orders 0 "${MSH_X[@]}"
MLP_SUBJECT="$SUBJECT" msh --host 127.0.0.1 --port "$P_X509" "${MSH_X[@]}" --eval "const r = db.getSiblingDB('\$external').runCommand({createUser: process.env.MLP_SUBJECT, roles:[{role:'read', db:'$DB'}]}); if (!r.ok) throw new Error(JSON.stringify(r))" >/dev/null
stop_one x509
start_mongod x509 "$P_X509" --auth "${TLS_ARGS[@]}" --setParameter authenticationMechanisms=MONGODB-X509,SCRAM-SHA-256
export_line INTELY_MONGO_FX_X509_PORT "$P_X509"

# 6. wire compression
log "compression :$P_COMP"
start_mongod compress "$P_COMP" --networkMessageCompressors zstd,zlib,snappy
export_line INTELY_MONGO_FX_COMPRESS_PORT "$P_COMP"

# 7. user-level sshd on a high loopback port (host key, client key and authorized_keys are temporary). A non-root sshd can only
# sign in the user that runs it, and only by key: there is no password or second user, so the "forwarding off" user is a second
# sshd with AllowTcpForwarding no, and the password tunnel runs against the node SSH server of 7b (INTELY_MLOCAL_SSH2_DIR).
if [ "${INTELY_MLOCAL_SSH:-1}" != 0 ] && [ -x /usr/sbin/sshd ]; then
  P_SSH="$(rport "${USED[@]}")"; USED+=("$P_SSH")
  P_SSHNF="$(rport "${USED[@]}")"; USED+=("$P_SSHNF")
  ssh-keygen -q -t ed25519 -N "" -C intely-fixture -f "$BASE/ssh/id_ed25519"
  ssh-keygen -q -t ed25519 -N "" -C intely-fixture-host -f "$BASE/ssh/host_ed25519"
  cp "$BASE/ssh/id_ed25519.pub" "$BASE/ssh/authorized_keys"; chmod 600 "$BASE/ssh/authorized_keys"
  ME="$(id -un)"
  for kind in fwd nofwd; do
    port="$P_SSH"; allow=yes; [ "$kind" = nofwd ] && { port="$P_SSHNF"; allow=no; }
    cat > "$BASE/ssh/sshd_$kind.conf" <<CONF
Port $port
ListenAddress 127.0.0.1
HostKey $BASE/ssh/host_ed25519
PidFile $BASE/ssh/sshd_$kind.pid
AuthorizedKeysFile $BASE/ssh/authorized_keys
AllowUsers $ME
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
UsePAM no
StrictModes no
AllowTcpForwarding $allow
PermitTTY no
LogLevel ERROR
CONF
    /usr/sbin/sshd -D -e -f "$BASE/ssh/sshd_$kind.conf" >/dev/null 2>"$BASE/log/sshd_$kind.err" &
    echo "sshd_$kind $!" >> "$BASE/pids"
  done
  for _ in $(seq 1 40); do
    nc -z 127.0.0.1 "$P_SSH" 2>/dev/null && nc -z 127.0.0.1 "$P_SSHNF" 2>/dev/null && break
    sleep 0.25
  done
  if nc -z 127.0.0.1 "$P_SSH" 2>/dev/null; then
    FP="$(ssh-keygen -lf "$BASE/ssh/host_ed25519.pub" | awk '{print $2}')"
    export_line INTELY_MONGO_FX_SSH_PORT "$P_SSH"
    export_line INTELY_MONGO_FX_SSH_NOFWD_PORT "$P_SSHNF"
    export_line INTELY_MONGO_FX_SSH_USER "$ME"
    export_line INTELY_MONGO_FX_SSH_NOFWD_USER "$ME"
    export_line INTELY_MONGO_FX_SSH_KEY "$BASE/ssh/id_ed25519"
    export_line INTELY_MONGO_FX_SSH_HOSTKEY_FP "$FP"
    export_line INTELY_MONGO_FX_SSH_DB_HOST "127.0.0.1:$P_STANDALONE"
    export_line INTELY_MONGO_FX_SSH_TLS_HOST "localhost:$P_TLS"
    # 7b. password and keyboard-interactive. OpenSSH's sshd cannot serve them without root: no PAM service of our own, no shadow
    # file, no second user, and `AuthorizedKeysCommand` only ever decides about KEYS. So a small SSH server in node (the `ssh2`
    # module, found by ssh-password-server.mjs; it is not a dependency of this repo) answers on a third port with the SAME host key
    # and the current user, checking a random per-run password. The real `ssh` client and the real askpass flow run against it; it
    # is NOT OpenSSH's sshd, and a run without the module reports the password part as a counted skip ((design notes: mongo-live-report)).
    if [ "${INTELY_MLOCAL_SSH_PW:-1}" != 0 ] && command -v node >/dev/null 2>&1; then
      P_SSHPW="$(rport "${USED[@]}")"; USED+=("$P_SSHPW")
      SSHPW="$(rand 12)"
      INTELY_SSHPW="$SSHPW" node "$HERE/ssh-password-server.mjs" --port "$P_SSHPW" --host-key "$BASE/ssh/host_ed25519" --user "$ME" \
        >"$BASE/log/sshd_pw.out" 2>"$BASE/log/sshd_pw.err" &
      echo "sshd_pw $!" >> "$BASE/pids"
      for _ in $(seq 1 40); do
        grep -q '"ready":true' "$BASE/log/sshd_pw.out" 2>/dev/null && break
        kill -0 "$(awk '$1=="sshd_pw"{p=$2} END{print p}' "$BASE/pids")" 2>/dev/null || break
        sleep 0.25
      done
      if grep -q '"ready":true' "$BASE/log/sshd_pw.out" 2>/dev/null; then
        export_line INTELY_MONGO_FX_SSH_PW_PORT "$P_SSHPW"
        export_line INTELY_MONGO_FX_SSH_PASSWORD "$SSHPW"
      else
        log "password ssh server not started (the ssh part of the matrix runs without its password half): $(head -n 1 "$BASE/log/sshd_pw.err" 2>/dev/null)"
        sed -i.bak "/^sshd_pw /d" "$BASE/pids"; rm -f "$BASE/pids.bak"
      fi
    fi
  else
    log "sshd did not start; the ssh part of the matrix is skipped:"; head -n 5 "$BASE/log/sshd_fwd.err" >&2
  fi
fi

trap - EXIT
log "up (mongod $VERSION); run: eval \"\$(scripts/mongo-fixture/local.sh env)\" && INTELY_MONGO_MATRIX=1 cargo test -p intely-mongo --features mongo --test matrix -j 2 -- --test-threads=1"
cat "$BASE/env.sh"

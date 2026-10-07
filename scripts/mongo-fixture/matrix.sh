#!/usr/bin/env bash
# Docker fixture matrix for crates/mongo/tests/matrix.rs (spec (design notes: mongo-everyone-spec) section 10).
#   matrix.sh up      start the containers, seed them, print `export INTELY_MONGO_FX_*` lines on stdout
#   matrix.sh env     print the same lines again (state lives in $TMPDIR/intely-matrix-<tag>)
#   matrix.sh down    remove every container, the network and the temp directory
# INTELY_MATRIX_BACKEND=local|auto: the Docker-free backend (local.sh), same output contract.
# Without a usable Docker: prints the reason on stderr and exits 3 (the Rust tests then print "skipped", counted, not PASS).
# Everything is throwaway: random 127.0.0.1 ports, tmpfs data, random passwords, TLS material only below the mktemp-style
# directory, containers labelled intely.matrix=<tag>. Nothing here touches a user database or the real ~/.ssh.
#   up    : INTELY_MATRIX_TAG (default w5), INTELY_MATRIX_MONGO_IMAGE (default mongo:7)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# INTELY_MATRIX_BACKEND=local runs the same matrix on real mongod processes and a user-level sshd (no Docker): see local.sh.
# `auto` picks Docker when its daemon answers within 20 s and the local mongod otherwise.
# shellcheck source=matrix-lib.sh
. "$HERE/matrix-lib.sh"
case "${INTELY_MATRIX_BACKEND:-docker}" in
  local) exec "$HERE/local.sh" "$@";;
  auto) if ! mx_docker_ok; then mx_log "docker unusable ($MX_REASON): using the local mongod backend"; exec "$HERE/local.sh" "$@"; fi;;
esac

cmd="${1:-}"
case "$cmd" in
  env)
    [ -f "$MX_ENV_FILE" ] || { mx_log "nothing is up (run: matrix.sh up)"; exit 1; }
    cat "$MX_ENV_FILE"; exit 0;;
  down)
    if mx_docker_ok; then mx_down; mx_log "removed containers, network and $MX_BASE_DIR"; else rm -rf "$MX_BASE_DIR"; mx_log "docker unusable ($MX_REASON); removed $MX_BASE_DIR only"; fi
    exit 0;;
  up) ;;
  *) echo "usage: matrix.sh up|down|env" >&2; exit 2;;
esac

if ! mx_docker_ok; then echo "matrix: skipped: $MX_REASON" >&2; exit 3; fi
case "$MX_BASE_DIR" in ""|/|"$HOME"|"$HOME/") mx_log "refusing base dir '$MX_BASE_DIR'"; exit 2;; esac

mx_down
trap 'rc=$?; if [ "$rc" -ne 0 ]; then mx_log "up failed (exit $rc); cleaning up"; mx_down; fi' EXIT
trap 'exit 130' INT TERM

mkdir -p "$MX_BASE_DIR"; chmod 700 "$MX_BASE_DIR"
mkdir -p "$MX_BASE_DIR/tls" "$MX_BASE_DIR/ssh" "$MX_BASE_DIR/init" "$MX_BASE_DIR/seed"
: > "$MX_ENV_FILE"; chmod 600 "$MX_ENV_FILE"
DB=shop
mx_export INTELY_MONGO_FX_DIR "$MX_BASE_DIR"
mx_export INTELY_MONGO_FX_DB "$DB"

mx_log "seed data"
node "$HERE/seed-generic.mjs" --out "$MX_BASE_DIR/seed" >&2
KEYPASS="$(bash "$HERE/tls.sh" "$MX_BASE_DIR/tls")"
PUB="$MX_BASE_DIR/tls/pub"; mkdir -p "$PUB"
for f in ca.pem ca-other.pem server.pem server-wrong.pem client.pem client-enc.pem client-other.pem; do cp "$MX_BASE_DIR/tls/$f" "$PUB/"; done
chmod 755 "$PUB"; chmod 644 "$PUB"/*
SUBJECT="$(cat "$MX_BASE_DIR/tls/subject.txt")"
mx_export INTELY_MONGO_FX_TLS_DIR "$MX_BASE_DIR/tls"
mx_export INTELY_MONGO_FX_TLS_KEY_PASS "$KEYPASS"
mx_export INTELY_MONGO_FX_X509_SUBJECT "$SUBJECT"

docker network create --label "$MX_LABEL" "$MX_NET" >/dev/null

# mx_create <name> <files-src-dir|-> <docker create args...> -- <command args...>: create, copy files, start.
mx_create() {
  local name="$1" files="$2"; shift 2
  docker create --name "$name" --label "$MX_LABEL" --network "$MX_NET" "$@" >/dev/null
  [ "$files" = "-" ] || docker cp "$files/." "$name:/fx" >/dev/null
  docker start "$name" >/dev/null
}
TLS_ARGS=(--tlsMode requireTLS --tlsCertificateKeyFile /fx/server.pem --tlsCAFile /fx/ca.pem)
seed_into() { # container, extra mongoimport args
  local c="$1"; shift
  for f in products customers orders; do
    docker cp "$MX_BASE_DIR/seed/$f.ndjson" "$c:/tmp/$f.ndjson" >/dev/null
    docker exec "$c" mongoimport --quiet --host localhost "$@" --db "$DB" --collection "$f" --file "/tmp/$f.ndjson" >/dev/null
  done
  docker exec "$c" sh -c 'rm -f /tmp/*.ndjson'
}

# 1. standalone, no auth
mx_log "standalone"
mx_create mongo-standalone - -p 127.0.0.1::27017 --tmpfs /data/db "$MX_MONGO_IMAGE"
mx_wait_mongo mongo-standalone
seed_into mongo-standalone
mx_export INTELY_MONGO_FX_STANDALONE_PORT "$(mx_port mongo-standalone 27017)"

# 2. auth: root, ro (read), restricted (find on shop.orders only), anyread
mx_log "auth"
PW_ROOT="$(mx_random)"; PW_RO="$(mx_random)"; PW_RESTRICT="$(mx_random)"; PW_ANY="$(mx_random)"
cat > "$MX_BASE_DIR/init/auth.js" <<JS
const admin = db.getSiblingDB('admin');
admin.createRole({role:'ordersFindOnly', privileges:[{resource:{db:'$DB',collection:'orders'}, actions:['find']}], roles:[]});
admin.createUser({user:'ro', pwd:'$PW_RO', roles:[{role:'read', db:'$DB'}]});
admin.createUser({user:'restricted', pwd:'$PW_RESTRICT', roles:[{role:'ordersFindOnly', db:'admin'}]});
admin.createUser({user:'anyread', pwd:'$PW_ANY', roles:[{role:'readAnyDatabase', db:'admin'}]});
JS
chmod 644 "$MX_BASE_DIR/init/auth.js"
docker create --name mongo-auth --label "$MX_LABEL" --network "$MX_NET" -p 127.0.0.1::27017 --tmpfs /data/db \
  -e MONGO_INITDB_ROOT_USERNAME=root -e MONGO_INITDB_ROOT_PASSWORD="$PW_ROOT" "$MX_MONGO_IMAGE" --auth >/dev/null
docker cp "$MX_BASE_DIR/init/auth.js" mongo-auth:/docker-entrypoint-initdb.d/auth.js >/dev/null
docker start mongo-auth >/dev/null
mx_wait_mongo mongo-auth -u root -p "$PW_ROOT" --authenticationDatabase admin
seed_into mongo-auth -u root -p "$PW_ROOT" --authenticationDatabase admin
mx_export INTELY_MONGO_FX_AUTH_PORT "$(mx_port mongo-auth 27017)"
mx_export INTELY_MONGO_FX_AUTH_ROOT_PW "$PW_ROOT"
mx_export INTELY_MONGO_FX_AUTH_RO_PW "$PW_RO"
mx_export INTELY_MONGO_FX_AUTH_RESTRICTED_PW "$PW_RESTRICT"
mx_export INTELY_MONGO_FX_AUTH_ANYREAD_PW "$PW_ANY"

# 3. single-node replica set rs0, published on the same port it listens on
mx_log "replica set"
RSP="$(mx_free_port)"
mx_create mongo-rs - -p "127.0.0.1:$RSP:$RSP" --tmpfs /data/db "$MX_MONGO_IMAGE" --replSet rs0 --port "$RSP" --bind_ip_all
mx_wait_mongo mongo-rs --port "$RSP"
docker exec mongo-rs mongosh --quiet --port "$RSP" --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'127.0.0.1:$RSP'}]})" >/dev/null
for _ in $(seq 1 60); do docker exec mongo-rs mongosh --quiet --port "$RSP" --eval 'db.hello().isWritablePrimary' 2>/dev/null | grep -q true && break; sleep 1; done
seed_into mongo-rs --port "$RSP"
mx_export INTELY_MONGO_FX_RS_PORT "$RSP"
mx_export INTELY_MONGO_FX_RS_NAME rs0

# 4. TLS: optional client certificate; plus one whose server certificate is for another name
mx_log "tls"
mx_create mongo-tls "$PUB" -p 127.0.0.1::27017 --tmpfs /data/db "$MX_MONGO_IMAGE" "${TLS_ARGS[@]}" --tlsAllowConnectionsWithoutCertificates
mx_wait_mongo mongo-tls --tls --tlsCAFile /fx/ca.pem --host localhost
seed_into mongo-tls --ssl --sslCAFile /fx/ca.pem
mx_export INTELY_MONGO_FX_TLS_PORT "$(mx_port mongo-tls 27017)"
mx_create mongo-tls-wrong "$PUB" -p 127.0.0.1::27017 --tmpfs /data/db "$MX_MONGO_IMAGE" --tlsMode requireTLS --tlsCertificateKeyFile /fx/server-wrong.pem --tlsCAFile /fx/ca.pem --tlsAllowConnectionsWithoutCertificates
mx_wait_mongo mongo-tls-wrong --tls --tlsCAFile /fx/ca.pem --tlsAllowInvalidHostnames --host localhost
mx_export INTELY_MONGO_FX_TLS_WRONG_PORT "$(mx_port mongo-tls-wrong 27017)"

# 5. x509: client certificate required, one $external user for the subject of client.pem
mx_log "x509"
PW_X="$(mx_random)"
cat > "$MX_BASE_DIR/init/x509.js" <<JS
db.getSiblingDB('\$external').runCommand({createUser: '$SUBJECT', roles:[{role:'read', db:'$DB'}]});
JS
chmod 644 "$MX_BASE_DIR/init/x509.js"
docker create --name mongo-x509 --label "$MX_LABEL" --network "$MX_NET" -p 127.0.0.1::27017 --tmpfs /data/db \
  -e MONGO_INITDB_ROOT_USERNAME=root -e MONGO_INITDB_ROOT_PASSWORD="$PW_X" "$MX_MONGO_IMAGE" --auth "${TLS_ARGS[@]}" --setParameter authenticationMechanisms=MONGODB-X509,SCRAM-SHA-256 >/dev/null
docker cp "$PUB/." mongo-x509:/fx >/dev/null
docker cp "$MX_BASE_DIR/init/x509.js" mongo-x509:/docker-entrypoint-initdb.d/x509.js >/dev/null
docker start mongo-x509 >/dev/null
mx_wait_mongo mongo-x509 --tls --tlsCAFile /fx/ca.pem --tlsCertificateKeyFile /fx/client.pem --host localhost --authenticationDatabase '$external' --authenticationMechanism MONGODB-X509
seed_into mongo-x509 --ssl --sslCAFile /fx/ca.pem --sslPEMKeyFile /fx/client.pem -u "$SUBJECT" --authenticationDatabase '$external' --authenticationMechanism MONGODB-X509
mx_export INTELY_MONGO_FX_X509_PORT "$(mx_port mongo-x509 27017)"

# 6. compression
mx_log "compression"
mx_create mongo-compress - -p 127.0.0.1::27017 --tmpfs /data/db "$MX_MONGO_IMAGE" --networkMessageCompressors zstd,zlib,snappy
mx_wait_mongo mongo-compress
mx_export INTELY_MONGO_FX_COMPRESS_PORT "$(mx_port mongo-compress 27017)"

# 7. sshd (alpine, pinned): users `tunnel` (key + password, forwarding on) and `nofwd` (forwarding off); 127.0.0.1 only
mx_log "sshd"
docker build -q -t "$MX_SSHD_IMAGE" --label "$MX_LABEL" - >/dev/null <<'DOCKERFILE'
FROM alpine:3.20
RUN apk add --no-cache openssh-server \
 && ssh-keygen -A \
 && adduser -D -s /bin/sh tunnel && adduser -D -s /bin/sh nofwd \
 && printf 'PasswordAuthentication yes\nPubkeyAuthentication yes\nKbdInteractiveAuthentication no\nUsePAM no\nPermitRootLogin no\nAllowTcpForwarding yes\nMatch User nofwd\n  AllowTcpForwarding no\n' >> /etc/ssh/sshd_config
CMD ["/usr/sbin/sshd", "-D", "-e"]
DOCKERFILE
ssh-keygen -q -t ed25519 -N "" -C intely-fixture -f "$MX_BASE_DIR/ssh/id_ed25519"
PW_SSH="$(mx_random)"
mx_create ssh - -p 127.0.0.1::22 "$MX_SSHD_IMAGE"
for u in tunnel nofwd; do
  printf '%s:%s\n' "$u" "$PW_SSH" | docker exec -i ssh chpasswd
  docker exec -i ssh sh -c "mkdir -p /home/$u/.ssh && cat > /home/$u/.ssh/authorized_keys && chown -R $u:$u /home/$u/.ssh && chmod 700 /home/$u/.ssh && chmod 600 /home/$u/.ssh/authorized_keys" < "$MX_BASE_DIR/ssh/id_ed25519.pub"
done
FP="$(docker exec ssh ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | awk '{print $2}')"
mx_export INTELY_MONGO_FX_SSH_PORT "$(mx_port ssh 22)"
mx_export INTELY_MONGO_FX_SSH_USER tunnel
mx_export INTELY_MONGO_FX_SSH_NOFWD_USER nofwd
mx_export INTELY_MONGO_FX_SSH_PASSWORD "$PW_SSH"
mx_export INTELY_MONGO_FX_SSH_KEY "$MX_BASE_DIR/ssh/id_ed25519"
mx_export INTELY_MONGO_FX_SSH_HOSTKEY_FP "$FP"
mx_export INTELY_MONGO_FX_SSH_DB_HOST mongo-standalone:27017
mx_export INTELY_MONGO_FX_SSH_TLS_HOST mongo-tls:27017

trap - EXIT
mx_log "up; run: eval \"\$(scripts/mongo-fixture/matrix.sh env)\" && INTELY_MONGO_MATRIX=1 cargo test -p intely-mongo --features mongo --test matrix -j 2 -- --test-threads=1"
cat "$MX_ENV_FILE"

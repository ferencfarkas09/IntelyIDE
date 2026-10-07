#!/usr/bin/env bash
# Shared helpers for matrix.sh (sourced, never executed). Throwaway loopback containers only: every container carries the
# label intely.matrix=<tag>, publishes on 127.0.0.1 with a random port, keeps its data on tmpfs and is removed by `down`.
# This file never touches a user database, the real ~/.ssh or any real network.

MX_TAG="${INTELY_MATRIX_TAG:-w5}"
MX_LABEL="intely.matrix=$MX_TAG"
MX_NET="intely-matrix-$MX_TAG"
MX_MONGO_IMAGE="${INTELY_MATRIX_MONGO_IMAGE:-mongo:7}"
MX_SSHD_IMAGE="intely-matrix-sshd:1"
MX_BASE_DIR="${INTELY_MATRIX_DIR:-${TMPDIR:-/tmp}/intely-matrix-$MX_TAG}"
MX_ENV_FILE="$MX_BASE_DIR/env.sh"

mx_log() { printf 'matrix: %s\n' "$*" >&2; }

# Runs "$@" and kills it after $1 seconds (macOS has no timeout(1)). Exit 124 on timeout.
mx_timeout() {
  local secs="$1"; shift
  "$@" & local pid=$!
  ( sleep "$secs"; pkill -TERM -P "$pid" 2>/dev/null; kill -TERM "$pid" 2>/dev/null; sleep 2; pkill -KILL -P "$pid" 2>/dev/null; kill -KILL "$pid" 2>/dev/null ) >/dev/null 2>&1 &
  local watcher=$!
  local rc=0; wait "$pid" 2>/dev/null || rc=$?
  pkill -P "$watcher" 2>/dev/null; kill "$watcher" 2>/dev/null; wait "$watcher" 2>/dev/null || true
  [ "$rc" -ge 128 ] && return 124
  return "$rc"
}

# Prints the reason and returns 1 when Docker cannot be used. Callers exit 3.
mx_docker_ok() {
  if ! command -v docker >/dev/null 2>&1; then MX_REASON="docker is not installed"; return 1; fi
  if ! mx_timeout 20 docker info >/dev/null 2>&1; then MX_REASON="the docker daemon is not running or does not answer within 20 s (open Docker Desktop)"; return 1; fi
  return 0
}

mx_random() { openssl rand -hex "${1:-12}"; }

# A free loopback port (for the replica set, which must be published on the same port it listens on).
mx_free_port() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }

# mx_run <name> <docker run args...>: starts a labelled container on the matrix network.
mx_run() {
  local name="$1"; shift
  docker run -d --name "$name" --label "$MX_LABEL" --network "$MX_NET" "$@" >/dev/null
}

# Host port of a container's published port (e.g. mx_port mongo-tls 27017).
mx_port() { docker port "$1" "$2/tcp" | head -1 | sed 's/.*://'; }

# Waits until mongod answers a ping inside the container. $2.. are extra mongosh args.
mx_wait_mongo() {
  local c="$1"; shift
  local i
  for i in $(seq 1 90); do
    if docker exec "$c" mongosh --quiet "$@" --eval 'db.runCommand({ping:1}).ok' 2>/dev/null | grep -q 1; then return 0; fi
    sleep 1
  done
  mx_log "timeout waiting for $c"; return 1
}

# Removes every container with our label, the network and the temp directory. Idempotent.
mx_down() {
  local ids
  ids="$(docker ps -aq --filter "label=$MX_LABEL" 2>/dev/null || true)"
  [ -n "$ids" ] && docker rm -f $ids >/dev/null 2>&1 || true
  docker network rm "$MX_NET" >/dev/null 2>&1 || true
  rm -rf "$MX_BASE_DIR"
}

# Appends one `export NAME='value'` line to the env file (values never contain a single quote).
mx_export() { printf "export %s='%s'\n" "$1" "$2" >> "$MX_ENV_FILE"; }

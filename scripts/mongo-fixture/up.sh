#!/usr/bin/env bash
# Throwaway loopback MongoDB fixtures for the M0 spike. NEVER touches a user database.
#   up.sh [image]   start two containers (no-auth + auth) on random 127.0.0.1 ports, seed synthetic data, print env lines
#   up.sh down      stop and remove them
# Output: shell `export` lines for INTELY_MONGO_TEST_URI (no auth), INTELY_MONGO_AUTH_* (auth server, random passwords).
set -euo pipefail
cd "$(dirname "$0")/../.."
TAG="${INTELY_MONGO_TAG:-m0}"
IMG="${1:-mongo:6-jammy}"
N1="intely-$TAG-mongo"; N2="intely-$TAG-mongo-auth"
if [ "${1:-}" = down ]; then docker rm -f "$N1" "$N2" >/dev/null 2>&1 || true; echo "removed $N1 $N2" >&2; exit 0; fi
docker info >/dev/null 2>&1 || { echo "docker daemon not running (open -a Docker)" >&2; exit 3; }
DB=intely_test_happy
DATA=".scratch/mongo-fixture-data-m0"
[ -f "$DATA/orders.ndjson" ] || node scripts/mongo-fixture/seed.mjs --out "$DATA" >&2
docker rm -f "$N1" "$N2" >/dev/null 2>&1 || true
# bound to 127.0.0.1 only; data dir on tmpfs
docker run -d --name "$N1" -p 127.0.0.1::27017 --tmpfs /data/db "$IMG" >/dev/null
PW_ROOT=$(openssl rand -hex 12); PW_RO=$(openssl rand -hex 12); PW_RESTRICT=$(openssl rand -hex 12); PW_ANY=$(openssl rand -hex 12)
docker run -d --name "$N2" -p 127.0.0.1::27017 --tmpfs /data/db -e MONGO_INITDB_ROOT_USERNAME=root -e MONGO_INITDB_ROOT_PASSWORD="$PW_ROOT" "$IMG" --auth >/dev/null
wait_up() { for _ in $(seq 1 60); do docker exec "$1" mongosh --quiet --eval 'db.runCommand({ping:1}).ok' $2 2>/dev/null | grep -q 1 && return 0; sleep 1; done; echo "timeout waiting for $1" >&2; return 1; }
wait_up "$N1" ""
# import synthetic data (container-local, throwaway)
for f in restaurants users products customers orders legacy; do
  docker cp "$DATA/$f.ndjson" "$N1:/tmp/$f.ndjson" >&2
  docker exec "$N1" mongoimport --quiet --db "$DB" --collection "$f" --file "/tmp/$f.ndjson" >&2
done
docker exec "$N1" mongosh --quiet "$DB" --eval 'db.orders.createIndex({restaurant:1,createdAt:-1}); db.orders.createIndex({status:1}); db.customers.createIndex({restaurant:1})' >&2
docker exec "$N1" sh -c 'rm -f /tmp/*.ndjson'
P1=$(docker port "$N1" 27017/tcp | head -1 | sed 's/.*://')
echo "export INTELY_MONGO_TEST_URI='mongodb://127.0.0.1:$P1/$DB'"
# auth server: same data, three kinds of users
wait_up "$N2" "-u root -p $PW_ROOT --authenticationDatabase admin"
for f in restaurants users products customers orders legacy; do
  docker cp "$DATA/$f.ndjson" "$N2:/tmp/$f.ndjson" >&2
  docker exec "$N2" mongoimport --quiet -u root -p "$PW_ROOT" --authenticationDatabase admin --db "$DB" --collection "$f" --file "/tmp/$f.ndjson" >&2
done
docker exec "$N2" sh -c 'rm -f /tmp/*.ndjson'
docker exec "$N2" mongosh --quiet -u root -p "$PW_ROOT" --authenticationDatabase admin admin --eval "
  db.createRole({role:'ordersFindOnly', privileges:[{resource:{db:'$DB',collection:'orders'}, actions:['find']}], roles:[]});
  db.createUser({user:'ro', pwd:'$PW_RO', roles:[{role:'read', db:'$DB'}]});
  db.createUser({user:'restricted', pwd:'$PW_RESTRICT', roles:[{role:'ordersFindOnly', db:'admin'}]});
  db.createUser({user:'anyread', pwd:'$PW_ANY', roles:[{role:'readAnyDatabase', db:'admin'}]});" >&2
P2=$(docker port "$N2" 27017/tcp | head -1 | sed 's/.*://')
echo "export INTELY_MONGO_AUTH_PORT='$P2'"
echo "export INTELY_MONGO_AUTH_DB='$DB'"
echo "export INTELY_MONGO_AUTH_ROOT='mongodb://root:$PW_ROOT@127.0.0.1:$P2/admin'"
echo "export INTELY_MONGO_AUTH_RO='mongodb://ro:$PW_RO@127.0.0.1:$P2/$DB?authSource=admin'"
echo "export INTELY_MONGO_AUTH_RESTRICTED='mongodb://restricted:$PW_RESTRICT@127.0.0.1:$P2/$DB?authSource=admin'"
echo "export INTELY_MONGO_AUTH_ANYREAD='mongodb://anyread:$PW_ANY@127.0.0.1:$P2/$DB?authSource=admin'"

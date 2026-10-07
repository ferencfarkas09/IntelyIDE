#!/usr/bin/env bash
# Collects REAL driver error strings from the fixture matrix for the diagnosis corpus (T3):
#   collect-errors.sh            run crates/mongo/tests/matrix.rs against the containers of `matrix.sh up` and write
#                                crates/mongo/tests/golden/diagnose.real.json (sanitised)
#   collect-errors.sh --sanitize <in.jsonl> <out.json>   only the sanitising step (used by --self-test and by hand)
#   collect-errors.sh --self-test                         proves the sanitiser on a built-in sample, no Docker
# Without Docker or without a running matrix it prints the reason and exits 3 (nothing is written).
# INTELY_MATRIX_BACKEND=local reads the fixture of local.sh instead (no Docker).
# Sanitising replaces Atlas, bastion and user host names, ports, temp paths, user names and every fixture secret with
# fixed placeholders BEFORE the file is saved; the diagnose test loads the result next to the synthetic corpus.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT_DEFAULT="$ROOT/crates/mongo/tests/golden/diagnose.real.json"

sanitize() { # in.jsonl out.json  (secrets come from INTELY_MONGO_FX_* variables in the environment)
  node - "$1" "$2" <<'JS'
const fs = require('fs');
const [inp, out] = process.argv.slice(2);
const secrets = Object.entries(process.env).filter(([k, v]) => k.startsWith('INTELY_MONGO_FX_') && /(_PW|_PASSWORD|_KEY_PASS)$/.test(k) && v.length >= 6).map(([, v]) => v);
const subject = process.env.INTELY_MONGO_FX_X509_SUBJECT;
const rules = [
  [/mongodb(\+srv)?:\/\/[^\s"']+/g, 'mongodb://<uri>'],
  [/\b[a-z0-9-]+(\.[a-z0-9-]+)*\.mongodb\.net\b/gi, 'cluster0.example.net'],
  [/\/(?:private\/)?var\/folders\/[^\s"',)]*/g, '<tmp>'],
  [/\/(?:Users|home)\/[^\s"',)]*/g, '<path>'],
  [/\/tmp\/[^\s"',)]*/g, '<tmp>'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}:\d{4,5}\b/g, '127.0.0.1:27017'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (m) => (m === '127.0.0.1' ? m : '192.0.2.10')],
  [/\b(?!localhost\b|other\.example\b|cluster0\.example\.net\b|bastion\.example\.net\b)(?:[a-z0-9-]+\.)+(?:com|net|org|io|hu|dev|cloud|internal|local|lan)\b/gi, 'db.example.net'],
  [/\bmongo-(?:standalone|auth|rs|tls|tls-wrong|x509|compress)\b/g, 'db-internal'],
];
const clean = (s) => {
  let t = String(s);
  for (const x of secrets) t = t.split(x).join('<secret>');
  if (subject) t = t.split(subject).join('CN=user,O=Org');
  for (const [re, to] of rules) t = t.replace(re, to);
  return t;
};
const walk = (v) => Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : typeof v === 'string' ? clean(v) : v;
const lines = fs.existsSync(inp) ? fs.readFileSync(inp, 'utf8').split('\n').filter(Boolean) : [];
const seen = new Set();
const entries = [];
for (const l of lines) {
  const e = walk(JSON.parse(l));
  if (seen.has(e.name)) continue;
  seen.add(e.name);
  entries.push(e);
}
fs.writeFileSync(out, JSON.stringify(entries, null, 1) + '\n');
console.error(`collect-errors: ${entries.length} real entries -> ${out}`);
JS
}

case "${1:-}" in
  --sanitize) sanitize "${2:?in.jsonl}" "${3:?out.json}"; exit 0;;
  --self-test)
    T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
    cat > "$T/in.jsonl" <<'JSONL'
{"name":"a","source":"real","hint":"none","text":"dial cluster0-shard-00-00.abcde.mongodb.net:27017 at /Users/someone/ca.pem user bob pw hunter22xx","ctx":{"hosts":["cluster0-shard-00-00.abcde.mongodb.net"]},"code":"net.refused"}
{"name":"a","source":"real","hint":"none","text":"duplicate name is dropped","ctx":{},"code":"other"}
{"name":"b","source":"real","hint":"io:refused","text":"mongodb://u:hunter22xx@10.1.2.3:27018/x refused by bastion.corp.example.com via 10.9.9.9 in /var/folders/zz/T/tmp.abc/ca.pem","ctx":{},"code":"net.refused"}
JSONL
    INTELY_MONGO_FX_AUTH_RO_PW=hunter22xx sanitize "$T/in.jsonl" "$T/out.json" 2>/dev/null
    node -e '
      const e = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const all = JSON.stringify(e);
      const bad = ["mongodb.net:", "someone", "hunter22xx", "10.1.2.3", "10.9.9.9", "corp.example.com", "/var/folders", "/Users/"].filter((x) => all.includes(x));
      if (e.length !== 2 || bad.length) { console.error("self-test FAILED", e.length, bad); process.exit(1); }
      console.error("self-test ok: 2 entries, nothing sensitive left");' "$T/out.json"
    exit 0;;
esac

# shellcheck source=matrix-lib.sh
. "$HERE/matrix-lib.sh"
if [ "${INTELY_MATRIX_BACKEND:-docker}" = local ]; then
  # the Docker-free fixture (local.sh up): its env lines come from `local.sh env`
  LOCAL_ENV="$("$HERE/local.sh" env 2>/dev/null)" || { echo "collect-errors: skipped: no local fixture is up (run scripts/mongo-fixture/local.sh up)" >&2; exit 3; }
  eval "$LOCAL_ENV"
else
  if ! mx_docker_ok; then echo "collect-errors: skipped: $MX_REASON" >&2; exit 3; fi
  [ -f "$MX_ENV_FILE" ] || { echo "collect-errors: skipped: no fixture is up (run scripts/mongo-fixture/matrix.sh up)" >&2; exit 3; }
  # shellcheck disable=SC1090
  . "$MX_ENV_FILE"
fi
RAW="$(mktemp)"; trap 'rm -f "$RAW"' EXIT
cd "$ROOT"
INTELY_MONGO_MATRIX=1 INTELY_MONGO_COLLECT="$RAW" "$ROOT/scripts/with-build-lock.sh" nice -n 10 cargo test -p intely-mongo --features mongo --test matrix -j 2 -- --test-threads=1 >&2 || true
sanitize "$RAW" "${1:-$OUT_DEFAULT}"

#!/usr/bin/env bash
# TLS material for the fixture matrix, written ONLY below the directory given as $1 (a mktemp -d). Throwaway keys, random
# passphrase, nothing outside that directory is read or written. Uses the system openssl.
#   tls.sh <dir>     prints the passphrase of client-enc.key on stdout
# Files (PEM): ca.pem; ca-other.pem (an unrelated CA, never used to sign anything); server.pem (cert+key, SAN localhost,mongo-tls,127.0.0.1); server-wrong.pem (cert for other.example only);
# client.pem (cert+key, subject CN=client,O=IntelyFixtureClient: a real mongod refuses an x509 user whose O/OU/DC equal the server
# certificate's, because it would pass for a cluster member, so the client organisation must differ from the server one); client-enc.pem (same cert, ENCRYPTED PKCS#8 key);
# client-other.pem (subject CN=stranger,O=IntelyFixtureClient, not a database user); subject.txt (RFC2253 subject of client.pem).
set -euo pipefail
dir="${1:?usage: tls.sh <dir>}"
case "$dir" in ""|/|"$HOME"|"$HOME/") echo "tls.sh: refusing directory '$dir'" >&2; exit 2;; esac
[ -d "$dir" ] || { echo "tls.sh: $dir is not a directory" >&2; exit 2; }
cd "$dir"
umask 077
O=openssl
$O req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 2 -subj "/CN=Intely Fixture CA/O=IntelyFixture" >/dev/null 2>&1

# a second, unrelated CA: "the CA file I gave is the wrong one"
$O req -x509 -newkey rsa:2048 -nodes -keyout ca-other.key -out ca-other.pem -days 2 -subj "/CN=Intely Other CA/O=IntelyOtherFixture" >/dev/null 2>&1

leaf() { # name subject san(optional) usage
  local name="$1" subj="$2" san="$3" eku="$4"
  { echo "basicConstraints=CA:FALSE"; echo "keyUsage=digitalSignature,keyEncipherment"; echo "extendedKeyUsage=$eku"; [ -n "$san" ] && echo "subjectAltName=$san"; true; } > "$name.ext"
  $O req -newkey rsa:2048 -nodes -keyout "$name.key" -out "$name.csr" -subj "$subj" >/dev/null 2>&1
  $O x509 -req -in "$name.csr" -CA ca.pem -CAkey ca.key -CAcreateserial -out "$name.crt" -days 2 -extfile "$name.ext" >/dev/null 2>&1
}
leaf server "/CN=localhost/O=IntelyFixture" "DNS:localhost,DNS:mongo-tls,IP:127.0.0.1" serverAuth
leaf server-wrong "/CN=other.example/O=IntelyFixture" "DNS:other.example" serverAuth
leaf client "/CN=client/O=IntelyFixtureClient" "" clientAuth
leaf client-other "/CN=stranger/O=IntelyFixtureClient" "" clientAuth

cat server.crt server.key > server.pem
cat server-wrong.crt server-wrong.key > server-wrong.pem
cat client.crt client.key > client.pem
cat client-other.crt client-other.key > client-other.pem
PASS="$($O rand -hex 12)"
$O pkcs8 -topk8 -v2 aes-256-cbc -in client.key -passout "pass:$PASS" -out client-enc.key >/dev/null 2>&1
cat client.crt client-enc.key > client-enc.pem
$O x509 -in client.crt -noout -subject -nameopt RFC2253 | sed 's/^subject=//; s/^subject= *//' > subject.txt
# the mongod containers run as another uid and read these through docker cp: they hold throwaway keys only
chmod 0644 *.pem *.crt
rm -f ./*.csr ./*.ext ./*.srl
echo "$PASS"

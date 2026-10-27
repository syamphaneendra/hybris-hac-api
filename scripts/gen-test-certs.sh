#!/usr/bin/env bash
# Generates the TEST-ONLY TLS material in test/fixtures/tls/:
#   ca.pem / ca.key          self-signed test CA
#   server.pem / server.key  server certificate for 127.0.0.1 / localhost, signed by the CA
# These keys protect nothing: they are committed so the TLS tests are reproducible.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test/fixtures/tls"
mkdir -p "$DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -subj "/CN=hybris-hac-api test CA" \
  -keyout "$DIR/ca.key" -out "$DIR/ca.pem" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null

openssl req -newkey rsa:2048 -nodes \
  -subj "/CN=localhost" \
  -keyout "$DIR/server.key" -out "$TMP/server.csr" 2>/dev/null

cat > "$TMP/ext.cnf" <<'EOF'
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:127.0.0.1,DNS:localhost
EOF

openssl x509 -req -in "$TMP/server.csr" -CA "$DIR/ca.pem" -CAkey "$DIR/ca.key" \
  -CAcreateserial -CAserial "$TMP/ca.srl" -days 3650 -extfile "$TMP/ext.cnf" \
  -out "$DIR/server.pem" 2>/dev/null

echo "wrote $DIR/{ca.pem,ca.key,server.pem,server.key}"

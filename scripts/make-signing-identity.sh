#!/bin/sh
# OPTIONAL. Creates a self-signed code-signing identity named "Tally Local Signing" in your login Keychain, so that Tally keeps the
# SAME identity across rebuilds and macOS asks about the Keychain only once ever (an ad-hoc signature changes with every build).
# It adds one certificate + key to your login Keychain (macOS may ask for your login password). Run it yourself: npm run make-signing-identity
# Then build with:  PLANNER_SIGN_IDENTITY="Tally Local Signing" npm run build
set -e
NAME="Tally Local Signing"
if security find-identity -p codesigning | grep -q "\"$NAME\""; then echo "\"$NAME\" already exists."; exit 0; fi
TMP=$(mktemp -d)
cat > "$TMP/openssl.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -days 3650 -config "$TMP/openssl.cnf" 2>/dev/null
PASS=$(openssl rand -hex 12)
openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -out "$TMP/id.p12" -passout "pass:$PASS" 2>/dev/null
security import "$TMP/id.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P "$PASS" -T /usr/bin/codesign
rm -rf "$TMP"
echo "Created \"$NAME\". Build with: PLANNER_SIGN_IDENTITY=\"$NAME\" npm run build"

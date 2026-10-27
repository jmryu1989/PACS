#!/usr/bin/env bash
# Install or update the Minhoon studio on a host that also runs the deployed PACS.
# It creates the system user `studio`, everything under /opt/minhoon-studio, one systemd unit and one root-only
# password file. It never touches Docker, nginx, Orthanc, Keycloak, the PACS database or ports 80/443.
#
#   sudo bash install.sh <bundle-dir>            # bundle-dir holds app.tgz base.tar assets-ohif.tgz assets-dicomweb.tgz BASE_SHA
#   sudo bash install.sh <bundle-dir> --rotate-passwords
#
# Re-running updates the app and keeps the sandbox (its commits), the data, the Claude login and the passwords.
set -euo pipefail

BUNDLE=${1:?bundle directory}
ROTATE=${2:-}
ROOT=/opt/minhoon-studio
PORT=8443
NODE_VERSION=22.23.2
CLAUDE_VERSION=2.1.284
PASSFILE=/root/minhoon-studio-passwords.txt
HOSTNAME_PUBLIC=pacs.koreaimagingnetwork.com
IP_PUBLIC=61.109.239.207

[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
for f in app.tgz base.tar assets-ohif.tgz assets-dicomweb.tgz BASE_SHA; do [ -f "$BUNDLE/$f" ] || { echo "missing $BUNDLE/$f"; exit 1; }; done
BASE_SHA=$(tr -d '[:space:]' < "$BUNDLE/BASE_SHA")

# The port must be free or already ours.
if ss -ltnH "( sport = :$PORT )" | grep -q . && ! systemctl is-active --quiet minhoon-studio; then
  echo "port $PORT is in use by something else; refusing"; exit 1
fi

echo "== user and folders"
id studio >/dev/null 2>&1 || useradd --system --home-dir "$ROOT/home" --shell /usr/sbin/nologin --user-group studio
install -d -o root -g root -m 755 "$ROOT" "$ROOT/etc" "$ROOT/assets" "$ROOT/bin" "$ROOT/knowledge"
install -d -o studio -g studio -m 750 "$ROOT/data" "$ROOT/home" "$ROOT/claude-config" "$ROOT/claude-config/sdij" "$ROOT/claude-config/admin" "$ROOT/tls"

echo "== app (read-only for the service)"
rm -rf "$ROOT/app.new" && mkdir -p "$ROOT/app.new"
tar -xzf "$BUNDLE/app.tgz" -C "$ROOT/app.new"
chown -R root:root "$ROOT/app.new" && chmod -R go-w "$ROOT/app.new"
rm -rf "$ROOT/app.old"; [ -d "$ROOT/app" ] && mv "$ROOT/app" "$ROOT/app.old"; mv "$ROOT/app.new" "$ROOT/app"

echo "== node $NODE_VERSION (private copy, not on the system PATH)"
if [ ! -x "$ROOT/node/bin/node" ] || [ "$("$ROOT/node/bin/node" --version)" != "v$NODE_VERSION" ]; then
  tmp=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" -o "$tmp/node.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  (cd "$tmp" && grep " node-v$NODE_VERSION-linux-x64.tar.xz\$" SHASUMS256.txt | sed "s/node-v$NODE_VERSION-linux-x64.tar.xz/node.tar.xz/" | sha256sum -c -)
  rm -rf "$ROOT/node" && mkdir -p "$ROOT/node" && tar -xJf "$tmp/node.tar.xz" -C "$ROOT/node" --strip-components=1
  chown -R root:root "$ROOT/node"; rm -rf "$tmp"
fi

echo "== Claude Code CLI $CLAUDE_VERSION for user studio (no login here)"
if [ ! -x "$ROOT/home/.local/bin/claude" ]; then
  sudo -u studio -H env HOME="$ROOT/home" bash -c "curl -fsSL https://claude.ai/install.sh | bash -s $CLAUDE_VERSION" </dev/null
fi
ln -sfn "$ROOT/home/.local/bin/claude" "$ROOT/bin/claude"

echo "== assets (pinned OHIF build, public CC BY sample DICOMweb)"
for a in ohif dicomweb; do
  rm -rf "$ROOT/assets/$a.new" && mkdir -p "$ROOT/assets/$a.new"
  tar -xzf "$BUNDLE/assets-$a.tgz" -C "$ROOT/assets/$a.new"
  rm -rf "$ROOT/assets/$a"; mv "$ROOT/assets/$a.new" "$ROOT/assets/$a"
done
chown -R root:root "$ROOT/assets"; chmod -R a+rX "$ROOT/assets"

echo "== sandbox (product tree at main $BASE_SHA; created once, then kept)"
if [ ! -d "$ROOT/sandbox/.git" ]; then
  install -d -o studio -g studio "$ROOT/sandbox"
  sudo -u studio -H env HOME="$ROOT/home" python3 "$ROOT/app/deploy/make-sandbox.py" --archive "$BUNDLE/base.tar" --sha "$BASE_SHA" --out "$ROOT/sandbox"
fi
install -d -o studio -g studio "$ROOT/sandbox-read"

echo "== knowledge feed (the commander replaces status.json; seeded once)"
[ -f "$ROOT/knowledge/status.json" ] || install -o root -g root -m 644 "$ROOT/app/knowledge-seed/status.json" "$ROOT/knowledge/status.json"

echo "== TLS (self-signed, studio only; the PACS certificates are not used)"
if [ ! -f "$ROOT/tls/cert.pem" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=$HOSTNAME_PUBLIC" \
    -addext "subjectAltName=DNS:$HOSTNAME_PUBLIC,IP:$IP_PUBLIC" -keyout "$ROOT/tls/key.pem" -out "$ROOT/tls/cert.pem" 2>/dev/null
  chown studio:studio "$ROOT/tls/key.pem" "$ROOT/tls/cert.pem"; chmod 600 "$ROOT/tls/key.pem"
fi

echo "== config"
cat > "$ROOT/etc/config.json" <<JSON
{
  "listen": { "host": "0.0.0.0", "port": $PORT },
  "tls": { "cert": "$ROOT/tls/cert.pem", "key": "$ROOT/tls/key.pem" },
  "paths": {
    "sandbox": "$ROOT/sandbox", "sandboxRead": "$ROOT/sandbox-read", "data": "$ROOT/data",
    "ohifDist": "$ROOT/assets/ohif", "dicomweb": "$ROOT/assets/dicomweb", "knowledge": "$ROOT/knowledge"
  },
  "claude": {
    "bin": "$ROOT/bin/claude",
    "configDirs": { "sdij": "$ROOT/claude-config/sdij", "admin": "$ROOT/claude-config/admin" },
    "account": "sdij",
    "model": null,
    "shellTool": "Bash",
    "python": "python3",
    "turnTimeoutSec": 900,
    "pathPrepend": "$ROOT/node/bin"
  },
  "digest": { "idleMinutes": 60 }
}
JSON
[ -f "$ROOT/etc/studio.env" ] || printf '# STUDIO_CLAUDE_ACCOUNT=admin   # switch the chat to the admin Claude login (README)\n' > "$ROOT/etc/studio.env"
chmod 644 "$ROOT/etc/config.json" "$ROOT/etc/studio.env"

echo "== studio passwords (root-only file; never printed)"
if [ ! -f "$PASSFILE" ] || [ "$ROTATE" = "--rotate-passwords" ]; then
  umask 077
  P1=$(openssl rand -base64 18 | tr '+/' 'xy'); P2=$(openssl rand -base64 18 | tr '+/' 'xy')
  printf 'Minhoon studio logins (https://%s:%s/ or https://%s:%s/)\nminhoon  %s\nowner    %s\n' "$IP_PUBLIC" "$PORT" "$HOSTNAME_PUBLIC" "$PORT" "$P1" "$P2" > "$PASSFILE"
  chmod 600 "$PASSFILE"; chown root:root "$PASSFILE"
  printf '%s' "$P1" | sudo -u studio "$ROOT/node/bin/node" "$ROOT/app/server/server.js" set-password minhoon "민훈" --config "$ROOT/etc/config.json"
  printf '%s' "$P2" | sudo -u studio "$ROOT/node/bin/node" "$ROOT/app/server/server.js" set-password owner "정모" --config "$ROOT/etc/config.json"
  unset P1 P2
fi

echo "== systemd"
install -o root -g root -m 644 "$ROOT/app/deploy/minhoon-studio.service" /etc/systemd/system/minhoon-studio.service
systemctl daemon-reload
systemctl enable minhoon-studio >/dev/null
systemctl restart minhoon-studio
sleep 3
systemctl is-active minhoon-studio
code=$(curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1:$PORT/studio/login.html")
gate=$(curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1:$PORT/api/me")
echo "login page $code (want 200), /api/me without login $gate (want 401)"
[ "$code" = 200 ] && [ "$gate" = 401 ]
echo "installed. Claude login state:"
sudo -u studio -H env HOME="$ROOT/home" CLAUDE_CONFIG_DIR="$ROOT/claude-config/sdij" "$ROOT/bin/claude" auth status --text 2>/dev/null | head -3 || true

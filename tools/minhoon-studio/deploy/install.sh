#!/usr/bin/env bash
# Install or update the Minhoon studio on a host that also runs the deployed PACS.
# It creates the system user `studio`, everything under /opt/minhoon-studio, one systemd unit and one root-only
# password file, plus one certbot deploy hook that copies the host's Let's Encrypt certificate for the studio.
# It never touches Docker, nginx, Orthanc, Keycloak, the PACS database, ports 80/443 or the certbot renewal config.
#
#   sudo bash install.sh <bundle-dir>            # bundle-dir holds app.tgz base.tar assets-ohif.tgz assets-dicomweb.tgz BASE_SHA
#   sudo bash install.sh <bundle-dir> --rotate-passwords
#
# Re-running updates the app and keeps the sandbox (its commits), the data, the Claude login and the passwords.
# A bundle with a newer BASE_SHA refreshes the sandbox: main is merged into the studio branch (make-sandbox.py
# --refresh; every studio commit stays). What a run replaces is kept beside it as <name>.bak-YYYYMMDD (the first run
# of a day keeps its backup; remove old ones by hand).
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
BAK=bak-$(date +%Y%m%d)

# Move a path aside as <path>.$BAK, or drop it when today's backup already exists (that one is the older state).
backup_move() { if [ -e "$1.$BAK" ]; then rm -rf "$1"; else mv "$1" "$1.$BAK"; fi; }

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
[ -d "$ROOT/app" ] && backup_move "$ROOT/app"; mv "$ROOT/app.new" "$ROOT/app"

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

echo "== assets (pinned OHIF build; DICOMweb: public CC BY samples + synthetic MG vendor phantoms)"
for a in ohif dicomweb; do
  rm -rf "$ROOT/assets/$a.new" && mkdir -p "$ROOT/assets/$a.new"
  tar -xzf "$BUNDLE/assets-$a.tgz" -C "$ROOT/assets/$a.new"
  [ -d "$ROOT/assets/$a" ] && backup_move "$ROOT/assets/$a"; mv "$ROOT/assets/$a.new" "$ROOT/assets/$a"
done
# Archives made on Windows carry 0777 modes; the service only reads the assets.
chown -R root:root "$ROOT/assets"; chmod -R a+rX,go-w "$ROOT/assets"

# The bundle folder is the uploader's private directory; give studio its own copy of the archive.
sandbox_tool() {
  install -o studio -g studio -m 600 "$BUNDLE/base.tar" "$ROOT/home/base.tar"
  sudo -u studio -H env HOME="$ROOT/home" python3 "$ROOT/app/deploy/make-sandbox.py" --archive "$ROOT/home/base.tar" --sha "$BASE_SHA" --out "$ROOT/sandbox" "$@"
  rm -f "$ROOT/home/base.tar"
}
echo "== sandbox (product tree at main $BASE_SHA; created once, then kept and refreshed)"
if [ ! -d "$ROOT/sandbox/.git" ]; then
  install -d -o studio -g studio "$ROOT/sandbox"
  sandbox_tool
else
  current=$(sudo -u studio git -C "$ROOT/sandbox" log -1 --format='%(trailers:key=Studio-Base-Sha,valueonly)' studio-base | tr -d '[:space:]')
  if [ "$current" != "$BASE_SHA" ]; then
    echo "   refresh $current -> $BASE_SHA (merge into $(sudo -u studio git -C "$ROOT/sandbox" rev-parse --abbrev-ref HEAD))"
    # No chat edit may write the sandbox during the merge; the unit is started again below.
    systemctl stop minhoon-studio 2>/dev/null || true
    [ -e "$ROOT/sandbox.$BAK" ] || cp -a "$ROOT/sandbox" "$ROOT/sandbox.$BAK"
    # A changed studio-mock/dataset.json resets the mock state (mock.js); keep the old one.
    [ -f "$ROOT/data/mock-state.json" ] && { [ -e "$ROOT/data/mock-state.json.$BAK" ] || cp -a "$ROOT/data/mock-state.json" "$ROOT/data/mock-state.json.$BAK"; }
    sandbox_tool --refresh --python python3 | tee "$ROOT/data/refresh-$BASE_SHA.json"
  fi
fi
install -d -o studio -g studio "$ROOT/sandbox-read" "$ROOT/sandbox-preview"

echo "== knowledge feed (the commander replaces status.json; seeded once)"
[ -f "$ROOT/knowledge/status.json" ] || install -o root -g root -m 644 "$ROOT/app/knowledge-seed/status.json" "$ROOT/knowledge/status.json"

echo "== TLS"
LE_LINEAGE=/etc/letsencrypt/live/$HOSTNAME_PUBLIC
if [ -f "$LE_LINEAGE/fullchain.pem" ]; then
  # Browser-trusted: the host's Let's Encrypt certificate for the hostname, copied by a deploy hook after each
  # renewal (owner decision 2026-10-28). The certbot lineage and its renewal config are left as they are.
  echo "   Let's Encrypt $HOSTNAME_PUBLIC (deploy hook minhoon-studio-cert)"
  install -o root -g root -m 755 "$ROOT/app/deploy/minhoon-studio-cert" /etc/letsencrypt/renewal-hooks/deploy/minhoon-studio-cert
  MINHOON_STUDIO_NO_RESTART=1 /etc/letsencrypt/renewal-hooks/deploy/minhoon-studio-cert
  TLS_CERT=$ROOT/etc/tls/fullchain.pem; TLS_KEY=$ROOT/etc/tls/privkey.pem
else
  echo "   self-signed (no $LE_LINEAGE on this host)"
  if [ ! -f "$ROOT/tls/cert.pem" ]; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=$HOSTNAME_PUBLIC" \
      -addext "subjectAltName=DNS:$HOSTNAME_PUBLIC,IP:$IP_PUBLIC" -keyout "$ROOT/tls/key.pem" -out "$ROOT/tls/cert.pem" 2>/dev/null
    chown studio:studio "$ROOT/tls/key.pem" "$ROOT/tls/cert.pem"; chmod 600 "$ROOT/tls/key.pem"
  fi
  TLS_CERT=$ROOT/tls/cert.pem; TLS_KEY=$ROOT/tls/key.pem
fi

echo "== config"
cat > "$ROOT/etc/config.json" <<JSON
{
  "listen": { "host": "0.0.0.0", "port": $PORT },
  "tls": { "cert": "$TLS_CERT", "key": "$TLS_KEY" },
  "paths": {
    "sandbox": "$ROOT/sandbox", "sandboxRead": "$ROOT/sandbox-read", "sandboxPreview": "$ROOT/sandbox-preview", "data": "$ROOT/data",
    "ohifDist": "$ROOT/assets/ohif", "dicomweb": "$ROOT/assets/dicomweb", "knowledge": "$ROOT/knowledge",
    "feedback": "$ROOT/knowledge/minhoon-feedback.md"
  },
  "claude": {
    "bin": "$ROOT/bin/claude",
    "configDirs": { "sdij": "$ROOT/claude-config/sdij", "admin": "$ROOT/claude-config/admin" },
    "account": "sdij",
    "model": null,
    "models": { "fast": "sonnet", "deep": "opus" },
    "defaultChoice": "fast",
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
  printf 'Minhoon studio logins (https://%s:%s/ or https://%s:%s/)\nminhoon  %s\nowner    %s\n' "$HOSTNAME_PUBLIC" "$PORT" "$IP_PUBLIC" "$PORT" "$P1" "$P2" > "$PASSFILE"
  chmod 600 "$PASSFILE"; chown root:root "$PASSFILE"
  printf '%s' "$P1" | sudo -u studio "$ROOT/node/bin/node" "$ROOT/app/server/server.js" set-password minhoon "민훈" --config "$ROOT/etc/config.json"
  printf '%s' "$P2" | sudo -u studio "$ROOT/node/bin/node" "$ROOT/app/server/server.js" set-password owner "정모" --config "$ROOT/etc/config.json"
  unset P1 P2
fi
chmod 600 "$ROOT/data/users.json" "$ROOT/data/sessions.json" 2>/dev/null || true

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

#!/usr/bin/env bash
# Install or update the Minhoon studio on a host that also runs the deployed PACS.
# It creates the system user `studio`, everything under /opt/minhoon-studio, one systemd unit and one root-only
# password file, plus one certbot deploy hook that copies the host's Let's Encrypt certificate for the studio.
# It never touches Docker, nginx, Orthanc, Keycloak, the PACS database, ports 80/443 or the certbot renewal config.
#
#   sudo bash install.sh <bundle-dir>            # bundle-dir holds app.tgz base.tar assets-ohif.tgz assets-dicomweb.tgz BASE_SHA
#   sudo bash install.sh <bundle-dir> --rotate-passwords
#
# Re-running updates the app and keeps the sandbox (its commits), the data, the Claude login, the passwords and
# etc/config.json + etc/studio.env (written only when absent; a new claude-config/<name> folder is added to an
# existing config, nothing else in it changes). A bundle with a newer BASE_SHA refreshes the sandbox: main is merged
# into the studio branch (make-sandbox.py --refresh; every studio commit stays) with the unit stopped; a conflict or a
# failed check or step stops the install and puts the sandbox back as it was. A studio that was stopped before the run
# stays stopped; a running one is started again only on a sandbox verified as merged or restored (a first install
# starts it). What a run replaces or copies first is kept beside it as
# <name>.bak-YYYYMMDD-HHMMSS-<pid>, one id per run, so every run can be rolled back (remove old ones by hand).
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
# One id per run: a second run on the same day must keep the state it replaces too (10-31: the day's backup made the
# second run delete the app it replaced).
BAK=bak-$(date +%Y%m%d-%H%M%S)-$$

# Keep a path as <path>.$BAK (moved or copied); never replaces an existing backup.
backup_move() { [ ! -e "$1.$BAK" ] || { echo "backup $1.$BAK already exists; refusing"; exit 1; }; mv "$1" "$1.$BAK"; }
backup_copy() { [ ! -e "$1.$BAK" ] || { echo "backup $1.$BAK already exists; refusing"; exit 1; }; cp -a "$1" "$1.$BAK"; }
echo "backup id: $BAK"

# The studio's state before this run decides its state after it: an update never starts a studio the owner stopped
# (10-31 review: the final restart started a paused studio). Only a first install, with no unit yet, starts it.
if systemctl is-active --quiet minhoon-studio; then was_active=yes; else was_active=no; fi
first_install=no; [ -f /etc/systemd/system/minhoon-studio.service ] || first_install=yes

# Stop the unit and confirm nothing of it still runs: a chat edit writing the sandbox during the backup or the merge
# would be lost to the refresh's restore. Exits without touching anything if that cannot be confirmed.
stop_studio() {
  if [ "$(systemctl show -p LoadState --value minhoon-studio 2>/dev/null)" = loaded ]; then
    systemctl stop minhoon-studio || echo "   systemctl stop minhoon-studio failed"
  fi
  local left
  left=$(pgrep -u studio -a || true)
  if systemctl is-active --quiet minhoon-studio || [ -n "$left" ]; then
    echo "could not confirm the studio stopped (unit $(systemctl is-active minhoon-studio 2>/dev/null || true); processes of user studio: ${left:-none})"
    echo "the sandbox was not touched; stop it by hand, then rerun"
    exit 1
  fi
}

# True when the refresh summary says the sandbox was verified as before the run and git agrees on HEAD.
sandbox_restored() {
  local head
  head=$(python3 -c 'import json, sys
s = json.load(open(sys.argv[1], encoding="utf-8"))
print(s["head_before"] if s.get("sandbox_restored") is True else "")' "$1" 2>/dev/null) || return 1
  [ -n "$head" ] && [ "$(sudo -u studio git -C "$ROOT/sandbox" rev-parse HEAD 2>/dev/null)" = "$head" ]
}

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
  local rc=0
  sudo -u studio -H env HOME="$ROOT/home" python3 "$ROOT/app/deploy/make-sandbox.py" --archive "$ROOT/home/base.tar" --sha "$BASE_SHA" --out "$ROOT/sandbox" "$@" || rc=$?
  rm -f "$ROOT/home/base.tar"
  return $rc
}
echo "== sandbox (product tree at main $BASE_SHA; created once, then kept and refreshed)"
if [ ! -d "$ROOT/sandbox/.git" ]; then
  install -d -o studio -g studio "$ROOT/sandbox"
  sandbox_tool
else
  current=$(sudo -u studio git -C "$ROOT/sandbox" log -1 --format='%(trailers:key=Studio-Base-Sha,valueonly)' studio-base | tr -d '[:space:]')
  if [ "$current" != "$BASE_SHA" ]; then
    echo "   refresh $current -> $BASE_SHA (merge into $(sudo -u studio git -C "$ROOT/sandbox" rev-parse --abbrev-ref HEAD))"
    # No chat edit may write the sandbox during the merge; the unit is started again at the end if it was running.
    stop_studio
    backup_copy "$ROOT/sandbox"
    # A changed studio-mock/dataset.json resets the mock state (mock.js); keep the old one.
    if [ -f "$ROOT/data/mock-state.json" ]; then backup_copy "$ROOT/data/mock-state.json"; fi
    summary_json=$ROOT/data/refresh-$BASE_SHA-$BAK.json
    if ! sandbox_tool --refresh --python python3 --node "$ROOT/node/bin/node" | tee "$summary_json"; then
      echo "sandbox refresh to $BASE_SHA stopped: see $summary_json; resolve by hand, then rerun"
      if sandbox_restored "$summary_json"; then
        # The new app runs with the old sandbox: a studio that was running keeps running, a paused one stays stopped.
        if [ "$was_active" = yes ]; then systemctl start minhoon-studio; fi
      else
        # No verified restore (failed, or no summary at all): the chat must not edit a sandbox in an unknown state.
        echo "the sandbox was NOT verified as restored; the studio stays stopped. Inspect $ROOT/sandbox (copy before the run: $ROOT/sandbox.$BAK)"
      fi
      exit 1
    fi
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
# Every login folder under claude-config/ is an account: the owner adds one by hand (claude-config/<name> plus
# STUDIO_CLAUDE_ACCOUNT=<name> in studio.env). An existing config.json is the owner's (accounts, models, mappings
# edited by hand) and is never rewritten: 10-31 a rewrite dropped the hand-added account and the chat answered
# "unknown Claude account". Only a folder it does not list yet is added to claude.configDirs.
if [ -f "$ROOT/etc/studio.env" ]; then
  acct=$(sed -n 's/^STUDIO_CLAUDE_ACCOUNT=//p' "$ROOT/etc/studio.env" | tail -1 | tr -d '[:space:]')
  [ -z "$acct" ] || [ -d "$ROOT/claude-config/$acct" ] || { echo "studio.env names Claude account '$acct' but claude-config/$acct is missing"; exit 1; }
fi
if [ -f "$ROOT/etc/config.json" ]; then
  added=$(python3 - "$ROOT/etc/config.json" "$ROOT/claude-config" "$TLS_CERT" <<'PY'
import json, os, re, sys
path, root, cert = sys.argv[1:4]
with open(path, encoding="utf-8") as f:
    config = json.load(f)
dirs = config.setdefault("claude", {}).setdefault("configDirs", {})
added = [n for n in sorted(os.listdir(root))
         if re.fullmatch(r"[A-Za-z0-9_-]+", n) and os.path.isdir(os.path.join(root, n)) and n not in dirs]
if (config.get("tls") or {}).get("cert") != cert:
    print(f"   note: config.json keeps tls.cert {(config.get('tls') or {}).get('cert')} (this host would use {cert})", file=sys.stderr)
if added:
    for n in added:
        dirs[n] = os.path.join(root, n)
    with open(path + ".new", "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)
        f.write("\n")
print(" ".join(added))
PY
)
  if [ -n "$added" ]; then
    backup_copy "$ROOT/etc/config.json"
    mv "$ROOT/etc/config.json.new" "$ROOT/etc/config.json"
    echo "   kept config.json; added account folder(s): $added (previous: config.json.$BAK)"
  else
    echo "   kept config.json unchanged"
  fi
else
CONFIG_DIRS=$(for d in "$ROOT"/claude-config/*/; do n=$(basename "$d"); case "$n" in *[!A-Za-z0-9_-]*) continue;; esac
  printf '"%s": "%s", ' "$n" "$ROOT/claude-config/$n"; done | sed 's/, $//')
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
    "configDirs": { $CONFIG_DIRS },
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
fi
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
if [ "$was_active" = no ] && [ "$first_install" = no ]; then
  echo "installed; the studio was stopped before this run and stays stopped (start: sudo systemctl start minhoon-studio)"
  exit 0
fi
[ "$first_install" = no ] || systemctl enable minhoon-studio >/dev/null
systemctl restart minhoon-studio
sleep 3
systemctl is-active minhoon-studio
code=$(curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1:$PORT/studio/login.html")
gate=$(curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1:$PORT/api/me")
echo "login page $code (want 200), /api/me without login $gate (want 401)"
[ "$code" = 200 ] && [ "$gate" = 401 ]
echo "installed. Claude login state:"
sudo -u studio -H env HOME="$ROOT/home" CLAUDE_CONFIG_DIR="$ROOT/claude-config/sdij" "$ROOT/bin/claude" auth status --text 2>/dev/null | head -3 || true

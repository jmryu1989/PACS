#!/bin/bash
# VM side of scripts/minhoon-demo/deploy.ps1 (D1872): runs under vm-run.ps1 as its -CmdFile, cwd = the exact checkout.
# Brings up the checkout's own docker-compose.yml plus compose.demo.yml as the synthetic project $COMPOSE_PROJECT_NAME,
# waits for HTTPS readiness, then holds the stack until vm-run -Cancel (teardown.ps1) or the hang timeout sends TERM.
# On TERM/exit it stops the stack and removes its volumes and the demo secrets; vm-run's cleanup removes anything left.
# Synthetic data only; the laptop loads public samples through an SSH tunnel to the loopback Orthanc port.
set -uo pipefail
RUN=$(dirname "$KIN_HEAVY_ARTIFACTS")
INBOX=/srv/kin-heavy/in/minhoon-demo-$KIN_HEAVY_NAME
DEMO=$RUN/demo
P=$COMPOSE_PROJECT_NAME
LOG=$KIN_HEAVY_ARTIFACTS/progress.log
progress() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; echo "$*" > "$DEMO/phase.tmp" && mv "$DEMO/phase.tmp" "$DEMO/phase"; }
dc() { docker compose -p "$P" --env-file "$DEMO/stack.env" -f docker-compose.yml -f "$DEMO/compose.demo.yml" "$@"; }

[ -d "$INBOX" ] || { echo "missing inbox $INBOX (deploy.ps1 ships it before launch)" >> "$LOG"; exit 2; }
mkdir -m 700 "$DEMO" && mv "$INBOX"/* "$DEMO"/ && rmdir "$INBOX" || { echo "cannot take inbox" >> "$LOG"; exit 2; }
# shellcheck disable=SC1091
. "$DEMO/params"    # PUBLIC_IP DEMO_ORTHANC_PORT READY_TIMEOUT_SEC
stopping=0
# Fallback stop for the hang timeout or an early failure; teardown.ps1 stops the stack itself first (ctl.sh stop).
stop_stack() {
  [ "$stopping" = 1 ] && return; stopping=1
  trap '' TERM INT
  [ -d "$DEMO" ] || return 0
  progress "stopping (signal or exit)"
  dc ps -a > "$KIN_HEAVY_ARTIFACTS/compose-ps-final.txt" 2>&1
  dc logs --no-color --timestamps --tail 5000 > "$KIN_HEAVY_ARTIFACTS/compose-logs-final.txt" 2>&1
  timeout 300 docker compose -p "$P" --env-file "$DEMO/stack.env" -f docker-compose.yml -f "$DEMO/compose.demo.yml" \
    down -v --remove-orphans >> "$LOG" 2>&1
  echo "down exit=$?" >> "$LOG"
  rm -rf "$DEMO"
  echo "$(date -u +%FT%TZ) stopped; demo secrets removed" >> "$LOG"
}
trap 'stop_stack; exit 143' TERM INT
trap 'stop_stack' EXIT

progress "preparing"
mkdir -m 700 "$DEMO/certs"
# Self-signed for the public IP: the browser warns once ("advanced -> proceed"); the name itself matches.
openssl req -x509 -nodes -newkey rsa:2048 -days 30 -keyout "$DEMO/certs/kin.key" -out "$DEMO/certs/kin.crt" \
  -subj "/CN=$PUBLIC_IP/O=KIN synthetic demo (self-signed)" \
  -addext "subjectAltName=IP:$PUBLIC_IP,DNS:localhost,IP:127.0.0.1" 2> "$KIN_HEAVY_ARTIFACTS/openssl.log" || exit 3
chmod 755 "$DEMO/certs"; chmod 644 "$DEMO/certs/kin.crt" "$DEMO/certs/kin.key"
openssl x509 -in "$DEMO/certs/kin.crt" -noout -subject -ext subjectAltName -fingerprint -sha256 > "$KIN_HEAVY_ARTIFACTS/tls-cert.txt"
head -c 32 /dev/urandom > "$DEMO/wrapping.key" && chmod 644 "$DEMO/wrapping.key"
chmod 755 "$DEMO"; chmod 644 "$DEMO/realm.json"   # bind-mounted into keycloak; the run dir itself stays private
{ echo "DEMO_DIR=$DEMO"; echo "DEMO_ORTHANC_PORT=$DEMO_ORTHANC_PORT"; echo "KIN_REVISION=$KIN_HEAVY_SHA"; } >> "$DEMO/stack.env"
git rev-parse HEAD > "$KIN_HEAVY_ARTIFACTS/checkout-head.txt"
df -h / > "$KIN_HEAVY_ARTIFACTS/df-before.txt"

progress "building"
dc config -q >> "$LOG" 2>&1 || { progress "failed: compose config"; exit 4; }
dc build >> "$KIN_HEAVY_ARTIFACTS/build.log" 2>&1 || { progress "failed: build"; exit 5; }
progress "starting"
dc up -d --wait db >> "$LOG" 2>&1 || { progress "failed: db"; exit 6; }
dc exec -T db createdb -U kin keycloak >> "$LOG" 2>&1 || { progress "failed: createdb keycloak"; exit 6; }
dc up -d >> "$LOG" 2>&1 || { progress "failed: up"; dc ps -a >> "$LOG" 2>&1; exit 7; }

progress "waiting-ready"
deadline=$(( $(date +%s) + READY_TIMEOUT_SEC ))
until curl -sk --max-time 10 https://127.0.0.1/api/health | grep -q '"memberRights":"ready"'; do
  if [ "$(date +%s)" -ge "$deadline" ]; then progress "failed: readiness timeout"; dc ps -a >> "$LOG" 2>&1; exit 8; fi
  sleep 5
done
# Keycloak has imported the realm. Keep a credential-free copy at the mount source so an on-failure restart can still
# start (import is skipped for an existing realm) while the test passwords no longer sit on the VM disk.
python3 - "$DEMO/realm.json" <<'PY'
import json, sys
p = sys.argv[1]
realm = json.load(open(p, encoding='utf-8'))
for user in realm.get('users', []):
    user.pop('credentials', None)
json.dump(realm, open(p, 'w', encoding='utf-8'))
PY
dc ps > "$KIN_HEAVY_ARTIFACTS/compose-ps-ready.txt" 2>&1
df -h / > "$KIN_HEAVY_ARTIFACTS/df-ready.txt"
progress "ready"

# Hold until TERM. A health line every 5 minutes is the session's own uptime record.
n=0
while :; do
  sleep 30 & wait $!
  n=$((n + 1))
  if [ $((n % 10)) = 0 ]; then
    h=$(curl -sk --max-time 10 -o /dev/null -w '%{http_code}' https://127.0.0.1/api/health)
    echo "$(date -u +%FT%TZ) health=$h mem_avail_kib=$(awk '/MemAvailable/{print $2}' /proc/meminfo)" >> "$LOG"
  fi
done

#!/bin/bash
# Laptop -> VM control for a running demo (called over ssh by deploy.ps1 / demo_setup.py). Read or exec only; it creates
# no docker objects, so vm-run's cleanup diff still owns the stack.
#   ctl.sh <run-name> phase | load <study-uid>... | sql (stdin) | provision <kin-test-username> | ps
# Public sample originals come from the cache /srv/kin-heavy/demo-samples that deploy.ps1 fills across demo runs
# (public test data only; teardown.ps1 -PurgeSamples removes it) so a redeploy does not re-upload 6.7 GB.
set -uo pipefail
NAME=$1; ACTION=$2
[[ $NAME =~ ^[A-Za-z0-9._-]{1,64}$ ]] || { echo "bad name"; exit 2; }
RUN=/srv/kin-heavy/runs/$NAME
DEMO=$RUN/demo
CACHE=/srv/kin-heavy/demo-samples
P="kh-$(echo "$NAME" | tr 'A-Z.' 'a-z-')"
svc() { docker ps -q --filter "label=com.docker.compose.project=$P" --filter "label=com.docker.compose.service=$1"; }
one() { local ids; ids=$(svc "$1"); [ "$(echo "$ids" | grep -c .)" = 1 ] || { echo "expected one running $1 in $P" >&2; exit 3; }; echo "$ids"; }
case "$ACTION" in
phase) echo "state=$(cat "$RUN/state" 2>/dev/null || echo missing) phase=$(cat "$DEMO/phase" 2>/dev/null || echo none)";;
load)
  # The checkout's own scripts/mgxa_acceptance.py (empty-Orthanc check, original bytes, SHA-256 read-back), run next to
  # the loopback Orthanc. pydicom 2.4.4 comes from the host's smoke venv, requests from the distro Python (no install).
  shift 2
  studies=()
  for s in "$@"; do [[ $s =~ ^[0-9.]{1,64}$ ]] || { echo "bad study uid"; exit 2; }; studies+=(--study "$s"); done
  ORTHANC_PASS=$(sed -n 's/^ORTHANC_PASS=//p' "$DEMO/stack.env"); PORT=$(sed -n 's/^DEMO_ORTHANC_PORT=//p' "$DEMO/stack.env")
  cd "$RUN/src" && PYTHONPATH=/opt/kin-smoke/py/lib/python3.12/site-packages MGXA_ORTHANC_USER=admin MGXA_ORTHANC_PASSWORD=$ORTHANC_PASS \
    python3 -B scripts/mgxa_acceptance.py load --inventory "$DEMO/inventory.json" "${studies[@]}" --synthetic-project "$P" \
    --orthanc "http://127.0.0.1:$PORT" --timeout 900 --output "$DEMO/load.json";;
sql) docker exec -i "$(one db)" psql -X -q -v ON_ERROR_STOP=1 -U kin -d kin;;
provision)
  user=${3:-}
  [[ $user =~ ^kin-test-[a-z0-9-]{1,40}$ ]] || { echo "bad username"; exit 2; }
  sub=$(docker exec -i "$(one db)" psql -X -At -U kin -d kin -c "SELECT sub FROM \"MemberRights\" WHERE username='$user' AND approved AND NOT suspended")
  [ -n "$sub" ] || { echo "no approved member $user"; exit 4; }
  docker exec -i "$(one api)" node - "$sub" < "$RUN/src/tests/emr/d/provision_synthetic.cjs";;
stop)
  # Explicit stop used by teardown.ps1 before vm-run -Cancel (the command's TERM trap is only the hang-timeout fallback).
  [ -d "$DEMO" ] || { echo "already stopped"; exit 0; }
  A=$RUN/artifacts
  dc=(docker compose -p "$P" --env-file "$DEMO/stack.env" -f "$RUN/src/docker-compose.yml" -f "$DEMO/compose.demo.yml")
  echo "$(date -u +%FT%TZ) stopping (teardown)" >> "$A/progress.log"
  "${dc[@]}" ps -a > "$A/compose-ps-final.txt" 2>&1
  "${dc[@]}" logs --no-color --timestamps --tail 5000 > "$A/compose-logs-final.txt" 2>&1
  timeout 300 "${dc[@]}" down -v --remove-orphans >> "$A/progress.log" 2>&1; rc=$?
  echo "$(date -u +%FT%TZ) down exit=$rc" >> "$A/progress.log"
  rm -rf "$DEMO" && echo "$(date -u +%FT%TZ) stopped; demo secrets removed" >> "$A/progress.log"
  echo "down exit=$rc";;
ps) docker ps --filter "label=com.docker.compose.project=$P" --format '{{.Names}} {{.Status}} {{.Ports}}';;
*) echo "usage: ctl.sh <name> phase|load <uid>...|sql|provision <user>|ps"; exit 2;;
esac

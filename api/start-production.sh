#!/bin/sh
set -eu

# EMR-B1: 이관과 서비스는 서로 다른 프로세스·자격이다. `migrate`는 설치(installer) 자격의 일회성 컨테이너에서
# 검토된 migration만 적용하고(npx 자동 다운로드 없음), `serve`는 최소권한 runtime 자격으로 서버만 연다.
# 서비스 프로세스는 이관 자격을 받지 않으며 migration을 실행하지 않는다. 시작 확인 실패는 서버를 열지 않는다.
if [ "$#" -ne 1 ]; then
  echo "start-production.sh: expected exactly one entry mode" >&2
  exit 64
fi
case "$1" in
  migrate)
    exec ./node_modules/.bin/prisma migrate deploy
    ;;
  serve)
    # Node가 PID 1로 종료 신호를 받아 배포 때 이전 서버가 남지 않게 한다.
    exec node dist/main.js
    ;;
  state-serve-v3)
    KIN_EMR_STATE_FORMAT=3 exec node dist/emr-runtime/state-service-main.js
    ;;
  state-serve-v4)
    # The same compiled state-service main (Node PID 1); the explicit entry mode names the stored major format it
    # serves. A v3 pair is refused by the v4 mode and a v4 pair by the v3 mode, before any journal or lock exists.
    KIN_EMR_STATE_FORMAT=4 exec node dist/emr-runtime/state-service-main.js
    ;;
  state-convert-v4)
    # One-shot conversion root (same identity, reader credential and fence as the serving root): the quiesced v3
    # source under KIN_EMR_STATE_DIR is streamed into the empty v4 target under KIN_EMR_STATE_TARGET; it exits.
    KIN_EMR_STATE_MODE=convert-v4 exec node dist/emr-runtime/state-service-main.js
    ;;
  state-export-v3)
    # One-shot lossless export (rollback) of a v4 source into a new v3 target; the unchanged v3 reader admits it.
    KIN_EMR_STATE_MODE=export-v3 exec node dist/emr-runtime/state-service-main.js
    ;;
  *)
    echo "start-production.sh: expected migrate, serve, state-serve-v3, state-serve-v4, state-convert-v4 or state-export-v3" >&2
    exit 64
    ;;
esac

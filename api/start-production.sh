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
    exec node dist/emr-runtime/state-service-main.js
    ;;
  *)
    echo "start-production.sh: expected migrate, serve or state-serve-v3" >&2
    exit 64
    ;;
esac

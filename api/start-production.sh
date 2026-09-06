#!/bin/sh
set -eu

# npx의 자동 다운로드를 허용하지 않고, migration 실패 시 서버가 열리지 않게 한다.
./node_modules/.bin/prisma migrate deploy
# Node가 PID 1로 종료 신호를 받아 배포 때 이전 서버가 남지 않게 한다.
exec node dist/main.js

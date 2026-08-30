#!/bin/sh
# 렌더가 끝난 뒤 검사해야 nginx 변수 오치환·누락 인증서가 시작 루프가 아니라 즉시 실패한다.
set -e
nginx -t

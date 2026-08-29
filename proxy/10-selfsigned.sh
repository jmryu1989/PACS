#!/bin/sh
# 자체 서명 인증서가 없으면 만든다 (nginx 이미지가 기동 때 이 디렉터리의 .sh를 실행한다).
#
# 개발용이므로 브라우저는 경고를 띄운다 — 한 번 "고급 → 계속 진행"을 누르면 된다.
# 배포(6단계)에서는 이 파일 두 개를 진짜 인증서로 바꿔 끼우면 nginx.conf는 그대로다.
set -e
CERT_DIR=/etc/nginx/certs
CRT="$CERT_DIR/kin.crt"
KEY="$CERT_DIR/kin.key"

mkdir -p "$CERT_DIR"

if [ -s "$CRT" ] && [ -s "$KEY" ]; then
  echo "[kin-proxy] 인증서가 이미 있다: $CRT"
  exit 0
fi

echo "[kin-proxy] 자체 서명 인증서를 만든다 (개발용)"
# SAN이 없으면 최신 브라우저는 CN을 아예 안 본다 — "이름이 안 맞는다"로 거절당한다.
openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
  -keyout "$KEY" -out "$CRT" \
  -subj "/CN=localhost/O=Korea Imaging Network/C=KR" \
  -addext "subjectAltName=DNS:localhost,DNS:host.docker.internal,IP:127.0.0.1" \
  2>/dev/null

chmod 600 "$KEY"
echo "[kin-proxy] 준비됨: $CRT"

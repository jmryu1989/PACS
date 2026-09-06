# KIN 리버스 프록시 — 모든 것을 한 출처로 모은다
#
# 왜 필요한가:
#   ① CORS가 사라진다. 브라우저가 8042(화면)와 3000(API)을 오가는 한 프리플라이트와
#      Access-Control 헤더를 계속 맞춰야 하고, 토큰은 sessionStorage에 있을 수밖에 없다.
#   ② 한 출처가 되면 토큰을 **HttpOnly 쿠키**로 옮길 길이 열린다. 지금은 XSS가 곧
#      계정 탈취다(auth.js에 그렇게 적어놨다).
#   ③ Orthanc 자격증명을 브라우저에서 걷어낸다. 지금은 브라우저에 캐시된
#      basic auth 덕분에 썸네일이 뜬다 — 시크릿 창이나 남의 PC에서는 전부 401이다.
#   ④ 프로덕션(6단계)의 모양을 지금 만들어 둔다. 배포 때 바뀌는 건 인증서와 호스트명뿐이다.
FROM nginx:1.27-alpine

# 자체 서명 인증서를 컨테이너가 직접 만든다.
# **개인키를 저장소에 커밋하지 않기 위해서다.** 공개 저장소에 키가 한 번 올라가면
# 히스토리에서 지워도 이미 나간 것이다.
RUN apk add --no-cache openssl

COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY 10-selfsigned.sh /docker-entrypoint.d/10-selfsigned.sh
COPY 15-kin-config.envsh /docker-entrypoint.d/15-kin-config.envsh
COPY 25-nginx-test.sh /docker-entrypoint.d/25-nginx-test.sh
COPY branding/ /usr/share/nginx/html/kin-brand/
# 윈도우에서 체크아웃하면 실행 비트가 안 붙는다. CRLF도 함께 털어낸다 —
# 셸 스크립트에 CR이 남으면 "not found" 같은 엉뚱한 오류로 나타난다.
RUN sed -i 's/\r$//' /docker-entrypoint.d/10-selfsigned.sh \
                       /docker-entrypoint.d/15-kin-config.envsh \
                       /docker-entrypoint.d/25-nginx-test.sh \
 && chmod +x /docker-entrypoint.d/10-selfsigned.sh \
             /docker-entrypoint.d/15-kin-config.envsh \
             /docker-entrypoint.d/25-nginx-test.sh \
 && chmod 644 /etc/nginx/templates/default.conf.template \
 && chmod -R u=rwX,go=rX /usr/share/nginx/html/kin-brand

# Private (umask077) deployment checkouts yield 600/700 assets. nginx workers
# must be able to traverse/read the copied public branding regardless of host modes.

# KIN API — 개발용 이미지 (프로덕션 멀티스테이지는 6단계에서)
#
# alpine이 아니라 slim(Debian)을 쓰는 이유: Prisma의 쿼리·스키마 엔진은 미리 컴파일된
# 네이티브 바이너리이고, alpine은 glibc가 아닌 musl을 쓴다. alpine에서는 엔진이 OpenSSL을
# 못 찾아 "Could not parse schema engine response"로 죽는다. 이미지가 조금 커지는 대신
# 하루를 아낀다.
FROM node:22-slim

# Prisma 엔진이 요구하는 OpenSSL (slim 이미지에는 빠져 있을 수 있음)
RUN apt-get update -y \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 의존성 먼저 — package.json이 안 바뀌면 이 레이어는 캐시된다 (빌드가 빨라진다)
COPY package.json package-lock.json ./
RUN npm ci

# Prisma 클라이언트 생성에는 스키마가 필요하다
COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json nest-cli.json ./
COPY src ./src

EXPOSE 3000

# 부팅은 검토된 migration만 적용한다. 기존 DB는 baseline.mjs로 이력을 한 번
# 등록해야 한다. 여기서 자동 resolve/db push를 하면 누락된 변경까지 적용으로 위장한다.
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start:dev"]

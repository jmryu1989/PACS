# KIN API — Compose가 development/production target을 명시한다.
#
# alpine이 아니라 slim(Debian)을 쓰는 이유: Prisma의 쿼리·스키마 엔진은 미리 컴파일된
# 네이티브 바이너리이고, alpine은 glibc가 아닌 musl을 쓴다. alpine에서는 엔진이 OpenSSL을
# 못 찾아 "Could not parse schema engine response"로 죽는다. 이미지가 조금 커지는 대신
# 하루를 아낀다.
FROM node:22-slim AS base

# Prisma 엔진이 요구하는 OpenSSL (slim 이미지에는 빠져 있을 수 있음)
RUN apt-get update -y \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS development

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
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && npm run start:dev"]

FROM development AS build
RUN npm run build \
 && npm prune --omit=dev --ignore-scripts

# 빌드 도구·원본 TS를 함께 복사하면 운영에서도 watch/재컴파일이 가능해진다.
# Prisma CLI만은 부팅 시 검토된 migration을 적용하므로 runtime dependency다.
FROM base AS production
ARG VCS_REF=unknown
LABEL org.opencontainers.image.revision=$VCS_REF
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY start-production.sh ./start-production.sh
USER node
EXPOSE 3000
CMD ["sh", "/app/start-production.sh"]

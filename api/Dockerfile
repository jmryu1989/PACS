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
COPY package.json ./
RUN npm install

# Prisma 클라이언트 생성에는 스키마가 필요하다
COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json nest-cli.json ./
COPY src ./src

EXPOSE 3000

# 개발 편의: 뜰 때 스키마를 DB에 반영하고 watch 모드로 실행.
# 마이그레이션 파일 관리(prisma migrate)는 스키마가 안정되는 시점에 도입한다.
CMD ["sh", "-c", "npx prisma db push --skip-generate && npm run start:dev"]

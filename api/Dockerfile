# KIN API — 개발용 이미지 (프로덕션 멀티스테이지는 6단계에서)
FROM node:22-alpine

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

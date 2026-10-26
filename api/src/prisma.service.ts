import { Injectable, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { verifyRuntimeConnection } from './emr-runtime/manifest';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
  async onModuleInit() {
    await this.$connect();
    // 운영 기동은 접속기록 추가 전용 권한과 PostgreSQL 내구성을 확인한다.
    if (process.env.DEPLOYMENT_MODE === 'production') await verifyRuntimeConnection(this);
  }
  // onModuleDestroy는 HTTP 서버가 닫히기 전에 호출된다. 남은 요청의 DB 사용이
  // 끝난 뒤 연결을 정리하도록 Nest의 dispose 이후 훅을 사용한다.
  async onApplicationShutdown() {
    await this.$disconnect();
  }
}

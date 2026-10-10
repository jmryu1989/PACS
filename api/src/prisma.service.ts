import { Injectable, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { verifyRuntimeConnection } from './emr-runtime/manifest';
import { appendPoolConfiguration } from './emr-runtime/admission';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
  readonly emrAppendPoolSize: number;
  constructor() {
    const pool = process.env.DATABASE_URL ? appendPoolConfiguration(process.env.DATABASE_URL) : null;
    super(pool ? { datasources: { db: { url: pool.url } } } : undefined);
    this.emrAppendPoolSize = pool?.poolSize ?? 3;
  }
  async onModuleInit() {
    await this.$connect();
    // EMR-B1 시작 경계: 운영 서버는 최소권한 runtime 역할(소유·superuser·이관/보존 자격 없음)과 전용 저장소에 놓인 원장
    // 위에서만 시작한다. 확인에 실패하면 HTTP를 열기 전에 Nest 초기화가 실패한다. 이관은 별도 프로세스의 설치 자격으로 한다.
    if (process.env.DEPLOYMENT_MODE === 'production') await verifyRuntimeConnection(this);
  }
  // onModuleDestroy는 HTTP 서버가 닫히기 전에 호출된다. 남은 요청의 DB 사용이
  // 끝난 뒤 연결을 정리하도록 Nest의 dispose 이후 훅을 사용한다.
  async onApplicationShutdown() {
    await this.$disconnect();
  }
}

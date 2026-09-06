import { Injectable, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
  async onModuleInit() {
    await this.$connect();
  }
  // onModuleDestroy는 HTTP 서버가 닫히기 전에 호출된다. 남은 요청의 DB 사용이
  // 끝난 뒤 연결을 정리하도록 Nest의 dispose 이후 훅을 사용한다.
  async onApplicationShutdown() {
    await this.$disconnect();
  }
}

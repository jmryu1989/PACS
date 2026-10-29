import { ForbiddenException, Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { Caller } from './pacs.service';
import { BackgroundWork, EMR_BACKGROUND_WORK } from './emr-runtime/background-work';

const RETENTION_MS = 72 * 60 * 60 * 1000;

@Injectable()
export class PreloadKeyService implements OnModuleInit, OnModuleDestroy {
  private stopSweep?: () => void;
  constructor(private readonly prisma: PrismaService,
    @Inject(EMR_BACKGROUND_WORK) private readonly background: BackgroundWork) {}

  onModuleInit() {
    this.stopSweep = this.background.every('preload.retireKeys', 60 * 60 * 1000, () => this.retire());
  }
  onModuleDestroy() { this.stopSweep?.(); }

  retire(now = new Date()) {
    return this.prisma.preloadCacheKey.updateMany({
      where: { retiredAt: null, lastIssuedAt: { lte: new Date(now.getTime() - RETENTION_MS) } },
      data: { key: null, retiredAt: now },
    });
  }

  async issue(caller: Caller) {
    if (caller.kind !== 'member' || !caller.institution || !caller.sub
      || !caller.roles.some(role => ['radiologist', 'technician', 'admin'].includes(role))) {
      throw new ForbiddenException('이 계정으로는 미리 받기를 쓸 수 없습니다');
    }
    const now = new Date();
    const rows = await this.prisma.$transaction(async tx => {
      // Also retire on issue: a sleeping API must not reissue an overdue key before its hourly sweep.
      await tx.preloadCacheKey.updateMany({ where: { institution: caller.institution, sub: caller.sub,
        retiredAt: null, lastIssuedAt: { lte: new Date(now.getTime() - RETENTION_MS) } }, data: { key: null, retiredAt: now } });
      // The partial unique index serializes concurrent first logins; all callers receive the same active key.
      return tx.$queryRaw<Array<{ id: string; key: Buffer }>>`
        INSERT INTO "PreloadCacheKey" ("id", "institution", "sub", "key", "createdAt", "lastIssuedAt")
        VALUES (${randomUUID()}::uuid, ${caller.institution}, ${caller.sub}, ${randomBytes(32)}, ${now}, ${now})
        ON CONFLICT ("institution", "sub") WHERE "retiredAt" IS NULL
        DO UPDATE SET "lastIssuedAt" = GREATEST("PreloadCacheKey"."lastIssuedAt", EXCLUDED."lastIssuedAt")
        RETURNING "id", "key"`;
    });
    return { keyId: rows[0].id, key: Buffer.from(rows[0].key).toString('base64'), serverTime: now.toISOString() };
  }
}

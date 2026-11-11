import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { dictationParser } from './dictation-parser';
import { studyTransferLocalParser } from './study-transfer-local-parser';
import { studyAttachmentParser } from './study-attachment-parser';
import { join } from 'node:path';
import { EmrRuntime } from './emr-runtime/application';
import { PrismaClient } from '@prisma/client';
import { DraftPurposeDisposal, PurposeLedgerFile, configureDraftPurpose, draftPurposeAdapter, purposeLedgerDirectory,
  purposeLedgerMirrorDirectory } from './emr-retention/draft-purpose';
import { nodeLedgerIo } from './emr-retention/ledger-file';
import { composeRetentionGate } from './emr-retention/retention-gate';
import { ReportLedgerFile, ReportRetention, reportLedgerDirectory, reportLedgerMirrorDirectory, reportRetentionAdapter } from './emr-retention/report-retention';

async function bootstrap() {
  // 설정 실수는 첫 요청의 500/인증 우회가 아니라 기동 실패로 드러나야 한다.
  const production = process.env.DEPLOYMENT_MODE === 'production';
  if (production && process.env.AUTH_REQUIRED !== 'true') {
    console.error('[KIN API] DEPLOYMENT_MODE=production에서는 AUTH_REQUIRED=true여야 합니다. 기동을 중단합니다.');
    process.exit(1);
  }
  if (process.env.AUTH_REQUIRED !== 'false')
    for (const key of [
      'KC_ISSUER', 'KC_JWKS_URL', 'KC_AUDIENCE',
      'KC_WEB_SECRET', 'KIN_COOKIE_SECRET', 'PUBLIC_ORIGIN',
    ])
      if (!process.env[key]) {
        console.error(`[KIN API] ${key}가 설정되지 않았습니다. 인증이 켜진 상태에서는 필수입니다. 기동을 중단합니다.`);
        process.exit(1);
      }

  if (!process.env.KIN_EMR_STATE_DIR || !process.env.DATABASE_URL)
    throw new Error('EmrDatabaseAndFailureDirectoryRequired');
  const runtime = new EmrRuntime(process.env.DATABASE_URL, join(process.env.KIN_EMR_STATE_DIR, 'outage'));
  await runtime.start();
  // CD-09-P/C: before any request, this database must agree with every retention unit's external ledger (one composed
  // gate, units in order). A restored older copy gets every destruction a ledger completed re-applied here; a copy a
  // ledger cannot be matched with keeps the server closed (no listen), naming the unit and its code. Ended works still
  // pending are then destroyed before the first request. With KIN_LEDGER_MIRROR_DIR each ledger is also written to its
  // mirror, which the gate reads for a lost or damaged ledger file.
  const purposeDb = new PrismaClient();
  try {
    await composeRetentionGate([
      draftPurposeAdapter(() => configureDraftPurpose(new DraftPurposeDisposal(purposeDb,
        new PurposeLedgerFile(purposeLedgerDirectory(), nodeLedgerIo, purposeLedgerMirrorDirectory())))),
      // CD-09-D: reports whose retention ended, after the draft purpose unit (its ledger beside the purpose ledger).
      reportRetentionAdapter(() => new ReportRetention(purposeDb,
        new ReportLedgerFile(reportLedgerDirectory(), nodeLedgerIo, reportLedgerMirrorDirectory()))),
    ]).open();
  } catch (error) {
    await purposeDb.$disconnect().catch(() => undefined);
    await runtime.stop(Date.now() + 5000);
    throw error;
  }
  let app;
  try { app = await NestFactory.create(AppModule.withLedger(runtime, {
    proxyPeers: (process.env.KIN_REQUEST_PROXY_PEERS ?? '').split(',').map(peer => peer.trim()).filter(Boolean),
  }), { rawBody: true, abortOnError: false }); }
  catch (error) { await runtime.stop(Date.now() + 5000); throw error; }
  app.use(dictationParser());
  app.use(studyTransferLocalParser());
  app.use(studyAttachmentParser());
  /**
   * 모든 `/api/` 응답의 기본값은 `no-store`다(S7-U5 A016). 예전에는 경로 목록에 든 곳만 그랬고, 목록에 없는 GET(판독 이력·
   * 인용·구조·감사 등)은 브라우저 캐시가 요청 없이 다시 내주었다 — Log out 뒤의 뒤로 가기나 다음 사람의 같은 주소가 서버에
   * 묻지 않고 앞사람의 답을 읽는다. 경로를 하나씩 더하는 목록은 새 경로를 빠뜨리므로 기본값을 뒤집는다.
   * Nest의 body parser·라우팅·인증 가드보다 먼저 등록한다: 잘못된 JSON(400)·인증 거절(401·403)·없는 경로(404)의 답도 같다.
   * 영상 화소(/dicom-web)와 뷰어 번들(/ohif)은 이 서버의 `/api/` 밖이라 해당하지 않는다. nginx의 `location /api/`에 두지
   * 않는 이유: 그 수준의 add_header는 서버 수준 보안 헤더의 상속을 끊는다.
   */
  app.use((req: any, res: any, next: () => void) => {
    const path = String(req.originalUrl ?? '').split('?')[0];
    if (path === '/api' || path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // PID 1 Node가 SIGTERM을 무시하면 Docker가 제한 시간 뒤 SIGKILL한다.
  // 배포 때 진행 중 요청과 DB 연결을 닫고 종료하도록 Nest 종료 훅을 켠다.
  app.enableShutdownHooks();

  // 프록시가 한 출처로 합쳤다. 예외적인 개발 출처가 필요할 때만 env 화이트리스트를 연다.
  const corsOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',').map(origin => origin.trim()).filter(Boolean);
  if (corsOrigins.length)
    app.enableCors({ origin: corsOrigins, credentials: false });
  app.setGlobalPrefix('api');

  try { await app.listen(3000, '0.0.0.0'); }
  catch (error) {
    try { await app.close(); } finally { await runtime.stop(Date.now() + 5000); }
    throw error;
  }
  console.log('[KIN API] http://localhost:3000/api');
  if (process.env.AUTH_REQUIRED === 'false')
    console.warn('[KIN API] ⚠️  인증이 꺼져 있습니다 (AUTH_REQUIRED=false). 사내망 밖에 노출하지 마세요.');
  else
    console.log(`[KIN API] 인증: Keycloak (iss=${process.env.KC_ISSUER})`);
}
bootstrap().catch(error => { console.error('[KIN API] Startup failed.', error); process.exitCode = 1; });

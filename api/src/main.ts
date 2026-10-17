import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import type { INestApplication } from '@nestjs/common';
import { EmrApplicationRuntime, EmrStartupFailure } from './emr-runtime/application';
import { startupFailureMessage } from './emr-runtime/manifest';
import { dictationParser } from './dictation-parser';

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

  // EMR-B2-BASE: a provider refusal while Nest builds the module graph (abortOnError off) reaches the one closed line at the
  // end of this file instead of Nest's English error, stack and exit; Nest's own logs stay buffered until the server listens.
  const app = startup.app = await NestFactory.create(AppModule, { rawBody: true, abortOnError: false, bufferLogs: true, autoFlushLogs: false });
  app.use(dictationParser());
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
  // EMR-B2-BASE: the EMR ledger owner starts once, after the module graph and before every init hook (timers) and the
  // listener; a refused start never opens either. A is composed with B's readers.
  await app.get(EmrApplicationRuntime).start();
  startup.phase = 'init';
  await app.init();
  startup.phase = 'listen';
  await app.listen(3000, '0.0.0.0');
  app.flushLogs();
  console.log('[KIN API] http://localhost:3000/api');
  if (process.env.AUTH_REQUIRED === 'false')
    console.warn('[KIN API] ⚠️  인증이 꺼져 있습니다 (AUTH_REQUIRED=false). 사내망 밖에 노출하지 마세요.');
  else
    console.log(`[KIN API] 인증: Keycloak (iss=${process.env.KC_ISSUER})`);
}
/**
 * EMR-B2-BASE: a start that failed anywhere (create, the EMR owner's phases, init, listen) prints one closed line - never
 * a provider message, which can carry a connection string - then closes what exists (the app and the owner's resources,
 * each once) for at most 5 s and exits nonzero. A supervisor restart is a new process with its own recovery. A start
 * that a stop signal interrupted is already being closed by Nest's shutdown hook, which ends the process with that
 * signal; this path then only bounds the wait.
 */
const startup: { phase: 'create' | 'init' | 'listen'; app?: INestApplication } = { phase: 'create' };
bootstrap().catch(async error => {
  const failure = error instanceof EmrStartupFailure ? error : null;
  console.error('[KIN API] ' + startupFailureMessage(failure ? failure.phase : startup.phase, failure ? failure.failure : error));
  if (failure?.interrupted) {
    setTimeout(() => process.exit(1), 5000);
    return;
  }
  const app = startup.app;
  const cleanup = (async () => {
    try { await app?.close(); } catch { /* the line above is the failure */ }
    try { await app?.get(EmrApplicationRuntime).close(); } catch { /* the line above is the failure */ }
  })();
  await Promise.race([cleanup, new Promise(done => setTimeout(done, 5000))]);
  process.exit(1);
});

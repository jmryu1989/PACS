import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

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

  const app = await NestFactory.create(AppModule);
  // PID 1 Node가 SIGTERM을 무시하면 Docker가 제한 시간 뒤 SIGKILL한다.
  // 배포 때 진행 중 요청과 DB 연결을 닫고 종료하도록 Nest 종료 훅을 켠다.
  app.enableShutdownHooks();

  // 프록시가 한 출처로 합쳤다. 예외적인 개발 출처가 필요할 때만 env 화이트리스트를 연다.
  const corsOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',').map(origin => origin.trim()).filter(Boolean);
  if (corsOrigins.length)
    app.enableCors({ origin: corsOrigins, credentials: false });
  app.setGlobalPrefix('api');

  await app.listen(3000, '0.0.0.0');
  console.log('[KIN API] http://localhost:3000/api');
  if (process.env.AUTH_REQUIRED === 'false')
    console.warn('[KIN API] ⚠️  인증이 꺼져 있습니다 (AUTH_REQUIRED=false). 사내망 밖에 노출하지 마세요.');
  else
    console.log(`[KIN API] 인증: Keycloak (iss=${process.env.KC_ISSUER})`);
}
bootstrap();

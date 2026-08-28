import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 프론트는 Orthanc(8042)가 서빙하고 API는 3000에 있다 → 다른 출처이므로 CORS 필요.
  // 3단계 후반에 리버스 프록시로 한 출처에 합치면 이 줄은 사라진다.
  app.enableCors({ origin: true, credentials: false });
  app.setGlobalPrefix('api');

  await app.listen(3000, '0.0.0.0');
  console.log('[KIN API] http://localhost:3000/api');
  if (process.env.AUTH_REQUIRED === 'false')
    console.warn('[KIN API] ⚠️  인증이 꺼져 있습니다 (AUTH_REQUIRED=false). 사내망 밖에 노출하지 마세요.');
  else
    console.log(`[KIN API] 인증: Keycloak (iss=${process.env.KC_ISSUER})`);
}
bootstrap();

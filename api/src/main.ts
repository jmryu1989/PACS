import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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

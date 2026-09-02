import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PrismaService } from './prisma.service';
import { PacsController } from './pacs.controller';
import { PacsService } from './pacs.service';
import { OrthancService } from './orthanc.service';
import { KeycloakService } from './keycloak.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

function adminNoStore(_req: any, res: any, next: () => void) {
  res.setHeader('Cache-Control', 'no-store');
  next();
}

@Module({
  controllers: [PacsController, AuthController, AdminController],
  providers: [
    PrismaService, PacsService, OrthancService, KeycloakService, AuthService, AdminService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // 가드가 401/403으로 먼저 끝내는 응답도 브라우저 캐시에 남지 않아야 한다.
    consumer.apply(adminNoStore).forRoutes(AdminController);
  }
}

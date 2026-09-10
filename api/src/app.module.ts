import { ConsultationController } from './consultation.controller';
import { ConsultationService } from './consultation.service';
import { ReaderAssignmentController } from './reader-assignment.controller';
import { ReaderAssignmentService } from './reader-assignment.service';
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
import { ViewerController } from './viewer.controller';
import { ViewerService } from './viewer.service';
import { ViewerJobController } from './viewer-job.controller';
import { ViewerJobService } from './viewer-job.service';
import { ConnectController } from './connect.controller';
import { ConnectService } from './connect.service';
import { ManualSrController } from './manual-sr.controller';
import { ManualSrService } from './manual-sr.service';
import { ReportPreviewController } from './report-preview.controller';
import { FavoriteController } from './favorite.controller';
import { FavoriteService } from './favorite.service';
import { StudyTagsController } from './study-tags.controller';
import { StudyTagsService } from './study-tags.service';

function adminNoStore(_req: any, res: any, next: () => void) {
  res.setHeader('Cache-Control', 'no-store');
  next();
}

@Module({
  controllers: [PacsController, AuthController, AdminController, ViewerController, ViewerJobController, ConnectController, ManualSrController, ReportPreviewController, FavoriteController, StudyTagsController, ReaderAssignmentController, ConsultationController],
  providers: [
    PrismaService, PacsService, OrthancService, KeycloakService, AuthService, AdminService, ViewerService, ViewerJobService, ConnectService, ManualSrService, FavoriteService, StudyTagsService, ReaderAssignmentService, ConsultationService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // 가드가 401/403으로 먼저 끝내는 응답도 브라우저 캐시에 남지 않아야 한다.
    consumer.apply(adminNoStore).forRoutes(AdminController, ViewerController, ViewerJobController, ConnectController, ManualSrController, ReportPreviewController, FavoriteController, StudyTagsController, ReaderAssignmentController, ConsultationController);
  }
}

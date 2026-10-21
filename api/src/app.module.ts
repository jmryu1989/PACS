import { AsrService } from './asr.service';
import { DictationController } from './dictation.controller';
import { StudyAccessService } from './study-access.service';
import { StudyAccessController } from './study-access.controller';
import { StudyAccessInterceptor } from './study-access.interceptor';
import { ConsultationController } from './consultation.controller';
import { ConsultationService } from './consultation.service';
import { ClinicianQuestionController } from './clinician-question.controller';
import { ClinicianQuestionService } from './clinician-question.service';
import { ImageRequestController } from './image-request.controller';
import { ImageRequestService } from './image-request.service';
import { CriticalResultController } from './critical-result.controller';
import { CriticalResultService } from './critical-result.service';
import { ReaderAssignmentController } from './reader-assignment.controller';
import { ReaderAssignmentService } from './reader-assignment.service';
import { DynamicModule, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { BackgroundWork, EMR_BACKGROUND_WORK } from './emr-runtime/background-work';
import { EMR_RECORD_PORT, EmrRecordPort } from './emr-runtime/record-port';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
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
import { ViewerContextEventService } from './viewer-context-event.service';
import { FindingController } from './finding.controller';
import { FindingService } from './finding.service';
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
import { ClinicalContextController } from './clinical-context.controller';
import { ClinicalContextService } from './clinical-context.service';

function adminNoStore(_req: any, res: any, next: () => void) {
  res.setHeader('Cache-Control', 'no-store');
  next();
}

@Module({
  controllers: [DictationController, PacsController, AuthController, AdminController, ViewerController, FindingController, ViewerJobController, ConnectController, ManualSrController, ReportPreviewController, FavoriteController, StudyTagsController, ReaderAssignmentController, ConsultationController, ClinicianQuestionController, ImageRequestController, ClinicalContextController, CriticalResultController, StudyAccessController],
  providers: [
    ViewerContextEventService,
    AsrService, StudyAccessService, PrismaService, PacsService, OrthancService, KeycloakService, AuthService, AdminService, ViewerService, FindingService, ViewerJobService, ConnectService, ManualSrService, FavoriteService, StudyTagsService, ReaderAssignmentService, ConsultationService, ClinicianQuestionService, ImageRequestService, ClinicalContextService, CriticalResultService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: StudyAccessInterceptor },
  ],
})
export class AppModule implements NestModule {
  // Construction closure (imports, field initializers, factories including async/useValue, constructors and configure)
  // must remain resource-free. No connection, file handle, timer, worker, process listener or detached acquisition here.
  // Acquire only in awaited init/bootstrap hooks, retaining a cleanup handle before waiting. The launcher registers
  // the lifecycle adapter first, and its settlement barrier joins peer acquisitions even when one hook rejects.
  /** EMR-B2 (c): the module as the launcher creates it - the record port it prepared and the process's background-work
   * handle, by value under their tokens. Nothing else of the EMR lifetime is a provider, so no consumer can start,
   * close, recover, compose or reach the protected-state session or transport. */
  static forLaunch(port: EmrRecordPort, background: BackgroundWork): DynamicModule {
    return { module: AppModule, providers: [{ provide: EMR_RECORD_PORT, useValue: port }, { provide: EMR_BACKGROUND_WORK, useValue: background }] };
  }
  configure(consumer: MiddlewareConsumer) {
    // 가드가 401/403으로 먼저 끝내는 응답도 브라우저 캐시에 남지 않아야 한다.
    consumer.apply(adminNoStore).forRoutes(AdminController, ViewerController, FindingController, ViewerJobController, ConnectController, ManualSrController, ReportPreviewController, FavoriteController, StudyTagsController, ReaderAssignmentController, ConsultationController, ClinicianQuestionController, ImageRequestController, ClinicalContextController, CriticalResultController, StudyAccessController);
  }
}

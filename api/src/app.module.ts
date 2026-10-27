import { startupClinicalProviders } from './emr-clinical/startup';
import { EMR_BACKGROUND_WORK } from './emr-runtime/background-work';
import { EmrAuditController } from './emr-audit/audit.controller';
import { EmrAuditService } from './emr-audit/service';
import { EmrViewingModule } from './emr-viewing/emr-viewing.module';
import { AsrService } from './asr.service';
import { DictationController } from './dictation.controller';
import { StudyAccessService } from './study-access.service';
import { StudyAccessController } from './study-access.controller';
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
import { DynamicModule, Module } from '@nestjs/common';
import type { EmrRuntime } from './emr-runtime/application';
import { EMR_RECORD_PORT } from './emr-runtime/record-port';
import { EmrNestLifecycle } from './emr-runtime/nest-lifecycle';
import { createRequestContext, REQUEST_CONTEXT_CAPTURE, REQUEST_CONTEXT_SOURCE } from './emr-runtime/request-context';
import { createRequestIngress, RequestIngressConfiguration } from './emr-runtime/request-ingress';
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
import { AdminAccessReview } from './admin-access-review';
import { ViewerController } from './viewer.controller';
import { ViewerService } from './viewer.service';
import { ViewerContextEventService } from './viewer-context-event.service';
import { MultiStudyViewController } from './multi-study-view.controller';
import { MultiStudyViewService } from './multi-study-view.service';
import { ViewingSetAccess } from './emr-viewing/viewing-set-access';
import { FindingController } from './finding.controller';
import { FindingService } from './finding.service';
import { ViewerJobController } from './viewer-job.controller';
import { ViewerJobService } from './viewer-job.service';
import { ConnectController } from './connect.controller';
import { ConnectService } from './connect.service';
import { OnlineImageService } from './emr-image/service';
import { ImageContextSource, ModuleAImageContextPending, ProductionImageContext } from './emr-image/context';
import { ManualSrController } from './manual-sr.controller';
import { ManualSrService } from './manual-sr.service';
import { ReportPreviewController } from './report-preview.controller';
import { FavoriteController } from './favorite.controller';
import { FavoriteService } from './favorite.service';
import { StudyTagsController } from './study-tags.controller';
import { StudyTagsService } from './study-tags.service';
import { ClinicalContextController } from './clinical-context.controller';
import { ClinicalContextService } from './clinical-context.service';
import { StudyTransferLocalController } from './study-transfer-local.controller';
import { StudyTransferLocalService } from './study-transfer-local.service';
import { DicomImportGateService } from './dicom-import-gate.service';

@Module({
  controllers: [EmrAuditController, DictationController, PacsController, AuthController, AdminController, ViewerController, MultiStudyViewController, FindingController, ViewerJobController, ConnectController, ManualSrController, ReportPreviewController, FavoriteController, StudyTagsController, ReaderAssignmentController, ConsultationController, ClinicianQuestionController, ImageRequestController, ClinicalContextController, CriticalResultController, StudyAccessController, StudyTransferLocalController],
  providers: [
    EmrAuditService,
    ...startupClinicalProviders,
    ViewerContextEventService,
    OnlineImageService, ModuleAImageContextPending,
    { provide: ImageContextSource, inject: [ModuleAImageContextPending],
      useFactory: (lookups: ModuleAImageContextPending) => new ProductionImageContext(lookups, lookups) },
    AsrService, StudyAccessService, PrismaService, PacsService, OrthancService, KeycloakService, AuthService, AdminService, ViewerService, FindingService, ViewerJobService, ConnectService, ManualSrService, FavoriteService, StudyTagsService, ReaderAssignmentService, ConsultationService, ClinicianQuestionService, ImageRequestService, ClinicalContextService, CriticalResultService,
    StudyTransferLocalService, DicomImportGateService,
    AdminAccessReview,
    { provide: APP_GUARD, useClass: AuthGuard },
    // W9 source selections use the same request-bound A1 response recorder.
    MultiStudyViewService, ViewingSetAccess,
  ],
})
export class AppModule {
  static withLedger(runtime: EmrRuntime, ingress: RequestIngressConfiguration = { proxyPeers: [] }): DynamicModule {
    const requests = createRequestContext(createRequestIngress(ingress), runtime.port);
    return { module: AppModule, imports: [EmrViewingModule.withRequests(requests.source)], providers: [
      { provide: REQUEST_CONTEXT_CAPTURE, useValue: requests.capture },
      { provide: REQUEST_CONTEXT_SOURCE, useValue: requests.source },
      { provide: EMR_RECORD_PORT, useValue: runtime.port },
      { provide: EMR_BACKGROUND_WORK, useValue: runtime.background.work },
      { provide: EmrNestLifecycle, useValue: new EmrNestLifecycle(runtime) },
    ], exports: [EMR_RECORD_PORT, REQUEST_CONTEXT_SOURCE] };
  }
}

import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { OrthancService } from './orthanc.service';
import { KeycloakService } from './keycloak.service';
import { StudyAccessService } from './study-access.service';
import { FindingService } from './finding.service';
import { PacsAccess } from './pacs/access';
import { PacsInstitutions } from './pacs/institutions';
import { PacsPreferences } from './pacs/preferences';
import { PacsFilters } from './pacs/filters';
import { PacsAudit } from './pacs/audit';
import { PacsMetrics } from './pacs/metrics';
import { PacsWorklist } from './pacs/worklist';
import { PacsDicomGateway } from './pacs/dicom-gateway';
import { PacsStudyState } from './pacs/study-state';
import { PacsTechNote } from './pacs/tech-note';
import { PacsHold } from './pacs/hold';
import { PacsClinician } from './pacs/clinician';
import { PacsReportEvidence } from './pacs/report-evidence';
import { PacsReportDraft } from './pacs/report-draft';
import { PacsReportCommit } from './pacs/report-commit';
import type { Caller } from './pacs/access';

// The service's existing named exports stay importable from this path (order S9-U0b section 4).
export type { Caller } from './pacs/access';
export { qidoCount } from './pacs/values';
export type { DraftOwner } from './pacs/values';
export { OWNER_ONLY_AUDIT_ACTIONS, INSTITUTION_AUDIT_ACTIONS } from './pacs/audit';
export { ADMIN_METRIC_KEYS, ADMIN_METRIC_DAY_MS, ADMIN_METRIC_WEEK_MS, orthancDiskBytes, adminMetricRows } from './pacs/metrics';
export type { AdminMetricFailure, AdminMetricStorage, AdminMetricStudies } from './pacs/metrics';

/**
 * PACS 업무 API의 facade. 컨트롤러·서비스가 주입받는 Nest provider는 이것 하나다(5개 의존성, 기존 constructor 순서).
 * 구현은 api/src/pacs/ 의 concern 객체에 있고, 그 객체는 여기서만 만든다 — Nest provider가 아니므로 DI 그래프는
 * 분할 전과 같다. 공개 메서드는 같은 이름의 concern 메서드에 인수를 순서 그대로 넘긴다. 지도는 api/src/pacs/README.md.
 */
@Injectable()
export class PacsService implements OnModuleInit {
  private readonly accessConcern: PacsAccess;
  private readonly institutionsConcern: PacsInstitutions;
  private readonly preferencesConcern: PacsPreferences;
  private readonly filtersConcern: PacsFilters;
  private readonly auditConcern: PacsAudit;
  private readonly metricsConcern: PacsMetrics;
  private readonly worklistConcern: PacsWorklist;
  private readonly dicomGatewayConcern: PacsDicomGateway;
  private readonly studyStateConcern: PacsStudyState;
  private readonly techNoteConcern: PacsTechNote;
  private readonly holdConcern: PacsHold;
  private readonly clinicianConcern: PacsClinician;
  private readonly reportEvidenceConcern: PacsReportEvidence;
  private readonly reportDraftConcern: PacsReportDraft;
  private readonly reportCommitConcern: PacsReportCommit;

  constructor(
    private prisma: PrismaService,
    private orthanc: OrthancService,
    private keycloak: KeycloakService, private studyAccess:StudyAccessService,
    // 인용이 가리키는 소견의 가독은 소견 쪽 관문이 판정한다. 판독문 관문(기관·예비판독)은
    // 그보다 넓어서, 그것만으로 통과시키면 읽을 수 없는 비교 검사가 인용을 통해 새어 나온다.
    private findings: FindingService) {
    this.accessConcern = new PacsAccess(this.prisma, this.studyAccess);
    this.institutionsConcern = new PacsInstitutions(this.prisma, this.orthanc, this.keycloak, this.studyAccess, this.accessConcern);
    this.preferencesConcern = new PacsPreferences(this.prisma);
    this.filtersConcern = new PacsFilters(this.prisma);
    this.auditConcern = new PacsAudit(this.prisma, this.studyAccess, this.accessConcern);
    this.metricsConcern = new PacsMetrics(this.prisma, this.orthanc, this.studyAccess, this.accessConcern);
    this.worklistConcern = new PacsWorklist(this.prisma, this.orthanc, this.studyAccess, this.accessConcern, this.institutionsConcern, this.preferencesConcern, this.auditConcern);
    this.dicomGatewayConcern = new PacsDicomGateway(this.prisma, this.orthanc, this.studyAccess, this.accessConcern, this.institutionsConcern);
    this.studyStateConcern = new PacsStudyState(this.prisma, this.studyAccess, this.accessConcern, this.institutionsConcern, this.auditConcern);
    this.techNoteConcern = new PacsTechNote(this.prisma, this.studyAccess, this.accessConcern);
    this.holdConcern = new PacsHold(this.prisma, this.studyAccess, this.accessConcern);
    this.clinicianConcern = new PacsClinician(this.prisma, this.studyAccess, this.accessConcern, this.worklistConcern);
    this.reportEvidenceConcern = new PacsReportEvidence(this.prisma, this.studyAccess, this.findings, this.accessConcern);
    this.reportDraftConcern = new PacsReportDraft(this.prisma, this.studyAccess, this.accessConcern, this.auditConcern, this.reportEvidenceConcern);
    this.reportCommitConcern = new PacsReportCommit(this.keycloak, this.studyAccess, this.reportEvidenceConcern, this.reportDraftConcern);
  }

  // ── institutions (api/src/pacs/institutions.ts) ──
  async onModuleInit() {
    return this.institutionsConcern.onModuleInit();
  }

  institutionName(id: string | null) {
    return this.institutionsConcern.institutionName(id);
  }

  async unassigned(c: Caller) {
    return this.institutionsConcern.unassigned(c);
  }

  async assignInstitution(uid: string, institutionId: string, c: Caller) {
    return this.institutionsConcern.assignInstitution(uid, institutionId, c);
  }

  async colleagues(c: Caller) {
    return this.institutionsConcern.colleagues(c);
  }

  // ── preferences (api/src/pacs/preferences.ts) ──
  async prefs(c: Caller) {
    return this.preferencesConcern.prefs(c);
  }

  async readingPreferences(c: Caller) {
    return this.preferencesConcern.readingPreferences(c);
  }

  async saveReadingPreferences(body: any, c: Caller) {
    return this.preferencesConcern.saveReadingPreferences(body, c);
  }

  async hangingProtocols(c: Caller) {
    return this.preferencesConcern.hangingProtocols(c);
  }

  async saveHangingProtocols(body: any, c: Caller) {
    return this.preferencesConcern.saveHangingProtocols(body, c);
  }

  async siteHangingProtocols(c: Caller) {
    return this.preferencesConcern.siteHangingProtocols(c);
  }

  async saveSiteHangingProtocols(body: any, c: Caller) {
    return this.preferencesConcern.saveSiteHangingProtocols(body, c);
  }

  async workspaceShortcuts(c: Caller) {
    return this.preferencesConcern.workspaceShortcuts(c);
  }

  async saveWorkspaceShortcuts(body: any, c: Caller) {
    return this.preferencesConcern.saveWorkspaceShortcuts(body, c);
  }

  async readingAppearance(c: Caller) {
    return this.preferencesConcern.readingAppearance(c);
  }

  async saveReadingAppearance(body: any, c: Caller) {
    return this.preferencesConcern.saveReadingAppearance(body, c);
  }

  async workspaceLayout(c: Caller) {
    return this.preferencesConcern.workspaceLayout(c);
  }

  async writeWorkspaceLayout(body: any, c: Caller, clear: boolean) {
    return this.preferencesConcern.writeWorkspaceLayout(body, c, clear);
  }

  async worklistColumns(c: Caller) {
    return this.preferencesConcern.worklistColumns(c);
  }

  async writeWorklistColumns(body: any, c: Caller, clear: boolean) {
    return this.preferencesConcern.writeWorklistColumns(body, c, clear);
  }

  async saveTemplate(body: any, c: Caller) {
    return this.preferencesConcern.saveTemplate(body, c);
  }

  async deleteTemplate(id: number, c: Caller) {
    return this.preferencesConcern.deleteTemplate(id, c);
  }

  // ── filters (api/src/pacs/filters.ts) ──
  async saveFilter(body: any, c: Caller) {
    return this.filtersConcern.saveFilter(body, c);
  }

  async setDefaultFilter(id: number, on: boolean, c: Caller) {
    return this.filtersConcern.setDefaultFilter(id, on, c);
  }

  async deleteFilter(id: number, c: Caller) {
    return this.filtersConcern.deleteFilter(id, c);
  }

  async readFilterFolders(c: Caller) {
    return this.filtersConcern.readFilterFolders(c);
  }

  async writeFilterFolders(body: any, c: Caller) {
    return this.filtersConcern.writeFilterFolders(body, c);
  }

  async readSharedFilters(c: Caller) {
    return this.filtersConcern.readSharedFilters(c);
  }

  async writeSharedFilters(body: any, c: Caller) {
    return this.filtersConcern.writeSharedFilters(body, c);
  }

  async copySharedFilters(body: any, c: Caller) {
    return this.filtersConcern.copySharedFilters(body, c);
  }

  // ── audit (api/src/pacs/audit.ts) ──
  async audits(uid: string | undefined, take: number, c: Caller) {
    return this.auditConcern.audits(uid, take, c);
  }

  // ── metrics (api/src/pacs/metrics.ts) ──
  async adminMetrics(c: Caller) {
    return this.metricsConcern.adminMetrics(c);
  }

  // ── worklist (api/src/pacs/worklist.ts) ──
  async listStudies(c: Caller, query?: any) {
    return this.worklistConcern.listStudies(c, query);
  }

  async bootstrap(c: Caller, query?: any) {
    return this.worklistConcern.bootstrap(c, query);
  }

  // ── dicom-gateway (api/src/pacs/dicom-gateway.ts) ──
  async authzDicom(originalUri: string, originalMethod: string, c: Caller) {
    return this.dicomGatewayConcern.authzDicom(originalUri, originalMethod, c);
  }

  async announceStudy(studyUid: string, institutionNameTag: unknown, c: Caller) {
    return this.dicomGatewayConcern.announceStudy(studyUid, institutionNameTag, c);
  }

  async gatewayReceipt(body: unknown, c: Caller) {
    return this.dicomGatewayConcern.gatewayReceipt(body, c);
  }

  async requestGatewayRetry(uid: string, body: unknown, c: Caller) {
    return this.dicomGatewayConcern.requestGatewayRetry(uid, body, c);
  }

  async gatewayRetryRequests(query: unknown, c: Caller) {
    return this.dicomGatewayConcern.gatewayRetryRequests(query, c);
  }

  async dicomLookup(studyUid: string, sopUid: string, c: Caller) {
    return this.dicomGatewayConcern.dicomLookup(studyUid, sopUid, c);
  }

  // ── study-state (api/src/pacs/study-state.ts) ──
  async patchState(uid: string, body: any, c: Caller) {
    return this.studyStateConcern.patchState(uid, body, c);
  }

  async match(uid: string, oid: string, patient: any, c: Caller) {
    return this.studyStateConcern.match(uid, oid, patient, c);
  }

  async unmatch(uid: string, c: Caller) {
    return this.studyStateConcern.unmatch(uid, c);
  }

  async removeState(uid: string, c: Caller) {
    return this.studyStateConcern.removeState(uid, c);
  }

  // ── tech-note (api/src/pacs/tech-note.ts) ──
  async techNote(uid: string, c: Caller, before?: string) {
    return this.techNoteConcern.techNote(uid, c, before);
  }

  async saveTechNote(uid: string, body: any, c: Caller) {
    return this.techNoteConcern.saveTechNote(uid, body, c);
  }

  // ── hold (api/src/pacs/hold.ts) ──
  async hold(uid: string, c: Caller) {
    return this.holdConcern.hold(uid, c);
  }

  async release(uid: string, c: Caller) {
    return this.holdConcern.release(uid, c);
  }

  async forceRelease(uid: string, c: Caller) {
    return this.holdConcern.forceRelease(uid, c);
  }

  // ── clinician (api/src/pacs/clinician.ts) ──
  async clinicianStudies(c: Caller, query?: any) {
    return this.clinicianConcern.clinicianStudies(c, query);
  }

  async clinicianReportRead(uid: string, c: Caller) {
    return this.clinicianConcern.clinicianReportRead(uid, c);
  }

  async clinicianViewerHead(uid: string, c: Caller): Promise<number | null> {
    return this.clinicianConcern.clinicianViewerHead(uid, c);
  }

  async clinicianTimeline(uid: string, c: Caller, query?: any) {
    return this.clinicianConcern.clinicianTimeline(uid, c, query);
  }

  // ── report-evidence (api/src/pacs/report-evidence.ts) ──
  async versions(uid: string, c: Caller) {
    return this.reportEvidenceConcern.versions(uid, c);
  }

  async reportCitations(uid: string, c: Caller) {
    return this.reportEvidenceConcern.reportCitations(uid, c);
  }

  async reportStructure(uid: string, c: Caller) {
    return this.reportEvidenceConcern.reportStructure(uid, c);
  }

  async reportVersionCitations(uid: string, version: string, c: Caller) {
    return this.reportEvidenceConcern.reportVersionCitations(uid, version, c);
  }

  // ── report-draft (api/src/pacs/report-draft.ts) ──
  async readDraft(uid: string, c: Caller) {
    return this.reportDraftConcern.readDraft(uid, c);
  }

  async dictationGate(uid: string, c: Caller) {
    return this.reportDraftConcern.dictationGate(uid, c);
  }

  async dictationAudit(uid: string, c: Caller, detail: { bytes: number; seconds: number; ms: number; engine: string; outcome: string }) {
    return this.reportDraftConcern.dictationAudit(uid, c, detail);
  }

  async putReport(uid: string, body: any, c: Caller, session: string | null) {
    return this.reportDraftConcern.putReport(uid, body, c, session);
  }

  async discardDraft(uid: string, body: any, c: Caller, session: string | null) {
    return this.reportDraftConcern.discardDraft(uid, body, c, session);
  }

  async forceDiscardDrafts(uid: string, body: any, c: Caller, session: string | null) {
    return this.reportDraftConcern.forceDiscardDrafts(uid, body, c, session);
  }

  // ── report-commit (api/src/pacs/report-commit.ts) ──
  async commitReport(uid: string, body: any, c: Caller, session: string | null) {
    return this.reportCommitConcern.commitReport(uid, body, c, session);
  }
}

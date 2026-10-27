import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { OrthancService } from '../orthanc.service';
import { StudyAccessService } from '../study-access.service';
import { STUDY_IDENTITY_UNRESOLVED, STUDY_IDENTITY_UNRESOLVED_MESSAGE } from '../study-source-groups';
import { lockMemberRights } from '../member-rights';
import { PacsAccess, Caller } from '../pacs/access';
import { REQUEST_CONTEXT_SOURCE, RequestContextSource, RequestWorkContext } from '../emr-runtime/request-context';
import { EMR_RECORD_PORT, EmrRecordPort } from '../emr-runtime/record-port';
import { FileWrappingSecrets } from '../emr-signature/server-keys';
import type { RequestIdentityPort, RequestIdentity, WrappingSecrets } from '../emr-signature/server-contract';
import { EMR_NATIVE_REPORT_SIGNING } from '../emr-report/native-signing';
import { EMR_CLINICAL_ROUTES, ClinicalRouteSources } from './routes';
import { EMR_MANUAL_SR_SIGNING } from './manual-sr';
import { ClinicalStore } from './store';
import { createOnlineClinicalServices } from './services';
import { clinicalRouteSources } from './sources';
import type { ClinicalContextSource } from './runtime';
import { FindingService } from '../finding.service';
import { findingSources } from '../emr-source/finding';

const ONLINE_CLINICAL_SERVICES = Symbol('OnlineClinicalServices');
/** The composed C2 administrative facade (manage only): it has no decrypt or sign capability. */
export const EMR_SIGNING_KEY_ADMIN = Symbol('EmrSigningKeyAdmin');
export type SigningKeyAdmin = ReturnType<typeof createOnlineClinicalServices>['keys'];
const clinicalRole = (roles: readonly string[]) => roles.some(role => ['radiologist', 'clinician', 'technician'].includes(role));

/** Registration is the immutable member identity bound to current institutional
 * rights. Suspending or replacing a C2 key does not silently create another one. */
export function memberSigningRegistration(identityId: string): string { return 'member:' + identityId; }

export function onlineRequestIdentity(requests: RequestContextSource): RequestIdentityPort {
  const withContext = <T>(request: object, task: (context: RequestWorkContext) => Promise<T>): Promise<T> =>
    'requireCurrent' in request && typeof request.requireCurrent === 'function'
      ? task(request as RequestWorkContext) : requests.withWork(request as IncomingMessage, task);
  const resolve = (tx: Prisma.TransactionClient, request: object): Promise<RequestIdentity> =>
    withContext(request, async context => {
      await context.requireCurrent(tx);
      const f = context.facts;
      const canSign = clinicalRole(f.roles);
      return { online: true, capacity: canSign ? 'clinical' : 'operator',
        actor: { identity: f.actor, identityRegistrationId: memberSigningRegistration(f.actor.id), kind: 'member',
          roles: f.roles, institutionId: f.institution, canSign, canCancel: canSign,
          rightsVersion: String(f.rightsVersion), sessionState: 'active' },
        ingress: { requestId: f.requestId, ip: f.ingress } };
    });
  return { resolve,
    async authorizeKeyManagement(tx, request, institutionId) {
      const current = await resolve(tx, request);
      if (!current.actor.roles.includes('admin') || current.actor.institutionId !== institutionId)
        throw new ForbiddenException('소속 기관의 키 관리 권한이 필요합니다.');
      return { ...current, capacity: 'operator' };
    },
    async doctor(tx, institutionId, doctorId) {
      // The runtime login reads B2 identities only through its definer functions, never the table.
      const rows = await tx.$queryRaw<{ issuer: string; subject: string }[]>`
        SELECT issuer, subject FROM emr_access.member_identity_binding(${doctorId}::uuid)`;
      const identity = rows[0];
      if (!identity) throw new NotFoundException('회원 신원을 확인할 수 없습니다.');
      await lockMemberRights(tx, identity.subject);
      const member = await tx.memberRights.findUnique({ where: { sub: identity.subject } });
      if (!member?.approved || member.suspended || member.institution !== institutionId || !clinicalRole(member.roles))
        throw new ForbiddenException('현재 소속 기관의 임상 기록 권한을 확인할 수 없습니다.');
      return { identity: { id: doctorId, ...identity }, identityRegistrationId: memberSigningRegistration(doctorId), institutionId, canSign: true };
    } };
}

/** Deployment supplies the existing C2 file custody. Delay reading until use:
 * an unset signing secret must not prevent unrelated worklist reads at startup. */
export function configuredWrappingSecrets(env: NodeJS.ProcessEnv = process.env): WrappingSecrets {
  return { get currentId() { return env.KIN_EMR_WRAPPING_KEY_ID ?? ''; },
    async read(id) {
      if (!env.KIN_EMR_WRAPPING_KEY_FILES || !env.KIN_EMR_WRAPPING_KEY_ID)
        throw new ServiceUnavailableException({ code: 'WrappingSecretConfigurationPending', message: '서명키 보관 파일 설정을 확인하세요.' });
      return new FileWrappingSecrets(env.KIN_EMR_WRAPPING_KEY_ID, JSON.parse(env.KIN_EMR_WRAPPING_KEY_FILES)).read(id);
    } };
}

export const CURRENT_CLINICAL_CONTEXT = Symbol('CURRENT_CLINICAL_CONTEXT');

export function createCurrentClinicalContext(prisma: PrismaService, requests: RequestContextSource,
  orthanc: OrthancService, studyAccess: StudyAccessService): ClinicalContextSource {
  const identity = onlineRequestIdentity(requests);
  const access = new PacsAccess(prisma, studyAccess);
  const scope = async (tx: Prisma.TransactionClient, request: object, uid: string) => {
    const current = await identity.resolve(tx, request);
    const state = await tx.studyState.findUnique({ where: { uid } });
    if (!state || !access.visible(state, current.actor.institutionId)) throw new NotFoundException('검사가 없습니다.');
    const c: Caller = { sub: current.actor.identity.subject, actor: current.actor.identity.subject,
      institution: current.actor.institutionId, roles: [...current.actor.roles], kind: 'member' };
    await studyAccess.prepare(c, [uid]);
    await studyAccess.require(c, [uid], tx);
    return { studyId: uid, managingInstitutionId: state.institutionId, teleInstitutionId: state.teleInstitutionId };
  };
  const context: ClinicalContextSource = {
    async facts(tx, request) {
      const current = await identity.resolve(tx, request);
      return { actor: { identity: current.actor.identity, kind: current.actor.kind, roles: current.actor.roles,
        institutionId: current.actor.institutionId, signingRegistrationId: current.actor.canSign ? current.actor.identityRegistrationId : null },
        requestId: current.ingress.requestId, ip: current.ingress.ip };
    },
    scope,
    async study(tx, request, uid) {
      const current = await scope(tx, request, uid);
      // This snapshot binds the currently observed original patient to the
      // managing institution. It is not an A fixed-version/retention lookup.
      // WORKLIST-SPLIT-UID: a UID that two patient resources share has no
      // resolved patient; the product's own refusal answers, never an invented link.
      const resources = await orthanc.studyIdentityResources(uid);
      if (!resources.length) throw new NotFoundException('검사가 없습니다.');
      if (resources.length > 1) throw new ConflictException({ code: STUDY_IDENTITY_UNRESOLVED, message: STUDY_IDENTITY_UNRESOLVED_MESSAGE });
      const patientId = OrthancService.tag(resources[0], '00100020');
      if (!patientId.trim() || patientId.length > 64) throw new BadRequestException('원본 환자 식별을 확인할 수 없습니다');
      return { ...current, patient: { linkId: JSON.stringify([current.managingInstitutionId, patientId]),
        patientId, assigningAuthority: current.managingInstitutionId } };
    },
  };
  return context;
}

export function createStartupClinicalServices(prisma: PrismaService, records: EmrRecordPort,
  requests: RequestContextSource, orthanc: OrthancService, studyAccess: StudyAccessService,
  findings: FindingService) {
  const identity = onlineRequestIdentity(requests);
  const context = createCurrentClinicalContext(prisma, requests, orthanc, studyAccess);
  const sources = clinicalRouteSources(identity, records, findingSources(findings, identity));
  return createOnlineClinicalServices({ records, store: new ClinicalStore(prisma), identity,
    secrets: configuredWrappingSecrets(), context, sources: async (tx, request, write) => {
      const prepared = await sources(tx, request, write);
      if (write.surface !== 'tech-note.write') return prepared;
      // The acquisition context is this study, not a transport request ID that
      // changes when the same saved command is retried after a lost response.
      return { ...prepared, workContext: { kind: 'acquisition', studyId: write.studyId, referenceId: write.studyId } };
    },
    async project() { throw new Error('ClinicalRouteProjectorRequired'); } });
}

export const startupClinicalProviders = [
  { provide: CURRENT_CLINICAL_CONTEXT, inject: [PrismaService, REQUEST_CONTEXT_SOURCE, OrthancService, StudyAccessService],
    useFactory: createCurrentClinicalContext },
  { provide: ONLINE_CLINICAL_SERVICES,
    inject: [PrismaService, EMR_RECORD_PORT, REQUEST_CONTEXT_SOURCE, OrthancService, StudyAccessService, FindingService],
    useFactory: createStartupClinicalServices },
  { provide: EMR_CLINICAL_ROUTES, inject: [ONLINE_CLINICAL_SERVICES], useFactory: (services: ReturnType<typeof createOnlineClinicalServices>) => services.routes },
  { provide: EMR_MANUAL_SR_SIGNING, inject: [ONLINE_CLINICAL_SERVICES], useFactory: (services: ReturnType<typeof createOnlineClinicalServices>) => services.manualSrSigning },
  { provide: EMR_NATIVE_REPORT_SIGNING, inject: [ONLINE_CLINICAL_SERVICES], useFactory: (services: ReturnType<typeof createOnlineClinicalServices>) => services.nativeReportSigning },
  { provide: EMR_SIGNING_KEY_ADMIN, inject: [ONLINE_CLINICAL_SERVICES], useFactory: (services: ReturnType<typeof createOnlineClinicalServices>) => services.keys },
];

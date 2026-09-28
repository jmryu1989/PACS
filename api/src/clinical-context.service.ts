import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { OrthancService } from './orthanc.service';
import { StudyAccessService } from './study-access.service';
import type { AccessSnapshot } from './study-access.service';
import { PacsService } from './pacs.service';
import type { Caller } from './pacs.service';
import { viewerUid } from './viewer-input';
import {
  CLINICAL_CONTEXT_BUSY, CLINICAL_CONTEXT_CHANGED, CLINICAL_CONTEXT_INPUT_INVALID, CLINICAL_CONTEXT_ROLE,
  CONTEXT_HISTORY_LIMIT, CONTEXT_PRIOR_LIMIT, CONTEXT_REQUEST_TAG_CODES,
  clinicalContextAnswer, clinicalContextCallerRefusal, contextAccess, contextFirstInstance, contextHistoryItem,
  contextIdentity, contextIdentityKeys, contextOrder, contextOriginalSeries, contextOrthancStudy, contextPatientKey,
  contextPinnedUids, contextPins, contextPinsChanged, contextPriorItem, contextReadSection, contextRequestTags,
  contextSameKey, contextSection, contextSigned, contextStudySources, contextTechNoteItem,
} from './clinical-context-policy';
import type { ContextMember, ContextPins, ContextSourceStudy } from './clinical-context-policy';

/**
 * S7-U4a — Clinical Context 읽기(계약 S7-U4p §6.1 R1~R9). 무엇을 싣고 어떻게 판정하는지는 clinical-context-policy.ts의
 * 순수 함수가 정하고, 여기서는 읽는 순서·트랜잭션·재검증만 정한다.
 * REQ-S7-U4p-CONSISTENCY/READ-ONLY/READ-RULE -> RISK-S7-U4p-MEMBER-CHANGE/READ-WRITES, RISK-S7-U4a-TENANT/NONFINAL
 *   -> TEST-S7-U4a-SERVICE (tests/clinical_context_service_test.cjs), TEST-S7-U4a-LIVE (tests/clinical_context_live.py).
 *
 * 읽기 전용이다(R9): DB 쓰기·감사 행·StudyState 지연 등록·Orthanc 쓰기가 없다. 그래서 워크리스트 목록(listStudies)을 부르지
 * 않는다 — 그 경로는 처음 본 검사를 등록하고 감사한다. 오더 표와 StudyState의 Match 복사 칸은 고르지도 읽지도 않는다.
 */

const notFound = () => new NotFoundException('검사를 찾을 수 없습니다');
const changed = () => new ConflictException({ code: CLINICAL_CONTEXT_CHANGED,
  message: '읽는 사이 검사의 기관·원격판독·판독 상태·Tech Note가 바뀌었습니다. 다시 불러오세요' });
// study-access.service.ts가 R3·R7(b)에서 내는 것과 같은 답이다. R6에서는 트랜잭션 안에서 읽은 정책을 비교하므로 여기서 만든다.
const accessChanged = () => new ConflictException({ code: 'STUDY_ACCESS_CHANGED', message: '검사 접근 조건이 변경되었습니다. 다시 불러온 뒤 확인하세요' });

/** DB가 지금 답하지 못한 경우(lock_timeout·트랜잭션 시간 초과·교착). study-access.service.ts write()와 같은 목록이다. */
const dbBusy = (error: any) => ['P2024', 'P2028', 'P2034'].includes(error?.code)
  || error?.code === 'P2010' && ['55P03', '57014', '40P01'].includes(error?.meta?.code);

/**
 * 그 경우만 503 CLINICAL_CONTEXT_BUSY다(§9.4). R6 안의 StudyAccess 정책 잠금·조회는 자기 503을 내고 원래 오류를 cause로만
 * 넘기므로 그 cause도 본다. 정책 행 형식 오류 같은 다른 StudyAccess 실패는 원래 503 그대로 나간다. DB 오류 원문은 싣지 않는다.
 */
function busyOr(error: any): never {
  if (dbBusy(error) || error instanceof ServiceUnavailableException && dbBusy(error.cause))
    throw new ServiceUnavailableException({ code: CLINICAL_CONTEXT_BUSY, message: '검사 처리 중입니다. 잠시 후 다시 시도하세요' });
  throw error;
}

const now = () => new Date().toISOString();

/** QIDO 한 행을 원본 DICOM 값으로 읽는다. 워크리스트 행과 같은 태그·같은 읽기(OrthancService.tag, ModalitiesInStudy 쉼표 연결)다. */
function sourceStudy(row: any): ContextSourceStudy {
  const tag = (key: string) => OrthancService.tag(row, key);
  const modalities = row?.['00080061']?.Value;
  return { uid: tag('0020000D'), patientId: tag('00100020'), birth: tag('00100030'), sex: tag('00100040'),
    date: tag('00080020'), modalities: Array.isArray(modalities) ? modalities.join(',') : '',
    description: tag('00081030'), accession: tag('00080050'), row };
}

type StudiesRead =
  | { kind: 'read'; anchor: ContextSourceStudy; candidates: ContextSourceStudy[] }
  | { kind: 'failed'; reason: string; at: string };

@Injectable()
export class ClinicalContextService {
  constructor(private prisma: PrismaService, private orthanc: OrthancService, private studyAccess: StudyAccessService,
    private pacs: PacsService) {}

  async read(uid: string, query: any, c: Caller) {
    // R1 입력: path UID 하나. query 키는 하나도 받지 않는다 — 조건을 받는 읽기가 아니다.
    const input = () => new BadRequestException({ code: CLINICAL_CONTEXT_INPUT_INVALID, message: '검사 UID를 확인하세요. 이 조회는 다른 조건을 받지 않습니다' });
    try { viewerUid(uid); } catch { throw input(); }
    if (query != null && (typeof query !== 'object' || Object.keys(query).length > 0)) throw input();

    // R2 호출자(R-CTX-ANCHOR (1)(2)(4)). clinician-only는 guard와 controller가 이미 CLINICIAN_ROUTE_DENIED로 끝냈다.
    const refusal = clinicalContextCallerRefusal(c);
    if (refusal === 'member') throw new ForbiddenException('회원 전용입니다');
    if (refusal === 'institution') throw new ForbiddenException('소속 기관이 없는 계정입니다. Keycloak에서 이 사용자를 기관 그룹에 넣어주세요.');
    if (refusal === 'role') throw new ForbiddenException({ code: CLINICAL_CONTEXT_ROLE, message: 'Clinical Context는 판독의·관리자만 볼 수 있습니다' });
    const me = c.institution as string;

    // R3 접근 고정(V-ACCESS). 원본 태그 규칙이 있으면 기준의 원본 메타데이터를 어떤 트랜잭션보다 먼저 준비한다.
    const access = await this.studyAccess.snapshot(c);
    await this.studyAccess.prepare(c, [uid], access);

    // R4 기준 입장(V-P0). 없는 검사·다른 기관·닫힌 tele·StudyAccess 제외는 같은 404 한 가지다 — 존재 여부도 정보다.
    const entry = await this.prisma.studyState.findUnique({ where: { uid }, select: { institutionId: true, teleInstitutionId: true } });
    if (!contextAccess(entry, me)) throw notFound();
    await this.studyAccess.require(c, [uid]);
    const entered = { institutionId: entry.institutionId ?? null, teleInstitutionId: entry.teleInstitutionId ?? null };

    // R5 Orthanc: 어떤 DB 트랜잭션도 열지 않은 상태에서 읽는다. 원본 열거와 요청 태그 헤더는 서로 독립이고 실패는 구역에만 남는다.
    const [studies, requestTags] = await Promise.all([this.readStudies(uid), this.readRequestTags(uid)]);

    // R6 DB 한 번(RepeatableRead). 여기서 읽은 값이 §6.2 고정값이다.
    const read = await this.snapshot(uid, c, access, entered, studies).catch(busyOr);

    // R7(a) 트랜잭션 밖 SQL 문장 하나로 고정값을 다시 읽는다. StudyAccess revision은 검사별 변경으로 오르지 않는다(F-54).
    const rows = await this.recheck(uid, contextPinnedUids(read.pins)).catch(busyOr);
    if (contextPinsChanged(read.pins, rows)) throw changed();
    // R7(b) 이어서 접근 정책(목록과 같은 순서). 이 성공 시각이 답의 observedAt이다. 그 전에는 답을 조립하지 않는다.
    await this.studyAccess.unchanged(c, access);
    const observedAt = now();

    // R8 조립.
    const institutionName = this.pacs.institutionName(read.anchor.institutionId);
    const anchorKeys = studies.kind === 'read' ? contextIdentityKeys(studies.anchor) : { birth: '', sex: '' };
    let priorReports: any, history: any;
    if (studies.kind === 'failed') {
      // 구성원은 원본 PatientID로만 정할 수 있으므로 원본 행·열거가 실패하면 두 구역이 함께 실패한다(§7.1).
      priorReports = contextSection('priorReports', 'failed', studies.reason, studies.at);
      history = contextSection('history', 'failed', studies.reason, studies.at);
    } else if (read.patientKey === null) {
      // K-5: 다른 검사를 찾지 않았다. "없음"이 아니다.
      priorReports = contextSection('priorReports', 'not_configured', 'no_patient_key', null);
      history = contextSection('history', 'not_configured', 'no_patient_key', null);
    } else {
      const bodies = new Map<number, any>(read.bodies.map((body: any) => [body.id, body]));
      history = contextReadSection('history', read.members.slice(0, CONTEXT_HISTORY_LIMIT)
        .map(member => contextHistoryItem(member, institutionName, anchorKeys, read.readAt)), read.readAt, read.members.length > CONTEXT_HISTORY_LIMIT);
      priorReports = contextReadSection('priorReports', read.shown
        .map(member => contextPriorItem(member, bodies.get(member.head.id), anchorKeys, read.readAt)), read.readAt, read.signed > CONTEXT_PRIOR_LIMIT);
    }
    const techNote = contextReadSection('techNote', read.note ? [contextTechNoteItem(uid, read.note, read.readAt)] : [], read.readAt);
    return clinicalContextAnswer({
      uid, observedAt, patientKey: read.patientKey,
      anchor: { access: read.access, institutionName, techNoteVersion: read.note?.version ?? 0 },
      identity: contextIdentity(studies.kind === 'read' ? [anchorKeys, ...read.members.map(member => contextIdentityKeys(member.source))] : []),
      sections: { priorReports, history, requestTags, techNote },
    });
  }

  /** R5 (a)(b): 원본 열거 한 번(워크리스트와 같은 QIDO)에서 기준 행과 같은 PatientID의 후보를 가른다. 실패는 던지지 않고 돌려준다. */
  private async readStudies(uid: string): Promise<StudiesRead> {
    let rows: any;
    try { rows = await this.orthanc.studies(); } catch { return { kind: 'failed', reason: 'source_unavailable', at: now() }; }
    const at = now();
    if (!Array.isArray(rows)) return { kind: 'failed', reason: 'source_invalid', at };
    const sources = contextStudySources(rows.map(sourceStudy), uid);
    if (sources.kind === 'missing') return { kind: 'failed', reason: 'source_row_missing', at };
    if (sources.kind === 'invalid') return { kind: 'failed', reason: 'source_invalid', at };
    return sources;
  }

  /** R5 (c): 원본 영상 인스턴스 한 개의 헤더(§5.4 다섯 경우). 실패는 이 구역에만 남는다. */
  private async readRequestTags(uid: string) {
    const failed = (reason: string, at = now()) => contextSection('requestTags', 'failed', reason, at);
    let found: any, series: any, instances: any, header: any;
    try { found = await this.orthanc.contextLookup(uid); } catch { return failed('source_unavailable'); }
    const study = contextOrthancStudy(found);
    if (study.kind === 'missing') return failed('source_row_missing');
    if (study.kind === 'invalid') return failed('source_invalid');
    try { series = await this.orthanc.contextSeries(study.id); } catch { return failed('source_unavailable'); }
    const listedAt = now();
    const chosen = contextOriginalSeries(series);
    if (chosen.kind === 'invalid') return failed('source_invalid', listedAt);
    if (chosen.kind === 'none') return contextSection('requestTags', 'not_configured', 'no_original_instance', listedAt);
    try { instances = await this.orthanc.contextInstances(chosen.id); } catch { return failed('source_unavailable'); }
    const instance = contextFirstInstance(instances);
    if (!instance) return failed('source_invalid');
    try { header = await this.orthanc.contextHeader(instance.id, CONTEXT_REQUEST_TAG_CODES); } catch { return failed('source_unavailable'); }
    const readAt = now();
    const tags = contextRequestTags(header, instance.sop, readAt);
    return tags.state === 'failed' ? failed(tags.reason, readAt) : contextReadSection('requestTags', tags.items, readAt);
  }

  /**
   * R6: 트랜잭션 하나에서 정책(공유 잠금) → 기준과 후보의 StudyState → 기준 재입장 → 구성원 거르기(K-2 + visible + matches)
   * → Report.version → 머리 판 행 → 기준의 최신 Tech Note 메타 순서로 읽는다. 쓰기는 없다. 본문은 서명 확정이면서 보일
   * 몫(상한 안)인 머리 판에서만 읽는다 — 서명 전 본문(P·T 포함)은 이 요청이 메모리로도 가져오지 않는다.
   */
  private snapshot(uid: string, c: Caller, access: AccessSnapshot,
    entered: { institutionId: string | null; teleInstitutionId: string | null }, studies: StudiesRead) {
    const me = c.institution as string;
    const candidates = studies.kind === 'read' ? studies.candidates : [];
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      // V-ACCESS: 같은 정책 스냅샷이어야 R3에서 고정한 규칙으로 구성원을 거를 수 있다(study-access.service.ts의 digest와 같은 비교).
      if (JSON.stringify(await this.studyAccess.snapshot(c, tx)) !== JSON.stringify(access)) throw accessChanged();
      const states = await tx.studyState.findMany({ where: { uid: { in: [uid, ...candidates.map(source => source.uid)] } },
        select: { uid: true, institutionId: true, teleInstitutionId: true, rs: true, preDoc: true, preReviewer: true, createdAt: true } });
      const stateOf = new Map<string, any>(states.map(state => [state.uid, state]));
      const anchor = stateOf.get(uid);
      const anchorAccess = contextAccess(anchor, me);
      if (!anchorAccess) throw notFound();
      if ((anchor.institutionId ?? null) !== entered.institutionId || (anchor.teleInstitutionId ?? null) !== entered.teleInstitutionId) throw changed();
      await this.studyAccess.require(c, [uid], tx);

      const patientKey = studies.kind === 'read' ? contextPatientKey(anchor.institutionId, studies.anchor.patientId) : null;
      // StudyState가 없는 후보(Orthanc에만 있고 KIN 미등록)는 보이지 않는 것으로 뺀다. 이 읽기는 등록하지 않는다.
      const keyed = candidates.filter(source => stateOf.has(source.uid))
        .map(source => ({ ...source, sourcePatientKey: contextPatientKey(stateOf.get(source.uid).institutionId, source.patientId) }));
      const visible = contextSameKey(uid, patientKey, keyed)
        .map(source => ({ source, state: stateOf.get(source.uid), access: contextAccess(stateOf.get(source.uid), me) }))
        .filter(member => member.access !== null && this.studyAccess.matches(access, member.source.uid, member.source.row));
      const memberUids = visible.map(member => member.source.uid);
      const reports = memberUids.length ? await tx.report.findMany({ where: { uid: { in: memberUids } }, select: { uid: true, version: true } }) : [];
      const versionOf = new Map<string, number>(reports.map(report => [report.uid, report.version]));
      const pairs = memberUids.filter(member => (versionOf.get(member) ?? 0) > 0).map(member => ({ uid: member, version: versionOf.get(member) }));
      const heads = pairs.length ? await tx.reportVersion.findMany({ where: { OR: pairs },
        select: { id: true, uid: true, version: true, action: true, author: true, at: true } }) : [];
      const headOf = new Map<string, any>(heads.map(head => [head.uid, head]));
      const members: ContextMember[] = visible.map(member => ({ ...member, reportVersion: versionOf.get(member.source.uid) ?? 0,
        head: headOf.get(member.source.uid)?.version === versionOf.get(member.source.uid) ? headOf.get(member.source.uid) : null }));
      members.sort((a, b) => contextOrder(a.source, b.source));
      const signed = members.filter(contextSigned);
      const shown = signed.slice(0, CONTEXT_PRIOR_LIMIT);
      const bodies = shown.length ? await tx.reportVersion.findMany({ where: { id: { in: shown.map(member => member.head.id) } },
        select: { id: true, findings: true, conclusion: true, recommendation: true } }) : [];
      const note = await tx.techNoteRevision.findFirst({ where: { studyUid: uid }, orderBy: { version: 'desc' },
        select: { version: true, text: true, author: true, createdAt: true } });
      const readAt = now();
      const pins: ContextPins = contextPins(anchor, note?.version ?? 0, members);
      return { anchor, access: anchorAccess, patientKey, members, signed: signed.length, shown, bodies, note, readAt, pins };
    }, { isolationLevel: 'RepeatableRead', maxWait: 2000, timeout: 5000 });
  }

  /**
   * R7(a): 기준과 기여 구성원 전부의 기관·tele·RS·P 짝·머리 판 번호와 기준의 최신 Tech Note 판을 **한 문장**(한 시점)으로 읽는다.
   * 잠금을 걸지 않는다 — 모든 변경 경로가 같은 잠금에 참여함을 증명하는 대신 확정 시점의 번호를 비교한다(§6.2).
   */
  private recheck(uid: string, uids: string[]) {
    return this.prisma.$queryRaw<any[]>`
      SELECT s.uid, s."institutionId", s."teleInstitutionId", s.rs, s."preDoc", s."preReviewer",
        COALESCE(r.version, 0) AS "reportVersion",
        (SELECT COALESCE(MAX(n.version), 0) FROM "TechNoteRevision" n WHERE n."studyUid" = ${uid}) AS "techNoteVersion"
      FROM "StudyState" s LEFT JOIN "Report" r ON r.uid = s.uid
      WHERE s.uid IN (${Prisma.join(uids)})`;
  }
}

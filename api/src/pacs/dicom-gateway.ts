/*
 * DICOMweb 경로의 기관 관문, SOP lookup, Gateway의 수신 예고·전송 영수증·Now Retry 요청과 그 목록.
 * PacsService가 만들어 소유하는 평범한 객체다(Nest provider가 아니다). 생성자는 참조만 저장한다.
 */
import type { StudyAccessService } from '../study-access.service';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { PrismaService } from '../prisma.service';
import type { OrthancService } from '../orthanc.service';
import { clinicianOnly } from '../clinician-policy';
import { decideGatewayReceipt, GATEWAY_EPOCH_INCIDENT_WINDOW_MS, GatewayReceiptInputError, parseGatewayReceipt,
  storedGatewayReceipt } from '../gateway-receipt';
import type { GatewayReceipt, GatewayReceiptDecision } from '../gateway-receipt';
import { decideGatewayRetryRequest, GATEWAY_RETRY_BUSY, GATEWAY_RETRY_INVALID, GATEWAY_RETRY_NOT_RETRY,
  GATEWAY_RETRY_POLL_INVALID, GATEWAY_RETRY_UNSUPPORTED_F01, GatewayRetryInputError, parseGatewayRetryPoll,
  parseGatewayRetryRequestBody } from '../gateway-retry';
import { dump } from './values';
import { need, needExact, inst } from './access';
import type { Caller, PacsAccess } from './access';
import type { PacsInstitutions } from './institutions';

export class PacsDicomGateway {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orthanc: OrthancService,
    private readonly studyAccess: StudyAccessService,
    private readonly access: PacsAccess,
    private readonly institutions: PacsInstitutions) {}

  /**
   * DICOMweb 경로의 기관 관문. 워크리스트가 지키는 경계(visible)를 영상 경로에도 세운다.
   * auth_request 제약상 거부는 전부 403이다 — 404를 던지면 nginx가 500으로 바꾼다.
   */
  async authzDicom(originalUri: string, originalMethod: string, c: Caller) {
    const me = inst(c);
    const [path, query = ''] = originalUri.split('?');
    const method = originalMethod.toUpperCase();

    // Gateway가 여는 유일한 DICOMweb 면: announce로 소유권을 먼저 고정한 지정형 STOW.
    if (method === 'POST') {
      needExact(c, 'gateway', 'DICOM 수신');
      const m = /^\/dicom-web\/studies\/([0-9.]+)$/.exec(path);
      if (!m) throw new ForbiddenException('지정형 STOW만 허용됩니다');
      const s = await this.prisma.studyState.findUnique({ where: { uid: m[1] } });
      if (!s || s.institutionId !== me)
        throw new ForbiddenException('announce되지 않은 검사입니다');
      return;
    }
    if (!['GET', 'HEAD'].includes(method))
      throw new ForbiddenException('허용되지 않는 DICOMweb 메서드입니다');
    if (c.kind === 'gateway')
      throw new ForbiddenException('게이트웨이는 영상을 조회할 수 없습니다');

    // 서버 정보는 관리자만. 프론트 사용처 없음 — 버전 정보는 표면 축소가 이득이다.
    if (path === '/system') { need(c.roles, 'admin', '서버 정보 조회'); return; }
    // 로그인만으로 충분한 경로 — PHI 없음
    if (path === '/statistics') {
      // 서버 전체의 검사 수다. clinician-only에게는 자기 범위 밖 검사가 몇 건 있는지 세어 주는 창이라
      // 닫는다(S5-U1b COUNT-LEAK). 임상의 목록의 total은 볼 수 있는 검사만 센다.
      if (clinicianOnly(c.roles)) throw new ForbiddenException('전체 검사 통계를 열람할 수 없습니다');
      if((await this.studyAccess.snapshot(c)).policy.restricted)throw new ForbiddenException('전체 검사 통계를 열람할 수 없습니다');
      return;
    }

    // /dicom-web/studies/{uid}/... — 경로의 UID로 관문
    let m = /^\/dicom-web\/studies\/([0-9.]+)(?:\/|$)/.exec(path);
    let uid = m?.[1];

    // /dicom-web/studies?StudyInstanceUID=... — 쿼리의 UID로 관문 (OHIF 초기 조회)
    if (!uid && path === '/dicom-web/studies') {
      const q = new URLSearchParams(query);
      if(q.getAll('StudyInstanceUID').length+q.getAll('0020000D').length!==1)
        throw new ForbiddenException('검사 UID를 하나만 지정하세요');
      uid = q.get('StudyInstanceUID') ?? q.get('0020000D') ?? undefined;
      // UID 없는 전체 열거는 이 관문이 막으려는 바로 그것이다. 목록은 /api/studies가 기관을 걸러 준다.
      if (!uid) throw new ForbiddenException('전체 목록은 워크리스트 API를 사용하세요');
    }

    // /instances/{orthancId}/... — Orthanc에 물어 StudyInstanceUID로 환원
    if (!uid) {
      const im = /^\/instances\/([0-9a-f-]+)(?:\/|$)/.exec(path);
      if (im) {
        try { uid = await this.orthanc.instanceStudyUid(im[1]); }   // 불변이라 캐시됨
        catch {
          // 존재 여부도 정보다. Orthanc 장애도 403이 되지만, 503은 auth_request가 500으로 바꾸므로 수용한다.
          throw new ForbiddenException('열람 권한이 없습니다');
        }
      }
    }

    if (!uid) throw new ForbiddenException('허용되지 않는 경로입니다');
    const s = await this.prisma.studyState.findUnique({ where: { uid } });
    // 미등록(기관 미확정) 검사는 기본 거부 — 워크리스트를 한 번 열면 lazy 등록이 기관을 박는다.
    if (!s || !this.access.visible(s, me)) throw new ForbiddenException('열람 권한이 없습니다');
    try{await this.studyAccess.require(c,[uid]);}catch(e){throw new ForbiddenException('열람 권한이 없습니다');}
  }

  /**
   * Gateway 수신 예고. DICOM 태그는 참고 신호일 뿐이고 소유 기관은 서명된 자격증명으로 정한다.
   * 같은 기관의 재시도는 쓰기와 감사를 모두 생략한다.
   */
  async announceStudy(studyUid: string, institutionNameTag: unknown, c: Caller) {
    needExact(c, 'gateway', '검사 수신 예고');
    const me = inst(c);
    if (typeof studyUid !== 'string' || !/^[0-9.]+$/.test(studyUid))
      throw new BadRequestException('올바른 studyUid가 필요합니다');
    if (institutionNameTag != null && typeof institutionNameTag !== 'string')
      throw new BadRequestException('institutionNameTag는 문자열이어야 합니다');

    const existing = await this.prisma.studyState.findUnique({ where: { uid: studyUid } });
    if (existing) {
      if (existing.institutionId !== me)
        throw new ConflictException({ code: 'STUDY_OWNERSHIP_CONFLICT' });
      return { studyUid, institutionId: me, origin: existing.origin };
    }

    const resolvedTag = this.institutions.resolveInstitution(typeof institutionNameTag === 'string' ? institutionNameTag : '');
    const tagMismatch = resolvedTag != null && resolvedTag !== me;
    try {
      const saved = await this.prisma.$transaction(async tx => {
        const created = await tx.studyState.create({ data: {
          uid: studyUid,
          institutionId: me,
          reqHosp: this.institutions.instName(me),
          ss: 'Unverified',
          origin: 'gateway',
        } });
        await tx.auditLog.create({ data: {
          actor: c.actor || 'unknown',
          action: 'study.announce',
          target: studyUid,
          detail: dump({ institutionId: me, ...(tagMismatch ? { tagMismatch: true } : {}) }),
        } });
        return created;
      });
      return { studyUid, institutionId: me, origin: saved.origin };
    } catch (error: any) {
      // 동시 재시도는 unique 경쟁에서 진 쪽도 같은 기관이면 멱등 성공이다.
      if (error?.code !== 'P2002') throw error;
      const winner = await this.prisma.studyState.findUnique({ where: { uid: studyUid } });
      if (!winner || winner.institutionId !== me)
        throw new ConflictException({ code: 'STUDY_OWNERSHIP_CONFLICT' });
      return { studyUid, institutionId: me, origin: winner.origin };
    }
  }

  /**
   * S4-U3 Gateway 전송 영수증(`gateway-receipt.ts`).
   *
   * 자기 기관 StudyState가 없는 UID는 없든 남의 것이든 **같은 404 하나**다. 그 판정이 순서·epoch
   * 비교보다 먼저 온다 — 남의 검사에 409가 나가면 그 검사가 있다는 사실이 샌다. announce의 소유권 409는
   * 쓰지 않는다. 409는 순서·본문 충돌과 모르는 epoch에만 쓴다.
   *
   * 한 검사의 영수증 처리는 advisory lock으로 줄 세운다. 그래서 최초 저장과 epoch 사건 감사의 속도
   * 제한이 경쟁에서도 한 건이고, 속도 제한 때문에 저장된 영수증 행을 건드리지 않는다.
   */
  async gatewayReceipt(body: unknown, c: Caller) {
    needExact(c, 'gateway', '전송 영수증');
    const me = inst(c);
    let receipt: GatewayReceipt;
    try { receipt = parseGatewayReceipt(body); }
    catch (error) {
      if (error instanceof GatewayReceiptInputError)
        throw new BadRequestException({ code: 'GATEWAY_RECEIPT_INVALID', field: error.message });
      throw error;
    }
    const uid = receipt.studyUid;
    const outcome: GatewayReceiptDecision | { kind: 'absent' } = await this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${'kin.gateway-receipt:' + uid}, 0))`;
      const study = await tx.studyState.findUnique({ where: { uid }, select: { institutionId: true } });
      if (!study || study.institutionId !== me) return { kind: 'absent' as const };
      const row = await tx.gatewayReceipt.findUnique({ where: { studyUid: uid } });
      // 다른 기관 자격증명이 남긴 행은 이 epoch의 것이 아니다. 덮어쓰지 않는다.
      const decision: GatewayReceiptDecision = row && row.institutionId !== me ? { kind: 'epoch' }
        : decideGatewayReceipt(row ? storedGatewayReceipt(row) : null, receipt);
      const fields = { epoch: receipt.epoch, seq: receipt.seq, phase: receipt.phase, attempt: receipt.attempt,
        successCount: receipt.successCount, localCount: receipt.localCount, errorCode: receipt.errorCode,
        receivedAt: new Date() };
      const audit = (action: string, detail: any) =>
        tx.auditLog.create({ data: { actor: c.actor || 'unknown', action, target: uid, detail: dump(detail) } });
      if (decision.kind === 'first') {
        await tx.gatewayReceipt.create({ data: { studyUid: uid, institutionId: me, ...fields } });
        await audit('gateway.receipt.first', { epoch: receipt.epoch, seq: receipt.seq, phase: receipt.phase });
      } else if (decision.kind === 'advance') {
        await tx.gatewayReceipt.update({ where: { studyUid: uid }, data: fields });
        if (decision.transition)
          await audit('gateway.receipt.transition', { epoch: receipt.epoch, seq: receipt.seq, from: row.phase, phase: receipt.phase });
      } else if (decision.kind === 'epoch') {
        const since = new Date(Date.now() - GATEWAY_EPOCH_INCIDENT_WINDOW_MS);
        const recent = await tx.auditLog.findFirst({
          where: { action: 'gateway.receipt.epoch_unrecognised', target: uid, at: { gte: since } }, select: { id: true } });
        if (!recent) await audit('gateway.receipt.epoch_unrecognised', { registeredEpoch: row.epoch, offeredEpoch: receipt.epoch });
      }
      return decision;
    }, { isolationLevel: 'ReadCommitted', maxWait: 4000, timeout: 8000 }).catch((error: any) => {
      if (error?.code === 'P2028' || error?.code === 'P2010' && ['55P03', '57014'].includes(error?.meta?.code))
        throw new ServiceUnavailableException({ code: 'GATEWAY_RECEIPT_BUSY' });
      throw error;
    });
    if (outcome.kind === 'absent') throw new NotFoundException({ code: 'GATEWAY_RECEIPT_STUDY_NOT_FOUND' });
    if (outcome.kind === 'conflict') throw new ConflictException({ code: 'GATEWAY_RECEIPT_CONFLICT' });
    if (outcome.kind === 'epoch') throw new ConflictException({ code: 'GATEWAY_EPOCH_UNRECOGNISED' });
    return { studyUid: uid, result: outcome.kind === 'first' || outcome.kind === 'advance' ? 'stored' : outcome.kind };
  }

  /**
   * S4-U4 Now Retry 요청(`gateway-retry.ts`). 사람은 요청을 남길 뿐이다 — 병원으로 밀지 않고, 재시도가
   * 돌았다고 말하지 않는다. 응답 `requested`는 "저장됨"이다.
   *
   * 없는·남의·원격판독으로 받은·접근 조건 밖 검사는 모두 `gate()`와 같은 404 한 가지다(존재 여부도 정보다).
   * 요청은 U3 영수증과 **같은 advisory lock** 안에서 지금 저장된 `retry` 영수증의 (epoch, seq)에 묶인다.
   * 같은 묶음의 두 번째 요청은 쓰기·감사 없이 처음 시각을 돌려준다. 영수증·StudyState·Orthanc는 쓰지 않는다.
   */
  async requestGatewayRetry(uid: string, body: unknown, c: Caller) {
    need(c.roles, 'technician', 'Gateway 재시도 요청');
    if (c.kind !== 'member') throw new ForbiddenException('회원 전용입니다');
    const me = inst(c);
    try { parseGatewayRetryRequestBody(body); }
    catch (error) {
      if (error instanceof GatewayRetryInputError) throw new BadRequestException({ code: GATEWAY_RETRY_INVALID });
      throw error;
    }
    const s = await this.access.gate(uid, c);
    // gate()는 원격판독을 받은 기관에도 검사를 보여 준다. 요청은 소유(촬영) 기관만 하고, 받은 쪽에는 같은 404다.
    if (!s || s.institutionId !== me) throw new NotFoundException('검사를 찾을 수 없습니다');
    await this.studyAccess.prepare(c, [uid]);
    type Outcome = { kind: 'absent' | 'not_retry' | 'unsupported_f01' }
      | { kind: 'requested' | 'already_requested'; requestedAt: Date };
    const outcome: Outcome = await this.prisma.$transaction(async (tx): Promise<Outcome> => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      // U3 영수증과 같은 키: 한 검사의 요청과 영수증 갱신은 줄을 서므로, 묶은 (epoch, seq)는 커밋 순간의 저장값이다.
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${'kin.gateway-receipt:' + uid}, 0))`;
      await this.studyAccess.require(c, [uid], tx);
      const study = await tx.studyState.findUnique({ where: { uid }, select: { institutionId: true } });
      if (!study || study.institutionId !== me) return { kind: 'absent' };
      const receipt = await tx.gatewayReceipt.findFirst({ where: { studyUid: uid, institutionId: me } });
      const decision = decideGatewayRetryRequest(receipt);
      if (decision !== 'eligible') return { kind: decision };
      const key = { studyUid: uid, epoch: receipt!.epoch, seq: receipt!.seq };
      const existing = await tx.gatewayRetryRequest.findUnique({ where: { studyUid_epoch_seq: key } });
      if (existing) return { kind: 'already_requested', requestedAt: existing.requestedAt };
      const requestedAt = new Date();
      await tx.gatewayRetryRequest.create({ data: { ...key, requestedAt } });
      await tx.auditLog.create({ data: { actor: c.actor || 'unknown', action: 'gateway.retry.request', target: uid,
        detail: dump({ epoch: key.epoch, seq: Number(key.seq) }) } });
      return { kind: 'requested', requestedAt };
    }, { isolationLevel: 'ReadCommitted', maxWait: 4000, timeout: 8000 }).catch((error: any) => {
      if (error?.code === 'P2028' || error?.code === 'P2010' && ['55P03', '57014'].includes(error?.meta?.code))
        throw new ServiceUnavailableException({ code: GATEWAY_RETRY_BUSY });
      throw error;
    });
    if (outcome.kind === 'requested' || outcome.kind === 'already_requested')
      return { studyUid: uid, result: outcome.kind, requestedAt: outcome.requestedAt.toISOString() };
    if (outcome.kind === 'unsupported_f01') throw new ConflictException({ code: GATEWAY_RETRY_UNSUPPORTED_F01 });
    if (outcome.kind === 'not_retry') throw new ConflictException({ code: GATEWAY_RETRY_NOT_RETRY });
    throw new NotFoundException('검사를 찾을 수 없습니다');
  }

  /**
   * S4-U4 Gateway가 가져가는 Now Retry 목록. 읽기만 한다 — 쓰기·감사가 없다. 답은 이 자격증명 기관의
   * studyUid뿐이고 개수·시각·epoch·다른 기관의 것은 싣지 않는다. 대기 판정은 SQL 한 문장에서 LIMIT 전에
   * 끝난다: 요청의 (epoch, seq)가 지금 저장된 영수증과 같고, 그 영수증이 `retry`이며, 영수증과 StudyState가
   * 모두 이 기관 것이다. 다른 epoch의 조회는 오류 없이 빈 목록이다(H-1: 여기서는 epoch을 만들거나 바꾸지 않는다).
   */
  async gatewayRetryRequests(query: unknown, c: Caller) {
    needExact(c, 'gateway', 'Gateway 재시도 요청 조회');
    const me = inst(c);
    let epoch: string;
    try { epoch = parseGatewayRetryPoll(query); }
    catch (error) {
      if (error instanceof GatewayRetryInputError) throw new BadRequestException({ code: GATEWAY_RETRY_POLL_INVALID });
      throw error;
    }
    // LIMIT은 gateway-retry.ts GATEWAY_RETRY_POLL_LIMIT(100)이다. 검사당 대기 요청은 저장 영수증 하나에 묶여 최대 한 건이다.
    const rows: { studyUid: string }[] = await this.prisma.$queryRaw`SELECT q."studyUid" FROM "GatewayRetryRequest" q
      JOIN "GatewayReceipt" r ON r."studyUid" = q."studyUid" AND r.epoch = q.epoch AND r.seq = q.seq
      JOIN "StudyState" s ON s.uid = q."studyUid"
      WHERE q.epoch = ${epoch}::uuid AND r.phase = 'retry' AND r."institutionId" = ${me} AND s."institutionId" = ${me}
      ORDER BY q."requestedAt", q."studyUid" LIMIT 100`;
    return { studyUids: rows.map(row => row.studyUid) };
  }

  /** SOP lookup도 요청 Study의 기관 관문 안에서만 Orthanc ID를 내보낸다. */
  async dicomLookup(studyUid: string, sopUid: string, c: Caller) {
    const me = inst(c);
    if (!/^[0-9.]+$/.test(studyUid ?? '') || !/^[0-9.]+$/.test(sopUid ?? ''))
      throw new BadRequestException('studyUid와 sopUid가 필요합니다');

    const found = await this.orthanc.lookupInstance(sopUid);
    const instances = found.filter((item: any) => item?.Type === 'Instance' && /^[0-9a-f-]+$/.test(item?.ID ?? ''));
    if (instances.length !== 1) throw new ForbiddenException('열람 권한이 없습니다');

    let actualUid: string;
    try { actualUid = await this.orthanc.instanceStudyUid(instances[0].ID); }
    catch { throw new ForbiddenException('열람 권한이 없습니다'); }
    if (actualUid !== studyUid) throw new ForbiddenException('열람 권한이 없습니다');

    const study = await this.prisma.studyState.findUnique({ where: { uid: actualUid } });
    if (!study || !this.access.visible(study, me)) throw new ForbiddenException('열람 권한이 없습니다');
    await this.studyAccess.require(c,[actualUid]);
    return { id: instances[0].ID };
  }
}

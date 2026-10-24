/*
 * 내 판독문 초안의 저장·비우기·버리기·관리자 강제 해제, 초안 권위 읽기, 받아쓰기 관문. 초안을 바꾸는 길은 모두
 * draftTransaction 하나를 지난다(세션 → 검사 → 초안 잠금 순서, 감사는 같은 트랜잭션).
 * PacsService가 만들어 소유하는 평범한 객체다(Nest provider가 아니다). 생성자는 참조만 저장한다.
 */
import { canReadPreliminary } from '../preliminary-reader';
import type { StudyAccessService } from '../study-access.service';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../prisma.service';
import { dump, holdAlive, toClient, draftConflict, draftOwner, draftEpochOf, draftExpected, draftSnapshotInput,
  draftEnvelope, draftTransactionError, draftBounded } from './values';
import type { DraftOwner } from './values';
import { need, inst } from './access';
import type { Caller, PacsAccess } from './access';
import type { PacsAudit } from './audit';
import type { PacsReportEvidence } from './report-evidence';
import { relatedInsertInput, relatedInsertId, relatedEvidenceIds, relatedRequestHash, relatedProposalHash, relatedInsertionText,
  relatedOwnReceipt, relatedSameBinding, relatedResult, relatedInsertInvalid, relatedInsertRefusal, relatedInsertIdReused }
  from '../report-related-insert';
import type { RelatedInsertRefusal } from '../report-related-insert';
import type { AccessAction, AccessEventV1 } from '../emr-contract/access-event';
import type { EmrRecordPort } from '../emr-runtime/record-port';

export interface DraftRequestFacts {
  /** Original authenticated request, used only by the server signing adapter. */
  request?: object;
  issuer: string;
  ip: { address: string; source: 'trusted-proxy' | 'request-peer' } | null;
  requestId: string;
}
type DraftObservation = { facts: DraftRequestFacts; surface: string; action: AccessAction; target?: 'report-version' };
type RecordDraft = (state: any, value: any, action?: AccessAction,
  source?: { uid: string; version: number }) => Promise<void>;

export class PacsReportDraft {
  constructor(
    private readonly prisma: PrismaService,
    private readonly studyAccess: StudyAccessService,
    private readonly access: PacsAccess,
    private readonly audit: PacsAudit,
    private readonly reportEvidence: PacsReportEvidence,
    private readonly ledger: EmrRecordPort) {}

  private async recorded<T>(uid: string, c: Caller, observation: DraftObservation,
      body: (tx: Prisma.TransactionClient, record: RecordDraft) => Promise<T>,
      options: { maxWait: number; timeout: number }): Promise<T> {
    const work = this.ledger.begin();
    try {
      const { facts, surface } = observation;
      const identity = { issuer: facts.issuer, subject: c.sub,
        id: await work.resolveRequestIdentity(facts.issuer, c.sub) };
      return await work.transactionWithRecords((tx, record) => body(tx, async (state, value, action = observation.action, source) => {
        const report = !!source || observation.target === 'report-version';
        const revision = source ? String(source.version) : report ? String(value.state.version) : value.revision;
        const resource = report ? source?.uid ?? uid : JSON.stringify([uid, c.actor]);
        const event: AccessEventV1 = {
          formatVersion: 1, surface, eventId: randomUUID(),
          userId: { status: 'known', value: identity }, rolesAtTime: { status: 'known', value: c.roles },
          actingInstitution: { status: 'known', value: inst(c) },
          managingInstitution: { status: 'known', value: state.institutionId },
          occurredAt: new Date().toISOString(),
          trustedProxyIp: facts.ip ? { status: 'known', value: facts.ip } : { status: 'unresolved', reason: 'not-observed' },
          cause: 'user-view', context: { basis: 'worklist', studyId: uid, relatedStudyId: null, reason: null },
          executor: 'member', targets: [{ kind: report ? 'report-version' : 'private-draft',
            patientLinkSnapshot: { status: 'unresolved', reason: 'not-resolved' },
            studyId: { status: 'known', value: source?.uid ?? uid }, recordId: { status: 'known', value: resource },
            versionId: { status: 'known', value: revision } }],
          action, result: action === 'provide-prepared' ? 'prepared' : 'succeeded',
          requestId: facts.requestId, auditLinkId: 'audit:' + randomUUID(), relatedEventId: null,
        };
        // Writes reach here in their business transaction; views supply the
        // captured read snapshot. Neither response leaves before this commit.
        await record(event, async () => ({ kind: report ? 'ReportVersion' : 'ReportDraft', id: resource, version: revision }));
      }), options);
    } finally { work.end(); }
  }

  private relatedDraftView(outcome: any) {
    const value = outcome?.body ?? outcome?.refusal?.getResponse?.();
    return value?.snapshot ? value : null;
  }

  /**
   * 판독문 초안 저장. **`Report`가 아니라 내 `ReportDraft` 행에 쓴다.**
   *
   * 예전엔 초안도 `Report`에 썼고, 거기서 이 시스템의 판독문 손실이 거의 다 나왔다:
   * 초안이 남의 확정본을 덮고, 두 사람의 초안이 서로를 덮고, Clear 한 번에 승인본이
   * 화면에서 사라졌다. 확정 경로에만 낙관적 락이 있었기 때문이라고 생각해서
   * 이쪽에도 락을 달았더니, 이번엔 **20초 자동 저장이 409를 받는** 문제가 생겼다 —
   * 사용자가 안 보고 있을 때 "충돌했습니다"를 띄워봐야 할 수 있는 일이 없다.
   *
   * 진짜 원인은 락이 없어서가 아니라 **한 칸을 둘이 썼기 때문**이었다.
   * 초안을 쓴 사람에게 붙이면 **남과의** 충돌은 감지할 필요조차 없다. 같은 행을 안 쓰니까.
   *
   * 남과의 충돌은 확정할 때만 일어난다 — 사람이 화면 앞에 있고, 스스로 누른 순간이고,
   * 물어볼 수 있는 자리다. 그 낙관적 락(`Report.version`)은 `commitReport` 한 곳에 있다.
   *
   * 자기 자신과의 충돌은 다른 문제다(S7-U5): 답을 못 받은 앞선 쓰기, 다른 탭, 다시 로그인한 같은 계정이 같은 행을
   * 쓴다. 무조건 upsert는 늦게 닿은 옛 글로 나중 글을 덮고, 지운 초안을 되살렸다. 그래서 내 행에는 저장된 경계
   * (`revision`)가 있고, 초안을 바꾸는 모든 길은 아래 `draftTransaction` 하나를 지난다.
   */
  // Shared with putReport: dictation cannot create a weaker copy of report refusal rules.
  private reportDraftRules(prev: any, c: Caller) {
    if (prev?.ss === 'Unverified' && prev.em !== 'E')
      throw new ConflictException('촬영 중(미확인) 검사입니다 — 기사 확인(Verify) 뒤 판독할 수 있습니다');
    const heldByOther = holdAlive(prev) && prev.holder !== c.actor ? prev.holder : null;
    if (heldByOther)
      throw new ConflictException({ code: 'REPORT_HELD', holder: heldByOther, message: `${heldByOther} 님이 판독 중입니다` });
    if (!prev) throw new NotFoundException('검사를 찾을 수 없습니다');
    if (!canReadPreliminary(prev, c))
      throw new ForbiddenException(
        `예비 판독(RS: P) 중입니다. ${prev?.preReviewer ?? '지정된 판독의'}만 이어서 판독할 수 있습니다.`);
    return prev;
  }

  private async reportDraftGate(uid: string, c: Caller, tx: any) {
    need(c.roles, 'radiologist', '판독문 저장');
    const prev = await this.access.gate(uid,c,tx);
    // WORKLIST-SPLIT-UID: observed before the transaction by the caller (dictationGate); refused inside the scope only.
    if (prev) this.studyAccess.assertUnsplitSource(c, uid);
    return this.reportDraftRules(prev, c);
  }

  /**
   * 초안을 바꾸는 **모든** 길(저장·비우기·내 초안 버리기·확정·관리자 강제 해제)이 지나는 한 트랜잭션(U5S-REQ-16).
   *
   * 순서가 곧 계약이다:
   *  1. 외부 준비(접근 정책의 원본 조회, 상급 판독의 조회)는 트랜잭션 **밖**에서, 5초 안에. 넘기면 아무것도 쓰지 않고 503이다.
   *     기다리는 줄은 없다 — 앞선 요청의 준비가 멈춰도 뒤 요청은 자기 차례를 따로 가진다.
   *  2. 쿠키 세션이 보낸 변경은 **그 세션 행을 먼저 잠근다**(FOR KEY SHARE). 로그아웃·만료의 행 삭제는 이 잠금을 기다리므로,
   *     변경은 세션이 끝나기 전에 commit되거나 끝난 뒤에 401로 실패한다 — 끝난 세션의 글이 뒤늦게 저장되지 않는다. 토큰
   *     갱신·접속 시각 갱신은 키를 바꾸지 않아 이 잠금과 부딪히지 않는다. Bearer 호출에는 세션이 없다.
   *  3. 접근 범위를 트랜잭션 안에서 다시 보고, 검사 행을 잠근다(FOR UPDATE). 같은 검사의 초안 변경·확정·강제 해제·검사 삭제가
   *     여기서 줄을 선다 — 행이 아직 없는 첫 쓰기 둘도 한 줄이다.
   *  4. 세대(draftEpoch)가 요청이 본 것과 다르면 충돌이다. 내 행의 revision 대조는 `ownDraft`가, 조건부 쓰기와 revision
   *     전진은 `storeDraft`가 한다. 감사 행은 같은 트랜잭션에서 쓴다 — 변경과 감사는 함께 남거나 함께 없다.
   * 잠금 순서는 세션 → 검사 → (확정의 Report) → 초안 행으로 하나다. 대기는 유한하다: 연결 4초, 잠금 3초, 트랜잭션 8초.
   *
   * `related`는 W5 관련 판독문 삽입(O4 R1)만 넘긴다. 그 요청은 Source 검사 행도 함께 잡는다(FOR SHARE: 그 판의 확정·초기화가
   * 판정 중에 끼어들지 못하고, 같은 Source를 쓰는 다른 삽입은 막지 않는다). 두 행은 중복 없이 UID의 코드 단위 순서(DICOM UID에서는
   * C 순서)로 잠그므로 A←B와 B←A가 같은 줄에 선다. 그리고 세대 대조를 여기서 하지 않는다 — 이미 적용된 같은 요청은 세대·revision이
   * 바뀐 뒤에도 영수증으로 답해야 하므로, 영수증 판정이 CAS 앞에 있고 새 적용만 CAS를 본다(그 판정은 putReport에 있다).
   * 일반 호출자는 `related` 없이 이전과 같은 질의·순서·거절을 그대로 지난다.
   */
  async draftTransaction<T>(uid: string, c: Caller, session: string | null, epoch: string,
      prepare: () => Promise<unknown>,
      work: (tx: Prisma.TransactionClient, state: any,
        audit: (actor: string, action: string, target: string, detail?: any) => Promise<any>, record?: RecordDraft) => Promise<T>,
      related?: { source: string | null }, observation?: DraftObservation): Promise<T> {
    const me = inst(c);
    // WORKLIST-SPLIT-UID: the request's own source observation is part of the same bounded preparation, outside the
    // transaction; no Orthanc read ever happens under the study lock.
    await draftBounded((async () => { await prepare(); await this.studyAccess.prepareSourceIdentity(c, [uid]); })());
    let rolledBackView: { state: any; value: any } | null = null;
    const perform = async (tx: Prisma.TransactionClient, record?: RecordDraft) => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      if (session !== null) {
        const held = await tx.$queryRaw<any[]>`SELECT 1 AS held FROM "AuthSession" WHERE sid = ${session} FOR KEY SHARE`;
        if (!held.length)
          throw new UnauthorizedException({ code: 'AUTH_SESSION_ENDED', message: '인증 세션이 종료되어 판독문 초안을 저장하지 않았습니다' });
      }
      await this.studyAccess.require(c,[uid],tx);
      const source = related?.source ?? null;
      if (source !== null && source < uid) await tx.$queryRaw`SELECT uid FROM "StudyState" WHERE uid = ${source} FOR SHARE`;
      const states = await tx.$queryRaw<any[]>`SELECT * FROM "StudyState" WHERE uid = ${uid} FOR UPDATE`;
      const state = states[0];
      if (source !== null && source > uid) await tx.$queryRaw`SELECT uid FROM "StudyState" WHERE uid = ${source} FOR SHARE`;
      if (!state || !this.access.visible(state, me)) throw new NotFoundException('검사를 찾을 수 없습니다');
      // Every draft change, clear, discard, forced discard and commit of a UID two patient resources answer is refused
      // before any write: no Verified or emergency state makes either patient's header the report's patient.
      this.studyAccess.assertUnsplitSource(c, uid);
      if (!related && state.draftEpoch !== epoch) throw draftConflict();
      const audit=(actor:string,action:string,target:string,detail?:any)=>tx.auditLog.create({data:{actor:actor||'unknown',action,target,detail:dump(detail)}});
      let value: T;
      try { value = await work(tx, state, audit, record); }
      catch (error) {
        const view = related && this.relatedDraftView({ refusal: error });
        if (view) rolledBackView = { state, value: view };
        throw error;
      }
      if (record) {
        if (!related) await record(state, value);
        const view = related ? this.relatedDraftView(value) : value;
        if (view) await record(state, view, 'provide-prepared');
      }
      return value;
    };
    const options = { maxWait: 4000, timeout: 8000 };
    return (observation ? this.recorded(uid, c, observation, perform, options)
      : this.prisma.$transaction(tx => perform(tx), options)).catch(async error => {
        // A receipt race can roll back the business transaction but still return
        // its captured draft. Commit that view before sending the refusal.
        if (rolledBackView && observation) await this.recorded(uid, c,
          { ...observation, action: 'provide-prepared' }, async (_tx, record) => {
            await record(rolledBackView.state, rolledBackView.value);
          }, options);
        return draftTransactionError(error);
      });
  }

  /** 내 초안 행을 잠그고 요청이 본 revision과 대조한다. 행이 없으면 이 세대의 revision 0이다. */
  async ownDraft(tx: Prisma.TransactionClient, uid: string, c: Caller, revision: number) {
    const rows = await tx.$queryRaw<any[]>`
      SELECT uid, author, findings, conclusion, recommendation, "baseVersion", citations, structured, revision, present, "updatedAt"
      FROM "ReportDraft" WHERE uid = ${uid} AND author = ${c.actor} FOR UPDATE`;
    const row = rows[0] ?? null;
    if ((row?.revision ?? 0) !== revision) throw draftConflict();
    return row;
  }

  /**
   * 내 초안 행을 **읽은 revision일 때만** 쓰고 revision을 하나 올린다. `content`가 null이면 비운 자리다: 행은 남고
   * (present=false) 내용 칸은 비운다 — 행을 지우면 revision이 사라져 지운 뒤에 닿은 옛 쓰기가 초안을 되살린다.
   * 초안이 없던 작성자의 비우기·버리기·확정도 경계를 올린다(0 → 1). 0행 갱신은 충돌이다 — 덮지 않는다.
   */
  async storeDraft(tx: Prisma.TransactionClient, uid: string, author: string, row: any,
      content: { findings: string; conclusion: string; recommendation: string; baseVersion: number;
        citations: any[]; structured: any[] } | null) {
    const revision = (row?.revision ?? 0) + 1;
    const text = content
      ? { present: true, findings: content.findings, conclusion: content.conclusion,
          recommendation: content.recommendation, baseVersion: content.baseVersion }
      : { present: false, findings: '', conclusion: '', recommendation: '', baseVersion: 0 };
    // "없음"의 모양은 SQL NULL 하나다(P13). 빈 배열을 저장하면 읽는 쪽이 두 가지를 구분해야 한다.
    const citations = content?.citations.length ? content.citations : null;
    const structured = content?.structured.length ? content.structured : null;
    if (!row)
      return tx.reportDraft.create({ data: { uid, author, ...text, revision,
        ...(citations ? { citations } : {}), ...(structured ? { structured } : {}) } });
    const changed = await tx.reportDraft.updateMany({
      where: { uid, author, revision: row.revision },
      data: { ...text, revision, citations: citations ?? Prisma.DbNull, structured: structured ?? Prisma.DbNull },
    });
    if (changed.count !== 1) throw draftConflict();
    return tx.reportDraft.findUnique({ where: { uid_author: { uid, author } } });
  }

  /**
   * 내 초안의 권위 있는 읽기(U5S-REQ-15, 17). 충돌이나 답을 받지 못한 저장 뒤에 화면이 무엇이 저장돼 있는지 확인하는
   * 자리다 — 검사 행의 세대와 내 행을 한 스냅숏에서 읽는다. 관문은 초안 쓰기와 같은 역할·기관·예비 판독 규칙이다.
   *
   * `insertRequestId`(W5 Check, O4 R1)가 오면 같은 스냅숏에서 그 삽입 영수증도 읽어 봉투에 `relatedInsert`로 싣는다. 쓰기는
   * 없다 — 읽기가 거절·취소 행을 만들지 않는다. 관문은 지금 Target 개인 초안의 가독뿐이고 Source의 글·상세는 답하지 않는다.
   * 영수증이 없으면 unknown, 남의 영수증이면 그 내용 없이 ID_REUSED다.
   */
  async readDraft(uid: string, c: Caller, facts: DraftRequestFacts, insertRequestId?: string) {
    need(c.roles, 'radiologist', '판독문 초안 조회');
    const owner: DraftOwner = { institution: inst(c), sub: c.sub, author: c.actor };
    const receiptId = insertRequestId === undefined ? null : relatedInsertId(insertRequestId);
    await this.studyAccess.prepare(c,[uid]);
    await this.studyAccess.prepareSourceIdentity(c,[uid]);
    const snapshot = await this.prisma.$transaction(async tx => {
      const state = await this.access.gate(uid, c, tx);
      if (!state) throw new NotFoundException('검사를 찾을 수 없습니다');
      this.studyAccess.assertUnsplitSource(c, uid);
      if (!canReadPreliminary(state, c))
        throw new ForbiddenException(
          `예비 판독(RS: P) 중입니다. ${state?.preReviewer ?? '지정된 판독의'}만 볼 수 있습니다.`);
      const envelope = draftEnvelope(uid, owner, state.draftEpoch, await this.access.myDraft(uid, c.actor, tx));
      if (receiptId === null) return { state, value: envelope };
      const receipt = await tx.reportDraftInsertReceipt.findUnique({ where: { insertRequestId: receiptId } });
      return { state, value: { ...envelope,
        relatedInsert: relatedResult(receiptId, receipt, envelope, !receipt || relatedOwnReceipt(receipt, owner, uid), null) } };
    }, { isolationLevel: 'RepeatableRead', maxWait: 2000, timeout: 5000 });
    // Preserve the existing repeatable read. The entry describes that captured
    // snapshot; no later fetch may substitute a different body after recording.
    return this.recorded(uid, c, { facts, surface: 'GET studies/:uid/draft', action: 'provide-prepared' }, async (_tx, record) => {
      await record(snapshot.state, snapshot.value);
      return snapshot.value;
    }, { maxWait: 2000, timeout: 5000 });
  }

  async dictationGate(uid: string, c: Caller) {
    await this.studyAccess.prepareSourceIdentity(c, [uid]);
    return this.access.scopeWrite(uid, c, async tx => { await this.reportDraftGate(uid, c, tx); });
  }

  async dictationAudit(uid: string, c: Caller, detail: { bytes: number; seconds: number; ms: number; engine: string; outcome: string }) {
    await this.audit.audit(c.actor, 'dictation.request', uid, detail);
  }

  async putReport(uid: string, body: any, c: Caller, session: string | null, facts: DraftRequestFacts) {
    need(c.roles, 'radiologist', '판독문 저장');
    // 작성자·경계·전체 스냅숏의 모양을 어떤 읽기보다 먼저 본다. 거절은 검사·초안 행을 읽거나 쓰거나 감사를 남기지 않는다.
    const owner = draftOwner(body, c);
    const expected = draftExpected(body);
    const content = draftSnapshotInput(body);
    if (body.relatedInsert !== undefined) {
      /**
       * W5 관련 판독문 삽입(O4 R1, D1423). 다른 검사의 승인본(approve/addendum) 원문 일부를 내 초안 Findings/Conclusion 한 칸 끝에
       * 넣는 명시 삽입이며, 같은 PUT이 그 고정 요청 전체(본문 세 칸·기준 판·두 ID 목록)를 싣는다. 이 요청 하나가 영수증 한 행이다.
       * 기존 인용(`insert`)·구조화(`structure`)와 한 요청에 섞지 않는다 — 어느 증언이 어느 글의 것인지 갈라지지 않게.
       */
      if (body.insert !== undefined || body.structure !== undefined) throw relatedInsertInvalid('relatedInsert');
      const related = relatedInsertInput(body.relatedInsert, uid, content, expected);
      const proposal = { ...content, ...relatedEvidenceIds(body) };
      const asked = { requestHash: relatedRequestHash(related, owner, expected, proposal), proposalHash: relatedProposalHash(proposal),
        expected, proposal };
      const binding = { insertRequestId: related.insertRequestId, targetUid: uid, ownerInstitution: owner.institution,
        ownerSub: owner.sub, ownerAuthor: owner.author, requestHash: asked.requestHash, proposalHash: asked.proposalHash,
        expectedEpoch: expected.epoch, expectedRevision: expected.revision, sourceUid: related.source.uid,
        sourceVersion: related.source.version, targetBaseVersion: related.targetBaseVersion, section: related.section };
      /**
       * 영수증만으로 끝나는 답: 같은 ID의 다른 요청(ID_REUSED)과 이미 끝난 영수증(applied·discarded)의 replay·취소 답. Source는 쓰지
       * 않는다 — 과거 적용을 답하는 데 지금 Source를 다시 읽을 이유가 없고, Source의 원본 조회 실패·권한 상실·행 경합이 이미
       * 적용된 삽입의 답을 막아서는 안 된다(O4 R1). 영수증이 없거나 refused면 null: 새 적용·재시도·취소 판정으로 간다.
       */
      const settled = (receipt: any, envelope: any) => {
        if (!receipt) return null;
        // 같은 ID의 다른 요청: 이 호출만 거절하고 그 행은 바꾸지도, 답하지도 않는다.
        if (!relatedSameBinding(receipt, owner, uid, related, expected, asked.requestHash, asked.proposalHash))
          return { refusal: relatedInsertIdReused() };
        const view = relatedResult(related.insertRequestId, receipt, envelope, true, asked);
        if (receipt.state === 'applied') {
          if (related.intent === 'discard') return { refusal: relatedInsertRefusal('RELATED_INSERT_NOT_DISCARDABLE', envelope, view) };
          // 정확한 replay: 쓰기·감사·revision 증가 없이 지금 봉투와 영수증. clear/discard/commit/force/세대 교체 뒤에도 다시 넣지 않는다.
          return view.result === 'applied' ? { body: { ...envelope, relatedInsert: view } }
            : { refusal: relatedInsertRefusal('RELATED_INSERT_SUPERSEDED', envelope, view) };
        }
        if (receipt.state === 'discarded')
          return related.intent === 'discard' ? { body: { ...envelope, relatedInsert: view } }
            : { refusal: relatedInsertRefusal('RELATED_INSERT_DISCARDED', envelope, view) };
        return null;
      };
      /**
       * 먼저 지금 Target의 개인 초안 읽기 관문(역할·기관·StudyAccess·예비 판독)과 owner 아래, 한 RepeatableRead 스냅숏에서 내 초안과
       * 영수증을 읽어 끝난 영수증·ID_REUSED를 답한다. Source 준비도 Source 행 잠금도 없다. 쓰기가 없으므로 잠그지 않는다 — 이
       * 스냅숏 뒤에 끝난 영수증은 아래 잠근 트랜잭션이 CAS 전에 다시 판정한다.
       * WORKLIST-SPLIT-UID: Target의 원본 관찰은 트랜잭션 밖의 유한한 준비에 있고, 두 환자 자원이 답하는 Target이면 영수증을
       * 읽기 전에 409 STUDY_IDENTITY_UNRESOLVED다 — 이미 적용·취소·거절된 영수증이 있어도 그 내용도 봉투도 답하지 않는다.
       */
      await draftBounded((async () => {
        await this.studyAccess.prepare(c,[uid]);
        await this.studyAccess.prepareSourceIdentity(c,[uid]);
      })());
      const early = await this.prisma.$transaction(async tx => {
        const state = await this.access.gate(uid, c, tx);
        if (!state) throw new NotFoundException('검사를 찾을 수 없습니다');
        this.studyAccess.assertUnsplitSource(c, uid);
        if (!canReadPreliminary(state, c))
          throw new ForbiddenException(
            `예비 판독(RS: P) 중입니다. ${state?.preReviewer ?? '지정된 판독의'}만 볼 수 있습니다.`);
        const mine = await this.access.myDraft(uid, c.actor, tx);
        const stored = await tx.reportDraftInsertReceipt.findUnique({ where: { insertRequestId: related.insertRequestId } });
        return { state, outcome: settled(stored, draftEnvelope(uid, owner, state.draftEpoch, mine)) };
      }, { isolationLevel: 'RepeatableRead', maxWait: 2000, timeout: 5000 });
      const earlyView = this.relatedDraftView(early.outcome);
      if (earlyView) await this.recorded(uid, c,
        { facts, surface: 'PUT studies/:uid/report', action: 'provide-prepared' }, async (_tx, record) => {
          await record(early.state, earlyView);
        }, { maxWait: 2000, timeout: 5000 });
      if (early.outcome?.refusal) throw early.outcome.refusal;
      if (early.outcome) return early.outcome.body;
      const outcome = await this.reportEvidence.reportLimitChecked(() => this.draftTransaction(uid, c, session, expected.epoch,
        async () => {
          await this.studyAccess.prepare(c,[uid]);
          // 취소는 Source를 읽지 않는다. 새 적용·refused 재시도만 Source의 현재 가독과 원본 관찰을 다시 요구한다(잠금 밖, 유한하게).
          if (related.intent === 'apply') {
            await this.studyAccess.prepare(c,[related.source.uid]);
            await this.studyAccess.prepareSourceIdentity(c,[related.source.uid]);
          }
        }, async (tx, state, audit, record) => {
        // 지금 Target 개인 초안의 가독이 영수증 판정보다 먼저다(replay도 지금 권한 아래에서만 답한다).
        if (!canReadPreliminary(state, c))
          throw new ForbiddenException(
            `예비 판독(RS: P) 중입니다. ${state?.preReviewer ?? '지정된 판독의'}만 볼 수 있습니다.`);
        // 잠금 순서의 나머지: 내 초안 행 → 영수증 행. 경쟁한 요청의 적용·취소는 이 잠금 뒤에 읽히므로 놓치지 않는다.
        const drafts = await tx.$queryRaw<any[]>`
          SELECT uid, author, findings, conclusion, recommendation, "baseVersion", citations, structured, revision, present, "updatedAt"
          FROM "ReportDraft" WHERE uid = ${uid} AND author = ${c.actor} FOR UPDATE`;
        const row = drafts[0] ?? null;
        const receipts = await tx.$queryRaw<any[]>`
          SELECT * FROM "ReportDraftInsertReceipt" WHERE "insertRequestId" = ${related.insertRequestId}::uuid FOR UPDATE`;
        const receipt = receipts[0] ?? null;
        const envelope = draftEnvelope(uid, owner, state.draftEpoch, row);
        const view = (stored: any) => relatedResult(related.insertRequestId, stored, envelope, true, asked);
        // 잠금 아래 다시 판정한다: 앞의 스냅숏 뒤에 경쟁한 요청이 적용·취소했으면 그 끝난 영수증으로 답한다(놓치지 않는다).
        const decided = settled(receipt, envelope);
        if (decided) return decided;
        // 영수증 행의 전이는 refused에서만, receiptRevision 하나씩 (migration의 guard와 같은 규칙).
        const move = async (from: any, to: { state: string; appliedRevision: number | null; reason: string | null }) => {
          const moved = await tx.reportDraftInsertReceipt.updateMany({
            where: { insertRequestId: from.insertRequestId, state: 'refused', receiptRevision: from.receiptRevision },
            data: { ...to, receiptRevision: from.receiptRevision + 1 } });
          if (moved.count !== 1) throw relatedInsertRefusal('RELATED_INSERT_RECEIPT_CHANGED', envelope, view(from));
          return { ...from, ...to, receiptRevision: from.receiptRevision + 1 };
        };
        if (related.intent === 'discard') {
          // 거절이 확인된 그 receiptRevision의 삽입만 취소 표식이 된다. 초안 본문·revision과 Source는 건드리지 않는다.
          if (!receipt) return { refusal: relatedInsertRefusal('RELATED_INSERT_NOT_DISCARDABLE', envelope, view(receipt)) };
          if (receipt.receiptRevision !== related.expectedReceiptRevision)
            return { refusal: relatedInsertRefusal('RELATED_INSERT_RECEIPT_CHANGED', envelope, view(receipt)) };
          const fenced = await move(receipt, { state: 'discarded', appliedRevision: null, reason: 'INSERT_DISCARDED' });
          return { body: { ...envelope, relatedInsert: view(fenced) } };
        }
        // 새 적용 또는 refused의 같은 ID 재시도. 업무 거절은 초안을 쓰기 전, 아직 유효한 이 트랜잭션에서 refused 행으로 남긴다
        // (같은 사유면 행을 다시 쓰지 않는다). DB 오류는 여기서 잡지 않는다 — 결과를 모르는 채 거절 행을 쓰지 않는다.
        const refuse = async (reason: RelatedInsertRefusal) => {
          const kept = !receipt
            ? await tx.reportDraftInsertReceipt.create({ data: { ...binding, state: 'refused', reason } })
            : receipt.reason === reason ? receipt : await move(receipt, { state: 'refused', appliedRevision: null, reason });
          return { refusal: relatedInsertRefusal('RELATED_INSERT_REFUSED', envelope, view(kept)) };
        };
        // 처음 CAS 그대로다. 세대나 revision이 전진했으면 같은 ID의 재시도도 거절이다 — 조용히 새 기준에 다시 얹지 않는다.
        if (state.draftEpoch !== expected.epoch || (row?.revision ?? 0) !== expected.revision) return refuse('DRAFT_CONFLICT');
        try { this.reportDraftRules(state, c); }
        catch (error: any) {
          if (!(error instanceof ConflictException)) throw error;
          return refuse((error.getResponse() as any)?.code === 'REPORT_HELD' ? 'TARGET_HELD' : 'TARGET_UNVERIFIED');
        }
        // Source: 지금 이 사람이 그 검사의 판 이력을 읽을 수 있는가(versions()와 같은 관문), 그 판이 서버의 승인·추가기재 판인가,
        // 그 판이 아직 그 검사의 머리인가. 화면이 보낸 글은 승인의 증명이 아니다 — 글은 아래에서 서버가 그 판으로 다시 만든다.
        let sourceState: any = null;
        try { sourceState = await this.access.gate(related.source.uid, c, tx); }
        catch (error: any) { if (!(error instanceof NotFoundException)) throw error; }
        if (!sourceState || !canReadPreliminary(sourceState, c)) return refuse('SOURCE_UNAVAILABLE');
        // WORKLIST-SPLIT-UID: 두 환자 자원이 답하는 Source의 판·머리·글은 쓰지 않는다(409 STUDY_IDENTITY_UNRESOLVED). 원본을
        // 관찰하지 못한 요청은 503 STUDY_SOURCE_UNAVAILABLE이다. 둘 다 업무 거절이 아니므로 영수증 행을 남기지 않는다 —
        // 트랜잭션은 아무것도 쓰지 않고 끝나며, 같은 ID의 재시도·Check·취소는 그대로 열려 있다.
        this.studyAccess.assertUnsplitSource(c, related.source.uid);
        const version = await tx.reportVersion.findUnique({
          where: { uid_version: { uid: related.source.uid, version: related.source.version } },
          select: { action: true, findings: true, conclusion: true, recommendation: true } });
        if (!version || !['approve', 'addendum'].includes(version.action)) return refuse('SOURCE_UNAVAILABLE');
        await record(sourceState, null, 'provide-prepared', related.source);
        if (version.action !== related.source.action) throw relatedInsertInvalid('source.action');
        const sourceHead = await tx.report.findUnique({ where: { uid: related.source.uid }, select: { version: true } });
        if ((sourceHead?.version ?? 0) !== related.source.version) return refuse('SOURCE_CHANGED');
        // Target seed: 내 초안이 있으면 그 revision의 글, 없으면 기준 판의 승인본(그 판이 아직 머리일 때만). 재기준은 없다.
        const head = await tx.report.findUnique({ where: { uid },
          select: { version: true, findings: true, conclusion: true, recommendation: true } });
        const present = !!row?.present;
        if (present !== (related.seedKind === 'private-draft')) throw relatedInsertInvalid('seedKind');
        if (!present && (head?.version ?? 0) !== related.targetBaseVersion) return refuse('SEED_CHANGED');
        const seed = present
          ? { findings: row.findings, conclusion: row.conclusion, recommendation: row.recommendation, baseVersion: row.baseVersion }
          : { findings: head?.findings ?? '', conclusion: head?.conclusion ?? '', recommendation: head?.recommendation ?? '',
              baseVersion: head?.version ?? 0 };
        if (related.seedKind === 'empty' && (seed.findings || seed.conclusion || seed.recommendation)) throw relatedInsertInvalid('seedKind');
        if (seed.baseVersion !== related.targetBaseVersion) throw relatedInsertInvalid('targetBaseVersion');
        // 제안 = 고정 seed의 그 칸 끝에 서버가 그 판에서 다시 만든 글을 더한 것. 다른 칸·Recommendation·근거 목록은 그대로다.
        if (relatedInsertionText(version, related.source.parts, seed[related.section]) !== related.text) throw relatedInsertInvalid('text');
        if (related.offset !== seed[related.section].length) throw relatedInsertInvalid('offset');
        const wanted = { ...seed, [related.section]: seed[related.section] + related.text };
        for (const field of ['findings', 'conclusion', 'recommendation', 'baseVersion'] as const)
          if (content[field] !== wanted[field]) throw relatedInsertInvalid(field);
        const kept = present ? envelope.snapshot : { citations: [], structured: [] };
        const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
        if (!same(proposal.citationIds, kept.citations)) throw relatedInsertInvalid('citationIds');
        if (!same(proposal.structureIds, kept.structured)) throw relatedInsertInvalid('structureIds');
        // 적용: 초안(+1), 기존 최소 report.draft 감사(일반 저장과 같은 모양: 길이와 인용·구조화의 식별자만), applied 영수증이 한 commit이다.
        const prior = present ? row : null;
        const cited = await this.reportEvidence.draftCitations(tx, uid, prior, body, content, c, head?.version ?? 0);
        const structure = await this.reportEvidence.draftStructure(tx, uid, prior, body, content, c, head?.version ?? 0);
        const saved = await this.storeDraft(tx, uid, c.actor, row,
          { ...content, citations: cited.entries, structured: structure.entries });
        await audit(c.actor, 'report.draft', uid, {
          len: [content.findings.length, content.conclusion.length, content.recommendation.length],
          ...(cited.detail ? { cits: cited.detail } : {}),
          ...(structure.detail ? { strs: structure.detail } : {}),
        });
        const appliedRevision = expected.revision + 1;
        const applied = receipt ? await move(receipt, { state: 'applied', appliedRevision, reason: null })
          : await tx.reportDraftInsertReceipt.create({ data: { ...binding, state: 'applied', appliedRevision } });
        const after = draftEnvelope(uid, owner, state.draftEpoch, saved);
        await record(state, after, 'draft-save');
        return { body: { ...after, relatedInsert: relatedResult(related.insertRequestId, applied, after, true, asked) } };
        }, { source: related.intent === 'apply' ? related.source.uid : null },
        { facts, surface: 'PUT studies/:uid/report', action: 'provide-prepared' }));
      // 업무 거절의 refused 행은 위 트랜잭션과 함께 commit됐다. 거절 답은 그 commit 뒤에 낸다.
      if (outcome.refusal) throw outcome.refusal;
      return outcome.body;
    }
    const empty = !(content.findings || content.conclusion || content.recommendation);
    return this.reportEvidence.reportLimitChecked(() => this.draftTransaction(uid, c, session, expected.epoch, async () => {
      await this.studyAccess.prepare(c,[uid]);
      /**
       * 소견 계보의 접근 정책은 **트랜잭션 밖에서** 준비되어야 한다.
       *
       * `prepare(c,[uid])`는 검사 하나만 요청하므로 전체 준비를 켜지 않는다(`study-access.service.ts`).
       * 그러면 트랜잭션 안에서 비교 검사를 묻는 순간 `allowed`는 준비를 못 하고 캐시가 없어 409를 던진다 —
       * 비교 검사를 가진 소견의 인용이 권한 문제도 아닌데 조용히 실패한다. 소견 목록이 같은 이유로 같은 형태를 쓴다.
       */
      if (body.insert !== undefined) await this.studyAccess.prepare(c);
    }, async (tx, state, audit) => {
    this.reportDraftRules(state, c);
    const row = await this.ownDraft(tx, uid, c, expected.revision);

    /**
     * 빈 초안은 **초안이 아니다.** 빈 초안을 남겨두면 그게 확정본을 가려서,
     * 승인된 판독문을 열었는데 빈 칸이 보이는 상태가 된다.
     * "초안이 없다"와 "초안이 비어 있다"는 화면에서 같은 뜻이어야 한다.
     */
    if (empty) {
      // 비우는 PUT에 삽입을 함께 보낼 수는 없다 — 넣었다고 말하는 문장이 본문에 없다.
      // 조용히 무시하면 화면은 200을 받고도 무엇이 기록되었는지 알 수 없다.
      if (body.insert !== undefined)
        throw new ConflictException({ code: 'REPORT_CITATION_TEXT',
          message: '삽입한 문구가 그 칸의 본문에 줄 단위로 그대로 있지 않습니다' });
      // 같은 이유로 구조화 적용도 함께 올 수 없다 — 넣었다고 말하는 문장이 본문에 없다.
      if (body.structure !== undefined)
        throw new ConflictException({ code: 'REPORT_STRUCTURE_TEXT',
          message: '구조화 항목의 문장이 그 칸의 본문에 줄 단위로 그대로 있지 않습니다' });
      const cleared = await this.storeDraft(tx, uid, c.actor, row, null);
      await audit(c.actor, 'report.draft.clear', uid, {});
      return draftEnvelope(uid, owner, state.draftEpoch, cleared);
    }

    /**
     * **기준 판은 화면이 실제로 본 판이어야 한다.**
     *
     * 판 번호는 커지기만 하므로 정직한 화면은 아직 없는 판을 기준으로
     * 삼을 수 없다. 여기 걸린다면 `baseVersion`의 출처가 틀린 것이고, 그대로 저장하면
     * 확정 때 낙관적 락이 **아무도 본 적 없는 판**을 통과시킨다.
     * 비우는 PUT(위)은 판 번호를 저장하지 않으므로 이 검사 앞에서 끝난다.
     */
    const baseVersion = content.baseVersion;
    // Report는 잠그지 않는다. 판 번호 대조는 예방이고, 실제 낙관적 락은 확정에 있다.
    const head = await tx.report.findUnique({ where: { uid }, select: { version: true } });
    if (baseVersion > (head?.version ?? 0))
      throw new BadRequestException(
        `아직 없는 판(v${baseVersion})을 기준으로 초안을 저장할 수 없습니다 (현재 v${head?.version ?? 0})`);

    // 기존 초안의 기준이 올라가는 PUT은 자동 저장이 아니라 **사람이 승인본을 확인하고
    // 다시 잡은 것**이다. 어느 판을 딛고 쓴 글인지는 나중에 되짚을 근거가 이것뿐이라
    // 자동 저장과 구분해 남긴다. 비운 자리(present=false)는 딛고 선 초안이 아니다.
    const prior = row?.present ? row : null;
    // 유지 목록은 전체 스냅숏의 일부라 언제나 온다 — 목록에 없는 건은 이 쓰기로 빠진다.
    const cited = await this.reportEvidence.draftCitations(tx, uid, prior, body, content, c, head?.version ?? 0);
    const structure = await this.reportEvidence.draftStructure(tx, uid, prior, body, content, c, head?.version ?? 0);

    const saved = await this.storeDraft(tx, uid, c.actor, row,
      { ...content, citations: cited.entries, structured: structure.entries });
    // 판독문 전문을 감사로그에 통째로 넣지 않는다 — 길이와 개인정보 때문. 길이만 남긴다.
    await audit(c.actor, 'report.draft', uid, {
      len: [content.findings.length, content.conclusion.length, content.recommendation.length],
      // 인용 감사는 `cid`·칸·수만 남긴다. `findingId`·`sourceIndex`·삽입 문구를 남기면
      // 역할·예비 판독 관문이 없는 감사 통로(`audits()`)로 판독문↔소견 연결이 통째로 새어 나간다.
      ...(cited.detail ? { cits: cited.detail } : {}),
      // 구조화 감사도 **건수와 `sid`만** 남긴다(P16). 고른 값·본문에 들어간 문장·항목 코드를
      // 남기면 역할 관문이 없는 감사 통로로 판독 내용이 새어 나간다.
      ...(structure.detail ? { strs: structure.detail } : {}),
    });
    if (prior && baseVersion > prior.baseVersion)
      await audit(c.actor, 'report.draft.rebase', uid, { from: prior.baseVersion, to: baseVersion });
    /**
     * 답은 저장된 것의 표준 스냅숏이다(U5S-REQ-15). 화면은 owner·uid·revision·스냅숏 전체가 보낸 것과 같을 때만
     * 저장됨으로 본다. 인용·구조화는 식별자만 싣는다 — 전문은 소견 가독을 다시 거는 전용 읽기로만 나간다.
     */
    return { ...draftEnvelope(uid, owner, state.draftEpoch, saved),
      ...(cited.inserted ? { inserted: cited.inserted } : {}),
      // 요청이 `structure`를 실어 보냈을 때만 이 칸이 있다(P9). 화면은 이 `sid` 하나로 유지 목록을 넓힌다.
      ...(structure.applied ? { applied: structure.applied } : {}) };
    }, undefined, { facts, surface: 'PUT studies/:uid/report', action: empty ? 'clear' : 'draft-save' }));
  }

  /**
   * 초안 버리기. 확정본으로 돌아가고 싶을 때 — "쓰다 만 것"과 "저장된 것"이
   * 다를 때 사용자가 고를 수 있어야 한다.
   * 내 초안만 비운다. 남의 초안은 애초에 보이지도 않는다. 행은 경계(revision)만 남긴 자리로 남는다.
   */
  async discardDraft(uid: string, body: any, c: Caller, session: string | null) {
    need(c.roles, 'radiologist', '판독문 저장');
    const owner = draftOwner(body, c);
    const expected = draftExpected(body);
    return this.draftTransaction(uid, c, session, expected.epoch, () => this.studyAccess.prepare(c,[uid]),
      async (tx, state, audit) => {
        const row = await this.ownDraft(tx, uid, c, expected.revision);
        // 초안이 없었어도 경계는 올린다 — 이 버리기보다 앞서 보낸 쓰기가 뒤늦게 닿아 초안을 만들지 못하게.
        const cleared = await this.storeDraft(tx, uid, c.actor, row, null);
        await audit(c.actor, 'report.draft.discard', uid, {});
        const rep = await tx.report.findUnique({ where: { uid } });
        return { ...draftEnvelope(uid, owner, state.draftEpoch, cleared), state: toClient(state, rep, c, cleared) };
      });
  }

  /**
   * 관리자용 초안 강제 해제.
   *
   * 평소의 discardDraft는 **내 초안만** 지운다. 그 경계를 느슨하게 만들어 관리자가
   * 남의 초안을 일반 경로로 지우게 하면, 실수인지 강제 조치인지 이력에서 구분할 수 없다.
   * 그래서 별도 admin 경로에서만 모든 초안을 지우고, 지우기 직전 내용을 판으로 남긴다.
   *
   * 검사 행을 잠근 채(`draftTransaction`) 그 검사의 초안 행을 FOR UPDATE로 고정한다. 조회한 초안과 실제로 비운
   * 초안이 달라지는 틈이 없고, 다른 검사의 자동 저장과 확정까지 멈추는 테이블 락은 잡지 않는다. 같은 검사의 확정도
   * 같은 잠금에 줄을 서므로 판 번호가 겹치지 않는다. 보존·비움·세대 교체·감사는 한 commit이다.
   */
  async forceDiscardDrafts(uid: string, body: any, c: Caller, session: string | null) {
    need(c.roles, 'admin', '판독문 초안 강제 해제');
    const me = inst(c);
    // 관리자도 자기가 본 세대를 보낸다: 그 사이 다른 강제 해제가 있었다면 이 요청은 옛 화면의 것이다.
    draftOwner(body, c);
    const epoch = draftEpochOf(body?.expectedEpoch, 'expectedEpoch');

    // CHECK 백스톱의 409 변환은 그대로 둔다. 판 번호 충돌의 재시도는 없다 — 확정과 강제 해제가 같은 검사 잠금에 줄을 선다.
    return this.reportEvidence.reportLimitChecked(() => this.draftTransaction(uid, c, session, epoch, () => this.studyAccess.prepare(c,[uid]),
      async tx => {
      // 비운 자리(present=false)는 초안이 아니다: 판으로 보존하지도, 건수에 넣지도 않는다.
      const drafts = await tx.$queryRaw<any[]>`
        SELECT uid, author, findings, conclusion, recommendation, "baseVersion", citations, structured, revision, present, "updatedAt"
        FROM "ReportDraft"
        WHERE uid = ${uid} AND present
        ORDER BY author
        FOR UPDATE
      `;
      /**
       * 세대를 **언제나** 바꾼다 — 지울 초안이 없어도. 아직 한 번도 쓰지 않은 작성자의 화면이 강제 해제 전에 보낸
       * 첫 쓰기(revision 0)는 행 대조로는 가릴 수 없다. 세대가 바뀌면 이 검사의 모든 옛 경계가 한꺼번에 거절된다.
       */
      const rotated = await tx.studyState.update({ where: { uid }, data: { draftEpoch: randomUUID() }, select: { draftEpoch: true } });
      if (!drafts.length) {
        // 강제 해제 호출 자체도 관리자 조치다. 지울 것이 없었어도 흔적은 남긴다.
        await tx.auditLog.create({
          data: {
            actor: c.actor, action: 'report.draft.force-discard', target: uid,
            detail: dump({ by: me, drafts: [], versions: [] }),
          },
        });
        return { ok: true, count: 0, drafts: [], versions: [], epoch: rotated.draftEpoch };
      }

      const last = await tx.reportVersion.findFirst({
        where: { uid }, orderBy: { version: 'desc' }, select: { version: true },
      });
      const firstVersion = (last?.version ?? 0) + 1;
      const versions = drafts.map((d, i) => firstVersion + i);
      const summary = drafts.map(d => ({
        author: d.author,
        len: [d.findings.length, d.conclusion.length, d.recommendation.length],
      }));

      await tx.reportVersion.createMany({
        data: drafts.map((d, i) => ({
          uid, version: versions[i], action: 'discarded',
          findings: d.findings, conclusion: d.conclusion, recommendation: d.recommendation,
          // 본문을 판으로 보존하면서 그 본문의 증언만 버리면, 남은 글이 어디서 왔는지 아무도
          // 되짚을 수 없다. 이 판에는 **그 작성자가 넣은 건만** 들어간다.
          // 되읽은 NULL을 그대로 쓰면 Prisma가 거절하므로 칸을 아예 생략한다 —
          // 그러지 않으면 인용이 없던 옛 초안의 강제 해제가 전부 실패한다.
          ...(d.citations === null || d.citations === undefined ? {} : { citations: d.citations }),
          // 구조화도 같은 규칙으로 함께 보존한다. 본문만 판으로 남기고 타입 있는 값을 버리면
          // 보존된 문장이 무엇을 뜻했는지 되짚을 자리가 없어진다 — 강제 해제는 사용자의
          // 실수가 아니라 관리자 조치이므로 더더욱 통째로 남아야 한다.
          ...(d.structured === null || d.structured === undefined ? {} : { structured: d.structured }),
          reason: `관리자 강제 초안 해제 (해제자: ${c.actor})`,
          author: d.author,   // 지운 관리자가 아니라 실제로 **쓴 사람**이 저자다
        })),
      });
      // 판으로 보존한 바로 그 행들만 비운다(잠근 revision일 때만). 각 작성자의 경계도 하나씩 오른다.
      for (const d of drafts) await this.storeDraft(tx, uid, d.author, d, null);
      // 판독문 전문은 감사로그에 넣지 않는다. 누구의 몇 글자를 지웠는지만 남긴다.
      await tx.auditLog.create({
        data: {
          actor: c.actor, action: 'report.draft.force-discard', target: uid,
          detail: dump({ by: me, drafts: summary, versions }),
        },
      });

      return { ok: true, count: drafts.length, drafts: summary, versions, epoch: rotated.draftEpoch };
    }));
  }
}

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

export class PacsReportDraft {
  constructor(
    private readonly prisma: PrismaService,
    private readonly studyAccess: StudyAccessService,
    private readonly access: PacsAccess,
    private readonly audit: PacsAudit,
    private readonly reportEvidence: PacsReportEvidence) {}

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
    return this.reportDraftRules(await this.access.gate(uid,c,tx), c);
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
   */
  async draftTransaction<T>(uid: string, c: Caller, session: string | null, epoch: string,
      prepare: () => Promise<unknown>,
      work: (tx: Prisma.TransactionClient, state: any,
        audit: (actor: string, action: string, target: string, detail?: any) => Promise<any>) => Promise<T>): Promise<T> {
    const me = inst(c);
    await draftBounded(prepare());
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      if (session !== null) {
        const held = await tx.$queryRaw<any[]>`SELECT 1 AS held FROM "AuthSession" WHERE sid = ${session} FOR KEY SHARE`;
        if (!held.length)
          throw new UnauthorizedException({ code: 'AUTH_SESSION_ENDED', message: '인증 세션이 종료되어 판독문 초안을 저장하지 않았습니다' });
      }
      await this.studyAccess.require(c,[uid],tx);
      const states = await tx.$queryRaw<any[]>`SELECT * FROM "StudyState" WHERE uid = ${uid} FOR UPDATE`;
      const state = states[0];
      if (!state || !this.access.visible(state, me)) throw new NotFoundException('검사를 찾을 수 없습니다');
      if (state.draftEpoch !== epoch) throw draftConflict();
      const audit=(actor:string,action:string,target:string,detail?:any)=>tx.auditLog.create({data:{actor:actor||'unknown',action,target,detail:dump(detail)}});
      return work(tx, state, audit);
    },{maxWait:4000,timeout:8000}).catch(draftTransactionError);
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
   */
  async readDraft(uid: string, c: Caller) {
    need(c.roles, 'radiologist', '판독문 초안 조회');
    const owner: DraftOwner = { institution: inst(c), sub: c.sub, author: c.actor };
    await this.studyAccess.prepare(c,[uid]);
    return this.prisma.$transaction(async tx => {
      const state = await this.access.gate(uid, c, tx);
      if (!state) throw new NotFoundException('검사를 찾을 수 없습니다');
      if (!canReadPreliminary(state, c))
        throw new ForbiddenException(
          `예비 판독(RS: P) 중입니다. ${state?.preReviewer ?? '지정된 판독의'}만 볼 수 있습니다.`);
      return draftEnvelope(uid, owner, state.draftEpoch, await this.access.myDraft(uid, c.actor, tx));
    }, { isolationLevel: 'RepeatableRead', maxWait: 2000, timeout: 5000 });
  }

  async dictationGate(uid: string, c: Caller) {
    return this.access.scopeWrite(uid, c, async tx => { await this.reportDraftGate(uid, c, tx); });
  }

  async dictationAudit(uid: string, c: Caller, detail: { bytes: number; seconds: number; ms: number; engine: string; outcome: string }) {
    await this.audit.audit(c.actor, 'dictation.request', uid, detail);
  }

  async putReport(uid: string, body: any, c: Caller, session: string | null) {
    need(c.roles, 'radiologist', '판독문 저장');
    // 작성자·경계·전체 스냅숏의 모양을 어떤 읽기보다 먼저 본다. 거절은 검사·초안 행을 읽거나 쓰거나 감사를 남기지 않는다.
    const owner = draftOwner(body, c);
    const expected = draftExpected(body);
    const content = draftSnapshotInput(body);
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
    }));
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

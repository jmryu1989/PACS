/*
 * 판독문 확정(commitReport): RS 상태 머신, 판(ReportVersion) 추가, 초안 경계 종료와 감사를 한 트랜잭션으로 한다.
 * PacsService가 만들어 소유하는 평범한 객체다(Nest provider가 아니다). 생성자는 참조만 저장한다.
 */
import { canReadPreliminary, designationMatches } from '../preliminary-reader';
import { rightsAllow, lockMemberRights } from '../member-rights';
import type { StudyAccessService } from '../study-access.service';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { KeycloakService } from '../keycloak.service';
import { applyKeepList, citationArray, citationUnion } from '../report-citation';
import { applyStructureKeepList, commitStructureSelection, structureArray, structureUnion } from '../report-structure';
import { holdAlive, toClient, draftOwner, draftExpected, draftEnvelope } from './values';
import { need, inst } from './access';
import type { Caller } from './access';
import { citationLimit, structureLimit, isStructureCheck, isCitationCheck } from './report-evidence';
import type { PacsReportEvidence } from './report-evidence';
import type { PacsReportDraft } from './report-draft';

export class PacsReportCommit {
  constructor(
    private readonly keycloak: KeycloakService,
    private readonly studyAccess: StudyAccessService,
    private readonly reportEvidence: PacsReportEvidence,
    private readonly reportDraft: PacsReportDraft) {}

  /**
   * 판독문 확정. 내용 저장 + 버전 적립 + RS 전이를 **한 번에, 트랜잭션으로** 한다.
   *
   * 왜 한 엔드포인트인가: 예전엔 프론트가 판독문 PUT과 상태 PATCH를 따로 쐈다.
   * 두 요청의 도착 순서가 뒤집히면 "승인됐는데 내용은 이전 것"인 상태가 남는다.
   * 판독문과 그 판독문의 상태는 같이 움직여야 하는 하나의 사실이다.
   */
  async commitReport(uid: string, body: any, c: Caller, session: string | null) {
    need(c.roles, 'radiologist', '판독문 확정');
    const me = inst(c);
    const action = body?.action;
    if (!['save', 'approve', 'addendum', 'reset', 'preliminary', 'defer'].includes(action))
      throw new BadRequestException(`알 수 없는 action: ${action}`);
    // 확정은 내 초안을 끝낸다. 그래서 초안 쓰기와 같은 작성자·경계를 함께 보내고(S7-U5), 판 번호의 낙관적 락은 그것과 따로 선다.
    const owner = draftOwner(body, c);
    const expected = draftExpected(body);
    /**
     * `citationIds`는 **내 초안 건에 대한 유지 목록**, `removeCitationIds`는 **머리 판 건에 대한
     * 명시적 제거 의사**다. 모양만 여기서 본다 — 모르는 값은 거절 사유가 아니라 무동작이다.
     * 그래서 낡은 화면은 제거에 실패할 수는 있어도 **보지 못한 건을 지울 수는 없다.**
     */
    const keepIds = this.reportEvidence.citationKeys(body.citationIds, 'citationIds');
    const removeIds = this.reportEvidence.citationKeys(body.removeCitationIds, 'removeCitationIds');
    // 구조화에는 `removeStructureIds`가 없다(P1). 머리 건이 빠지는 길은 **그 문장이 본문을
    // 떠나는 것** 하나뿐이고, 그래야 지운 적 없는 증언이 목록 하나로 사라지지 않는다.
    const structureKeepIds = this.reportEvidence.structureKeys(body.structureIds, 'structureIds');

    /**
     * 화면의 명부와 별개로, 지정 권한은 아래 트랜잭션에서 DB 회원을 잠그고 판정한다.
     * 명부 반영이 늦어도 철회된 판독의나 다른 기관 회원을 지정할 수 없다.
     */
    const wanted = action === 'preliminary' ? String(body.reviewer ?? '').trim() : '';
    let candidate: { sub: string } | null = null;

    try {
      return await this.reportDraft.draftTransaction(uid, c, session, expected.epoch, async () => {
        await this.studyAccess.prepare(c,[uid]);
        if (action === 'preliminary') {
          // Resolve the current picker identity before holding study/session locks over network I/O.
          const roster = await this.keycloak.usersInGroupWithRole(me, 'radiologist', true);
          const candidates = roster.filter(user => user.id === wanted);
          candidate = candidates.length === 1 ? candidates[0] : null;
        }
      }, async (tx, prev, audit) => {
    if (prev?.ss === 'Unverified' && prev.em !== 'E')
      throw new ConflictException('촬영 중(미확인) 검사입니다 — 기사 확인(Verify) 뒤 판독할 수 있습니다');
    const heldByOther = holdAlive(prev) && prev.holder !== c.actor ? prev.holder : null;
    if (heldByOther)
      throw new ConflictException({ code: 'REPORT_HELD', holder: heldByOther, message: `${heldByOther} 님이 판독 중입니다` });

    // 예비 판독 중인 검사는 지정된 두 사람 말고는 쓰지도 못한다.
    // 읽기만 막고 쓰기를 열어두면, 내용을 못 본 채로 덮어쓸 수 있다 — 더 나쁘다.
    if (!canReadPreliminary(prev, c))
      throw new ForbiddenException(
        `예비 판독(RS: P) 중입니다. ${prev?.preReviewer ?? '지정된 판독의'}만 이어서 판독할 수 있습니다.`);

    // Addendum은 승인된 판독에만 붙는다. 승인 전이라면 그냥 고쳐 쓰면 되기 때문.
    if (action === 'addendum' && prev?.rs !== 'A')
      throw new BadRequestException('Addendum은 승인(RS: A)된 판독문에만 붙일 수 있습니다');

    /**
     * 승인(A)에서 나가는 길도 둘뿐이다 — 이전 판을 남기는 Addendum, 사유가 남는 Reset.
     *
     * v0.6.3 회귀 확충에서 드러났다: `save`는 사유 없이 승인을 T로 떨어뜨리면서 repDoc·confirm을
     * 그대로 남겨 화면이 "읽었다"와 "아직 안 읽었다"를 동시에 말하게 했고, `approve`는 다른 판독의가
     * 본문과 승인자 이름을 조용히 갈아치우는 무표시 재승인이었다. 화면은 Save를 회색으로도 안 막았다.
     * P의 출구 규칙과 같은 모양으로 닫는다 — 하나만 닫으면 나머지 하나가 문이다.
     */
    if (prev?.rs === 'A' && (action === 'save' || action === 'approve'))
      throw new BadRequestException('승인된 판독문은 추가기재(Addendum) 또는 판독 취소(Reset)로만 바꿀 수 있습니다');

    // 판독을 되돌리는 것은 기록을 지우는 일이다. 사유 없이는 안 된다. (교훈 §1)
    if (action === 'reset' && !String(body.reason ?? '').trim())
      throw new BadRequestException('판독 취소에는 사유가 필요합니다');
    if (action === 'defer') {
      if (!String(body.reason ?? '').trim())
        throw new BadRequestException('보류에는 사유가 필요합니다');
      if (prev.rs === 'P')
        throw new BadRequestException('예비 판독(RS: P)은 보류할 수 없습니다 — 승인 또는 취소만 가능합니다');
      if (prev.rs === 'A')
        throw new BadRequestException('승인된 판독문은 보류할 수 없습니다. 먼저 판독 취소(Reset)를 하세요');
      if (!['W', 'T', 'H'].includes(prev.rs))
        throw new BadRequestException('대기·임시저장·보류 상태에서만 보류할 수 있습니다');
    }

    /**
     * ── Preliminary (RS=P) ──
     * "전문의가 상급 판독의를 지정하여 상급 판독의가 최종 판독하는 시스템"
     * (HPACS 매뉴얼 7.4.1.3-4). 별도의 전공의 롤이 있는 게 아니라, 누가 누구에게
     * 넘기느냐의 문제다. RS는 진행률이 아니라 **책임의 이전**을 표현한다 (교훈 §14).
     *
     * 지정 대상은 서버가 Keycloak에 물어 **실제로 존재하는 우리 기관 판독의**인지
     * 확인한다. 이 값이 판독문 접근을 좌우하므로, 클라이언트가 보낸 문자열을
     * 그대로 믿으면 오타 하나로 아무도 못 여는 판독문이 생긴다.
     */
    let reviewer: string | undefined;
    if (action === 'preliminary') {
      /**
       * 이미 승인된 판독문은 예비 판독으로 되돌릴 수 없다.
       *
       * 허용하면 확정된 의무기록이 지정된 두 사람만의 것이 되고, 본문이 body의
       * 빈 값으로 덮인다. 실제로 그렇게 됐다 — 승인자 본인조차 자기 판독문을 못 봤다.
       * 되돌리려면 사유가 남는 Reset을 거쳐야 한다.
       */
      if (prev?.rs === 'A')
        throw new BadRequestException(
          '승인된 판독문은 예비 판독으로 되돌릴 수 없습니다. 먼저 판독 취소(Reset)를 하세요');
      /**
       * 예비 판독(P) 중에는 다시 지정하지 못한다.
       *
       * 열어두면 사유 없이 preDoc이 호출자로 덮어써진다. 지정된 상급자가 작성자를 거꾸로
       * 지정하면 작성자가 preReviewer만 보는 아래 승인 관문을 지나 자기 예비 판독을 스스로
       * 승인하고, 제3자에게 넘기면 원래의 두 사람이 판독문에서 잠긴다. P에서 나가는 길은
       * 지정된 상급자의 승인과 사유가 남는 취소 둘뿐이다 — 지정을 바꾸려면 취소 뒤 다시 지정한다.
       * 화면도 P에서 Prelim을 막지만 화면 잠금이 서버 검사를 대신하지는 않는다.
       */
      if (prev?.rs === 'P')
        throw new BadRequestException(
          '예비 판독(RS: P) 중에는 지정을 바꿀 수 없습니다 — 사유를 남기는 판독 취소(Reset) 뒤 다시 지정하세요');
      reviewer = wanted;
      if (!reviewer) throw new BadRequestException('상급 판독의를 지정해야 합니다');
      if (reviewer === c.actor) throw new BadRequestException('자기 자신을 상급 판독의로 지정할 수 없습니다');
      if (candidate?.sub === c.sub) throw new BadRequestException('자기 자신을 상급 판독의로 지정할 수 없습니다');
      if (candidate) await lockMemberRights(tx, candidate.sub);
      const current = candidate && await tx.memberRights.findUnique({ where: { sub: candidate.sub } });
      if (!rightsAllow(current) || current.institution !== me || !current.roles.includes('radiologist'))
        throw new BadRequestException(`${reviewer} 은(는) 이 기관의 판독의가 아닙니다`);
    }

    // 승인으로 P를 끝내는 것은 **지정된 상급 판독의**의 일이다.
    // 예비 판독을 쓴 사람이 스스로 승인하면 감독이라는 절차 자체가 없어진다.
    if (action === 'approve' && prev?.rs === 'P' && !designationMatches(prev.preReviewer, prev.preReviewerSub, c))
      throw new ForbiddenException(
        `예비 판독의 최종 승인은 지정된 상급 판독의(${prev.preReviewer})만 할 수 있습니다`);

    let rs = { save: 'T', approve: 'A', addendum: 'A', reset: 'W', preliminary: 'P', defer: 'H' }[action as string];

    /**
     * **예비 판독 중에는 임시 저장이 P를 풀지 못한다.**
     *
     * 이걸 빼먹어서 감독이 통째로 우회됐다: 작성자가 `save`로 RS를 T로 떨어뜨린 뒤
     * `approve`를 부르면, 위의 검사가 `prev.rs === 'P'`를 보므로 그냥 통과했다.
     * 정상 호출 두 번에 상급자 감독이 사라졌다.
     *
     * P에서 빠져나가는 길은 두 개뿐이다 — 지정된 상급자의 승인, 또는 사유가 남는 취소.
     * 그 사이의 저장은 여전히 예비 판독이다.
     */
    if (prev?.rs === 'P' && action === 'save') rs = 'P';
    const content = action === 'reset'
      ? { findings: '', conclusion: '', recommendation: '' }
      : {
          findings: body.findings ?? '',
          conclusion: body.conclusion ?? '',
          recommendation: body.recommendation ?? '',
        };

    const stateData: any = { rs, holder: null, heldAt: null };   // 확정하면 점유가 풀린다
    stateData.holdReason = action === 'defer' ? body.reason : null;
    if (action === 'preliminary') {
      stateData.preDoc = c.actor;
      stateData.preReviewer = reviewer;
      stateData.preDocSub = c.sub;
      stateData.preReviewerSub = candidate!.sub;
    }
    // 판독이 되돌아가면 지정도 풀린다. RS는 W인데 "누구에게 맡겨져 있음"이 남아
    // 판독문이 계속 가려지는 상태가 제일 나쁘다.
    if (action === 'reset') {
      // 판독이 되돌아가면 그 판독에 딸린 이름도 함께 지운다. RS는 W인데 RepDoc에
      // 판독의 이름과 확정일이 남아 있으면, 화면은 "누가 읽었다"고 말하면서
      // 동시에 "아직 안 읽었다"고 말하는 셈이다.
      stateData.preDoc = null; stateData.preReviewer = null;
      stateData.preDocSub = null; stateData.preReviewerSub = null;
      stateData.repDoc = null; stateData.confirm = null;
    }
    if (action === 'approve' || action === 'addendum') {
      stateData.repDoc = c.actor.split('@')[0];
      stateData.confirm = new Date().toISOString().slice(0, 10);
      // 원격판독으로 받은 검사를 승인하면 의뢰 기관에 "끝났다"가 보여야 한다.
      // 상태가 상대편에 도달하지 않으면 워크플로가 아니라 파일 전송일 뿐이다 (교훈 §10).
      if (prev?.teleInstitutionId === me && prev?.institutionId !== me) stateData.ts = 'completed';
    }

        // 검사 행(StudyState)은 `draftTransaction`이 이미 잠갔다 — 첫 확정에는 아직 Report 행이 없어 FOR UPDATE만으로
        // 잠글 수 없으므로, 항상 존재하는 그 부모 잠금이 첫 판부터 같은 uid의 확정을 직렬화한다.
        // 안정된 부모 행을 잡은 뒤 현재 Report를 잠근 채 판 번호를 읽는다.
        const [cur] = await tx.$queryRaw<any[]>`
          SELECT version, "updatedBy", findings, conclusion, recommendation
          FROM "Report" WHERE uid = ${uid} FOR UPDATE`;

        /**
         * 내 초안 행을 **잠그고** 경계를 대조한 뒤 읽는다.
         *
         * 잠그지 않으면 다른 탭의 삽입이 이 읽기와 아래의 초안 비우기 사이에 끼어들 수 있고,
         * 그러면 사용자가 미리보기에서 확인까지 마친 문장의 증언이 행과 함께 사라진다 —
         * 잃는 것이 남의 것이 아니라 **본인이 방금 한 일**이다. 경계가 다르면(다른 탭이 그사이 저장·비움) 이 확정은
         * 자기가 보지 못한 초안을 끝내려는 것이라 거절한다.
         *
         * 잠금 순서는 (세션 →) StudyState → Report → 내 초안이고, 강제 해제는 StudyState → 초안들,
         * 초안 저장은 StudyState → 내 초안이다. 모두 같은 방향이라 순환이 없다.
         */
        const mine = await this.reportDraft.ownDraft(tx, uid, c, expected.revision);
        const draft = mine?.present ? mine : null;

        if (body.baseVersion === undefined)
          throw new BadRequestException('baseVersion이 필요합니다 (화면이 마지막으로 본 판 번호)');

        /**
         * **낡은 초안은 승인본에 덧붙지 못한다.**
         *
         * 화면이 보내는 `baseVersion`은 본문을 다시 그리지 않고도 올라간다 —
         * PATCH 응답 한 번이면 `appState`의 판 번호가 최신이 된다.
         * 그러면 아래 낙관적 락은 통과하고, 며칠 전 초안이 그 사이 승인된 판독문을
         * 통째로 대체한다(원장 IF-A24 「승인본 자동 덮어쓰기 금지」).
         * 그래서 화면이 말하는 판이 아니라 **초안 행에 적힌 판**을 본다.
         *
         * 아래 낙관적 락보다 **먼저** 본다. 락이 먼저 걸리면 사람은 "다시 불러오라"는
         * 옛 안내를 받고, 그 경로는 쓰던 글을 서버 내용으로 덮는다 — 정확히 이 단위가
         * 막으려는 손실이다. 거절 본문은 이미 잠가서 읽은 `cur` 행 그대로이므로
         * 추가 조회가 없고, 여기까지 온 호출자는 예비 판독·기관·역할 관문을 모두 지났다.
         *
         * 심층 방어다. 초안이 없는 확정은 구조적으로 이 관문을 지나가고,
         * `baseVersion`의 출처가 틀린 화면은 조용히 통과한다.
         */
        if (action === 'addendum' && draft && draft.baseVersion < (cur?.version ?? 0))
          throw new ConflictException({
            code: 'REPORT_DRAFT_STALE',
            message: `이 초안은 v${draft.baseVersion}을 기준으로 씁니다. 지금 승인본은 ` +
              `v${cur.version}입니다 — 승인본을 확인한 뒤 기준을 다시 잡아 주세요.`,
            head: {
              version: cur.version, updatedBy: cur.updatedBy ?? null,
              findings: cur.findings, conclusion: cur.conclusion, recommendation: cur.recommendation,
            },
            draftBaseVersion: draft.baseVersion,
          });

        if ((cur?.version ?? 0) !== body.baseVersion)
          throw new ConflictException(
            `그 사이 ${cur?.updatedBy ?? '다른 사용자'}가 v${cur?.version}을 저장했습니다. ` +
            `내용을 다시 불러온 뒤 작성해 주세요.`);

        /**
         * **이월은 머리 판에서만 온다.**
         *
         * 바로 아래 `last`는 머리 판이 아니다 — reset과 관리자 강제 해제가 만든 `discarded`
         * 행이 더 큰 번호를 갖고도 `Report.version`을 움직이지 않기 때문이다. 그것을 머리로
         * 쓰면 **남의 확정되지 않은 초안 인용이 내 서명 판에 「이월됨」으로 들어간다.**
         * 머리 판은 오직 `ReportVersion(uid, Report.version)` 한 행이고, 그 행은 불변이다.
         *
         * 낙관적 락 **뒤**에 읽는다. 거절되는 확정은 아무것도 더 읽지 않아야 한다.
         */
        const headCitations = await this.reportEvidence.versionCitations(tx, uid, cur?.version ?? 0);
        const headStructured = await this.reportEvidence.versionStructured(tx, uid, cur?.version ?? 0);
        const { kept, ignored } = applyKeepList(citationArray(draft?.citations), keepIds);
        const union = citationUnion(headCitations, removeIds, kept);
        const mineStructured = applyStructureKeepList(structureArray(draft?.structured), structureKeepIds);
        // 세 칸이 빈 확정과 reset은 본문이 없으니 증언할 것도 없다.
        const blank = !(content.findings || content.conclusion || content.recommendation);
        const citations = (action === 'reset' || blank) ? [] : union.entries;
        /**
         * 확정 시 **소견 검증은 하지 않는다.** 삽입 뒤 소견이 숨겨지거나 비교 검사 접근이
         * 회수되어도 서명은 막히지 않는다 — 기록을 남기지 못하게 하는 쪽이 더 나쁘다.
         * 한도 초과만이 새 거절이다.
         */
        await this.reportEvidence.citationBudget(tx, citations);
        const citationAudit = (citations.length || union.removed.length || ignored)
          ? { n: citations.length, ...(union.removed.length ? { dropped: union.removed } : {}),
              ...(ignored ? { ignored } : {}) } : null;

        /**
         * 구조화는 **한 가지 규칙**으로 고른다 (P1): 머리에서 왔든 초안에서 왔든, 그 문장이
         * 확정될 본문에 있을 때만 실린다. 인용과 달리 출처를 다시 묻지 않는다 — 구조화 건은
         * 자기 문장 말고 아무것도 가리키지 않기 때문이다.
         */
        const selection = commitStructureSelection(
          structureUnion(headStructured, mineStructured.kept), content, blank, action === 'reset');
        const structured = selection.entries;
        await this.reportEvidence.structureBudget(tx, structured);
        const structureAudit = (structured.length || selection.dropped.length || mineStructured.ignored)
          ? { n: structured.length, ...(selection.dropped.length ? { dropped: selection.dropped } : {}),
              ...(mineStructured.ignored ? { ignored: mineStructured.ignored } : {}) } : null;

        const last = await tx.reportVersion.findFirst({
          where: { uid }, orderBy: { version: 'desc' }, select: { version: true },
        });
        let version = (last?.version ?? 0) + 1;

        // Reset은 현재 판독문을 비우기 직전에 이력으로 보존한다. 같은 트랜잭션이라
        // 실패하면 비움도 스냅샷도 함께 취소되어 판독문을 잃을 틈이 없다.
        if (action === 'reset' && cur &&
            (cur.findings || cur.conclusion || cur.recommendation)) {
          await tx.reportVersion.create({ data: {
            uid, version, action: 'discarded',
            findings: cur.findings, conclusion: cur.conclusion,
            recommendation: cur.recommendation,
            // 비우기 직전의 본문을 판으로 남기면서 그 증언만 버리면, 보존된 글이 어디서
            // 왔는지 되짚을 수 없다. 같은 머리 판 행에서 읽은 그대로 함께 보존한다.
            citations: headCitations,
            // 구조화도 같은 이유로 함께 보존한다. 다만 빈 배열은 저장하지 않는다(P13) —
            // "없음"의 모양은 NULL 하나여야 읽는 쪽이 두 가지를 구분할 일이 없다.
            ...(headStructured.length ? { structured: headStructured } : {}),
            reason: `판독 취소로 폐기 (취소자: ${c.actor})`,
            author: cur.updatedBy ?? c.actor,
          }});
          version += 1;
        }

        const state = await tx.studyState.update({ where: { uid }, data: stateData });
        const report = await tx.report.upsert({ where: { uid },
          create: { uid, ...content, version, updatedBy: c.actor },
          update: { ...content, version, updatedBy: c.actor } });
        // 인용은 **`ReportVersion` 행에만** 쓴다. `Report`에는 칸이 없다 — 거울을 두면
        // 같은 사실이 두 곳에서 엇갈릴 수 있고, 그 순간 어느 쪽이 기록인지 말할 수 없다.
        await tx.reportVersion.create({ data: {
          uid, version, action, ...content, citations,
          ...(structured.length ? { structured } : {}),
          reason: body.reason ?? null, author: c.actor } });
        // 확정에 실패하면 초안도 남아야 하므로 같은 트랜잭션에서 비운다. 초안이 없던 확정도 경계를 올린다 —
        // 이 확정보다 앞서 보낸 초안 쓰기가 뒤늦게 닿아 확정 뒤에 초안을 만들지 못한다.
        const cleared = await this.reportDraft.storeDraft(tx, uid, c.actor, mine, null);

        /**
         * 감사 행은 **같은 트랜잭션에서** 쓴다(U5S-REQ-03). 밖에서 쓰면 확정은 남고 감사만 실패한 판이 생긴다 —
         * 누가 서명했는지의 기록이 없는 서명이다. 감사가 실패하면 확정·판·초안 비움이 모두 되돌아간다.
         */
        await audit(c.actor, `report.${action}`, uid, {
          version, by: me,
          len: [content.findings.length, content.conclusion.length, content.recommendation.length],
          reason: body.reason ?? undefined,
          reviewer,   // 누구에게 맡겼는가. 책임이 옮겨간 기록이므로 감사로그에 남아야 한다.
          // 몇 건이 남았고 무엇이 **지워졌는가**. 지워진 증언은 되짚을 자리가 여기뿐이라
          // `cid`는 남기지만, `findingId`·`sourceIndex`·문구는 남기지 않는다.
          ...(citationAudit ? { cits: citationAudit } : {}),
          // 구조화도 같은 규칙이다 — 건수와 `sid`만. 값·문장·항목 코드는 남기지 않는다(P16).
          ...(structureAudit ? { strs: structureAudit } : {}),
        });

        return { ...draftEnvelope(uid, owner, state.draftEpoch, cleared), state: toClient(state, report, c, cleared) };
      });
    } catch (e: any) {
      // CHECK 백스톱도 서버 고장이 아니라 명명된 409다. 우리 제약 이름일 때만 옮긴다.
      if (isCitationCheck(e)) citationLimit();
      if (isStructureCheck(e)) structureLimit();
      // @@unique(uid, version)은 최종 방어선이다. 불변조건이 깨져 충돌하더라도
      // 서버 고장으로 노출하지 않도록 C-1의 409 변환은 그대로 유지한다.
      if (e?.code === 'P2002')
        throw new ConflictException(
          '다른 사용자가 방금 이 판독문을 확정했습니다. 내용을 다시 불러온 뒤 확정해 주세요.');
      throw e;
    }
  }
}

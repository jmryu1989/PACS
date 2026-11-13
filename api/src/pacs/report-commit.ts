/*
 * 판독문 확정(commitReport): RS 상태 머신, 판(ReportVersion) 추가, 초안 경계 종료와 감사를 한 트랜잭션으로 한다.
 * PacsService가 만들어 소유하는 평범한 객체다(Nest provider가 아니다). 생성자는 참조만 저장한다.
 */
import { canReadPreliminary, designationMatches } from '../preliminary-reader';
import { rightsAllow, lockMemberRights } from '../member-rights';
import type { StudyAccessService } from '../study-access.service';
import { BadRequestException, ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import type { NativeReportSigning } from '../emr-report/native-signing';
import { ContractError } from '../emr-contract/validation';
import type { KeycloakService } from '../keycloak.service';
import { applyKeepList, citationArray, citationUnion } from '../report-citation';
import { applyStructureKeepList, commitStructureSelection, structureArray, structureUnion } from '../report-structure';
import { holdAlive, reportHeld, visibleHolder, toClient, draftOwner, draftExpected, draftEnvelope, amendUntil } from './values';
import { need, inst } from './access';
import type { Caller } from './access';
import { citationLimit, structureLimit, isStructureCheck, isCitationCheck } from './report-evidence';
import type { PacsReportEvidence } from './report-evidence';
import type { PacsReportDraft, DraftRequestFacts, EndedWork } from './report-draft';

export class PacsReportCommit {
  constructor(
    private readonly keycloak: KeycloakService,
    private readonly studyAccess: StudyAccessService,
    private readonly reportEvidence: PacsReportEvidence,
    private readonly reportDraft: PacsReportDraft,
    private readonly signing?: NativeReportSigning) {}

  /**
   * 판독문 확정. 내용 저장 + 버전 적립 + RS 전이를 **한 번에, 트랜잭션으로** 한다.
   *
   * 왜 한 엔드포인트인가: 예전엔 프론트가 판독문 PUT과 상태 PATCH를 따로 쐈다.
   * 두 요청의 도착 순서가 뒤집히면 "승인됐는데 내용은 이전 것"인 상태가 남는다.
   * 판독문과 그 판독문의 상태는 같이 움직여야 하는 하나의 사실이다.
   */
  async commitReport(uid: string, body: any, c: Caller, session: string | null, facts: DraftRequestFacts) {
    need(c.roles, 'radiologist', '판독문 확정');
    const me = inst(c);
    const action = body?.action;
    if (!['save', 'approve', 'amend', 'addendum', 'reset', 'preliminary', 'defer'].includes(action))
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

    // CD-09-P: the work this commit ends by its own signed result, or by the author's Reset that keeps none of it.
    let ended: EndedWork | null = null;
    try {
      // The answer follows the commit judgement of the end (settleEnding), never the transaction's promise alone.
      return await this.reportDraft.settleEnding(() => this.reportDraft.draftTransaction(uid, c, session, expected.epoch, async () => {
        await this.studyAccess.prepare(c,[uid]);
        if (action === 'preliminary') {
          // Resolve the current picker identity before holding study/session locks over network I/O.
          const roster = await this.keycloak.usersInGroupWithRole(me, 'radiologist', true);
          const candidates = roster.filter(user => user.id === wanted);
          candidate = candidates.length === 1 ? candidates[0] : null;
        }
      }, async (tx, prev, audit, record) => {
    if (prev?.ss === 'Unverified' && prev.em !== 'E')
      throw new ConflictException('촬영 중(미확인) 검사입니다 — 기사 확인(Verify) 뒤 판독할 수 있습니다');
    const heldByOther = holdAlive(prev) && prev.holder !== c.actor ? prev.holder : null;
    // 진행 중 판독 되돌리기는 "남이 Save해 둔 글"을 판정에 쓰므로 그 후보(W·T·H의 reset)만 머리 판을 여기서 잠가 읽는다.
    // 예비 판독(P) 관문에 걸리는 호출은 이 후보가 아니다 — 거절되는 호출이 Report 행에 닿지 않는다는 약속은 그대로다.
    const inProgress = action === 'reset' && ['W', 'T', 'H'].includes(prev?.rs);
    const early = inProgress ? await this.lockHead(tx, uid) : undefined;
    /**
     * ── FC-040 진행 중 판독 되돌리기 ──
     * 대기·임시저장·보류(W·T·H)인 검사를 남이 판독 중이거나(살아 있는 점유) 남이 Save해 둔 글이 머리에 있으면, 판독의 누구나
     * Reset으로 점유를 풀고 Unread로 되돌린다. 자리를 비운 화면의 점유가 검사를 붙잡아 두지 못하게 한다.
     * 승인본(A)에는 이 길이 없다(남의 점유는 그대로 REPORT_HELD, 승인본 취소는 사유 필수 그대로). 예비 판독(P)도 기존
     * 길 그대로다 — 점유를 우회하지 않고, 두 사람만, 사유 필수. 내 글만 있는 검사도 지금처럼 사유를 받는다.
     * 사유는 묻지 않고 **이 잠금 안에서** 서버가 만든다: 요청이 본 것이 아니라 지금 잠근 점유·저장 글이 기록된다.
     */
    const savedByOther = early?.updatedBy && early.updatedBy !== c.actor && (early.findings || early.conclusion || early.recommendation)
      ? early.updatedBy as string : null;
    const takeover = inProgress && (heldByOther || savedByOther)
      ? { holder: heldByOther ? visibleHolder(prev, c) : null, heldAt: heldByOther ? prev.heldAt : null, savedBy: savedByOther }
      : null;
    if (heldByOther && !takeover)
      throw reportHeld(prev, c);
    const reason: string | null = takeover
      ? `진행 중 판독 되돌림 (점유: ${takeover.holder ?? '없음'}, 저장 글: ${takeover.savedBy ?? '없음'})`
      : body.reason ?? null;

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
      throw new BadRequestException('승인된 판독문은 24시간 안의 수정(승인한 판독의), 추가기재(Addendum) 또는 판독 취소(Reset)로만 바꿀 수 있습니다');

    /**
     * ── FC-034 승인 뒤 24시간 수정(amend) ──
     * 첫 승인 시각(`approvedAt`)부터 24시간, 승인한 본인만(`approvedBySub`), Addendum이 붙기 전까지 본문을 고쳐 다시 서명한다.
     * 판정은 검사 행을 잠근 뒤 **서버 시각**으로 한다. 고쳐도 창은 다시 시작하지 않는다(approvedAt은 그대로).
     * 승인 시각을 모르는 옛 승인본은 "24시간 지남"이라고 말하지 않는다 — 수정은 없고 Addendum만이다.
     * 고친 글이 있는지는 머리 판을 잠가 읽은 뒤(아래) 본다.
     */
    if (action === 'amend') {
      if (prev?.rs !== 'A')
        throw new BadRequestException('승인 후 24시간 안의 수정은 승인(RS: A)된 판독문에만 할 수 있습니다');
      if (!prev.approvedAt)
        throw new BadRequestException('승인 시각을 확인할 수 없는 판독문입니다. Addendum으로만 덧붙일 수 있습니다');
      if (this.commitClock() >= amendUntil(prev.approvedAt)!.getTime())
        throw new BadRequestException('승인 후 24시간이 지나 Finalized된 판독문입니다. Addendum으로만 덧붙일 수 있습니다');
      if (prev.addendumAt)
        throw new BadRequestException('추가기재(Addendum)가 붙은 판독문은 Addendum으로만 바꿀 수 있습니다');
      if (!prev.approvedBySub || prev.approvedBySub !== c.sub)
        throw new BadRequestException('승인 후 24시간 안의 본문 수정은 승인한 판독의만 할 수 있습니다. 덧붙이려면 Addendum을 쓰세요');
    }

    // 판독을 되돌리는 것은 기록을 지우는 일이다. 사유 없이는 안 된다. (교훈 §1)
    if (action === 'reset' && !takeover && !String(body.reason ?? '').trim())
      throw new BadRequestException('판독 취소에는 사유가 필요합니다');
    if (action === 'defer') {
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

    let rs = { save: 'T', approve: 'A', amend: 'A', addendum: 'A', reset: 'W', preliminary: 'P', defer: 'H' }[action as string];

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

    const stateData: any = { rs, holder: null, holderInstitutionId: null, heldAt: null };   // 확정하면 점유가 풀린다
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
    /**
     * FC-034 지금 승인 회차의 조회값. 승인이 회차를 새로 열고(창의 시작·승인자), 수정은 시각만 남기고(rs·repDoc·confirm 그대로),
     * Addendum은 그 뒤로 수정을 닫고, 되돌리기는 회차를 지운다. 판 행과 같은 트랜잭션에서 쓴다.
     */
    const at = new Date(this.commitClock());
    if (action === 'approve')
      Object.assign(stateData, { approvedAt: at, approvedBySub: c.sub, amendedAt: null, addendumAt: null });
    if (action === 'amend') stateData.amendedAt = at;
    if (action === 'addendum') stateData.addendumAt = at;
    if (action === 'reset')
      Object.assign(stateData, { approvedAt: null, approvedBySub: null, amendedAt: null, addendumAt: null });

        // 검사 행(StudyState)은 `draftTransaction`이 이미 잠갔다 — 첫 확정에는 아직 Report 행이 없어 FOR UPDATE만으로
        // 잠글 수 없으므로, 항상 존재하는 그 부모 잠금이 첫 판부터 같은 uid의 확정을 직렬화한다.
        // 안정된 부모 행을 잡은 뒤 현재 Report를 잠근 채 판 번호를 읽는다(되돌리기 후보는 위에서 이미 잠가 읽었다).
        const cur = inProgress ? early : await this.lockHead(tx, uid);

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
        if ((action === 'addendum' || action === 'amend') && draft && draft.baseVersion < (cur?.version ?? 0))
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

        // FC-034: 수정은 고친 글이 있어야 한다 — 같은 글의 재서명은 판만 늘린다. 잠가 읽은 머리 판과 세 칸을 견준다.
        if (action === 'amend' && (!cur || (['findings', 'conclusion', 'recommendation'] as const)
            .every(k => (content as any)[k] === (cur[k] ?? ''))))
          throw new BadRequestException('고친 내용이 없습니다');

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
          await record(prev, null, 'cancel', { uid, version });
          version += 1;
        }

        /**
         * FC-040: 되돌린 사람에게는 남의 글 내용이 아니라 **있다는 사실만** 돌려준다. 점유자의 개인 초안은 건드리지 않고
         * (있는지만 본다 — 같은 부모 잠금 아래라 이 읽기와 그 사람의 초안 쓰기는 엇갈리지 않는다), 남이 Save해 둔 글은
         * 위의 `discarded` 판에 더해 그 글을 쓴 사람의 개인 초안으로 옮긴다(그 사람에게 살아 있는 초안이 없을 때만).
         */
        let released: { holder: string | null; holderDraft: boolean; savedBy: string | null; savedKept: boolean } | null = null;
        if (takeover) {
          const holderDraft = !!heldByOther && !!(await tx.reportDraft.findUnique({
            where: { uid_author: { uid, author: heldByOther } }, select: { present: true } }))?.present;
          const savedKept = !!savedByOther && await this.reportDraft.keepSavedText(tx, uid, prev.draftEpoch, savedByOther, {
            findings: cur.findings, conclusion: cur.conclusion, recommendation: cur.recommendation,
            baseVersion: cur.version, citations: headCitations, structured: headStructured,
          }, source => record!(prev, null, 'draft-save', source));
          released = { holder: takeover.holder, holderDraft, savedBy: savedByOther, savedKept };
        }

        const state = await tx.studyState.update({ where: { uid }, data: stateData });
        const report = await tx.report.upsert({ where: { uid },
          create: { uid, ...content, version, updatedBy: c.actor },
          update: { ...content, version, updatedBy: c.actor } });
        // 인용은 **`ReportVersion` 행에만** 쓴다. `Report`에는 칸이 없다 — 거울을 두면
        // 같은 사실이 두 곳에서 엇갈릴 수 있고, 그 순간 어느 쪽이 기록인지 말할 수 없다.
        const savedVersion = await tx.reportVersion.create({ data: {
          uid, version, action, ...content, citations,
          ...(structured.length ? { structured } : {}),
          reason, author: c.actor } });
        let signature = null;
        // An empty reset before any report exists is only a state change. C2
        // cancellation refers to a real previous version; never invent one.
        // 수정(amend)이 묶는 이전 판은 직전 머리 판(`cur.version`)이다 — 두 번째 수정은 첫 수정 판을 잇는다.
        if (['approve', 'amend', 'addendum'].includes(action) || action === 'reset' && cur) {
          if (!this.signing || !facts.request) throw new ServiceUnavailableException('온라인 서명 연결을 확인할 수 없습니다. 입력은 보존됩니다.');
          try { signature = await this.signing.sign(tx, facts.request, facts.requestId, savedVersion, cur?.version ?? 0); }
          catch (error) {
            // 이 계정이 쓸 수 있는 서명키가 없어 거절된 승인은 그 까닭과 할 일을 말한다 — 일반 문구만 실으면 판독의는 다시 눌러
            // 볼 뿐이고, 풀 수 있는 사람(기관 관리자)에게 닿지 않는다. 그 code는 키가 없을 때(만든 적 없음·폐기·정지)와 키의 신원이
            // 이 계정과 다를 때 모두 나오므로 어느 하나로 단정하지 않는다. 상태와 code는 그대로다(문구만 다르다).
            if (error instanceof ContractError) throw new ServiceUnavailableException({ code: error.code,
              message: error.code === 'DoctorSigningKeyUnavailable'
                ? '이 계정에서 사용할 수 있는 서명키를 확인하지 못해 승인하지 못했습니다. 기관 관리자에게 서명키(Signing Key)와 계정 정보 확인을 요청하세요. 판독 입력은 보존됩니다.'
                : '온라인 서명을 완료하지 못했습니다. 판독 입력은 보존됩니다.' });
            throw error;
          }
        }
        // 확정에 실패하면 초안도 남아야 하므로 같은 트랜잭션에서 비운다. 초안이 없던 확정도 경계를 올린다 —
        // 이 확정보다 앞서 보낸 초안 쓰기가 뒤늦게 닿아 확정 뒤에 초안을 만들지 못한다.
        if ((action === 'approve' || action === 'amend' || action === 'addendum') && signature)
          ended = await this.reportDraft.endWork(tx, mine, c.actor, { trigger: 'result-version-signed', action: action as 'approve' | 'amend' | 'addendum', signed: signature });
        else if (action === 'reset')
          ended = await this.reportDraft.endWork(tx, mine, c.actor, { trigger: 'explicit-discard' });
        const cleared = await this.reportDraft.storeDraft(tx, uid, c.actor, mine, null);

        /**
         * 감사 행은 **같은 트랜잭션에서** 쓴다(U5S-REQ-03). 밖에서 쓰면 확정은 남고 감사만 실패한 판이 생긴다 —
         * 누가 서명했는지의 기록이 없는 서명이다. 감사가 실패하면 확정·판·초안 비움이 모두 되돌아간다.
         */
        await audit(c.actor, `report.${action}`, uid, {
          version, by: me,
          len: [content.findings.length, content.conclusion.length, content.recommendation.length],
          reason: reason ?? undefined,
          reviewer,   // 누구에게 맡겼는가. 책임이 옮겨간 기록이므로 감사로그에 남아야 한다.
          // 진행 중 판독 되돌리기가 풀어 준 점유와 남의 저장 글. 사유 문장과 같은 사실을 따로 읽을 수 있게 둔다.
          ...(takeover ? { takeover } : {}),
          // 몇 건이 남았고 무엇이 **지워졌는가**. 지워진 증언은 되짚을 자리가 여기뿐이라
          // `cid`는 남기지만, `findingId`·`sourceIndex`·문구는 남기지 않는다.
          ...(citationAudit ? { cits: citationAudit } : {}),
          // 구조화도 같은 규칙이다 — 건수와 `sid`만. 값·문장·항목 코드는 남기지 않는다(P16).
          ...(structureAudit ? { strs: structureAudit } : {}),
        });

        return { ...draftEnvelope(uid, owner, state.draftEpoch, cleared), state: toClient(state, report, c, cleared), signature,
          ...(released ? { released } : {}) };
      }, undefined, { facts, surface: 'POST studies/:uid/report/commit',
        action: action === 'approve' ? 'approve-sign' : action === 'addendum' ? 'addendum' : action === 'amend' ? 'amend'
          : action === 'reset' ? 'cancel' : 'write', target: 'report-version' }), () => ended);
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

  /** 수정 창·승인 회차 시각의 서버 시계. 시험이 바꿔 끼운다(metrics.ts의 metricsClock과 같은 결). */
  protected commitClock = () => Date.now();

  /** 지금의 머리 판(Report 행)을 잠근 채 읽는다. 검사 행 잠금 아래에서만 부른다. 행이 없으면(첫 확정) undefined. */
  private async lockHead(tx: any, uid: string): Promise<any> {
    const [head] = await tx.$queryRaw`
      SELECT version, "updatedBy", findings, conclusion, recommendation
      FROM "Report" WHERE uid = ${uid} FOR UPDATE`;
    return head;
  }
}

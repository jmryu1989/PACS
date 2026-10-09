/*
 * 검사 상태 PATCH·오더 매칭/해제·검사 행 삭제와 원격판독 전이표. rs·repDoc·confirm은 여기서 바꾸지 않는다(commitReport 전용).
 * PacsService가 만들어 소유하는 평범한 객체다(Nest provider가 아니다). 생성자는 참조만 저장한다.
 */
import { canReadPreliminary } from '../preliminary-reader';
import type { StudyAccessService } from '../study-access.service';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma.service';
import { overlayShape, OVERLAY_RULE_TEXT } from '../study-identity';
import { closeReaderAssignments } from '../reader-assignment.service';
import { parse, dump, toClient } from './values';
import { need, inst } from './access';
import type { Caller, PacsAccess } from './access';
import type { PacsInstitutions } from './institutions';
import type { PacsAudit } from './audit';

const TECHNICIAN_FIELDS = ['ss', 'ward', 'reqHosp', 'em', 'ov'];

/**
 * PATCH로 바꿀 수 있는 필드.
 *
 * **`rs`·`repDoc`·`confirm`이 여기 없는 것이 핵심이다.**
 * 예전엔 있었고, 그래서 `PATCH {rs:"T"}` 한 번으로 예비 판독(RS=P) 잠금이 풀렸다.
 * 판독문에 걸어둔 관문 네 개(저장·확정·점유·이력)를 전부 우회하는 창문이었다.
 *
 * RS는 단순한 컬럼이 아니라 **판독문의 생애주기**다. 상태가 바뀔 때마다 판(version)이
 * 쌓이고, 승인자가 기록되고, 취소에는 사유가 남아야 한다. 그건 `commitReport`가
 * 트랜잭션으로 하는 일이고, 여기서 필드 하나 바꾸듯 할 수 있는 일이 아니다.
 * `repDoc`·`confirm`도 승인의 결과이지 클라이언트가 정할 값이 아니다.
 */
const STATE_FIELDS = ['ss', 'em', 'ts', 'ward', 'reqHosp'];
/** 전용 경로가 소유한 필드들. PATCH로 오면 조용히 무시하지 않고 소리 내어 막는다.
 * matched·orig는 /match·/unmatch의 Order+Study 원자 트랜잭션만이 쓴다. */
const REPORT_OWNED_FIELDS = ['rs', 'repDoc', 'confirm', 'matched', 'orig', 'holdReason'];

/** 원격판독 상태머신. 어느 쪽 기관이 이 전이를 일으킬 수 있는가가 핵심이다. */
const TELE_BY_OWNER = ['none', 'wait', 'sending', 'sent', 'cancelled', 'fail'];
  // 의뢰 기관이 미는 구간
const TELE_BY_RECEIVER = ['inReading', 'completed'];
                             // 수신 기관이 미는 구간
/** 통로가 닫히는 상태 — 여기로 가면 수신 기관은 검사를 더 못 본다 */
const TELE_CLOSED = ['none', 'cancelled'];
/** 화면의 실제 버튼 흐름과 같은 전이만 허용한다. 역행·건너뛰기는 데이터 조작이다. */
const TELE_NEXT: Record<string, string[]> = {
  none: ['wait'], wait: ['sending', 'cancelled'], sending: ['sent', 'fail', 'cancelled'],
  sent: ['inReading', 'cancelled'], inReading: ['completed', 'cancelled'],
  completed: [], cancelled: ['wait'], fail: ['wait', 'cancelled'],
};

export class PacsStudyState {
  constructor(
    private readonly prisma: PrismaService,
    private readonly studyAccess: StudyAccessService,
    private readonly access: PacsAccess,
    private readonly institutions: PacsInstitutions,
    private readonly audit: PacsAudit) {}

  /** 검사 상태 부분 수정 (RS 토글, Verify, Switch EM/ReqHosp, TS 전이 …) */
  async patchState(uid: string, body: any, c: Caller) {
    return this.access.scopeWrite(uid,c,async(tx,audit)=>{
    const me = inst(c);

    /**
     * 판독문의 생애주기에 속한 필드는 여기로 못 들어온다.
     * 조용히 무시하면 클라이언트는 "저장됐다"고 믿고 화면만 앞서 나간다 — 소리 내어 막는다.
     */
    const owned = REPORT_OWNED_FIELDS.filter(k => body[k] !== undefined);
    if (owned.length)
      throw new BadRequestException(
        `${owned.join(', ')} 은(는) 전용 경로(판독문 확정 /report/commit, 매칭 /match·/unmatch)로만 바꿀 수 있습니다`);

    // 무엇을 바꾸려 하는가에 따라 필요한 권한이 다르다
    if (TECHNICIAN_FIELDS.some(k => body[k] !== undefined)) need(c.roles, 'technician', '검사 정보 변경');

    const prev = await this.access.gate(uid,c,tx);
    // 쓰기 경로는 행을 만들지 않는다. 생성은 DICOM 기관명을 검증하는 listStudies 한 곳뿐이다.
    if (!prev) throw new NotFoundException('검사를 찾을 수 없습니다');

    /**
     * match·unmatch·삭제와 같은 규칙: 원격판독으로 받은 검사의 촬영 상태·환자 정보는 **보유 기관의 일**이다.
     * 세 형제 관문은 있었는데 patchState만 열려 있어서, 수신 기관 기사가 ss·em을 바꿔 소유 기관을 자기
     * 검사의 판독에서 잠그거나 ov로 환자 정보를 덮을 수 있었다(v0.6.3 회귀 확충에서 발견 —
     * "관문은 한 곳만 열려 있어도 관문이 아니다"). 수신 기관이 여는 건 TS의 자기 구간(아래)뿐이다.
     */
    if (prev.institutionId !== me && TECHNICIAN_FIELDS.some(k => body[k] !== undefined))
      throw new ForbiddenException('원격판독으로 받은 검사의 촬영·환자 정보는 보유 기관만 바꿀 수 있습니다');

    /**
     * **예비 판독 중인 검사는 여기서도 막는다.**
     *
     * 판독문 저장·확정·점유·이력 네 곳에 관문을 달면서 이 한 곳을 빼먹었고,
     * 그래서 `PATCH {rs:"T"}` 한 번으로 잠금이 통째로 풀렸다. 응답에 판독문 본문까지
     * 실려 나갔다. **관문은 한 곳만 열려 있어도 관문이 아니다.**
     */
    if (!canReadPreliminary(prev, c))
      throw new ForbiddenException(
        `예비 판독(RS: P) 중입니다. ${prev?.preReviewer ?? '지정된 판독의'}만 다룰 수 있습니다.`);

    const data: any = {};
    for (const k of STATE_FIELDS) if (body[k] !== undefined) data[k] = body[k];
    if (body.ov !== undefined) data.ov = dump(body.ov);

    // ── 원격판독: 유일하게 기관을 넘는 동작 ──
    if (body.ts !== undefined) {
      // 기관 관문과 역할 관문은 다른 축이다. 원격판독 의뢰·수신은 판독의만 결정한다.
      need(c.roles, 'radiologist', '원격판독 상태 변경');
      const owner = prev?.institutionId ?? me;
      const ts = body.ts;
      const from = prev?.ts ?? 'none';
      if (!(TELE_NEXT[from] ?? []).includes(ts))
        throw new BadRequestException(`허용되지 않는 TS 전이입니다: ${from} → ${ts}`);
      if (TELE_BY_OWNER.includes(ts)) {
        if (owner !== me)
          throw new ForbiddenException('원격판독 의뢰는 검사를 보유한 기관만 할 수 있습니다');
        // 매뉴얼 6.3.4.4 — 원격판독은 RS가 W이고 TS가 none/cancelled일 때만 요청할 수 있다.
        // 이미 우리 쪽에서 판독이 시작된 검사를 밖으로 보내면 판독문이 둘로 갈라진다.
        if (!TELE_CLOSED.includes(ts) && (prev?.rs ?? 'W') !== 'W')
          throw new BadRequestException(
            `판독 전(RS: W)인 검사만 원격판독을 의뢰할 수 있습니다 (현재 RS: ${prev?.rs})`);
        if (TELE_CLOSED.includes(ts)) data.teleInstitutionId = null;   // 의뢰 취소 → 통로를 닫는다
        else if (body.teleTo !== undefined) {
          if (!this.institutions.institutions.some(i => i.id === body.teleTo))
            throw new BadRequestException(`알 수 없는 기관: ${body.teleTo}`);
          if (body.teleTo === owner)
            throw new BadRequestException('자기 기관으로는 원격판독을 의뢰할 수 없습니다');
          data.teleInstitutionId = body.teleTo;
        } else if (!prev?.teleInstitutionId) {
          throw new BadRequestException('원격판독을 받을 기관(teleTo)을 지정해야 합니다');
        }
      } else if (TELE_BY_RECEIVER.includes(ts)) {
        if (prev?.teleInstitutionId !== me)
          throw new ForbiddenException('원격판독을 받은 기관만 이 상태로 바꿀 수 있습니다');
      } else {
        throw new BadRequestException(`알 수 없는 TS: ${ts}`);
      }
    }

    if (!Object.keys(data).length) throw new BadRequestException('바꿀 필드가 없습니다');

    // 판독문은 "그때 그 영상, 그 환자"에 대한 진술이다. 판독이 끝난 뒤 환자·검사 정보를
    // 갈아치우면 그 진술의 근거가 사라진다. 그래서 RS가 W일 때만 덮어쓰기를 허용한다.
    // (HPACS 매뉴얼 8.1.2.1.5 — 승인된 검사를 수정하면 판독문을 버리고 새 검사를 만든다)
    // 화면에서도 막고 있지만, 화면의 검사는 검사가 아니다. 서버가 막아야 막힌 것이다.
    if (body.ov !== undefined) {
      const rs = prev?.rs ?? 'W';
      if (rs !== 'W')
        throw new BadRequestException(`판독 전(RS: W)인 검사만 환자·검사 정보를 수정할 수 있습니다 (현재 RS: ${rs})`);
      // S4-U5 (M-1): last, after every existing refusal, so each caller and RS keeps its status and message. The
      // overlay reaches every institution that sees the row, so only display fields with text values are stored.
      if (!overlayShape(body.ov))
        throw new BadRequestException(`환자·검사 정보(ov) 형식이 잘못되었습니다 — ${OVERLAY_RULE_TEXT}`);
    }

    // S7-U3a (D-S7-09 a): an institution this write takes the tele channel away from (cancel, or a new teleTo) loses its
    // reader assignment in this transaction. The close goes first: it locks the StudyState row, which the update below
    // keeps to commit, and reads the channel being replaced under that lock rather than from gate()'s read above.
    if (data.teleInstitutionId !== undefined)
      await closeReaderAssignments(tx, uid, { institutionId: prev.institutionId, teleInstitutionId: data.teleInstitutionId }, c.actor, 'tele-closed');
    const saved = await tx.studyState.update({ where: { uid }, data });
    await audit(c.actor, 'state.patch', uid, { ...data, by: me });
    const r = await tx.report.findUnique({ where: { uid } });
    return toClient(saved, r, c, await this.access.myDraft(uid,c.actor,tx));
    });
  }

  /**
   * Match (8.1.2.1.1): 오더 정보를 검사에 덮어쓴다.
   * 두 테이블을 같이 바꾸므로 트랜잭션. 하나만 바뀌면 M/U가 어긋난 유령 상태가 남는다.
   */
  async match(uid: string, oid: string, patient: any, c: Caller) {
    need(c.roles, 'technician', '오더 매칭');
    const me = inst(c);
    const order = await this.prisma.order.findUnique({ where: { oid } });
    if (!order) throw new BadRequestException('오더를 찾을 수 없습니다');
    // 오더도 검사도 내 기관 것이어야 한다. 남의 병원 오더를 우리 검사에 붙이면
    // 환자 정보가 기관을 넘어 덮어써진다 — 조용히 섞이는 최악의 경로다.
    if (order.institutionId !== me) throw new BadRequestException('오더를 찾을 수 없습니다');

    const prev = await this.access.gate(uid, c);
    await this.studyAccess.prepare(c,[uid]);
    if (prev && prev.institutionId !== me)
      throw new ForbiddenException('원격판독으로 받은 검사는 매칭할 수 없습니다 (보유 기관의 일입니다)');
    // Match도 환자 정보를 덮어쓰는 동작이므로 같은 규칙을 받는다
    if (prev && prev.rs !== 'W')
      throw new BadRequestException(`판독 전(RS: W)인 검사만 매칭할 수 있습니다 (현재 RS: ${prev.rs})`);
    // S4-U5 (N-1): the client-claimed original is stored and relayed like the overlay, so it gets the same shape
    // check, after every existing refusal above. Mismatch or identity never refuses a match.
    if (!overlayShape(patient?.orig ?? null))
      throw new BadRequestException(`원래 정보(orig) 형식이 잘못되었습니다 — ${OVERLAY_RULE_TEXT}`);

    // S4-NB1: age is the client's untrusted ageOf convenience value relayed to every viewer incl. tele: coerce to '', never refuse (PATCH ov keeps its M-1 refusal).
    const ov = {
      id: order.patientId, name: order.name, sex: order.sex, birth: order.birth,
      age: overlayShape({ age: patient?.age }) ? patient.age : '', desc: order.descr, ward: order.ward,
    };
    const orig = parse(prev?.orig) ?? patient?.orig ?? null;

    let state;
    try {
      state = await this.prisma.$transaction(async tx => {
      await this.studyAccess.require(c,[uid],tx);
        /**
         * 먼저 읽은 `matched` 값은 두 요청이 함께 U를 봐버릴 수 있다. 조건부 갱신은
         * "아직 U일 때만 내가 M으로 바꾼다"를 DB 한 문장으로 만들고, 행 잠금 뒤의
         * 실제 상태에서 한 요청만 count=1을 받게 한다.
         */
        const claimedOrder = await tx.order.updateMany({
          where: { oid, institutionId: me, matched: 'U' },
          data: { matched: 'M', studyUid: uid },
        });
        if (claimedOrder.count !== 1)
          throw new BadRequestException('이미 매칭된 오더입니다. 목록을 새로고침한 뒤 다시 선택하세요.');

        const data = { matched: 'M', orderOid: oid, ov: dump(ov), orig: dump(orig), ward: order.ward };
        if (!prev) {
          return tx.studyState.create({
            data: { uid, institutionId: me, reqHosp: this.institutions.instName(me), ...data },
          });
        }

        // 검사 쪽도 같은 상태였을 때만 선점한다. 실패하면 위 오더 갱신도 함께 롤백된다.
        const claimedStudy = await tx.studyState.updateMany({
          where: { uid, institutionId: me, matched: 'U' }, data,
        });
        if (claimedStudy.count !== 1)
          throw new BadRequestException('이미 매칭된 검사입니다. 목록을 새로고침한 뒤 다시 선택하세요.');
        return tx.studyState.findUniqueOrThrow({ where: { uid } });
      });
    } catch (e: any) {
      /**
       * 서로 다른 오더를 같은 검사에 거는 경쟁은 각 오더 행이 달라 updateMany만으로
       * 직렬화되지 않는다. 양쪽 nullable unique가 마지막 관문이고, 그 충돌은 사용자가
       * 조치할 수 있는 말로 바꾼다. PostgreSQL은 NULL 중복을 허용하므로 미매칭은 막지 않는다.
       */
      if (e?.code === 'P2002')
        throw new BadRequestException(
          '이미 다른 오더 또는 검사와 매칭되었습니다. 목록을 새로고침한 뒤 다시 선택하세요.');
      throw e;
    }
    await this.audit.audit(c.actor, 'match', uid, { oid, ov, by: me });
    const r = await this.prisma.report.findUnique({ where: { uid } });
    return toClient(state, r, c, await this.access.myDraft(uid, c.actor));
  }

  /** Unmatch (8.1.2.1.2): 검사·오더 양쪽을 동시에 해제 */
  async unmatch(uid: string, c: Caller) {
    return this.access.scopeWrite(uid,c,async(tx,audit)=>{
    need(c.roles, 'technician', '매칭 해제');
    const me = inst(c);
    const prev = await this.access.gate(uid,c,tx);
    if (!prev || prev.matched !== 'M') throw new BadRequestException('매칭된 검사가 아닙니다');
    // Match와 같은 규칙을 해제에도 건다. 승인 뒤 환자·오더 연결을 바꾸면 진술의 근거가 사라진다.
    if (prev.rs !== 'W')
      throw new BadRequestException(`판독 전(RS: W)인 검사만 매칭을 풀 수 있습니다 (현재 RS: ${prev.rs})`);
    if (prev.institutionId !== me)
      throw new ForbiddenException('원격판독으로 받은 검사는 매칭을 풀 수 없습니다 (보유 기관의 일입니다)');

    const ops: any[] = [
      tx.studyState.update({
        where: { uid }, data: { matched: 'U', orderOid: null, ov: null },
      }),
    ];
    if (prev.orderOid)
      ops.push(tx.order.update({
        where: { oid: prev.orderOid }, data: { matched: 'U', studyUid: null },
      }));

    const [state] = await Promise.all(ops);
    await audit(c.actor, 'unmatch', uid, { oid: prev.orderOid, by: me });
    const r = await tx.report.findUnique({ where: { uid } });
    return toClient(state, r, c, await this.access.myDraft(uid,c.actor,tx));
    });
  }

  /** 검사 상태 행 삭제 (장비 수신 시뮬로 만든 가짜 검사 정리용) */
  async removeState(uid: string, c: Caller) {
    need(c.roles, 'technician', '검사 삭제');
    const me = inst(c);
    await this.access.gate(uid, c);
    await this.studyAccess.prepare(c,[uid]);
    return this.prisma.$transaction(async tx => {
      await this.studyAccess.require(c,[uid],tx);
    await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
    await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
    const parents = await tx.$queryRaw<any[]>`SELECT * FROM "StudyState" WHERE uid = ${uid} FOR UPDATE`;
    const prev = parents[0];
    if (!prev) throw new NotFoundException('검사가 없습니다');
    if (!this.access.visible(prev, me)) throw new ForbiddenException('검사에 접근할 수 없습니다');
    if (prev && prev.institutionId !== me)
      throw new ForbiddenException('원격판독으로 받은 검사는 삭제할 수 없습니다');

    // Creation takes this same parent lock. Hidden items still own immutable
    // history; deleting their parent would remove the authorization boundary.
    if (await tx.viewerItem.findFirst({ where: { studyUid: uid }, select: { id: true } }))
      throw new ConflictException('표시 이력이 있는 검사는 삭제할 수 없습니다');
    if (await tx.techNoteRevision.findFirst({ where: { studyUid: uid }, select: { version: true } }))
      throw new ConflictException('Tech 메모 이력이 있는 검사는 삭제할 수 없습니다');
    if (await tx.viewerJob.findFirst({ where: { studies: { has: uid } }, select: { id: true } }))
      throw new ConflictException('저장한 비교 작업에서 참조하는 검사는 삭제할 수 없습니다');
    // S5-U4a: 질문 스레드와 그 영수증은 검사에 묶인 기록이라 함께 지우지 않는다(FK Restrict). 처리되지 않은 FK 오류
    // 대신 명시 409로 거절한다. 질문 생성도 이 부모 잠금을 잡으므로 삭제와 생성이 엇갈리지 않는다.
    if (await tx.studyQuestion.findFirst({ where: { studyUid: uid }, select: { id: true } }))
      throw new ConflictException({ code: 'STUDY_HAS_QUESTIONS', message: '임상의 질문이 있는 검사는 삭제할 수 없습니다' });
    // S5-U4c: 영상 요청과 그 영수증도 같은 이유로 함께 지우지 않는다(FK Restrict). 요청 생성도 이 부모 잠금을 잡는다.
    if (await tx.studyImageRequest.findFirst({ where: { studyUid: uid }, select: { id: true } }))
      throw new ConflictException({ code: 'STUDY_HAS_IMAGE_REQUESTS', message: '영상 요청 기록이 있는 검사는 삭제할 수 없습니다' });
    // S7-U1a: 중요 결과 전달 기록·이벤트·영수증도 함께 지우지 않는다(FK Restrict). 고정 판이 비폐기 판독 이력이라 아래 400이
    // 먼저 막겠지만, 그 규칙이 바뀌어도 처리되지 않은 FK 오류 대신 명시 409다. 전달 생성도 이 부모 잠금을 잡는다.
    if (await tx.criticalResult.findFirst({ where: { studyUid: uid }, select: { id: true } }))
      throw new ConflictException({ code: 'STUDY_HAS_CRITICAL_RESULTS', message: '중요 결과 전달 기록이 있는 검사는 삭제할 수 없습니다' });

    /**
     * 삭제 가능 여부는 지금의 RS가 아니라 **사람의 기록이 생긴 적이 있는가**로 정한다.
     * 승인 뒤 Reset하면 RS는 다시 W지만, ReportVersion은 있었던 결정을 보존한다.
     * 그 상태 행을 지우면 현재 판독문은 cascade로 사라지고 이력은 조회 관문을 잃는다.
     * 초안도 아직 진술은 아니지만 누군가 쓰는 중인 글이므로 삭제로 가로채지 않는다.
     */
    const [version, draft] = await Promise.all([
      /**
       * 강제 해제로 보존한 discarded 초안만 있는 검사는 이후 삭제할 수 있어야 한다.
       * 그것은 판독 결정이 아니라 삭제 직전의 안전 사본이다. save/approve/reset 같은
       * 실제 생애주기 이력이 하나라도 있으면 이전과 똑같이 삭제를 막는다.
       */
      tx.reportVersion.findFirst({
        where: { uid, action: { not: 'discarded' } }, select: { id: true },
      }),
      // 비운 자리(present=false)는 쓰는 중인 글이 아니다 — 삭제를 막지 않는다.
      tx.reportDraft.findFirst({ where: { uid, present: true }, select: { author: true } }),
    ]);
    if (version)
      throw new BadRequestException(
        '판독 이력이 있는 검사는 삭제할 수 없습니다. 판독 취소(Reset)로 되돌리세요.');
    if (draft)
      throw new BadRequestException(
        `작성 중인 판독문 초안이 있는 검사는 삭제할 수 없습니다. ` +
        `작성자(${draft.author})에게 확정 또는 폐기를 요청하거나 관리자에게 강제 해제를 요청하세요.`);

    if (prev?.orderOid)
      await tx.order.update({ where: { oid: prev.orderOid }, data: { matched: 'U', studyUid: null } });
    // S7-U3a: deleting the study ends an open tele channel too; the receiver's reader assignment closes with it, under the
    // row lock taken above, so a study that arrives again under this UID never brings it back open.
    if (prev.teleInstitutionId)
      await closeReaderAssignments(tx, uid, { institutionId: prev.institutionId, teleInstitutionId: null }, c.actor, 'study-deleted');
    // 남은 초안 행은 비운 자리뿐이다(위에서 present 행이 있으면 거절했다). 검사 행과 함께 치운다: 같은 UID로 다시 생긴
    // 검사는 새 세대(draftEpoch)를 받으므로, 치운 자리의 revision이 없어도 옛 경계의 쓰기는 모두 거절된다.
    await tx.reportDraft.deleteMany({ where: { uid, present: false } });
    await tx.studyState.delete({ where: { uid } });
    await tx.auditLog.create({ data: { actor: c.actor, action: 'state.delete', target: uid, detail: JSON.stringify({ by: me }) } });
    return { ok: true };
    }, { isolationLevel: 'ReadCommitted', maxWait: 4000, timeout: 8000 });
  }
}

/*
 * 임상의 읽기(S5-U1b)와 환자 영상 타임라인(S5-U3). 워크리스트 목록을 그대로 부르고 좁히며, 판독 상태는 한 SQL 문장에서만 만든다.
 * PacsService가 만들어 소유하는 평범한 객체다(Nest provider가 아니다). 생성자는 참조만 저장한다.
 */
import type { StudyAccessService } from '../study-access.service';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma.service';
import { viewerUid } from '../viewer-input';
import { CLINICIAN_ROLE, clinicianFinal, clinicianKeyImage, clinicianList, clinicianListChanged, clinicianReport,
  clinicianTimeline, clinicianTimelineMembers } from '../clinician-policy';
import { studyPageQuery, studyPageSlice } from '../study-page';
// S5-U3 타임라인의 원본 생년월일·성별 비교는 S4-U5의 검토된 정규화를 그대로 쓴다.
import { birthKey, sexKey } from '../study-identity';
import { need, inst } from './access';
import type { Caller, PacsAccess } from './access';
import type { PacsWorklist } from './worklist';

export class PacsClinician {
  constructor(
    private readonly prisma: PrismaService,
    private readonly studyAccess: StudyAccessService,
    private readonly access: PacsAccess,
    private readonly worklist: PacsWorklist) {}

  // ══════════════════ S5-U1b 임상의 읽기 ══════════════════
  // REQ-S5-U1b-CLINICIAN-READ. 모양은 clinician-policy.ts의 순수 투영이 정하고, 여기서는 범위와 스냅샷만 정한다.

  /**
   * 임상의 목록. **워크리스트 목록(listStudies) 그 자체를 부르고** 행을 좁힌다 — 기관·원격판독·StudyAccess·
   * lazy 등록·페이지·접근 재검사를 따로 흉내 내면 둘 중 하나만 고쳐지는 날이 온다. 워크리스트 행의 초안·기사
   * 메모·판독의 배정·Gateway 영수증·오더 대사·관측 부재·observedAt은 clinicianList가 버리고 싣지 않는다.
   * total·이어받기는 워크리스트와 같다 — 볼 수 있는 검사만 센다.
   *
   * 판독 상태(rs·repDoc·confirm·판 번호·머리 판 action)는 워크리스트 행에서 가져오지 않는다. listStudies는 StudyState와
   * Report를 따로 읽으므로 그 사이 Addendum이 끼면 새 판 번호에 이전 서명자가 붙는다. 여기서 **한 SQL 문장**(한 스냅샷)으로
   * 기관 두 칸과 판독 상태를 함께 읽어 그 행에서만 상태를 만들고, 워크리스트 행과 그 칸들(CLINICIAN_LIST_PINS)이 하나라도
   * 다르면 워크리스트와 같은 409로 답 전체를 거절한다. 정책 변경은 StudyAccessInterceptor가 요청 전체에서 본다.
   */
  async clinicianStudies(c: Caller, query?: any) {
    this.clinicianCaller(c);
    const list = await this.worklist.listStudies(c, query);
    const uids: string[] = list.studies.map((row: any) => row.uid);
    const current = !uids.length ? [] : await this.prisma.$queryRaw<any[]>`
      SELECT s.uid, s."institutionId", s."teleInstitutionId", s.rs, s."repDoc", s.confirm,
        COALESCE(r.version, 0) AS version, v.action
      FROM "StudyState" s
      LEFT JOIN "Report" r ON r.uid = s.uid
      LEFT JOIN "ReportVersion" v ON v.uid = r.uid AND v.version = r.version
      WHERE s.uid IN (${Prisma.join(uids)})`;
    if (clinicianListChanged(list.studies, current))
      throw new ConflictException({ code: 'STUDY_LIST_CHANGED', message: '검사 목록 또는 판독 상태가 바뀌었습니다. 새로고침하세요.' });
    return clinicianList(list, current);
  }

  /**
   * 임상의 판독 읽기. 머리 판이 확정본(clinicianFinal)이면 **그 행의** 본문과 key image를, 아니면 상태만 준다
   * (S5-F5, D-S5-NONFINAL-VIEW 미결). 초안·이력·인용·구조화·작성자 칸은 없다. 예비 판독(P)도 상태만이라
   * 지정된 두 사람 규칙(canReadPrelim)을 넓히지 않는다. key image는 판독문 미리보기와 같은 조회다
   * (숨기지 않은 kind=key, 512건 한도).
   */
  async clinicianReportRead(uid: string, c: Caller) {
    return this.clinicianScope(uid, c, async (tx, state, head) => {
      const report = clinicianReport(state, head);
      if (!report.final) return { uid, report, keys: null };
      const rows = await tx.viewerItem.findMany({ where: { studyUid: uid, hidden: false,
        snapshot: { path: ['kind'], equals: 'key' } }, orderBy: { id: 'asc' }, take: 513,
        select: { id: true, revision: true, hidden: true, snapshot: true } });
      if (rows.length > 512) throw new ForbiddenException('키 이미지 목록 한도를 초과했습니다');
      return { uid, report, keys: rows.map(clinicianKeyImage).filter(Boolean) };
    });
  }

  /**
   * 표시 항목 관문(viewer.controller): 호출자·검사 범위(밖이면 404)를 판정하고, 지금 머리 판이 확정본이면 **그 판 번호**를,
   * 아니면 null을 답한다. true/false로 줄이지 않는 이유: 관문 두 번이 모두 "확정"이어도 그 사이 reset → 재승인이 끼었을
   * 수 있고, 그것은 판 번호로만 드러난다(clinicianViewerPinned).
   */
  async clinicianViewerHead(uid: string, c: Caller): Promise<number | null> {
    return this.clinicianScope(uid, c, async (_tx, state, head) => clinicianFinal(state.rs, head) ? head.version as number : null);
  }

  /**
   * 임상의 읽기의 호출자 관문. clinician 역할(need의 admin 예외 포함)과 회원 신원만 받는다 —
   * 판독의·기사는 자기 화면의 넓은 경로를 이미 갖고 있어 이 좁은 응답이 필요 없다. 기관은 inst()/gate()가 본다.
   */
  private clinicianCaller(c: Caller) {
    if (c.kind !== 'member') throw new ForbiddenException('회원 전용입니다');
    need(c.roles, CLINICIAN_ROLE, '임상의 조회');
  }

  /**
   * 임상의 판독 읽기와 표시 항목 관문이 함께 쓰는 **한 스냅샷**: 검사 범위(기관·원격판독·StudyAccess, 밖이거나
   * 행이 없으면 404 — 존재 여부도 정보다)와 머리 판. 머리 판은 `Report.version` 번 행 하나다 — reset이 남긴 더 큰
   * 번호의 discarded 행은 머리가 아니다. 범위 판정과 본문 읽기를 한 트랜잭션에 두어, 그 사이 reset·원격판독
   * 취소가 끼어들어 확정본이 아닌 판이나 범위 밖 검사가 답이 되지 않게 한다.
   */
  private async clinicianScope<T>(uid: string, c: Caller, work: (tx: any, state: any, head: any) => Promise<T>): Promise<T> {
    this.clinicianCaller(c);
    viewerUid(uid);
    // 원본 태그 조건이 있는 접근 정책은 트랜잭션 밖에서 준비한다(reportCitations와 같은 이유).
    await this.studyAccess.prepare(c, [uid]);
    return this.prisma.$transaction(async tx => {
      const state = await this.access.gate(uid, c, tx);
      if (!state) throw new NotFoundException('검사를 찾을 수 없습니다');
      const report = await tx.report.findUnique({ where: { uid }, select: { version: true } });
      const head = report?.version > 0 ? await tx.reportVersion.findUnique({
        where: { uid_version: { uid, version: report.version } },
        select: { version: true, action: true, findings: true, conclusion: true, recommendation: true } }) : null;
      return work(tx, state, head);
    }, { isolationLevel: 'RepeatableRead', maxWait: 2000, timeout: 5000 });
  }

  // ══════════════════ S5-U3 환자 영상 타임라인 ══════════════════
  // REQ-S5-U3-PATIENT-TIMELINE. 묶음·모양은 clinician-policy.ts의 순수 함수가 정하고, 여기서는 열거·쪽·스냅샷만 정한다.

  /**
   * 기준 검사와 서버 환자 키(기관|원본 DICOM PatientID)가 같은 검사 전부를 쪽으로 나눠 준다. 열거는 **워크리스트 목록(listStudies)
   * 그 자체**를 쪽 없이 한 번 부른 것이다 — 기관·원격판독·StudyAccess·lazy 등록·접근 재검사를 여기서 다시 만들지 않는다.
   * 그래서 취소된 원격판독 검사와 접근 정책 밖의 검사는 타임라인에도 없고, total도 볼 수 있는 검사만 센다. 기준 검사가 그 목록에
   * 없으면(없는 검사·다른 기관·취소된 원격판독·정책 밖) 404다 — 존재 여부도 정보다.
   * 쪽은 study-page.ts의 서명 이어받기를 그대로 쓰고 limit이 없으면 400이다(한 환자 ID에 검사가 몰려도 답이 한없이 커지지 않게).
   * 이어받기의 주인은 호출자·접근 정책 판·기준 검사라 워크리스트나 다른 검사의 타임라인 값으로는 이어지지 않고, 쪽 사이에 묶음이
   * 바뀌면 409다. 판독 상태는 clinicianStudies와 같은 한 SQL 문장에서만 만들고 목록 행과 다르면 답 전체를 409로 거절한다.
   */
  async clinicianTimeline(uid: string, c: Caller, query?: any) {
    this.clinicianCaller(c);
    viewerUid(uid);
    const me = inst(c);
    const access = await this.studyAccess.snapshot(c);
    const owner = [me, c.sub, c.actor, String(access.revision), String(access.windowOpen), 'timeline', uid];
    const page = studyPageQuery(query, owner);
    if (!page) throw new BadRequestException('타임라인은 limit(1~100)으로 쪽을 나눠 읽습니다');
    const list = await this.worklist.listStudies(c);
    const anchor = list.studies.find((row: any) => row.uid === uid);
    if (!anchor) throw new NotFoundException('검사를 찾을 수 없습니다');
    const members = clinicianTimelineMembers(anchor, list.studies);
    const window = studyPageSlice(members, (row: any) => row.uid as string, page, owner);
    const uids: string[] = window.rows.map((row: any) => row.uid);
    const current = !uids.length ? [] : await this.prisma.$queryRaw<any[]>`
      SELECT s.uid, s."institutionId", s."teleInstitutionId", s.rs, s."repDoc", s.confirm,
        COALESCE(r.version, 0) AS version, v.action
      FROM "StudyState" s
      LEFT JOIN "Report" r ON r.uid = s.uid
      LEFT JOIN "ReportVersion" v ON v.uid = r.uid AND v.version = r.version
      WHERE s.uid IN (${Prisma.join(uids)})`;
    if (clinicianListChanged(window.rows, current))
      throw new ConflictException({ code: 'STUDY_LIST_CHANGED', message: '검사 목록 또는 판독 상태가 바뀌었습니다. 새로고침하세요.' });
    // listStudies 행의 birth·sex는 QIDO 원본 태그이고 덮어쓰기는 state.ov에 따로 있다 — 여기서는 원본만 비교한다.
    return clinicianTimeline(uid, anchor, members, window, current, list.serverTime,
      (row: any) => ({ birth: birthKey(row?.birth), sex: sexKey(row?.sex) }));
  }
}

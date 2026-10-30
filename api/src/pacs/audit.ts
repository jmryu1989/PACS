/*
 * 감사 행 한 줄 쓰기(audit)와 검사별 감사 읽기(audits). 읽기는 기록 당시의 기관·소유 기관·원격판독 경계를 SQL 안에서 건다.
 * PacsService가 만들어 소유하는 평범한 객체다(Nest provider가 아니다). 생성자는 참조만 저장한다.
 */
import type { StudyAccessService } from '../study-access.service';
import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma.service';
import { noteTransactionError, dump, parse, visibleHolder } from './values';
import { inst } from './access';
import type { Caller, PacsAccess } from './access';

/**
 * 소유 기관 전용 감사 action(S5-U4p §11.1). 이 행은 `GET audit`의 두 경로 모두에서 생성 기관(detail.institution)
 * = 대상 검사의 **현재** 소유 기관 = caller 기관일 때만 나간다. 기존 action은 원격판독 기관에도 보이지만 질문은
 * 소유 기관 안의 대화라서, 질문 API가 404여도 감사 통로로 존재·행위자·전이가 새지 않게 한다. 한 action을 처음
 * 쓰는 단위가 여기에 이름을 더한다(S5-U4a: study.question, S5-U4c: study.image-request, S7-U1a: study.critical-result).
 */
export const OWNER_ONLY_AUDIT_ACTIONS: readonly string[] = Object.freeze(['study.question', 'study.image-request', 'study.critical-result']);
/**
 * 기록 기관 전용 감사 action(S7-U3a, D-S7-09 a). 소유 기관과 원격판독 수신 기관이 한 검사에 각자의 판독의 배정을 두므로,
 * 이 행은 `GET audit`의 두 경로에서 기록 기관(detail.institution) = caller 기관일 때만 나간다 — 상대 기관의 배정이
 * 감사 통로로 보이지 않게 한다(RISK-S7-U3a-CROSS-TENANT-ASSIGN). 점유·강제 해제도 작성자 신원을 담으므로 같은 경계를 따른다.
 */
export const INSTITUTION_AUDIT_ACTIONS: readonly string[] = Object.freeze(['reader.assignment', 'report.hold', 'hold.force-release']);

export class PacsAudit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly studyAccess: StudyAccessService,
    private readonly access: PacsAccess) {}

  audit(actor: string, action: string, target: string, detail?: any) {
    return this.prisma.auditLog.create({
      data: { actor: actor || 'unknown', action, target, detail: dump(detail) },
    });
  }

  /**
   * 감사로그. 내 기관이 볼 수 있는 검사의 것만. OWNER_ONLY_AUDIT_ACTIONS 행은 생성 기관 = 현재 소유 기관 = 나일 때만,
   * INSTITUTION_AUDIT_ACTIONS 행은 기록 기관 = 나일 때만(S7-U3a). 그 조건은 LIMIT이 있는 같은 SQL의 WHERE에 둔다 —
   * 가져온 뒤 거르면 짧은 쪽이 숨긴 행의 수·시각을 드러내고 보여야 할 오래된 행을 밀어낸다. CASE는 목록의 action에만 detail을 jsonb로 읽고, 검사 행이 없거나 기관이
   * null이면 NULL이 되어 행이 빠진다(닫힌 쪽). 같은 시각의 행은 id로 순서를 고정한다.
   */
  async audits(uid: string | undefined, take: number, c: Caller) {
    return (await this.auditRead(uid, take, c)).rows;
  }

  /**
   * A-027 (D1881): the rows of `audits()` and, per row, the institution its read is recorded to. A row that recorded
   * its institution (OWNER_ONLY_AUDIT_ACTIONS, INSTITUTION_AUDIT_ACTIONS) is that institution's (D7). Every other row
   * - the legacy rows written before an institution was stored on them - stays as it is, and this read of it is
   * recorded to the study's current StudyState.institutionId, taken by the same statement that selected the row (never
   * re-read afterwards and never the reader's own institution).
   */
  async auditRead(uid: string | undefined, take: number, c: Caller) {
    const selected: any[] = await this.selectAudits(uid, take, c);
    const rows = selected.map(({ managingInstitution, ...row }) => {
      if (row.action !== 'hold.force-release') return row;
      // A local administrator can release a foreign writer's hold. Keep the raw audit,
      // but the institution-scoped action must not reveal that writer in its response.
      const { holderInstitutionId, ...detail } = parse(row.detail) ?? {};
      return { ...row, detail: dump({ ...detail, holder: visibleHolder({ holder: detail.holder, holderInstitutionId }, c) }) };
    });
    return { rows, managing: selected.map(row => row.managingInstitution ?? null) };
  }

  private async selectAudits(uid: string | undefined, take: number, c: Caller): Promise<any[]> {
    const me = inst(c);
    const limit = Math.min(take, 500);
    if (uid) {
      // S7-U3a-R-001-F01: the scope check and the read are one transaction holding the study row shared. A tele cancel or
      // a delete locks that row first, so it waits for a read in progress, and a read that waited for one answers as an
      // unknown UID does. gate()'s unlocked check and a separate SELECT could fall on either side of the close.
      await this.studyAccess.prepare(c, [uid]);
      return this.prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
        await this.studyAccess.snapshot(c, tx);
        const [prev] = await tx.$queryRaw<any[]>`SELECT "institutionId", "teleInstitutionId" FROM "StudyState" WHERE uid = ${uid} FOR SHARE`;
        // versions()와 같은 이유. 삭제된 검사의 감사(환자 정보가 든 ov 포함)와 회원 감사 행(target이
        // Keycloak 사용자 id)이 이 통로로 새어 나갔다. 회원 감사 조회가 필요해지면 admin 전용 경로로 만든다.
        if (!prev || !this.access.visible(prev, me)) throw new NotFoundException('검사를 찾을 수 없습니다');
        await this.studyAccess.require(c, [uid], tx);
        return tx.$queryRaw<any[]>`SELECT a.*, CASE WHEN a.action = ANY(${OWNER_ONLY_AUDIT_ACTIONS}::text[]) OR a.action = ANY(${INSTITUTION_AUDIT_ACTIONS}::text[])
            THEN (a.detail::jsonb ->> 'institution') ELSE s."institutionId" END AS "managingInstitution"
          FROM "AuditLog" a LEFT JOIN "StudyState" s ON s.uid = a.target
          WHERE a.target = ${uid}
            AND CASE WHEN a.action = ANY(${OWNER_ONLY_AUDIT_ACTIONS}::text[])
                     THEN s."institutionId" = ${me} AND (a.detail::jsonb ->> 'institution') = ${me}
                     WHEN a.action = ANY(${INSTITUTION_AUDIT_ACTIONS}::text[])
                     THEN (a.detail::jsonb ->> 'institution') = ${me}
                     ELSE TRUE END
          ORDER BY a.at DESC, a.id DESC LIMIT ${limit}`;
      }, { maxWait: 4000, timeout: 8000 }).catch(noteTransactionError);
    }
    const mine = await this.prisma.studyState.findMany({
      where: { OR: [{ institutionId: me }, { teleInstitutionId: me }] },
      select: { uid: true },
    });
    const allowed = [...await this.studyAccess.allowed(c,mine.map(s=>s.uid))];
    // S7-U3a-R-001-F01: the institution boundary is checked again in the statement that reads the entries, so the entries
    // of a study whose tele channel closed after `mine` was read are left out, the close's own included.
    return this.prisma.$queryRaw<any[]>`SELECT a.*, CASE WHEN a.action = ANY(${OWNER_ONLY_AUDIT_ACTIONS}::text[]) OR a.action = ANY(${INSTITUTION_AUDIT_ACTIONS}::text[])
            THEN (a.detail::jsonb ->> 'institution') ELSE s."institutionId" END AS "managingInstitution"
          FROM "AuditLog" a LEFT JOIN "StudyState" s ON s.uid = a.target
      WHERE a.target = ANY(${allowed}::text[])
        AND (s."institutionId" = ${me} OR s."teleInstitutionId" = ${me})
        AND CASE WHEN a.action = ANY(${OWNER_ONLY_AUDIT_ACTIONS}::text[])
                 THEN s."institutionId" = ${me} AND (a.detail::jsonb ->> 'institution') = ${me}
                 WHEN a.action = ANY(${INSTITUTION_AUDIT_ACTIONS}::text[])
                 THEN (a.detail::jsonb ->> 'institution') = ${me}
                 ELSE TRUE END
      ORDER BY a.at DESC, a.id DESC LIMIT ${limit}`;
  }
}

/*
 * 기관 목록 캐시(이 객체 하나)·기동 시드·DICOM 기관명 해석·미배정 검사 배정·판독의 명부.
 * 캐시를 읽는 다른 concern은 이 객체의 `institutions`를 매번 읽는다. 복사본을 들면 reload가 한쪽에만 닿는다.
 * PacsService가 만들어 소유하는 평범한 객체다(Nest provider가 아니다). 생성자는 참조만 저장한다.
 */
import type { StudyAccessService } from '../study-access.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma.service';
import { OrthancService } from '../orthanc.service';
import type { KeycloakService } from '../keycloak.service';
import { SEED_INSTITUTIONS, SEED_ORDERS } from '../seed';
import { toClient } from './values';
import { need, inst } from './access';
import type { Caller, PacsAccess } from './access';

export class PacsInstitutions {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orthanc: OrthancService,
    private readonly keycloak: KeycloakService,
    private readonly studyAccess: StudyAccessService,
    private readonly access: PacsAccess) {}

  /** 기관 목록 캐시. 몇 개 안 되고 거의 안 바뀌므로 메모리에 둔다. */
  institutions: any[] = [];

  async onModuleInit() {
    // 기관 시드 — upsert라 이미 있으면 이름·별칭만 갱신된다
    for (const i of SEED_INSTITUTIONS)
      await this.prisma.institution.upsert({ where: { id: i.id }, create: i, update: { name: i.name, type: i.type, dicomNames: i.dicomNames } });
    await this.reloadInstitutions();

    const n = await this.prisma.order.count();
    if (n === 0) {
      await this.prisma.order.createMany({ data: SEED_ORDERS });
      console.log(`[KIN API] 오더 시드 ${SEED_ORDERS.length}건 생성`);
    } else {
      // 기관 컬럼이 생기기 전에 만들어진 오더는 전부 스키마 기본값(hallym)을 달고 있다.
      // 시드 오더의 소속을 코드와 맞춰준다 — 안 하면 판독센터 오더가 한림에 보인다.
      for (const o of SEED_ORDERS)
        await this.prisma.order.updateMany({
          where: { oid: o.oid, institutionId: { not: o.institutionId } },
          data: { institutionId: o.institutionId },
        });
    }
    console.log(`[KIN API] 기관 ${this.institutions.length}개: ${this.institutions.map(i => `${i.id}(${i.name})`).join(', ')}`);
  }

  private async reloadInstitutions() {
    this.institutions = await this.prisma.institution.findMany();
  }

  /**
   * DICOM InstitutionName(0008,0080) → 우리 기관 id.
   *
   * 못 찾으면 **null을 준다.** 모르는 기관명을 기본 기관에 밀어넣지 않는다 —
   * 그렇게 하면 남의 병원 검사가 조용히 우리 목록에 섞이고, 조용히 섞인 것은
   * 아무도 발견하지 못한다. 미배정 검사는 화면에서 "(미배정)"으로 보이고
   * 어느 기관에도 잡히지 않는다.
   */
  resolveInstitution(dicomName: string): string | null {
    const key = (dicomName ?? '').trim().toLowerCase();
    if (!key) return null;
    for (const i of this.institutions) {
      const names = String(i.dicomNames ?? '').split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean);
      if (names.includes(key) || i.id.toLowerCase() === key || i.name.toLowerCase() === key) return i.id;
    }
    return null;
  }

  instName(id: string | null) {
    return this.institutions.find(i => i.id === id)?.name ?? '(미배정)';
  }

  /** S7-U4a Clinical Context가 소유 기관을 워크리스트 행의 institutionName과 같은 표시 이름으로 싣는다(계약 S7-U4p §5.3). */
  institutionName(id: string | null) {
    return this.instName(id);
  }

  /**
   * ── 미배정 검사 (institutionId = null) ──
   *
   * DICOM `InstitutionName`을 못 알아본 검사는 어느 기관 것도 아니다. 그건 의도한
   * 설계다 — 모르는 기관명을 아무 데나 밀어넣으면 남의 병원 검사가 조용히 섞인다.
   *
   * 그런데 그 결과 **그 검사는 누구에게도 안 보인다.** 장비 태그 오타 하나로
   * 영상이 시스템에 들어와 있는데 아무도 모르는 상태가 되고, 아무도 모르므로
   * 아무도 고치지 않는다. 조용히 사라지는 검사는 조용히 섞이는 검사만큼 나쁘다.
   *
   * 그래서 **관리자용 통로 하나**를 낸다. 목록에 섞어 보여주지 않고, 별도 경로로만
   * 보이고, 배정은 감사로그에 남는다. (§9 — 편의로 기관 경계를 뚫지는 않는다)
   */
  async unassigned(c: Caller) {
    need(c.roles, 'admin', '미배정 검사 조회');
    inst(c);   // 소속이 없는 계정은 admin이어도 여기서 막힌다
    const orphans = await this.prisma.studyState.findMany({ where: { institutionId: null } });
    if (!orphans.length) return { studies: [], institutions: this.institutions.map(i => ({ id: i.id, name: i.name })) };
    const set = await this.studyAccess.allowed(c,orphans.map(o=>o.uid));
    const qido = await this.orthanc.studies();
    const studies = qido
      .filter(st => set.has(OrthancService.tag(st, '0020000D')))
      .map(st => ({
        uid: OrthancService.tag(st, '0020000D'),
        id: OrthancService.tag(st, '00100020'),
        name: OrthancService.tag(st, '00100010').replace(/\^/g, ' '),
        date: OrthancService.tag(st, '00080020'),
        desc: OrthancService.tag(st, '00081030'),
        // 왜 못 알아봤는지 사람이 보고 판단할 수 있어야 한다. 이 문자열이 단서다.
        dicomInstitution: OrthancService.tag(st, '00080080'),
      }));
    return { studies, institutions: this.institutions.map(i => ({ id: i.id, name: i.name })) };
  }

  /**
   * 미배정 검사를 기관에 배정한다.
   *
   * **이미 배정된 검사는 여기로 옮기지 못한다.** 판독문이 붙은 검사를 다른 기관으로
   * 옮기는 것은 전혀 다른 무게의 일이다 — 누가 읽었는지, 누가 볼 수 있는지가 함께
   * 바뀐다. 이 통로는 "고아를 집에 보내는" 것 하나만 한다.
   */
  async assignInstitution(uid: string, institutionId: string, c: Caller) {
    return this.access.scopeWrite(uid,c,async(tx,audit)=>{
    need(c.roles, 'admin', '검사 기관 배정');
    inst(c);
    await this.studyAccess.require(c,[uid],tx);
    if (!this.institutions.some(i => i.id === institutionId))
      throw new BadRequestException(`알 수 없는 기관입니다: ${institutionId}`);
    const s = await tx.studyState.findUnique({ where: { uid } });
    if (!s) throw new NotFoundException('검사를 찾을 수 없습니다');
    if (s.institutionId)
      throw new BadRequestException(
        `이미 ${this.instName(s.institutionId)}에 배정된 검사입니다. 기관 이동은 이 통로로 하지 않습니다.`);
    const saved = await tx.studyState.update({
      where: { uid }, data: { institutionId, reqHosp: this.instName(institutionId) },
    });
    await audit(c.actor, 'study.assign', uid, { institutionId });
    return toClient(saved, await tx.report.findUnique({ where: { uid } }), c, await this.access.myDraft(uid, c.actor, tx));
    });
  }

  /**
   * 내 기관의 판독의 목록 — Preliminary에서 상급 판독의를 고를 때 쓴다.
   * D623: 선택 명부는 Keycloak에 남고, 실제 지정 자격은 commitReport에서 DB로 판정한다.
   */
  async colleagues(c: Caller) {
    need(c.roles, 'radiologist', '판독의 목록 조회');   // Preliminary 지정 화면 전용
    const me = inst(c);
    const users = await this.keycloak.usersInGroupWithRole(me, 'radiologist');
    return users.filter(u => u.id !== c.actor);   // 자기 자신은 지정 대상이 아니다
  }
}

/*
 * 기관 목록 캐시(이 객체 하나)·기동 시드·DICOM 기관명·수신 장비 해석과 그 등록(D1882)·판독의 명부.
 * 캐시를 읽는 다른 concern은 이 객체의 `institutions`를 매번 읽는다. 복사본을 들면 reload가 한쪽에만 닿는다.
 * PacsService가 만들어 소유하는 평범한 객체다(Nest provider가 아니다). 생성자는 참조만 저장한다.
 */
import type { StudyAccessService } from '../study-access.service';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { PrismaService } from '../prisma.service';
import type { OrthancService } from '../orthanc.service';
import type { KeycloakService } from '../keycloak.service';
import { SEED_INSTITUTIONS, SEED_ORDERS } from '../seed';
import { institutionValues as names, withInstitutionValue } from '../institution-values';
import { dump } from './values';
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
    // 기관 시드 — 이미 있으면 이름·종류만 갱신한다. 별칭·장비는 생성 뒤 관리자가 병원과 확인해 등록한 사실이라(D1882)
    // 재기동이 덮어쓰면 등록이 사라지고 그 뒤 도착한 검사가 다시 보류된다.
    for (const i of SEED_INSTITUTIONS)
      await this.prisma.institution.upsert({ where: { id: i.id }, create: i, update: { name: i.name, type: i.type } });
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
   * 아무도 발견하지 못한다. 기관명도 등록 장비도 맞지 않는 검사는 보류되어(D1882)
   * 아무도 열지 못하고 어느 목록에도 없으며, 운영자에게는 환자 정보 없는 알림만 간다.
   */
  resolveInstitution(dicomName: string): string | null {
    const key = (dicomName ?? '').trim().toLowerCase();
    if (!key) return null;
    for (const i of this.institutions) {
      const aliases = names(i.dicomNames).map(s => s.toLowerCase());
      if (aliases.includes(key) || i.id.toLowerCase() === key || i.name.toLowerCase() === key) return i.id;
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
   * D1882: the sending device (the calling AE title Orthanc recorded) → institution id, from the devices an
   * administrator registered after confirming them with the hospital. AE titles compare exactly after trimming.
   */
  resolveDevice(aet: string | null): string | null {
    const key = (aet ?? '').trim();
    if (!key) return null;
    const owners = this.institutions.filter(i => names(i.dicomAets).includes(key));
    return owners.length === 1 ? owners[0].id : null;
  }

  /**
   * D1882: who sent a study is decided only by facts confirmed with the hospital — a sending device or an
   * InstitutionName spelling. An administrator records one for the own institution (an admin speaks for the own
   * hospital only, §1.4). One value names one institution: a value another institution holds is refused, the same
   * registration again changes nothing. The row lock, the write and the audit row are one transaction; there is no
   * per-study assignment and no removal here, since detaching studies that were already read is not this path's job.
   */
  async registerSource(kind: 'device' | 'alias', body: any, c: Caller) {
    need(c.roles, 'admin', kind === 'device' ? '수신 장비 등록' : '기관명 표기 등록');
    const me = inst(c);
    const value = typeof body?.value === 'string' ? body.value.trim() : '';
    const confirmation = typeof body?.confirmation === 'string' ? body.confirmation.trim() : '';
    // AE titles are at most 16 characters (PS3.5 VR AE). A spelling and the confirmation are as long as the hospital's
    // own text; the request body limit is their only bound. A comma is stored escaped (institution-values.ts).
    if (!value || (kind === 'device' && value.length > 16))
      throw new BadRequestException(kind === 'device' ? '장비 AE Title을 확인하세요(16자 이내).' : '기관명 표기를 확인하세요.');
    if (!confirmation)
      throw new BadRequestException('병원과 확인한 내용(누구와 언제)을 적으세요.');
    const field = kind === 'device' ? 'dicomAets' : 'dicomNames';
    const same = (row: any) => kind === 'device' ? names(row[field]).includes(value)
      : [row.id, row.name, ...names(row[field])].some(name => name.toLowerCase() === value.toLowerCase());
    const changed = await this.prisma.$transaction(async tx => {
      // Every institution row is locked in one order, so two registrations of one value cannot both pass the check.
      const rows = await tx.$queryRaw<any[]>`SELECT id, name, "dicomNames", "dicomAets" FROM "Institution" ORDER BY id FOR UPDATE`;
      const own = rows.find(row => row.id === me);
      if (!own) throw new BadRequestException(`알 수 없는 기관입니다: ${me}`);
      if (rows.some(row => row.id !== me && same(row)))
        throw new ConflictException({ code: 'SOURCE_REGISTERED_ELSEWHERE',
          message: '이미 다른 기관에 등록된 값입니다. 병원과 다시 확인하세요.' });
      if (same(own)) return false;
      await tx.institution.update({ where: { id: me }, data: { [field]: withInstitutionValue(own[field], value) } });
      await tx.auditLog.create({ data: { actor: c.actor || 'unknown',
        action: kind === 'device' ? 'institution.device.register' : 'institution.alias.register',
        target: me, detail: dump({ institution: me, value, confirmation }) } });
      return true;
    }, { maxWait: 4000, timeout: 8000 });
    await this.reloadInstitutions();
    return { kind, value, institutionId: me, changed };
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

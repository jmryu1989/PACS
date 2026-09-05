import { Injectable, BadRequestException, ConflictException, ForbiddenException, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { OrthancService } from './orthanc.service';
import { KeycloakService } from './keycloak.service';
import { SEED_INSTITUTIONS, SEED_ORDERS, SEED_TEMPLATES } from './seed';

/**
 * 호출자. 다섯 필드 모두 **서명된 토큰**과 가드 판정에서 나온다 — 클라이언트가 정할 수 없다.
 *  sub         KC 사용자 ID    (세션 일괄 폐기 키)
 *  actor       누구인가        (감사로그)
 *  roles       무엇을 할 수 있나 (판독의/기사)
 *  institution 어디 소속인가    (어떤 데이터를 볼 수 있나)  ← 이번 작업에서 추가
 *  kind        사람인가 gateway인가 (허용되는 API 면)
 */
export interface Caller {
  sub: string;
  actor: string;
  roles: string[];
  institution: string | null;
  kind: 'member' | 'gateway';
}

/**
 * 역할 검사. HPACS의 Radiology / Technician 두 탭이 그냥 화면 분리가 아니라
 * 권한 분리라는 것이 핵심 — 방사선사는 검사를 확인(Verify)하고 오더를 매칭하지만
 * 판독문을 승인하지 않는다. 판독의는 그 반대다.
 * admin은 둘 다 할 수 있다(개발·운영 편의).
 */
function need(roles: string[], role: string, what: string) {
  if (!roles?.includes(role) && !roles?.includes('admin'))
    throw new ForbiddenException(`${what}은(는) ${role} 권한이 필요합니다`);
}

/** Gateway 라우트에는 admin 예외가 없다. 신원 종류와 전용 역할이 모두 맞아야 한다. */
function needExact(c: Caller, role: string, what: string) {
  if (c.kind !== 'gateway' || !c.roles?.includes(role))
    throw new ForbiddenException(`${what}은(는) ${role} 전용입니다`);
}

/**
 * 소속 기관 확인.
 *
 * **admin에게도 예외를 주지 않는다.** 역할(role)은 "무엇을 할 수 있는가"이고
 * 기관은 "무엇을 볼 수 있는가"다. 둘은 다른 축이라, admin이라고 남의 병원 환자를
 * 보게 하면 그건 편의가 아니라 구멍이다. 운영자용 전역 조회가 정말 필요해지면
 * 그때 별도 경로로 만들고 감사로그를 남긴다.
 *
 * 기관이 비어 있으면 조용히 빈 목록을 주지 않고 **소리 내어 막는다.**
 * 매퍼 설정이 틀렸을 때 "검사가 하나도 없네" 로 보이면 그게 최악이다.
 */
function inst(c: Caller): string {
  if (!c.institution)
    throw new ForbiddenException(
      '소속 기관이 없는 계정입니다. Keycloak에서 이 사용자를 기관 그룹에 넣어주세요.');
  return c.institution;
}

const TECHNICIAN_FIELDS = ['ss', 'ward', 'reqHosp', 'em', 'ov'];

/** JSON 문자열 컬럼 ↔ 객체 변환. 서버가 깨진 값을 받아도 죽지 않게 감싼다. */
const parse = (s?: string) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const dump = (o: any) => (o == null ? null : JSON.stringify(o));

/**
 * 점유 유효시간. 브라우저가 죽거나 탭이 닫히면 해제 요청이 오지 않는다.
 * "닫았을 때 해제"만 믿으면 검사가 영원히 잠긴다 — 그래서 시간으로도 푼다.
 * 프론트는 이보다 짧은 주기로 하트비트를 보내 점유를 갱신한다.
 */
const HOLD_TTL_MS = 5 * 60 * 1000;
const holdAlive = (s: any) => s?.holder && s.heldAt && Date.now() - new Date(s.heldAt).getTime() < HOLD_TTL_MS;

/**
 * Preliminary(RS=P) 판독문을 이 사람이 볼 수 있는가.
 *
 * 예비 판독은 **아직 확정되지 않은 소견**이다. 상급 판독의가 뒤집을 수 있는 내용이
 * 기관 전체에 퍼지면, 나중에 정정해도 이미 읽은 사람의 머릿속까지 정정되지는 않는다.
 * 그래서 작성자와 지정된 상급자만 본다. (HPACS 매뉴얼 7.4.1.3-4.1)
 *
 * 검사 자체는 워크리스트에 그대로 보인다 — 가리는 건 판독문 내용뿐이다.
 * 검사를 통째로 숨기면 "그 검사 어디 갔냐"가 되고, 그건 다른 종류의 사고다.
 */
function canReadPrelim(s: any, actor: string) {
  if (s?.rs !== 'P') return true;
  return s.preDoc === actor || s.preReviewer === actor;
}

/**
 * 프론트가 그대로 쓸 수 있는 모양으로 되돌린다 (main.html의 appState 한 칸과 같은 구조)
 *
 * `d`는 **이 호출자 본인의 초안**이다. 남의 초안은 절대 실어 보내지 않는다 —
 * 초안은 아직 진술이 아니고, 확정되지 않은 소견이 퍼지면 나중에 뒤집어도
 * 이미 읽은 사람의 머릿속은 안 뒤집힌다 (RS=P를 가리는 것과 같은 이유).
 * 남이 쓰고 있다는 사실은 점유 표시(holder)가 이미 말해준다.
 */
function toClient(s: any, r: any, actor = '', d: any = null) {
  const hidden = !canReadPrelim(s, actor);
  return {
    rs: s.rs, ss: s.ss, em: s.em, ts: s.ts,
    matched: s.matched, ward: s.ward, reqHosp: s.reqHosp,
    institutionId: s.institutionId ?? null,
    teleInstitutionId: s.teleInstitutionId ?? null,
    /**
     * ── 아래 필드는 전부 `undefined`가 아니라 `null`이다 ──
     *
     * 클라이언트는 `{...기존, ...응답}`으로 상태를 병합한다. 그런데 `JSON.stringify`는
     * undefined 키를 **통째로 지운다.** 키가 없으면 스프레드가 이전 값을 못 덮으므로
     * "이 값은 비워졌다"는 사실이 영영 전달되지 않는다.
     *
     * 실제로 이 실수를 두 번 했다. 처음엔 `holder`에서(인계문서 §8), 이번엔 나머지
     * 전부에서. 결과는 **매칭을 해제했는데 화면엔 남의 환자 이름이 그대로 남고**,
     * **승인이 끝났는데 판독문이 계속 잠긴 것처럼 보이는 것**이었다.
     *
     * 비움도 값이다. 값이 사라졌다는 것도 전송해야 한다.
     */
    preDoc: s.preDoc ?? null, preReviewer: s.preReviewer ?? null,
    // 화면이 "왜 비어 있는지" 말할 수 있어야 한다. 빈 판독문과 가려진 판독문은 다르다.
    prelimHidden: hidden,
    repDoc: s.repDoc ?? null, confirm: s.confirm ?? null,
    ov: parse(s.ov) ?? null, orig: parse(s.orig) ?? null,
    oid: s.orderOid ?? null,
    // 만료된 점유는 없는 것으로 내보낸다. 화면이 유령 자물쇠를 그리지 않게.
    // undefined가 아니라 null인 이유: JSON.stringify는 undefined 키를 통째로 지운다.
    // 키가 사라지면 클라이언트의 `{...기존, ...응답}` 이 이전 점유자를 그대로 남긴다.
    // "값을 비웠다"는 사실도 전송되어야 한다.
    holder: holdAlive(s) ? s.holder : null,
    version: r?.version ?? 0,
    findings: hidden ? '' : (r?.findings ?? ''),
    conclusion: hidden ? '' : (r?.conclusion ?? ''),
    recommendation: hidden ? '' : (r?.recommendation ?? ''),
    /**
     * 내가 쓰다 만 초안. 없으면 `undefined`가 아니라 `null`이다 —
     * 클라이언트가 `{...기존, ...응답}`으로 병합하므로, 키가 없으면 "초안이 사라졌다"가
     * 전달되지 않아 확정한 뒤에도 옛 초안이 화면에 계속 남는다. (§14 — 비움도 값이다)
     */
    draft: (hidden || !d) ? null : {
      findings: d.findings, conclusion: d.conclusion, recommendation: d.recommendation,
      baseVersion: d.baseVersion, at: d.updatedAt,
    },
  };
}

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
const REPORT_OWNED_FIELDS = ['rs', 'repDoc', 'confirm', 'matched', 'orig'];

/** 원격판독 상태머신. 어느 쪽 기관이 이 전이를 일으킬 수 있는가가 핵심이다. */
const TELE_BY_OWNER = ['none', 'wait', 'sending', 'sent', 'cancelled', 'fail'];  // 의뢰 기관이 미는 구간
const TELE_BY_RECEIVER = ['inReading', 'completed'];                             // 수신 기관이 미는 구간
/** 통로가 닫히는 상태 — 여기로 가면 수신 기관은 검사를 더 못 본다 */
const TELE_CLOSED = ['none', 'cancelled'];
/** 화면의 실제 버튼 흐름과 같은 전이만 허용한다. 역행·건너뛰기는 데이터 조작이다. */
const TELE_NEXT: Record<string, string[]> = {
  none: ['wait'], wait: ['sending', 'cancelled'], sending: ['sent', 'fail', 'cancelled'],
  sent: ['inReading', 'cancelled'], inReading: ['completed', 'cancelled'],
  completed: [], cancelled: ['wait'], fail: ['wait', 'cancelled'],
};

@Injectable()
export class PacsService implements OnModuleInit {
  constructor(
    private prisma: PrismaService,
    private orthanc: OrthancService,
    private keycloak: KeycloakService,
  ) {}

  /** 기관 목록 캐시. 몇 개 안 되고 거의 안 바뀌므로 메모리에 둔다. */
  private institutions: any[] = [];

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
  private resolveInstitution(dicomName: string): string | null {
    const key = (dicomName ?? '').trim().toLowerCase();
    if (!key) return null;
    for (const i of this.institutions) {
      const names = String(i.dicomNames ?? '').split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean);
      if (names.includes(key) || i.id.toLowerCase() === key || i.name.toLowerCase() === key) return i.id;
    }
    return null;
  }

  private instName(id: string | null) {
    return this.institutions.find(i => i.id === id)?.name ?? '(미배정)';
  }

  private audit(actor: string, action: string, target: string, detail?: any) {
    return this.prisma.auditLog.create({
      data: { actor: actor || 'unknown', action, target, detail: dump(detail) },
    });
  }

  /**
   * 이 검사를 이 기관이 다룰 수 있는가.
   *  - 소유 기관이면 된다
   *  - 원격판독을 받은 기관이어도 된다  ← **기관 경계를 넘는 유일한 통로**
   */
  private visible(s: any, institution: string) {
    return s.institutionId === institution || s.teleInstitutionId === institution;
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
    const set = new Set(orphans.map(o => o.uid));
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
    need(c.roles, 'admin', '검사 기관 배정');
    inst(c);
    if (!this.institutions.some(i => i.id === institutionId))
      throw new BadRequestException(`알 수 없는 기관입니다: ${institutionId}`);
    const s = await this.prisma.studyState.findUnique({ where: { uid } });
    if (!s) throw new NotFoundException('검사를 찾을 수 없습니다');
    if (s.institutionId)
      throw new BadRequestException(
        `이미 ${this.instName(s.institutionId)}에 배정된 검사입니다. 기관 이동은 이 통로로 하지 않습니다.`);
    const saved = await this.prisma.studyState.update({
      where: { uid }, data: { institutionId, reqHosp: this.instName(institutionId) },
    });
    await this.audit(c.actor, 'study.assign', uid, { institutionId });
    return toClient(saved, await this.prisma.report.findUnique({ where: { uid } }), c.actor, null);
  }

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
    if (path === '/statistics') return;

    // /dicom-web/studies/{uid}/... — 경로의 UID로 관문
    let m = /^\/dicom-web\/studies\/([0-9.]+)(?:\/|$)/.exec(path);
    let uid = m?.[1];

    // /dicom-web/studies?StudyInstanceUID=... — 쿼리의 UID로 관문 (OHIF 초기 조회)
    if (!uid && path === '/dicom-web/studies') {
      const q = new URLSearchParams(query);
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
    if (!s || !this.visible(s, me)) throw new ForbiddenException('열람 권한이 없습니다');
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

    const resolvedTag = this.resolveInstitution(typeof institutionNameTag === 'string' ? institutionNameTag : '');
    const tagMismatch = resolvedTag != null && resolvedTag !== me;
    try {
      const saved = await this.prisma.$transaction(async tx => {
        const created = await tx.studyState.create({ data: {
          uid: studyUid,
          institutionId: me,
          reqHosp: this.instName(me),
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
    if (!study || !this.visible(study, me)) throw new ForbiddenException('열람 권한이 없습니다');
    return { id: instances[0].ID };
  }

  /** 쓰기 전 관문. 없는 검사와 남의 검사는 같은 메시지로 막는다(존재 여부도 정보다). */
  /**
   * 내 초안 한 건. **모든 `toClient` 호출이 이걸 실어야 한다.**
   *
   * 안 실으면 `draft: null`이 나가고, 클라이언트의 `{...기존, ...응답}`이
   * 방금 쓰고 있던 초안을 지운다 — 점유 하트비트나 Verify 한 번에 화면의 판독문이
   * 사라지는 것이다. §14("비움도 값이다")의 정확히 반대편 함정이고,
   * 같은 실수를 `holder`에서 한 번, `toClient`의 7개 필드에서 또 했다.
   */
  private myDraft(uid: string, actor: string) {
    return this.prisma.reportDraft.findUnique({ where: { uid_author: { uid, author: actor } } });
  }

  private async gate(uid: string, c: Caller) {
    const me = inst(c);
    const s = await this.prisma.studyState.findUnique({ where: { uid } });
    if (s && !this.visible(s, me))
      throw new NotFoundException('검사를 찾을 수 없습니다');
    return s;
  }

  // ══════════════════ 조회 ══════════════════

  /**
   * 검사 목록. **예전엔 브라우저가 Orthanc를 직접 불렀다.**
   * 이제 서버가 QIDO-RS를 대신 부르고, 기관으로 거른 뒤, 상태를 얹어 내려준다.
   * 필터를 화면에 두면 주소창으로 우회할 수 있다 — 경계는 서버에만 있다.
   *
   * 처음 본 검사는 여기서 StudyState 행이 생기며 기관이 박힌다(lazy 등록).
   * 조회가 쓰기를 하는 게 이상해 보이지만, 대안은 모든 쓰기 경로가 매번
   * Orthanc에 기관을 물어보는 것이다. 기관은 영상에 찍혀 오는 사실이고
   * 한 번 판정하면 변하지 않으므로, 처음 보는 순간 DB에 확정한다.
   */
  async listStudies(c: Caller) {
    const me = inst(c);
    const qido = await this.orthanc.studies();

    const states = await this.prisma.studyState.findMany();
    const byUid = new Map(states.map(s => [s.uid, s as any]));

    // 아직 등록 안 된 검사에 기관을 박는다 (한 번만 일어난다)
    const news: any[] = [];
    for (const st of qido) {
      const uid = OrthancService.tag(st, '0020000D');
      if (!uid) continue;
      const cur = byUid.get(uid);
      const resolved = this.resolveInstitution(OrthancService.tag(st, '00080080'));
      if (!cur) news.push({ uid, institutionId: resolved, reqHosp: this.instName(resolved) });
      else if (cur.institutionId == null && resolved) news.push({ uid, institutionId: resolved, patch: true });
    }
    for (const n of news) {
      const row = n.patch
        ? await this.prisma.studyState.update({ where: { uid: n.uid }, data: { institutionId: n.institutionId } })
        : await this.prisma.studyState.create({
            data: {
              uid: n.uid, institutionId: n.institutionId, reqHosp: n.reqHosp,
              // 처음 보는 검사는 방금 장비에서 도착한 것이다 → **기사 확인 전(Unverified)**.
              // 도착 검사는 바로 보이되, 비응급 판독 쓰기는 Verify 뒤에만 허용한다.
              // 도착하자마자 판독을 허용하면 기사가 환자·검사정보를 고칠 틈이 없고,
              // 그 상태로 판독이 붙으면 더는 고칠 수 없다(RS≠W 규칙).
              ss: 'Unverified',
            },
          });
      if (!n.patch) await this.audit('system', 'study.arrived', n.uid, { institutionId: n.institutionId });
      byUid.set(n.uid, row as any);
    }

    const reports = await this.prisma.report.findMany();
    const repByUid = new Map(reports.map(r => [r.uid, r]));
    // 목록에도 내 초안을 함께 싣는다. 30초 폴링 응답이 초안 없이 오면
    // 클라이언트 병합이 쓰고 있던 초안을 지운다.
    const drafts = await this.prisma.reportDraft.findMany({ where: { author: c.actor } });
    const draftByUid = new Map(drafts.map(d => [d.uid, d]));

    const out: any[] = [];
    for (const st of qido) {
      const uid = OrthancService.tag(st, '0020000D');
      const s = byUid.get(uid);
      if (!s || !this.visible(s, me)) continue;   // ← 기관 경계. 여기가 전부다.

      const birth = OrthancService.tag(st, '00100030');
      const date = OrthancService.tag(st, '00080020');
      const patientId = OrthancService.tag(st, '00100020');
      out.push({
        uid,
        count: +OrthancService.tag(st, '00201208') || 0,
        series: +OrthancService.tag(st, '00201206') || 0,
        acc: OrthancService.tag(st, '00080050'),
        id: patientId,
        // 화면 오버레이가 PatientID를 바꿔도 Related의 기관 경계는 원본 DICOM 값에 남는다.
        sourcePatientKey: s.institutionId == null || !patientId ? null : `${s.institutionId}|${patientId}`,
        name: OrthancService.tag(st, '00100010').replace(/\^/g, ' '),
        birth, date,
        sex: OrthancService.tag(st, '00100040'),
        modality: st['00080061']?.Value?.join(',') ?? '',
        desc: OrthancService.tag(st, '00081030'),
        institutionName: this.instName(s.institutionId),
        // 이 검사가 우리에게 원격판독으로 넘어온 것인가 (화면에서 구분해 보여준다)
        tele: s.teleInstitutionId === me && s.institutionId !== me,
        state: toClient(s, repByUid.get(uid), c.actor, draftByUid.get(uid)),
      });
    }
    return { studies: out, serverTime: new Date().toISOString() };
  }

  /** 프론트가 켜질 때 한 번에 받아가는 묶음 — 전부 내 기관 것만 */
  async bootstrap(c: Caller) {
    const me = inst(c);
    const [states, orders] = await Promise.all([
      this.prisma.studyState.findMany({
        where: { OR: [{ institutionId: me }, { teleInstitutionId: me }] },
      }),
      this.prisma.order.findMany({ where: { institutionId: me }, orderBy: { sched: 'asc' } }),
    ]);
    const reports = await this.prisma.report.findMany({
      where: { uid: { in: states.map(s => s.uid) } },
    });
    const byUid = Object.fromEntries(reports.map(r => [r.uid, r]));
    // 켤 때 내 초안도 함께 — "어제 쓰다 만 것"이 PC를 바꿔도 따라온다.
    // 필터·상용구를 계정에 붙인 것과 같은 이유다 (§6-A-4).
    const drafts = await this.prisma.reportDraft.findMany({ where: { author: c.actor } });
    const draftByUid = Object.fromEntries(drafts.map(d => [d.uid, d]));
    const prefs = await this.prefs(c);   // 필터·상용구도 첫 요청에 함께 (왕복을 늘리지 않는다)
    return {
      me: { actor: c.actor, roles: c.roles, institution: me, institutionName: this.instName(me) },
      filters: prefs.filters,
      templates: prefs.templates,
      institutions: this.institutions.map(i => ({ id: i.id, name: i.name, type: i.type })),
      states: Object.fromEntries(states.map(s => [s.uid, toClient(s, byUid[s.uid], c.actor, draftByUid[s.uid])])),
      orders: orders.map(o => ({
        oid: o.oid, id: o.patientId, name: o.name, sex: o.sex, birth: o.birth,
        sched: o.sched, modality: o.modality, desc: o.descr, ward: o.ward,
        reqDoc: o.reqDoc, matched: o.matched, studyUid: o.studyUid,
      })),
      serverTime: new Date().toISOString(),
    };
  }

  // ══════════════════ 쓰기 ══════════════════

  // ══════════════════ 개인 설정 (필터·상용구) ══════════════════
  //
  // 둘 다 **계정에 붙는다.** 브라우저가 아니라.
  // 판독의는 자기 필터를 하루 종일 쓴다. PC를 바꿨다고 초기화되면 깨지는 건
  // 작업이 아니라 신뢰다 (교훈 §6 — HPACS가 5년간 반복한 버그 카테고리).
  //
  // 반대로 **모니터 구성에 딸린 것(필름박스 레이아웃 등)은 계정에 두면 안 된다.**
  // HPACS도 Hanging Protocol만은 "계정 + 컴퓨터"별로 기억하도록 따로 만들었다 —
  // 집의 1대 모니터와 병원의 3대 모니터에 같은 레이아웃을 강요할 수 없기 때문.
  // 계정에 저장할 것과 기기에 남길 것을 나누는 기준이 여기 있다.

  /** 내 필터 + 내 상용구. 처음 보는 계정이면 기본 상용구를 넣어준다. */
  async prefs(c: Caller) {
    const owner = c.actor;
    /**
     * 새 계정에는 기본 상용구를 넣어준다 — 빈 목록은 버그로 보이기 때문.
     * (HPACS도 "신규계정인 경우 Reading Template 생성이 되지 않았던 오류"를 고친 적이 있다)
     *
     * **단, 판독의에게만.** 상용구는 판독문을 쓰는 도구다. 방사선사는 판독문을 안 쓰므로
     * 그 사람 계정에 판독 상용구가 세 개 생기면, 못 쓰는 기능이 목록에 놓여 있는 셈이다.
     * 화면에 있는데 아무것도 못 하는 것은 안내가 아니라 소음이다.
     */
    const canRead = c.roles?.includes('radiologist') || c.roles?.includes('admin');
    const n = await this.prisma.readingTemplate.count({ where: { owner } });
    if (n === 0 && canRead)
      await this.prisma.readingTemplate.createMany({
        data: SEED_TEMPLATES.map(t => ({ ...t, owner })),
      });

    const [filters, templates] = await Promise.all([
      this.prisma.userFilter.findMany({ where: { owner }, orderBy: { createdAt: 'asc' } }),
      this.prisma.readingTemplate.findMany({ where: { owner }, orderBy: [{ ord: 'asc' }, { id: 'asc' }] }),
    ]);
    return {
      filters: filters.map(f => ({ ...f, cols: parse(f.cols) ?? {} })),
      templates,
    };
  }

  /** 필터 저장 (같은 이름이면 덮어쓴다 — 이름이 곧 사용자에게는 그 필터다) */
  async saveFilter(body: any, c: Caller) {
    const owner = c.actor;
    const name = String(body.name ?? '').trim();
    if (!name) throw new BadRequestException('필터 이름이 필요합니다');

    const data = {
      mode: body.mode ?? 'Radiology',
      quick: String(body.quick ?? ''),
      days: Number.isFinite(+body.days) ? +body.days : -1,
      cols: dump(body.cols ?? {}) ?? '{}',
      sortKey: body.sortKey ?? null,
      sortDir: +body.sortDir || 0,
      isDefault: !!body.isDefault,
    };

    // 기본 필터는 하나뿐이다. 새로 지정하면 이전 것이 풀린다 —
    // 두 개가 기본이면 로그인할 때마다 어느 쪽이 걸릴지 모른다.
    if (data.isDefault)
      await this.prisma.userFilter.updateMany({ where: { owner }, data: { isDefault: false } });

    const saved = await this.prisma.userFilter.upsert({
      where: { owner_name: { owner, name } },
      create: { owner, name, ...data },
      update: data,
    });
    return { ...saved, cols: parse(saved.cols) ?? {} };
  }

  /** 기본 필터 지정/해제 */
  async setDefaultFilter(id: number, on: boolean, c: Caller) {
    const owner = c.actor;
    const f = await this.prisma.userFilter.findUnique({ where: { id } });
    if (!f || f.owner !== owner) throw new NotFoundException('필터를 찾을 수 없습니다');
    if (on) await this.prisma.userFilter.updateMany({ where: { owner }, data: { isDefault: false } });
    await this.prisma.userFilter.update({ where: { id }, data: { isDefault: on } });
    return { ok: true };
  }

  async deleteFilter(id: number, c: Caller) {
    // 남의 것을 지우지 못하게 owner를 조건에 넣는다. 찾아서 검사하고 지우면
    // 그 사이가 벌어질 수 있으므로 조건을 삭제문 안에 둔다.
    const r = await this.prisma.userFilter.deleteMany({ where: { id, owner: c.actor } });
    if (!r.count) throw new NotFoundException('필터를 찾을 수 없습니다');
    return { ok: true };
  }

  private async nextTemplateOrd(owner: string) {
    const last = await this.prisma.readingTemplate.findFirst({
      where: { owner }, orderBy: { ord: 'desc' }, select: { ord: true },
    });
    return (last?.ord ?? 0) + 1;
  }

  /** 상용구 저장 (id가 있으면 수정) */
  async saveTemplate(body: any, c: Caller) {
    need(c.roles, 'radiologist', '판독 상용구 편집');
    const owner = c.actor;
    const title = String(body.title ?? '').trim();
    if (!title) throw new BadRequestException('제목이 필요합니다');
    const data = {
      title,
      shortcut: String(body.shortcut ?? '').trim(),
      modality: String(body.modality ?? '').trim(),
      bodypart: String(body.bodypart ?? '').trim(),
      findings: body.findings ?? '',
      conclusion: body.conclusion ?? '',
      recommendation: body.recommendation ?? '',
      // 새로 만든 건 목록 끝에 붙는다. 0으로 두면 맨 위로 올라가서, 방금 만든 하나가
      // 매일 쓰던 상용구들을 밀어낸다. 순서는 사용자가 정할 것이지 우연히 정해질 게 아니다.
      ord: +body.ord || (body.id ? 0 : await this.nextTemplateOrd(owner)),
    };
    if (body.id) {
      const id = Number(body.id);
      if (!Number.isInteger(id) || id <= 0)
        throw new BadRequestException(`잘못된 상용구 id입니다: ${body.id}`);
      const r = await this.prisma.readingTemplate.updateMany({ where: { id, owner }, data });
      if (!r.count) throw new NotFoundException('상용구를 찾을 수 없습니다');
      return this.prisma.readingTemplate.findUnique({ where: { id } });
    }
    return this.prisma.readingTemplate.create({ data: { owner, ...data } });
  }

  async deleteTemplate(id: number, c: Caller) {
    need(c.roles, 'radiologist', '판독 상용구 삭제');   // saveTemplate과 같은 역할 경계
    const r = await this.prisma.readingTemplate.deleteMany({ where: { id, owner: c.actor } });
    if (!r.count) throw new NotFoundException('상용구를 찾을 수 없습니다');
    return { ok: true };
  }

  /** 검사 상태 부분 수정 (RS 토글, Verify, Switch EM/ReqHosp, TS 전이 …) */
  async patchState(uid: string, body: any, c: Caller) {
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

    const prev = await this.gate(uid, c);
    // 쓰기 경로는 행을 만들지 않는다. 생성은 DICOM 기관명을 검증하는 listStudies 한 곳뿐이다.
    if (!prev) throw new NotFoundException('검사를 찾을 수 없습니다');

    /**
     * **예비 판독 중인 검사는 여기서도 막는다.**
     *
     * 판독문 저장·확정·점유·이력 네 곳에 관문을 달면서 이 한 곳을 빼먹었고,
     * 그래서 `PATCH {rs:"T"}` 한 번으로 잠금이 통째로 풀렸다. 응답에 판독문 본문까지
     * 실려 나갔다. **관문은 한 곳만 열려 있어도 관문이 아니다.**
     */
    if (!canReadPrelim(prev, c.actor))
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
          if (!this.institutions.some(i => i.id === body.teleTo))
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
    }

    const saved = await this.prisma.studyState.update({ where: { uid }, data });
    await this.audit(c.actor, 'state.patch', uid, { ...data, by: me });
    const r = await this.prisma.report.findUnique({ where: { uid } });
    return toClient(saved, r, c.actor, await this.myDraft(uid, c.actor));
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
   * 초안을 쓴 사람에게 붙이면 충돌은 감지할 필요조차 없다. 같은 행을 안 쓰니까.
   *
   * 충돌은 확정할 때만 일어난다 — 사람이 화면 앞에 있고, 스스로 누른 순간이고,
   * 물어볼 수 있는 자리다. 낙관적 락은 `commitReport` 한 곳에만 있으면 된다.
   */
  async putReport(uid: string, body: any, c: Caller) {
    need(c.roles, 'radiologist', '판독문 저장');
    const prev = await this.gate(uid, c);
    if (prev?.ss === 'Unverified' && prev.em !== 'E')
      throw new ConflictException('촬영 중(미확인) 검사입니다 — 기사 확인(Verify) 뒤 판독할 수 있습니다');
    const heldByOther = holdAlive(prev) && prev.holder !== c.actor ? prev.holder : null;
    if (heldByOther)
      throw new ConflictException({ code: 'REPORT_HELD', holder: heldByOther, message: `${heldByOther} 님이 판독 중입니다` });
    if (!prev) throw new NotFoundException('검사를 찾을 수 없습니다');
    if (!canReadPrelim(prev, c.actor))
      throw new ForbiddenException(
        `예비 판독(RS: P) 중입니다. ${prev?.preReviewer ?? '지정된 판독의'}만 이어서 판독할 수 있습니다.`);

    const content = {
      findings: body.findings ?? '',
      conclusion: body.conclusion ?? '',
      recommendation: body.recommendation ?? '',
    };
    const empty = !(content.findings || content.conclusion || content.recommendation);

    /**
     * 빈 초안은 **행을 지운다.** 빈 초안을 남겨두면 그게 확정본을 가려서,
     * 승인된 판독문을 열었는데 빈 칸이 보이는 상태가 된다.
     * "초안이 없다"와 "초안이 비어 있다"는 화면에서 같은 뜻이어야 한다.
     */
    if (empty) {
      await this.prisma.reportDraft.deleteMany({ where: { uid, author: c.actor } });
      await this.audit(c.actor, 'report.draft.clear', uid, {});
      return { uid, author: c.actor, cleared: true };
    }

    const saved = await this.prisma.reportDraft.upsert({
      where: { uid_author: { uid, author: c.actor } },
      create: { uid, author: c.actor, ...content, baseVersion: body.baseVersion ?? 0 },
      update: { ...content, baseVersion: body.baseVersion ?? 0 },
    });
    // 판독문 전문을 감사로그에 통째로 넣지 않는다 — 길이와 개인정보 때문. 길이만 남긴다.
    await this.audit(c.actor, 'report.draft', uid, {
      len: [content.findings.length, content.conclusion.length, content.recommendation.length],
    });
    return saved;
  }

  /**
   * 초안 버리기. 확정본으로 돌아가고 싶을 때 — "쓰다 만 것"과 "저장된 것"이
   * 다를 때 사용자가 고를 수 있어야 한다.
   * 내 초안만 지운다. 남의 초안은 애초에 보이지도 않는다.
   */
  async discardDraft(uid: string, c: Caller) {
    need(c.roles, 'radiologist', '판독문 저장');
    await this.gate(uid, c);
    const r = await this.prisma.reportDraft.deleteMany({ where: { uid, author: c.actor } });
    if (r.count) await this.audit(c.actor, 'report.draft.discard', uid, {});
    const s = await this.prisma.studyState.findUnique({ where: { uid } });
    const rep = await this.prisma.report.findUnique({ where: { uid } });
    return toClient(s, rep, c.actor, null);
  }

  /**
   * 관리자용 초안 강제 해제.
   *
   * 평소의 discardDraft는 **내 초안만** 지운다. 그 경계를 느슨하게 만들어 관리자가
   * 남의 초안을 일반 경로로 지우게 하면, 실수인지 강제 조치인지 이력에서 구분할 수 없다.
   * 그래서 별도 admin 경로에서만 모든 초안을 지우고, 지우기 직전 내용을 판으로 남긴다.
   *
   * 현재 UID의 초안 행만 FOR UPDATE로 고정한다. 조회한 초안과 실제로 지운 초안이
   * 달라지는 틈은 막되, 다른 검사의 자동 저장과 확정까지 멈추는 테이블 락은 잡지 않는다.
   * 그 사이 다른 판독 확정이 같은 판 번호를 먼저 쓰면 이 트랜잭션은 P2002로 롤백되며,
   * 최신 판 번호와 남은 초안을 다시 읽어 한 번 재시도한다.
   */
  async forceDiscardDrafts(uid: string, c: Caller) {
    need(c.roles, 'admin', '판독문 초안 강제 해제');
    const me = inst(c);
    await this.gate(uid, c);

    const run = () => this.prisma.$transaction(async tx => {
      await tx.$queryRaw`
        SELECT uid FROM "StudyState" WHERE uid = ${uid} FOR UPDATE`;
      const drafts = await tx.$queryRaw<any[]>`
        SELECT uid, author, findings, conclusion, recommendation, "baseVersion", "updatedAt"
        FROM "ReportDraft"
        WHERE uid = ${uid}
        ORDER BY author
        FOR UPDATE
      `;
      if (!drafts.length) {
        // 강제 해제 호출 자체도 관리자 조치다. 지울 것이 없었어도 흔적은 남긴다.
        await tx.auditLog.create({
          data: {
            actor: c.actor, action: 'report.draft.force-discard', target: uid,
            detail: dump({ by: me, drafts: [], versions: [] }),
          },
        });
        return { ok: true, count: 0, drafts: [], versions: [] };
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
          reason: `관리자 강제 초안 해제 (해제자: ${c.actor})`,
          author: d.author,   // 지운 관리자가 아니라 실제로 **쓴 사람**이 저자다
        })),
      });
      // 조회 뒤 새로 생긴 초안은 지우지 않는다. 판으로 보존한 바로 그 행들만 없앤다.
      await tx.reportDraft.deleteMany({
        where: { OR: drafts.map(d => ({ uid: d.uid, author: d.author })) },
      });
      // 판독문 전문은 감사로그에 넣지 않는다. 누구의 몇 글자를 지웠는지만 남긴다.
      await tx.auditLog.create({
        data: {
          actor: c.actor, action: 'report.draft.force-discard', target: uid,
          detail: dump({ by: me, drafts: summary, versions }),
        },
      });

      return { ok: true, count: drafts.length, drafts: summary, versions };
    });

    try {
      return await run();
    } catch (e: any) {
      // 다른 판독 확정이 같은 (uid, version)을 먼저 썼다면, 새 번호로 전체 작업을 한 번만 다시 한다.
      if (e?.code !== 'P2002') throw e;
      return run();
    }
  }

  /**
   * 판독문 확정. 내용 저장 + 버전 적립 + RS 전이를 **한 번에, 트랜잭션으로** 한다.
   *
   * 왜 한 엔드포인트인가: 예전엔 프론트가 판독문 PUT과 상태 PATCH를 따로 쐈다.
   * 두 요청의 도착 순서가 뒤집히면 "승인됐는데 내용은 이전 것"인 상태가 남는다.
   * 판독문과 그 판독문의 상태는 같이 움직여야 하는 하나의 사실이다.
   */
  async commitReport(uid: string, body: any, c: Caller) {
    need(c.roles, 'radiologist', '판독문 확정');
    const me = inst(c);
    const action = body.action;
    if (!['save', 'approve', 'addendum', 'reset', 'preliminary'].includes(action))
      throw new BadRequestException(`알 수 없는 action: ${action}`);

    const prev = await this.gate(uid, c);
    if (prev?.ss === 'Unverified' && prev.em !== 'E')
      throw new ConflictException('촬영 중(미확인) 검사입니다 — 기사 확인(Verify) 뒤 판독할 수 있습니다');
    const heldByOther = holdAlive(prev) && prev.holder !== c.actor ? prev.holder : null;
    if (heldByOther)
      throw new ConflictException({ code: 'REPORT_HELD', holder: heldByOther, message: `${heldByOther} 님이 판독 중입니다` });
    if (!prev) throw new NotFoundException('검사를 찾을 수 없습니다');

    // 예비 판독 중인 검사는 지정된 두 사람 말고는 쓰지도 못한다.
    // 읽기만 막고 쓰기를 열어두면, 내용을 못 본 채로 덮어쓸 수 있다 — 더 나쁘다.
    if (!canReadPrelim(prev, c.actor))
      throw new ForbiddenException(
        `예비 판독(RS: P) 중입니다. ${prev?.preReviewer ?? '지정된 판독의'}만 이어서 판독할 수 있습니다.`);

    // Addendum은 승인된 판독에만 붙는다. 승인 전이라면 그냥 고쳐 쓰면 되기 때문.
    if (action === 'addendum' && prev?.rs !== 'A')
      throw new BadRequestException('Addendum은 승인(RS: A)된 판독문에만 붙일 수 있습니다');

    // 판독을 되돌리는 것은 기록을 지우는 일이다. 사유 없이는 안 된다. (교훈 §1)
    if (action === 'reset' && !String(body.reason ?? '').trim())
      throw new BadRequestException('판독 취소에는 사유가 필요합니다');

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
      reviewer = String(body.reviewer ?? '').trim();
      if (!reviewer) throw new BadRequestException('상급 판독의를 지정해야 합니다');
      if (reviewer === c.actor) throw new BadRequestException('자기 자신을 상급 판독의로 지정할 수 없습니다');
      const peers = await this.keycloak.usersInGroupWithRole(me, 'radiologist');
      if (!peers.some(u => u.id === reviewer))
        throw new BadRequestException(`${reviewer} 은(는) 이 기관의 판독의가 아닙니다`);
    }

    // 승인으로 P를 끝내는 것은 **지정된 상급 판독의**의 일이다.
    // 예비 판독을 쓴 사람이 스스로 승인하면 감독이라는 절차 자체가 없어진다.
    if (action === 'approve' && prev?.rs === 'P' && prev.preReviewer !== c.actor)
      throw new ForbiddenException(
        `예비 판독의 최종 승인은 지정된 상급 판독의(${prev.preReviewer})만 할 수 있습니다`);

    let rs = { save: 'T', approve: 'A', addendum: 'A', reset: 'W', preliminary: 'P' }[action];

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
    if (action === 'preliminary') {
      stateData.preDoc = c.actor;
      stateData.preReviewer = reviewer;
    }
    // 판독이 되돌아가면 지정도 풀린다. RS는 W인데 "누구에게 맡겨져 있음"이 남아
    // 판독문이 계속 가려지는 상태가 제일 나쁘다.
    if (action === 'reset') {
      // 판독이 되돌아가면 그 판독에 딸린 이름도 함께 지운다. RS는 W인데 RepDoc에
      // 판독의 이름과 확정일이 남아 있으면, 화면은 "누가 읽었다"고 말하면서
      // 동시에 "아직 안 읽었다"고 말하는 셈이다.
      stateData.preDoc = null; stateData.preReviewer = null;
      stateData.repDoc = null; stateData.confirm = null;
    }
    if (action === 'approve' || action === 'addendum') {
      stateData.repDoc = c.actor.split('@')[0];
      stateData.confirm = new Date().toISOString().slice(0, 10);
      // 원격판독으로 받은 검사를 승인하면 의뢰 기관에 "끝났다"가 보여야 한다.
      // 상태가 상대편에 도달하지 않으면 워크플로가 아니라 파일 전송일 뿐이다 (교훈 §10).
      if (prev?.teleInstitutionId === me && prev?.institutionId !== me) stateData.ts = 'completed';
    }

    let results: [any, number];
    try {
      results = await this.prisma.$transaction(async tx => {
        // 첫 확정에는 아직 Report 행이 없어 FOR UPDATE만으로 잠글 수 없다. B 적용 후
        // 항상 존재하는 StudyState를 먼저 잠가 첫 판부터 같은 uid의 확정을 직렬화한다.
        await tx.$queryRaw`
          SELECT uid FROM "StudyState" WHERE uid = ${uid} FOR UPDATE`;

        // 안정된 부모 행을 잡은 뒤 현재 Report를 잠근 채 판 번호를 읽는다.
        const [cur] = await tx.$queryRaw<any[]>`
          SELECT version, "updatedBy", findings, conclusion, recommendation
          FROM "Report" WHERE uid = ${uid} FOR UPDATE`;

        if (body.baseVersion === undefined)
          throw new BadRequestException('baseVersion이 필요합니다 (화면이 마지막으로 본 판 번호)');
        if ((cur?.version ?? 0) !== body.baseVersion)
          throw new ConflictException(
            `그 사이 ${cur?.updatedBy ?? '다른 사용자'}가 v${cur?.version}을 저장했습니다. ` +
            `내용을 다시 불러온 뒤 작성해 주세요.`);

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
            reason: `판독 취소로 폐기 (취소자: ${c.actor})`,
            author: cur.updatedBy ?? c.actor,
          }});
          version += 1;
        }

        const state = await tx.studyState.update({ where: { uid }, data: stateData });
        await tx.report.upsert({ where: { uid },
          create: { uid, ...content, version, updatedBy: c.actor },
          update: { ...content, version, updatedBy: c.actor } });
        await tx.reportVersion.create({ data: {
          uid, version, action, ...content, reason: body.reason ?? null, author: c.actor } });
        // 확정에 실패하면 초안도 남아야 하므로 같은 트랜잭션에서 지운다.
        await tx.reportDraft.deleteMany({ where: { uid, author: c.actor } });
        return [state, version] as [any, number];
      });
    } catch (e: any) {
      // @@unique(uid, version)은 최종 방어선이다. 불변조건이 깨져 충돌하더라도
      // 서버 고장으로 노출하지 않도록 C-1의 409 변환은 그대로 유지한다.
      if (e?.code === 'P2002')
        throw new ConflictException(
          '다른 사용자가 방금 이 판독문을 확정했습니다. 내용을 다시 불러온 뒤 확정해 주세요.');
      throw e;
    }
    const [state, version] = results;

    await this.audit(c.actor, `report.${action}`, uid, {
      version, by: me,
      len: [content.findings.length, content.conclusion.length, content.recommendation.length],
      reason: body.reason ?? undefined,
      reviewer,   // 누구에게 맡겼는가. 책임이 옮겨간 기록이므로 감사로그에 남아야 한다.
    });

    const r = await this.prisma.report.findUnique({ where: { uid } });
    return toClient(state, r, c.actor, await this.myDraft(uid, c.actor));
  }

  /**
   * 판독문 점유 선언 / 하트비트.
   *
   * 점유는 **열람이 아니라 쓰기**로 시작한다(프론트가 두 글자 이상 입력했을 때 부른다).
   * 검사를 열어보는 건 흔한 일이라 그걸 점유로 치면 경고가 남발되고, 남발된 경고는 무시된다.
   * (HPACS도 2021년에 이 기준으로 바꿨다 — 교훈 §2)
   *
   * 이미 다른 사람이 살아 있는 점유를 갖고 있으면 **막지 않고 알려준다.**
   * 응급 판독을 자물쇠로 막는 건 위험하다. 실제 충돌은 저장 시점의 버전 비교가 잡는다.
   *
   * 원격판독으로 넘어간 검사는 두 기관의 판독의가 동시에 열 수 있다 —
   * 점유가 기관을 넘어 보여야 하는 이유가 여기 있다.
   */
  async hold(uid: string, c: Caller) {
    need(c.roles, 'radiologist', '판독문 점유');
    const prev = await this.gate(uid, c);
    if (prev?.ss === 'Unverified' && prev.em !== 'E')
      throw new ConflictException('촬영 중(미확인) 검사입니다 — 기사 확인(Verify) 뒤 판독할 수 있습니다');
    if (!prev) throw new NotFoundException('검사를 찾을 수 없습니다');
    if (!canReadPrelim(prev, c.actor))
      throw new ForbiddenException('예비 판독(RS: P) 중인 검사입니다');
    const other = holdAlive(prev) && prev.holder !== c.actor ? prev.holder : null;

    // 남이 잡고 있으면 뺏지 않는다. 뺏으면 그쪽 화면의 자물쇠가 조용히 풀린다.
    if (!other) {
      await this.prisma.studyState.update({
        where: { uid }, data: { holder: c.actor, heldAt: new Date() },
      });
      if (!holdAlive(prev)) await this.audit(c.actor, 'report.hold', uid);
    }
    return { holder: other ?? c.actor, mine: !other, conflict: !!other };
  }

  /** 점유 해제 (검사를 옮기거나 판독을 확정할 때) */
  async release(uid: string, c: Caller) {
    need(c.roles, 'radiologist', '판독문 점유 해제');   // hold와 같은 역할 경계
    const prev = await this.gate(uid, c);
    if (!prev || prev.holder !== c.actor) return { ok: true };   // 내 것이 아니면 건드리지 않는다
    await this.prisma.studyState.update({ where: { uid }, data: { holder: null, heldAt: null } });
    return { ok: true };
  }

  async forceRelease(uid: string, c: Caller) {
    need(c.roles, 'admin', '판독 점유 강제 해제');
    const prev = await this.gate(uid, c);
    if (!prev) throw new NotFoundException('검사를 찾을 수 없습니다');
    await this.prisma.studyState.update({ where: { uid }, data: { holder: null, heldAt: null } });
    // 점유가 없었어도 관리자 조치의 호출 흔적은 남긴다.
    await this.audit(c.actor, 'hold.force-release', uid, {
      by: inst(c), holder: prev.holder ?? null, heldAt: prev.heldAt ?? null, alive: holdAlive(prev),
    });
    return { ok: true, released: prev.holder ?? null };
  }

  /** 판독문 이력 (최신순) */
  async versions(uid: string, c: Caller) {
    const prev = await this.gate(uid, c);
    // 본문을 가려놓고 이력에서 읽히면 가린 게 아니다. 같은 규칙을 여기에도 건다.
    if (!canReadPrelim(prev, c.actor))
      throw new ForbiddenException(
        `예비 판독(RS: P) 중입니다. ${prev?.preReviewer ?? '지정된 판독의'}만 볼 수 있습니다.`);
    return this.prisma.reportVersion.findMany({ where: { uid }, orderBy: { version: 'desc' } });
  }

  /**
   * 내 기관의 판독의 목록 — Preliminary에서 상급 판독의를 고를 때 쓴다.
   * 사용자 목록은 Keycloak에 있고, 우리 DB에 복사본을 만들면 두 곳이 어긋난다.
   */
  async colleagues(c: Caller) {
    need(c.roles, 'radiologist', '판독의 목록 조회');   // Preliminary 지정 화면 전용
    const me = inst(c);
    const users = await this.keycloak.usersInGroupWithRole(me, 'radiologist');
    return users.filter(u => u.id !== c.actor);   // 자기 자신은 지정 대상이 아니다
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

    const prev = await this.gate(uid, c);
    if (prev && prev.institutionId !== me)
      throw new ForbiddenException('원격판독으로 받은 검사는 매칭할 수 없습니다 (보유 기관의 일입니다)');
    // Match도 환자 정보를 덮어쓰는 동작이므로 같은 규칙을 받는다
    if (prev && prev.rs !== 'W')
      throw new BadRequestException(`판독 전(RS: W)인 검사만 매칭할 수 있습니다 (현재 RS: ${prev.rs})`);

    const ov = {
      id: order.patientId, name: order.name, sex: order.sex, birth: order.birth,
      age: patient?.age ?? '', desc: order.descr, ward: order.ward,
    };
    const orig = parse(prev?.orig) ?? patient?.orig ?? null;

    let state;
    try {
      state = await this.prisma.$transaction(async tx => {
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
            data: { uid, institutionId: me, reqHosp: this.instName(me), ...data },
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
    await this.audit(c.actor, 'match', uid, { oid, ov, by: me });
    const r = await this.prisma.report.findUnique({ where: { uid } });
    return toClient(state, r, c.actor, await this.myDraft(uid, c.actor));
  }

  /** Unmatch (8.1.2.1.2): 검사·오더 양쪽을 동시에 해제 */
  async unmatch(uid: string, c: Caller) {
    need(c.roles, 'technician', '매칭 해제');
    const me = inst(c);
    const prev = await this.gate(uid, c);
    if (!prev || prev.matched !== 'M') throw new BadRequestException('매칭된 검사가 아닙니다');
    // Match와 같은 규칙을 해제에도 건다. 승인 뒤 환자·오더 연결을 바꾸면 진술의 근거가 사라진다.
    if (prev.rs !== 'W')
      throw new BadRequestException(`판독 전(RS: W)인 검사만 매칭을 풀 수 있습니다 (현재 RS: ${prev.rs})`);
    if (prev.institutionId !== me)
      throw new ForbiddenException('원격판독으로 받은 검사는 매칭을 풀 수 없습니다 (보유 기관의 일입니다)');

    const ops: any[] = [
      this.prisma.studyState.update({
        where: { uid }, data: { matched: 'U', orderOid: null, ov: null },
      }),
    ];
    if (prev.orderOid)
      ops.push(this.prisma.order.update({
        where: { oid: prev.orderOid }, data: { matched: 'U', studyUid: null },
      }));

    const [state] = await this.prisma.$transaction(ops);
    await this.audit(c.actor, 'unmatch', uid, { oid: prev.orderOid, by: me });
    const r = await this.prisma.report.findUnique({ where: { uid } });
    return toClient(state, r, c.actor, await this.myDraft(uid, c.actor));
  }

  /** 검사 상태 행 삭제 (장비 수신 시뮬로 만든 가짜 검사 정리용) */
  async removeState(uid: string, c: Caller) {
    need(c.roles, 'technician', '검사 삭제');
    const me = inst(c);
    const prev = await this.gate(uid, c);
    if (prev && prev.institutionId !== me)
      throw new ForbiddenException('원격판독으로 받은 검사는 삭제할 수 없습니다');

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
      this.prisma.reportVersion.findFirst({
        where: { uid, action: { not: 'discarded' } }, select: { id: true },
      }),
      this.prisma.reportDraft.findFirst({ where: { uid }, select: { author: true } }),
    ]);
    if (version)
      throw new BadRequestException(
        '판독 이력이 있는 검사는 삭제할 수 없습니다. 판독 취소(Reset)로 되돌리세요.');
    if (draft)
      throw new BadRequestException(
        `작성 중인 판독문 초안이 있는 검사는 삭제할 수 없습니다. ` +
        `작성자(${draft.author})에게 확정 또는 폐기를 요청하거나 관리자에게 강제 해제를 요청하세요.`);

    if (prev?.orderOid)
      await this.prisma.order.update({ where: { oid: prev.orderOid }, data: { matched: 'U', studyUid: null } });
    await this.prisma.studyState.deleteMany({ where: { uid } });
    await this.audit(c.actor, 'state.delete', uid, { by: me });
    return { ok: true };
  }

  /** 감사로그. 내 기관이 볼 수 있는 검사의 것만. */
  async audits(uid: string | undefined, take: number, c: Caller) {
    const me = inst(c);
    if (uid) {
      await this.gate(uid, c);
      return this.prisma.auditLog.findMany({ where: { target: uid }, orderBy: { at: 'desc' }, take: Math.min(take, 500) });
    }
    const mine = await this.prisma.studyState.findMany({
      where: { OR: [{ institutionId: me }, { teleInstitutionId: me }] },
      select: { uid: true },
    });
    return this.prisma.auditLog.findMany({
      where: { target: { in: mine.map(s => s.uid) } },
      orderBy: { at: 'desc' },
      take: Math.min(take, 500),
    });
  }
}

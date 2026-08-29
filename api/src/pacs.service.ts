import { Injectable, BadRequestException, ConflictException, ForbiddenException, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { OrthancService } from './orthanc.service';
import { KeycloakService } from './keycloak.service';
import { SEED_INSTITUTIONS, SEED_ORDERS, SEED_TEMPLATES } from './seed';

/**
 * 호출자. 셋 다 **서명된 토큰**에서 나온다 — 클라이언트가 정할 수 없다.
 *  actor       누구인가        (감사로그)
 *  roles       무엇을 할 수 있나 (판독의/기사)
 *  institution 어디 소속인가    (어떤 데이터를 볼 수 있나)  ← 이번 작업에서 추가
 */
export interface Caller {
  actor: string;
  roles: string[];
  institution: string | null;
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

const RADIOLOGIST_FIELDS = ['rs', 'repDoc', 'confirm'];
const TECHNICIAN_FIELDS = ['ss', 'matched', 'ward', 'reqHosp', 'em', 'ov', 'orig'];

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

/** 프론트가 그대로 쓸 수 있는 모양으로 되돌린다 (main.html의 appState 한 칸과 같은 구조) */
function toClient(s: any, r: any, actor = '') {
  const hidden = !canReadPrelim(s, actor);
  return {
    rs: s.rs, ss: s.ss, em: s.em, ts: s.ts,
    matched: s.matched, ward: s.ward, reqHosp: s.reqHosp,
    institutionId: s.institutionId ?? null,
    teleInstitutionId: s.teleInstitutionId ?? null,
    preDoc: s.preDoc ?? undefined, preReviewer: s.preReviewer ?? undefined,
    // 화면이 "왜 비어 있는지" 말할 수 있어야 한다. 빈 판독문과 가려진 판독문은 다르다.
    prelimHidden: hidden || undefined,
    repDoc: s.repDoc ?? undefined, confirm: s.confirm ?? undefined,
    ov: parse(s.ov) ?? undefined, orig: parse(s.orig) ?? undefined,
    oid: s.orderOid ?? undefined,
    // 만료된 점유는 없는 것으로 내보낸다. 화면이 유령 자물쇠를 그리지 않게.
    // undefined가 아니라 null인 이유: JSON.stringify는 undefined 키를 통째로 지운다.
    // 키가 사라지면 클라이언트의 `{...기존, ...응답}` 이 이전 점유자를 그대로 남긴다.
    // "값을 비웠다"는 사실도 전송되어야 한다.
    holder: holdAlive(s) ? s.holder : null,
    version: r?.version ?? 0,
    findings: hidden ? '' : (r?.findings ?? ''),
    conclusion: hidden ? '' : (r?.conclusion ?? ''),
    recommendation: hidden ? '' : (r?.recommendation ?? ''),
  };
}

/** 클라이언트가 마음대로 컬럼을 못 만들게 화이트리스트로 거른다. */
const STATE_FIELDS = ['rs', 'ss', 'em', 'ts', 'matched', 'ward', 'reqHosp', 'repDoc', 'confirm'];

/** 원격판독 상태머신. 어느 쪽 기관이 이 전이를 일으킬 수 있는가가 핵심이다. */
const TELE_BY_OWNER = ['none', 'wait', 'sending', 'sent', 'cancelled', 'fail'];  // 의뢰 기관이 미는 구간
const TELE_BY_RECEIVER = ['inReading', 'completed'];                             // 수신 기관이 미는 구간
/** 통로가 닫히는 상태 — 여기로 가면 수신 기관은 검사를 더 못 본다 */
const TELE_CLOSED = ['none', 'cancelled'];

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

  /** 쓰기 전 관문. 없는 검사와 남의 검사는 같은 메시지로 막는다(존재 여부도 정보다). */
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
              // Radiology 탭은 Verified만 보여주므로, 이게 판독 진입 관문이 된다.
              // 도착하자마자 판독 목록에 뜨면 기사가 환자·검사정보를 고칠 틈이 없고,
              // 그 상태로 판독이 붙으면 더는 고칠 수 없다(RS≠W 규칙).
              ss: 'Unverified',
            },
          });
      if (!n.patch) await this.audit('system', 'study.arrived', n.uid, { institutionId: n.institutionId });
      byUid.set(n.uid, row as any);
    }

    const reports = await this.prisma.report.findMany();
    const repByUid = new Map(reports.map(r => [r.uid, r]));

    const out: any[] = [];
    for (const st of qido) {
      const uid = OrthancService.tag(st, '0020000D');
      const s = byUid.get(uid);
      if (!s || !this.visible(s, me)) continue;   // ← 기관 경계. 여기가 전부다.

      const birth = OrthancService.tag(st, '00100030');
      const date = OrthancService.tag(st, '00080020');
      out.push({
        uid,
        count: +OrthancService.tag(st, '00201208') || 0,
        series: +OrthancService.tag(st, '00201206') || 0,
        acc: OrthancService.tag(st, '00080050'),
        id: OrthancService.tag(st, '00100020'),
        name: OrthancService.tag(st, '00100010').replace(/\^/g, ' '),
        birth, date,
        sex: OrthancService.tag(st, '00100040'),
        modality: st['00080061']?.Value?.join(',') ?? '',
        desc: OrthancService.tag(st, '00081030'),
        institutionName: this.instName(s.institutionId),
        // 이 검사가 우리에게 원격판독으로 넘어온 것인가 (화면에서 구분해 보여준다)
        tele: s.teleInstitutionId === me && s.institutionId !== me,
        state: toClient(s, repByUid.get(uid), c.actor),
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
    const prefs = await this.prefs(c);   // 필터·상용구도 첫 요청에 함께 (왕복을 늘리지 않는다)
    return {
      me: { actor: c.actor, roles: c.roles, institution: me, institutionName: this.instName(me) },
      filters: prefs.filters,
      templates: prefs.templates,
      institutions: this.institutions.map(i => ({ id: i.id, name: i.name, type: i.type })),
      states: Object.fromEntries(states.map(s => [s.uid, toClient(s, byUid[s.uid], c.actor)])),
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
    const n = await this.prisma.readingTemplate.count({ where: { owner } });
    if (n === 0)
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
      const r = await this.prisma.readingTemplate.updateMany({ where: { id: +body.id, owner }, data });
      if (!r.count) throw new NotFoundException('상용구를 찾을 수 없습니다');
      return this.prisma.readingTemplate.findUnique({ where: { id: +body.id } });
    }
    return this.prisma.readingTemplate.create({ data: { owner, ...data } });
  }

  async deleteTemplate(id: number, c: Caller) {
    const r = await this.prisma.readingTemplate.deleteMany({ where: { id, owner: c.actor } });
    if (!r.count) throw new NotFoundException('상용구를 찾을 수 없습니다');
    return { ok: true };
  }

  /** 검사 상태 부분 수정 (RS 토글, Verify, Switch EM/ReqHosp, TS 전이 …) */
  async patchState(uid: string, body: any, c: Caller) {
    const me = inst(c);
    // 무엇을 바꾸려 하는가에 따라 필요한 권한이 다르다
    if (RADIOLOGIST_FIELDS.some(k => body[k] !== undefined)) need(c.roles, 'radiologist', '판독 상태 변경');
    if (TECHNICIAN_FIELDS.some(k => body[k] !== undefined)) need(c.roles, 'technician', '검사 정보 변경');

    const prev = await this.gate(uid, c);

    const data: any = {};
    for (const k of STATE_FIELDS) if (body[k] !== undefined) data[k] = body[k];
    if (body.ov !== undefined) data.ov = dump(body.ov);
    if (body.orig !== undefined) data.orig = dump(body.orig);

    // ── 원격판독: 유일하게 기관을 넘는 동작 ──
    if (body.ts !== undefined) {
      const owner = prev?.institutionId ?? me;
      const ts = body.ts;
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
      const rs = body.rs ?? prev?.rs ?? 'W';
      if (rs !== 'W')
        throw new BadRequestException(`판독 전(RS: W)인 검사만 환자·검사 정보를 수정할 수 있습니다 (현재 RS: ${rs})`);
    }

    // 처음 만들어지는 행(장비 수신 시뮬 등)은 만든 사람의 기관 것이 된다.
    // Orthanc에 실제로 있는 검사라면 listStudies가 이미 DICOM 태그로 기관을 박아 놓았다.
    const saved = await this.prisma.studyState.upsert({
      where: { uid },
      create: { uid, institutionId: me, reqHosp: this.instName(me), ...data },
      update: data,
    });
    await this.audit(c.actor, 'state.patch', uid, { ...data, by: me });
    const r = await this.prisma.report.findUnique({ where: { uid } });
    return toClient(saved, r, c.actor);
  }

  /**
   * 판독문 임시 저장(draft). 검사를 옮겨다닐 때마다 호출되므로 **버전을 남기지 않는다.**
   * 목적은 손실 방지 하나뿐 — HPACS가 7년차에 넣은 그 기능이다(교훈 §1).
   * 확정(save/approve/addendum/reset)은 commitReport 쪽이다.
   */
  async putReport(uid: string, body: any, c: Caller) {
    need(c.roles, 'radiologist', '판독문 저장');
    const me = inst(c);
    const prev = await this.gate(uid, c);
    if (!canReadPrelim(prev, c.actor))
      throw new ForbiddenException(
        `예비 판독(RS: P) 중입니다. ${prev?.preReviewer ?? '지정된 판독의'}만 이어서 판독할 수 있습니다.`);
    await this.prisma.studyState.upsert({
      where: { uid }, create: { uid, institutionId: me, reqHosp: this.instName(me) }, update: {},
    });
    const data = {
      findings: body.findings ?? '',
      conclusion: body.conclusion ?? '',
      recommendation: body.recommendation ?? '',
      updatedBy: c.actor,
    };
    const saved = await this.prisma.report.upsert({
      where: { uid }, create: { uid, ...data }, update: data,
    });
    // 판독문 전문을 감사로그에 통째로 넣지 않는다 — 길이와 개인정보 때문. 길이만 남긴다.
    await this.audit(c.actor, 'report.draft', uid, {
      len: [data.findings.length, data.conclusion.length, data.recommendation.length],
    });
    return saved;
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

    const rs = { save: 'T', approve: 'A', addendum: 'A', reset: 'W', preliminary: 'P' }[action];
    const content = action === 'reset'
      ? { findings: '', conclusion: '', recommendation: '' }
      : {
          findings: body.findings ?? '',
          conclusion: body.conclusion ?? '',
          recommendation: body.recommendation ?? '',
        };

    const last = await this.prisma.reportVersion.findFirst({
      where: { uid }, orderBy: { version: 'desc' }, select: { version: true },
    });
    let version = (last?.version ?? 0) + 1;

    /**
     * 낙관적 락. 프론트는 화면에 띄울 때 본 판 번호(baseVersion)를 같이 보낸다.
     * 그 사이 다른 사람이 확정했다면 번호가 달라지고, 여기서 막힌다.
     *
     * 점유 표시는 안내일 뿐이다(뺏을 수 있고, TTL로 풀리고, 동시에 시작할 수도 있다).
     * **덮어쓰기를 실제로 막는 건 이 비교 하나뿐이다.**
     */
    const current = await this.prisma.report.findUnique({ where: { uid } });
    if (body.baseVersion !== undefined && (current?.version ?? 0) !== body.baseVersion)
      throw new ConflictException(
        `그 사이 ${current?.updatedBy ?? '다른 사용자'}가 v${current?.version}을 저장했습니다. ` +
        `내용을 다시 불러온 뒤 작성해 주세요.`);

    /**
     * Reset은 저장돼 있던 판독문을 지운다. 그런데 **초안(draft)은 버전을 남기지 않으므로**
     * 그냥 지우면 그 내용은 이 시스템 어디에도 남지 않는다. 사유만 남고 무엇을 버렸는지는
     * 아무도 모른다.
     *
     * HPACS 릴리즈노트 2025.01은 이 동작에 "저장된 판독문을 삭제하기 때문에 주의가 필요하다"고
     * 경고문을 달았다. **경쟁사가 경고문을 붙인 자리는 보통 고쳐야 할 자리다.**
     * `ReportVersion`은 어차피 추가만 하는 역사이므로, 지우기 직전의 내용을 한 판 박아두면
     * 잃을 것이 없다. 판독문은 잃어버리면 안 되는 유일한 것이다 (교훈 §1).
     *
     * 화면에는 여전히 안 보인다 — 되돌린 것은 되돌린 것이다. 다만 이력에는 남는다.
     */
    const discardOps: any[] = [];
    if (action === 'reset' && current &&
        (current.findings || current.conclusion || current.recommendation)) {
      discardOps.push(this.prisma.reportVersion.create({
        data: {
          uid, version, action: 'discarded',
          findings: current.findings, conclusion: current.conclusion,
          recommendation: current.recommendation,
          reason: `판독 취소로 폐기 (취소자: ${c.actor})`,
          author: current.updatedBy ?? c.actor,   // 버린 사람이 아니라 **쓴 사람**이 저자다
        },
      }));
      version += 1;
    }

    const stateData: any = { rs, holder: null, heldAt: null };   // 확정하면 점유가 풀린다
    if (action === 'preliminary') {
      stateData.preDoc = c.actor;
      stateData.preReviewer = reviewer;
    }
    // 판독이 되돌아가면 지정도 풀린다. RS는 W인데 "누구에게 맡겨져 있음"이 남아
    // 판독문이 계속 가려지는 상태가 제일 나쁘다.
    if (action === 'reset') { stateData.preDoc = null; stateData.preReviewer = null; }
    if (action === 'approve' || action === 'addendum') {
      stateData.repDoc = c.actor.split('@')[0];
      stateData.confirm = new Date().toISOString().slice(0, 10);
      // 원격판독으로 받은 검사를 승인하면 의뢰 기관에 "끝났다"가 보여야 한다.
      // 상태가 상대편에 도달하지 않으면 워크플로가 아니라 파일 전송일 뿐이다 (교훈 §10).
      if (prev?.teleInstitutionId === me && prev?.institutionId !== me) stateData.ts = 'completed';
    }

    // 폐기 스냅샷이 먼저 들어간다. 같은 트랜잭션이라 실패하면 지우기도 함께 취소된다 —
    // "지워졌는데 기록은 없다"가 생길 틈이 없다.
    const ops = [
      ...discardOps,
      this.prisma.studyState.upsert({
        where: { uid },
        create: { uid, institutionId: prev?.institutionId ?? me, reqHosp: this.instName(prev?.institutionId ?? me), ...stateData },
        update: stateData,
      }),
      this.prisma.report.upsert({
        where: { uid },
        create: { uid, ...content, version, updatedBy: c.actor },
        update: { ...content, version, updatedBy: c.actor },
      }),
      this.prisma.reportVersion.create({
        data: { uid, version, action, ...content, reason: body.reason ?? null, author: c.actor },
      }),
    ];
    const results = await this.prisma.$transaction(ops);
    const state: any = results[discardOps.length];   // 스냅샷 다음이 상태 행이다

    await this.audit(c.actor, `report.${action}`, uid, {
      version, by: me,
      len: [content.findings.length, content.conclusion.length, content.recommendation.length],
      reason: body.reason ?? undefined,
      reviewer,   // 누구에게 맡겼는가. 책임이 옮겨간 기록이므로 감사로그에 남아야 한다.
    });

    const r = await this.prisma.report.findUnique({ where: { uid } });
    return toClient(state, r, c.actor);
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
    const me = inst(c);
    const prev = await this.gate(uid, c);
    if (!canReadPrelim(prev, c.actor))
      throw new ForbiddenException('예비 판독(RS: P) 중인 검사입니다');
    const other = holdAlive(prev) && prev.holder !== c.actor ? prev.holder : null;

    // 남이 잡고 있으면 뺏지 않는다. 뺏으면 그쪽 화면의 자물쇠가 조용히 풀린다.
    if (!other) {
      await this.prisma.studyState.upsert({
        where: { uid },
        create: { uid, institutionId: me, reqHosp: this.instName(me), holder: c.actor, heldAt: new Date() },
        update: { holder: c.actor, heldAt: new Date() },
      });
      if (!holdAlive(prev)) await this.audit(c.actor, 'report.hold', uid);
    }
    return { holder: other ?? c.actor, mine: !other, conflict: !!other };
  }

  /** 점유 해제 (검사를 옮기거나 판독을 확정할 때) */
  async release(uid: string, c: Caller) {
    const prev = await this.gate(uid, c);
    if (!prev || prev.holder !== c.actor) return { ok: true };   // 내 것이 아니면 건드리지 않는다
    await this.prisma.studyState.update({ where: { uid }, data: { holder: null, heldAt: null } });
    return { ok: true };
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
    if (order.matched === 'M') throw new BadRequestException('이미 매칭된 오더입니다');

    const prev = await this.gate(uid, c);
    if (prev && prev.institutionId !== me)
      throw new ForbiddenException('원격판독으로 받은 검사는 매칭할 수 없습니다 (보유 기관의 일입니다)');
    if (prev?.matched === 'M') throw new BadRequestException('이미 매칭된 검사입니다');
    // Match도 환자 정보를 덮어쓰는 동작이므로 같은 규칙을 받는다
    if (prev && prev.rs !== 'W')
      throw new BadRequestException(`판독 전(RS: W)인 검사만 매칭할 수 있습니다 (현재 RS: ${prev.rs})`);

    const ov = {
      id: order.patientId, name: order.name, sex: order.sex, birth: order.birth,
      age: patient?.age ?? '', desc: order.descr, ward: order.ward,
    };
    const orig = parse(prev?.orig) ?? patient?.orig ?? null;

    const [state] = await this.prisma.$transaction([
      this.prisma.studyState.upsert({
        where: { uid },
        create: { uid, institutionId: me, reqHosp: this.instName(me), matched: 'M', orderOid: oid, ov: dump(ov), orig: dump(orig), ward: order.ward },
        update: { matched: 'M', orderOid: oid, ov: dump(ov), orig: dump(orig), ward: order.ward },
      }),
      this.prisma.order.update({ where: { oid }, data: { matched: 'M', studyUid: uid } }),
    ]);
    await this.audit(c.actor, 'match', uid, { oid, ov, by: me });
    const r = await this.prisma.report.findUnique({ where: { uid } });
    return toClient(state, r, c.actor);
  }

  /** Unmatch (8.1.2.1.2): 검사·오더 양쪽을 동시에 해제 */
  async unmatch(uid: string, c: Caller) {
    need(c.roles, 'technician', '매칭 해제');
    const me = inst(c);
    const prev = await this.gate(uid, c);
    if (!prev || prev.matched !== 'M') throw new BadRequestException('매칭된 검사가 아닙니다');
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
    return toClient(state, r, c.actor);
  }

  /** 검사 상태 행 삭제 (장비 수신 시뮬로 만든 가짜 검사 정리용) */
  async removeState(uid: string, c: Caller) {
    need(c.roles, 'technician', '검사 삭제');
    const me = inst(c);
    const prev = await this.gate(uid, c);
    if (prev && prev.institutionId !== me)
      throw new ForbiddenException('원격판독으로 받은 검사는 삭제할 수 없습니다');
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

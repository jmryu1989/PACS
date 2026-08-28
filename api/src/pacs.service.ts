import { Injectable, BadRequestException, ForbiddenException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { SEED_ORDERS } from './seed';

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
const RADIOLOGIST_FIELDS = ['rs', 'repDoc', 'confirm'];
const TECHNICIAN_FIELDS = ['ss', 'matched', 'ward', 'reqHosp', 'em', 'ov', 'orig'];

/** JSON 문자열 컬럼 ↔ 객체 변환. 서버가 깨진 값을 받아도 죽지 않게 감싼다. */
const parse = (s?: string) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const dump = (o: any) => (o == null ? null : JSON.stringify(o));

/** 프론트가 그대로 쓸 수 있는 모양으로 되돌린다 (main.html의 appState 한 칸과 같은 구조) */
function toClient(s: any, r: any) {
  return {
    rs: s.rs, ss: s.ss, em: s.em, ts: s.ts,
    matched: s.matched, ward: s.ward, reqHosp: s.reqHosp,
    repDoc: s.repDoc ?? undefined, confirm: s.confirm ?? undefined,
    ov: parse(s.ov) ?? undefined, orig: parse(s.orig) ?? undefined,
    oid: s.orderOid ?? undefined,
    findings: r?.findings ?? '', conclusion: r?.conclusion ?? '', recommendation: r?.recommendation ?? '',
  };
}

/** 클라이언트가 마음대로 컬럼을 못 만들게 화이트리스트로 거른다. */
const STATE_FIELDS = ['rs', 'ss', 'em', 'ts', 'matched', 'ward', 'reqHosp', 'repDoc', 'confirm'];

@Injectable()
export class PacsService implements OnModuleInit {
  constructor(private prisma: PrismaService) {}

  /** 오더 테이블이 비어 있으면 시드를 넣는다 (RIS 연동 전까지의 임시 데이터) */
  async onModuleInit() {
    const n = await this.prisma.order.count();
    if (n === 0) {
      await this.prisma.order.createMany({ data: SEED_ORDERS });
      console.log(`[KIN API] 오더 시드 ${SEED_ORDERS.length}건 생성`);
    }
  }

  private audit(actor: string, action: string, target: string, detail?: any) {
    return this.prisma.auditLog.create({
      data: { actor: actor || 'unknown', action, target, detail: dump(detail) },
    });
  }

  /** 프론트가 켜질 때 한 번에 받아가는 묶음 */
  async bootstrap() {
    const [states, reports, orders] = await Promise.all([
      this.prisma.studyState.findMany(),
      this.prisma.report.findMany(),
      this.prisma.order.findMany({ orderBy: { sched: 'asc' } }),
    ]);
    const byUid = Object.fromEntries(reports.map(r => [r.uid, r]));
    return {
      states: Object.fromEntries(states.map(s => [s.uid, toClient(s, byUid[s.uid])])),
      orders: orders.map(o => ({
        oid: o.oid, id: o.patientId, name: o.name, sex: o.sex, birth: o.birth,
        sched: o.sched, modality: o.modality, desc: o.descr, ward: o.ward,
        reqDoc: o.reqDoc, matched: o.matched, studyUid: o.studyUid,
      })),
      serverTime: new Date().toISOString(),
    };
  }

  /** 검사 상태 부분 수정 (RS 토글, Verify, Switch EM/ReqHosp, TS 전이 …) */
  async patchState(uid: string, body: any, actor: string, roles: string[] = []) {
    // 무엇을 바꾸려 하는가에 따라 필요한 권한이 다르다
    if (RADIOLOGIST_FIELDS.some(k => body[k] !== undefined)) need(roles, 'radiologist', '판독 상태 변경');
    if (TECHNICIAN_FIELDS.some(k => body[k] !== undefined)) need(roles, 'technician', '검사 정보 변경');

    const data: any = {};
    for (const k of STATE_FIELDS) if (body[k] !== undefined) data[k] = body[k];
    if (body.ov !== undefined) data.ov = dump(body.ov);
    if (body.orig !== undefined) data.orig = dump(body.orig);
    if (!Object.keys(data).length) throw new BadRequestException('바꿀 필드가 없습니다');

    // 판독문은 "그때 그 영상, 그 환자"에 대한 진술이다. 판독이 끝난 뒤 환자·검사 정보를
    // 갈아치우면 그 진술의 근거가 사라진다. 그래서 RS가 W일 때만 덮어쓰기를 허용한다.
    // (HPACS 매뉴얼 8.1.2.1.5 — 승인된 검사를 수정하면 판독문을 버리고 새 검사를 만든다)
    // 화면에서도 막고 있지만, 화면의 검사는 검사가 아니다. 서버가 막아야 막힌 것이다.
    if (body.ov !== undefined) {
      const prev = await this.prisma.studyState.findUnique({ where: { uid } });
      const rs = body.rs ?? prev?.rs ?? 'W';
      if (rs !== 'W')
        throw new BadRequestException(`판독 전(RS: W)인 검사만 환자·검사 정보를 수정할 수 있습니다 (현재 RS: ${rs})`);
    }

    const saved = await this.prisma.studyState.upsert({
      where: { uid }, create: { uid, ...data }, update: data,
    });
    await this.audit(actor, 'state.patch', uid, data);
    const r = await this.prisma.report.findUnique({ where: { uid } });
    return toClient(saved, r);
  }

  /**
   * 판독문 임시 저장(draft). 검사를 옮겨다닐 때마다 호출되므로 **버전을 남기지 않는다.**
   * 목적은 손실 방지 하나뿐 — HPACS가 7년차에 넣은 그 기능이다(교훈 §1).
   * 확정(save/approve/addendum/reset)은 commitReport 쪽이다.
   */
  async putReport(uid: string, body: any, actor: string, roles: string[] = []) {
    need(roles, 'radiologist', '판독문 저장');
    await this.prisma.studyState.upsert({ where: { uid }, create: { uid }, update: {} });
    const data = {
      findings: body.findings ?? '',
      conclusion: body.conclusion ?? '',
      recommendation: body.recommendation ?? '',
      updatedBy: actor,
    };
    const saved = await this.prisma.report.upsert({
      where: { uid }, create: { uid, ...data }, update: data,
    });
    // 판독문 전문을 감사로그에 통째로 넣지 않는다 — 길이와 개인정보 때문. 길이만 남긴다.
    await this.audit(actor, 'report.draft', uid, {
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
  async commitReport(uid: string, body: any, actor: string, roles: string[] = []) {
    need(roles, 'radiologist', '판독문 확정');
    const action = body.action;
    if (!['save', 'approve', 'addendum', 'reset'].includes(action))
      throw new BadRequestException(`알 수 없는 action: ${action}`);

    const prev = await this.prisma.studyState.findUnique({ where: { uid } });

    // Addendum은 승인된 판독에만 붙는다. 승인 전이라면 그냥 고쳐 쓰면 되기 때문.
    if (action === 'addendum' && prev?.rs !== 'A')
      throw new BadRequestException('Addendum은 승인(RS: A)된 판독문에만 붙일 수 있습니다');

    // 판독을 되돌리는 것은 기록을 지우는 일이다. 사유 없이는 안 된다. (교훈 §1)
    if (action === 'reset' && !String(body.reason ?? '').trim())
      throw new BadRequestException('판독 취소에는 사유가 필요합니다');

    const rs = { save: 'T', approve: 'A', addendum: 'A', reset: 'W' }[action];
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
    const version = (last?.version ?? 0) + 1;

    const stateData: any = { rs };
    if (action === 'approve' || action === 'addendum') {
      stateData.repDoc = actor.split('@')[0];
      stateData.confirm = new Date().toISOString().slice(0, 10);
    }

    const [state] = await this.prisma.$transaction([
      this.prisma.studyState.upsert({ where: { uid }, create: { uid, ...stateData }, update: stateData }),
      this.prisma.report.upsert({
        where: { uid },
        create: { uid, ...content, version, updatedBy: actor },
        update: { ...content, version, updatedBy: actor },
      }),
      this.prisma.reportVersion.create({
        data: { uid, version, action, ...content, reason: body.reason ?? null, author: actor },
      }),
    ]);

    await this.audit(actor, `report.${action}`, uid, {
      version,
      len: [content.findings.length, content.conclusion.length, content.recommendation.length],
      reason: body.reason ?? undefined,
    });

    const r = await this.prisma.report.findUnique({ where: { uid } });
    return toClient(state, r);
  }

  /** 판독문 이력 (최신순) */
  versions(uid: string) {
    return this.prisma.reportVersion.findMany({ where: { uid }, orderBy: { version: 'desc' } });
  }

  /**
   * Match (8.1.2.1.1): 오더 정보를 검사에 덮어쓴다.
   * 두 테이블을 같이 바꾸므로 트랜잭션. 하나만 바뀌면 M/U가 어긋난 유령 상태가 남는다.
   */
  async match(uid: string, oid: string, patient: any, actor: string, roles: string[] = []) {
    need(roles, 'technician', '오더 매칭');
    const order = await this.prisma.order.findUnique({ where: { oid } });
    if (!order) throw new BadRequestException('오더를 찾을 수 없습니다');
    if (order.matched === 'M') throw new BadRequestException('이미 매칭된 오더입니다');

    const prev = await this.prisma.studyState.findUnique({ where: { uid } });
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
        create: { uid, matched: 'M', orderOid: oid, ov: dump(ov), orig: dump(orig), ward: order.ward },
        update: { matched: 'M', orderOid: oid, ov: dump(ov), orig: dump(orig), ward: order.ward },
      }),
      this.prisma.order.update({ where: { oid }, data: { matched: 'M', studyUid: uid } }),
    ]);
    await this.audit(actor, 'match', uid, { oid, ov });
    const r = await this.prisma.report.findUnique({ where: { uid } });
    return toClient(state, r);
  }

  /** Unmatch (8.1.2.1.2): 검사·오더 양쪽을 동시에 해제 */
  async unmatch(uid: string, actor: string, roles: string[] = []) {
    need(roles, 'technician', '매칭 해제');
    const prev = await this.prisma.studyState.findUnique({ where: { uid } });
    if (!prev || prev.matched !== 'M') throw new BadRequestException('매칭된 검사가 아닙니다');

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
    await this.audit(actor, 'unmatch', uid, { oid: prev.orderOid });
    const r = await this.prisma.report.findUnique({ where: { uid } });
    return toClient(state, r);
  }

  /** 검사 상태 행 삭제 (장비 수신 시뮬로 만든 가짜 검사 정리용) */
  async removeState(uid: string, actor: string, roles: string[] = []) {
    need(roles, 'technician', '검사 삭제');
    const prev = await this.prisma.studyState.findUnique({ where: { uid } });
    if (prev?.orderOid)
      await this.prisma.order.update({ where: { oid: prev.orderOid }, data: { matched: 'U', studyUid: null } });
    await this.prisma.studyState.deleteMany({ where: { uid } });
    await this.audit(actor, 'state.delete', uid);
    return { ok: true };
  }

  audits(uid?: string, take = 100) {
    return this.prisma.auditLog.findMany({
      where: uid ? { target: uid } : undefined,
      orderBy: { at: 'desc' },
      take: Math.min(take, 500),
    });
  }
}

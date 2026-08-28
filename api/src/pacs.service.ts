import { Injectable, BadRequestException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { SEED_ORDERS } from './seed';

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
  async patchState(uid: string, body: any, actor: string) {
    const data: any = {};
    for (const k of STATE_FIELDS) if (body[k] !== undefined) data[k] = body[k];
    if (body.ov !== undefined) data.ov = dump(body.ov);
    if (body.orig !== undefined) data.orig = dump(body.orig);
    if (!Object.keys(data).length) throw new BadRequestException('바꿀 필드가 없습니다');

    const saved = await this.prisma.studyState.upsert({
      where: { uid }, create: { uid, ...data }, update: data,
    });
    await this.audit(actor, 'state.patch', uid, data);
    const r = await this.prisma.report.findUnique({ where: { uid } });
    return toClient(saved, r);
  }

  /** 판독문 저장. 검사 상태 행이 없으면 함께 만든다. */
  async putReport(uid: string, body: any, actor: string) {
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
    await this.audit(actor, 'report.save', uid, {
      len: [data.findings.length, data.conclusion.length, data.recommendation.length],
    });
    return saved;
  }

  /**
   * Match (8.1.2.1.1): 오더 정보를 검사에 덮어쓴다.
   * 두 테이블을 같이 바꾸므로 트랜잭션. 하나만 바뀌면 M/U가 어긋난 유령 상태가 남는다.
   */
  async match(uid: string, oid: string, patient: any, actor: string) {
    const order = await this.prisma.order.findUnique({ where: { oid } });
    if (!order) throw new BadRequestException('오더를 찾을 수 없습니다');
    if (order.matched === 'M') throw new BadRequestException('이미 매칭된 오더입니다');

    const prev = await this.prisma.studyState.findUnique({ where: { uid } });
    if (prev?.matched === 'M') throw new BadRequestException('이미 매칭된 검사입니다');

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
  async unmatch(uid: string, actor: string) {
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
  async removeState(uid: string, actor: string) {
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

/*
 * 워크리스트 목록·초기 묶음. 목록 조회가 처음 본 검사를 등록(기관 확정·도착 감사)하고, 관측 부재와 오더 대사를 함께 싣는다.
 * PacsService가 만들어 소유하는 평범한 객체다(Nest provider가 아니다). 생성자는 참조만 저장한다.
 */
import type { StudyAccessService } from '../study-access.service';
import type { AccessSnapshot } from '../study-access.service';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma.service';
import { OrthancService } from '../orthanc.service';
import { studyPageQuery, studyPageSlice } from '../study-page';
import { reconcileOrders } from '../order-reconciliation';
import { ORDER_IDENTITY_SELECT, orderIdentity } from '../study-identity';
import { projectGatewayReceipt } from '../gateway-receipt';
// ASR capability is optional; no engine URL or credentials leave the server.
import { asrConfiguration } from '../asr.service';
import { qidoCount, toClient } from './values';
import { inst } from './access';
import type { Caller, PacsAccess } from './access';
import type { PacsInstitutions } from './institutions';
import type { PacsPreferences } from './preferences';
import type { PacsAudit } from './audit';

export class PacsWorklist {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orthanc: OrthancService,
    private readonly studyAccess: StudyAccessService,
    private readonly access: PacsAccess,
    private readonly institutions: PacsInstitutions,
    private readonly preferences: PacsPreferences,
    private readonly audit: PacsAudit) {}

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
  async listStudies(c: Caller, query?: any) {
    const me = inst(c);
    const access=await this.studyAccess.snapshot(c);
    const owner = [me, c.sub, c.actor, String(access.revision), String(access.windowOpen)], page = studyPageQuery(query, owner);
    // S4-U2 asks the paged enumeration for the indexed AccessionNumber too; the full QIDO carries it already.
    const qido = page ? await this.orthanc.studyIdentities(this.studyAccess.needsMetadata(access), true) : await this.orthanc.studies();
    // S4-U1b: the server time at which this successful enumeration returned. A failed QIDO throws
    // before this line, so no response ever carries an observation time it did not make.
    const observedAt = new Date().toISOString();

    const states = page ? await this.prisma.studyState.findMany({
      select: { uid:true, institutionId:true, teleInstitutionId:true, origin:true, createdAt:true },
    }) : await this.prisma.studyState.findMany();
    const byUid = new Map(states.map(s => [s.uid, s as any]));

    // Both source paths carry indexed InstitutionName. Cold/unassigned rows
    // resolve from that original tag without fetching patient details for all.

    // 아직 등록 안 된 검사에 기관을 박는다 (한 번만 일어난다)
    const news: any[] = [];
    for (const st of qido) {
      const uid = OrthancService.tag(st, '0020000D');
      if (!uid) continue;
      const cur = byUid.get(uid);
      const resolved = this.institutions.resolveInstitution(OrthancService.tag(st, '00080080'));
      if (!cur) news.push({ uid, institutionId: resolved, reqHosp: this.institutions.instName(resolved) });
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
      if (!n.patch) await this.audit.audit('system', 'study.arrived', n.uid, { institutionId: n.institutionId });
      byUid.set(n.uid, row as any);
    }

    const window = studyPageSlice(qido.filter(st => {
      const state = byUid.get(OrthancService.tag(st, '0020000D'));
      return state && this.access.visible(state, me) && this.studyAccess.matches(access,OrthancService.tag(st,'0020000D'),st);
    }), st => OrthancService.tag(st, '0020000D'), page, owner);
    const pageUids = window.rows.map(st => OrthancService.tag(st, '0020000D'));
    const changedAccess = (rows: any[]) => rows.length !== pageUids.length || rows.some(state => !this.access.visible(state, me)
      || state.institutionId !== byUid.get(state.uid)?.institutionId || state.teleInstitutionId !== byUid.get(state.uid)?.teleInstitutionId
      || (byUid.get(state.uid)?.rs !== undefined && (state.rs !== byUid.get(state.uid).rs
        || state.preDoc !== byUid.get(state.uid).preDoc || state.preReviewer !== byUid.get(state.uid).preReviewer
        || state.preDocSub !== byUid.get(state.uid).preDocSub || state.preReviewerSub !== byUid.get(state.uid).preReviewerSub)));
    const accessConflict = () => new ConflictException({ code:'STUDY_LIST_CHANGED', message:'검사 접근 범위가 바뀌었습니다. 새로고침하세요.' });
    if (page) {
      // Enumerate only identity/scope first; report state and overlays belong to the selected page.
      const details = await this.prisma.studyState.findMany({ where: { uid: { in: pageUids } } });
      if (changedAccess(details)) throw accessConflict();
      for (const state of details) byUid.set(state.uid, state);
    }
    const reports = await this.prisma.report.findMany({ where: { uid: { in: pageUids } } });
    const repByUid = new Map(reports.map(r => [r.uid, r]));
    // 목록에도 내 초안을 함께 싣는다. 30초 폴링 응답이 초안 없이 오면
    // 클라이언트 병합이 쓰고 있던 초안을 지운다.
    const drafts = await this.prisma.reportDraft.findMany({ where: { author: c.actor, uid: { in: pageUids } } });
    const draftByUid = new Map(drafts.map(d => [d.uid, d]));

    // Only presence/version leaves this query, never the note body or author.
    const noteRows = !pageUids.length ? [] : await this.prisma.$queryRaw<{ studyUid: string; version: number; present: boolean }[]>`
      SELECT DISTINCT ON (n."studyUid") n."studyUid", n.version, (n.text <> '') AS present
      FROM "TechNoteRevision" n JOIN "StudyState" s ON s.uid = n."studyUid"
      WHERE (s."institutionId" = ${me} OR s."teleInstitutionId" = ${me})
        AND n."studyUid" IN (${Prisma.join(pageUids)})
      ORDER BY n."studyUid", n.version DESC`;
    const noteByUid = new Map(noteRows.map(n => [n.studyUid, { version: n.version, present: n.present }]));

    // S7-U3a (D-S7-09 a): the caller institution's own rows, whether it owns the study or receives it by tele.
    const assignments = await this.prisma.readerAssignment.findMany({where:{studyUid:{in:pageUids},institutionId:me}});
    const assignmentByUid=new Map(assignments.map(a=>[a.studyUid,a]));
    // S4-U3 axis C: only receipts this institution's own Gateway credentials wrote, and below only on its own rows.
    const receipts = await this.prisma.gatewayReceipt.findMany({ where: { studyUid: { in: pageUids }, institutionId: me } });
    const receiptByUid = new Map(receipts.map(r => [r.studyUid, r]));
    // S4-U5: the orders this page's own linked rows point to, one read pinned to the caller's institution and
    // taken before the access re-check below. study-identity.ts judges each pair; no Order value is sent.
    const linked = [...new Set(pageUids.map(uid => byUid.get(uid))
      .filter(s => s?.institutionId === me && s.matched === 'M' && s.orderOid).map(s => s.orderOid))];
    const identityOrders = linked.length ? await this.prisma.order.findMany({
      where: { oid: { in: linked }, institutionId: me }, select: ORDER_IDENTITY_SELECT }) : [];
    const identityByOid = new Map(identityOrders.map(o => [o.oid, o]));
    const sourceRows = page ? await this.orthanc.studiesByUid(pageUids) : window.rows;
    const out: any[] = [];
    for (const st of sourceRows) {
      const uid = OrthancService.tag(st, '0020000D');
      const s = byUid.get(uid);
      if (!s || !this.access.visible(s, me)) continue;   // ← 기관 경계. 여기가 전부다.

      const birth = OrthancService.tag(st, '00100030');
      const date = OrthancService.tag(st, '00080020');
      const patientId = OrthancService.tag(st, '00100020');
      out.push({
        uid,
        techNote: noteByUid.get(uid) ?? { version: 0, present: false },
        readerAssignment: (()=>{const a=assignmentByUid.get(uid);return {revision:a?.revision??0,reader:a?.readerSub?{sub:a.readerSub,actor:a.readerActor,name:a.readerName}:null};})(),
        // null = no Gateway report: normal (device-direct, older agent, not installed), never failure or offline.
        // A tele receiver sees null too; the sender's transport is not its business.
        gatewayReceipt: s.institutionId === me ? projectGatewayReceipt(receiptByUid.get(uid)) : null,
        // S4-U5: judged on this row's server-read tags only, never on ov/orig. A tele receiver's row is null.
        orderIdentity: s.institutionId === me
          ? orderIdentity(me, s, identityByOid.get(s.orderOid), key => OrthancService.tag(st, key)) : null,
        // null은 unknown이다. 0은 QIDO가 실제로 0을 말했을 때만 나간다.
        count: qidoCount(st, '00201208'),
        series: qidoCount(st, '00201206'),
        acc: OrthancService.tag(st, '00080050'),
        id: patientId,
        // 화면 오버레이가 PatientID를 바꿔도 Related의 기관 경계는 원본 DICOM 값에 남는다.
        sourcePatientKey: s.institutionId == null || !patientId ? null : `${s.institutionId}|${patientId}`,
        name: OrthancService.tag(st, '00100010').replace(/\^/g, ' '),
        birth, date,
        sex: OrthancService.tag(st, '00100040'),
        modality: st['00080061']?.Value?.join(',') ?? '',
        desc: OrthancService.tag(st, '00081030'),
        institutionName: this.institutions.instName(s.institutionId),
        // 이 검사가 우리에게 원격판독으로 넘어온 것인가 (화면에서 구분해 보여준다)
        tele: s.teleInstitutionId === me && s.institutionId !== me,
        state: toClient(s, repByUid.get(uid), c, draftByUid.get(uid)),
      });
    }
    // A concurrent Preliminary transition can change who may read the report too.
    const current = await this.prisma.studyState.findMany({ where: { uid: { in: pageUids } },
      select: { uid:true, institutionId:true, teleInstitutionId:true, rs:true, preDoc:true, preReviewer:true, preDocSub:true, preReviewerSub:true } });
    if (changedAccess(current)) throw accessConflict();
    // S4-U2: the order side is read with the page that completes the list and BEFORE the access
    // re-check below, so a policy change during this request refuses the whole answer.
    const orderRows = !page || window.pagination?.next === null ? await this.orderSide(me) : null;
    // Absence is judged against the whole enumeration, never against this page's window. It is sent
    // once, with the page that completes the list, so a client never merges two absence answers.
    const notObserved = !page || window.pagination?.next === null ? this.notObserved(qido, states, me, access, observedAt) : undefined;
    // S4-F01V: an own study with no observed image still has its last Gateway receipt. Only receipts this
    // institution's own credentials wrote are read, before the access re-check like every other tenant read here.
    const absentReceipts = notObserved?.length ? await this.prisma.gatewayReceipt.findMany({ where: { studyUid: { in: notObserved.map(row => row.uid) }, institutionId: me } }) : [];
    await this.studyAccess.unchanged(c,access);
    // The key is added only when such a receipt exists; without one the item keeps its three fields.
    const absentReceiptByUid = new Map(absentReceipts.map(r => [r.studyUid, r]));
    for (const row of notObserved ?? []) { const receipt = absentReceiptByUid.get(row.uid); if (receipt) Object.assign(row, { gatewayReceipt: projectGatewayReceipt(receipt) }); }
    const orderReconciliation = orderRows ? this.orderReconciliation(qido, orderRows, me, access) : undefined;
    return { studies: out, serverTime: new Date().toISOString(), observedAt,
      ...(notObserved === undefined ? {} : { notObserved }),
      ...(orderReconciliation === undefined ? {} : { orderReconciliation }), ...(page ? { pagination: window.pagination } : {}) };
  }

  /**
   * S4-U1b 관측되지 않은 자기 기관 검사. **성공한** QIDO 열거 전체에 행이 없는 StudyState만 낸다.
   * 필드는 uid·origin·createdAt뿐이다 — QIDO 행이 없으니 환자 필드는 존재하지 않고, 지어내지 않는다.
   * 열거의 어느 행이라도 UID를 확인할 수 없으면 부재를 판정할 수 없으므로 `null`(모름)이다.
   * 원격판독으로 받은 검사는 자기 기관 행이 아니다. 접근 조건은 UID만으로 판정한다 — 메타데이터
   * 조건이 걸린 계정에는 원본 태그가 없는 행이 맞을 수 없으므로 보이지 않는다(닫힌 쪽으로 실패).
   * 열거가 끝난 뒤 생긴 행은 이 열거로 판정할 수 없으므로 다음 관측으로 넘긴다.
   */
  private notObserved(qido: any, states: any[], me: string, access: AccessSnapshot, observedAt: string) {
    if (!Array.isArray(qido)) return null;
    const present = new Set<string>();
    for (const st of qido) {
      const uid = OrthancService.tag(st, '0020000D');
      if (!uid) return null;
      present.add(uid);
    }
    const out: { uid: string; origin: string; createdAt: string }[] = [];
    for (const s of states) {
      if (s.institutionId !== me || present.has(s.uid) || !this.studyAccess.matches(access, s.uid)) continue;
      if (!(s.createdAt instanceof Date) || typeof s.origin !== 'string') return null;
      const createdAt = s.createdAt.toISOString();
      if (createdAt > observedAt) continue;
      out.push({ uid: s.uid, origin: s.origin, createdAt });
    }
    return out.sort((a, b) => a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0);
  }

  /**
   * S4-U2 오더 측 대사의 입력. 기관 조건을 조회에 건다 — 남의 기관 오더와 StudyState는 읽지도 않는다.
   * 필요한 칸만 고른다. 환자 칸은 이 면으로 나가지 않는다.
   */
  private orderSide(me: string) {
    return Promise.all([
      this.prisma.order.findMany({ where: { institutionId: me },
        select: { oid: true, institutionId: true, accession: true, matched: true, studyUid: true } }),
      this.prisma.studyState.findMany({ where: { institutionId: me },
        select: { uid: true, institutionId: true, matched: true, orderOid: true } }),
    ]);
  }

  /**
   * S4-U2 오더 측 대사 — **엔지니어링 전용**(`order-reconciliation.ts`). notObserved와 같은 성공한 열거로
   * 판정한다. 열거의 어느 행이라도 UID를 확인할 수 없으면 관측 여부를 말할 수 없으므로 `null`(모름)이다.
   * 검사 쪽 accession은 서버가 읽은 원본 태그(00080050)뿐이다 — ov/orig는 입력이 아니다.
   */
  private orderReconciliation(qido: any, [orders, links]: [any[], any[]], me: string, access: AccessSnapshot) {
    if (!Array.isArray(qido)) return null;
    const observed = new Map<string, any>();
    for (const st of qido) {
      const uid = OrthancService.tag(st, '0020000D');
      if (!uid) return null;
      observed.set(uid, st);
    }
    return reconcileOrders({ me, restricted: access.policy.restricted, orders, links, observed,
      accessionOf: row => OrthancService.tag(row, '00080050'),
      permitted: (uid, row) => this.studyAccess.matches(access, uid, row) });
  }

  /** 프론트가 켜질 때 한 번에 받아가는 묶음 — 전부 내 기관 것만 */
  async bootstrap(c: Caller, query?: any) {
    const me = inst(c);
    const omitStates = query?.states === 'omit';
    if (query && (Object.keys(query).some(key => key !== 'states') || (Object.keys(query).length && !omitStates)))
      throw new BadRequestException('초기 목록 요청 형식이 잘못되었습니다');
    const access=await this.studyAccess.snapshot(c);
    const [stateRows, orderRows] = await Promise.all([
      omitStates ? Promise.resolve([]) : this.prisma.studyState.findMany({
        where: { OR: [{ institutionId: me }, { teleInstitutionId: me }] },
      }),
      this.prisma.order.findMany({ where: { institutionId: me }, orderBy: { sched: 'asc' } }),
    ]);
    const permitted=await this.studyAccess.allowed(c,[...stateRows.map(s=>s.uid),...orderRows.flatMap(o=>o.studyUid?[o.studyUid]:[])]);
    const states=stateRows.filter(s=>permitted.has(s.uid));
    const orders=orderRows.filter(o=>o.studyUid?permitted.has(o.studyUid):!access.policy.restricted);
    const reports = omitStates ? [] : await this.prisma.report.findMany({
      where: { uid: { in: states.map(s => s.uid) } },
    });
    const byUid = Object.fromEntries(reports.map(r => [r.uid, r]));
    // 켤 때 내 초안도 함께 — "어제 쓰다 만 것"이 PC를 바꿔도 따라온다.
    // 필터·상용구를 계정에 붙인 것과 같은 이유다 (§6-A-4).
    // 보이는 검사의 것만 읽는다: 비운 자리(present=false)도 행으로 남으므로 작성자 전체를 읽으면 끝없이 늘어난다.
    const drafts = omitStates ? [] : await this.prisma.reportDraft.findMany({
      where: { author: c.actor, uid: { in: states.map(s => s.uid) } } });
    const draftByUid = Object.fromEntries(drafts.map(d => [d.uid, d]));
    await this.studyAccess.unchanged(c,access);
    const prefs = await this.preferences.prefs(c);   // 필터·상용구도 첫 요청에 함께 (왕복을 늘리지 않는다)
    return {
      ...(omitStates ? { statesOmitted:true } : {}),
      dictation: (() => { const { url, ...capability } = asrConfiguration(); return capability; })(),
      me: { actor: c.actor, roles: c.roles, institution: me, institutionName: this.institutions.instName(me) },
      filters: prefs.filters,
      templates: prefs.templates,
      institutions: this.institutions.institutions.map(i => ({ id: i.id, name: i.name, type: i.type })),
      states: Object.fromEntries(states.map(s => [s.uid, toClient(s, byUid[s.uid], c, draftByUid[s.uid])])),
      orders: orders.map(o => ({
        oid: o.oid, id: o.patientId, name: o.name, sex: o.sex, birth: o.birth,
        sched: o.sched, modality: o.modality, desc: o.descr, ward: o.ward,
        reqDoc: o.reqDoc, matched: o.matched, studyUid: o.studyUid,
      })),
      serverTime: new Date().toISOString(),
    };
  }
}

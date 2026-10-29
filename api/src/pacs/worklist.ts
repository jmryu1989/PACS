/*
 * 워크리스트 목록·초기 묶음. 목록 조회가 처음 본 검사를 등록(기관 확정·도착 감사)하고, 관측 부재와 오더 대사를 함께 싣는다.
 * 보낸 병원을 모르는 검사의 보류·운영자 알림·장비/표기 등록 뒤 자동 연결(D1882)도 같은 등록 자리에서 한다.
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
import { groupSources, consensus, sameUidSet, identityIssueList, sameAccessTags } from '../study-source-groups';
import { dump, qidoCount, toClient } from './values';
import { need, inst } from './access';
import type { Caller, PacsAccess } from './access';
import type { PacsInstitutions } from './institutions';
import type { PacsPreferences } from './preferences';
import type { PacsAudit } from './audit';
import { worklistRead } from '../emr-viewing/consumer-read';

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
    return (await this.selectStudies(c, query)).body;
  }

  async readStudies(c: Caller, query?: any) {
    const { body, institutions, identities } = await this.selectStudies(c, query);
    return worklistRead(body, c.actor, inst(c), institutions, identities);
  }

  /**
   * 아직 등록 안 된 검사를 등록하고 보류 검사를 붙인다(UID마다 기관은 한 번만 정해진다).
   *
   * D1882: 보낸 병원은 병원과 확인한 사실로만 정한다 — 등록된 InstitutionName 표기, 그것이 없으면 등록된 수신 장비.
   * 둘 다 맞지 않는 검사는 보류(institutionId null)다: 아무도 열지 못하고 어느 목록에도 없다. 장비·표기가 등록되면
   * 다음 관측에서 이 자리가 붙인다. 장비는 기관명이 맞지 않는 검사에만 묻는다(관측마다 수신 상태를 다시 읽고, 바뀌었을 때만 장비를 다시 읽는다).
   * Re-check before a second site: a device two hospitals share (joint screening centre, mobile unit) needs name or order
   * evidence, not the device alone.
   */
  private async registerArrivals(sources: { readonly uids: string[]; readonly byUid: Map<string, any[]> }, byUid: Map<string, any>, select?: Record<string, boolean>) {
    const resolvedOf = (st: any) => this.institutions.resolveInstitution(OrthancService.tag(st, '00080080'));
    for (const uid of sources.uids) {
      const cur = byUid.get(uid);
      if (cur && cur.institutionId != null) continue;
      // Every resource must name the same known institution; one unknown, empty or different name keeps it held.
      let resolved = consensus(sources.byUid.get(uid)!.map(resolvedOf)), device: string | null = null;
      if (!resolved) {
        device = await this.sendingDevice(uid);
        resolved = this.institutions.resolveDevice(device);
      }
      if (cur && !resolved) continue;
      // Decided once: a held answer is no longer needed (a split UID's announcement reads its own again).
      if (resolved) this.devices.delete(uid);
      // The audit row says which confirmed fact decided the hospital; an arrival keeps its old detail when the name did.
      const byDevice = resolved && device ? { via: 'device', aet: device } : null;
      const reread = () => this.prisma.studyState.findUnique({ where: { uid }, ...(select ? { select } : {}) });
      if (cur) {
        // Conditional: a concurrent observation that already attached it is not overwritten, and only the one that
        // attached it writes the audit row, in the same transaction.
        await this.prisma.$transaction(async tx => {
          const { count } = await tx.studyState.updateMany({ where: { uid, institutionId: null },
            data: { institutionId: resolved, reqHosp: this.institutions.instName(resolved) } });
          if (count) await tx.auditLog.create({ data: { actor: 'system', action: 'study.attach', target: uid,
            detail: dump({ institutionId: resolved, ...(byDevice ?? { via: 'alias' }) }) } });
        }, { maxWait: 4000, timeout: 8000 });
        const row = await reread();
        if (row) byUid.set(uid, row as any);
        continue;
      }
      let row: any;
      try {
        // Registration and its arrival audit commit or roll back together.
        row = await this.prisma.$transaction(async tx => {
          const created = await tx.studyState.create({
            data: {
              uid, institutionId: resolved, reqHosp: this.institutions.instName(resolved),
              // 처음 보는 검사는 방금 장비에서 도착한 것이다 → **기사 확인 전(Unverified)**.
              // 도착 검사는 바로 보이되, 비응급 판독 쓰기는 Verify 뒤에만 허용한다.
              // 도착하자마자 판독을 허용하면 기사가 환자·검사정보를 고칠 틈이 없고,
              // 그 상태로 판독이 붙으면 더는 고칠 수 없다(RS≠W 규칙).
              ss: 'Unverified',
            },
          });
          await tx.auditLog.create({ data: { actor: 'system', action: 'study.arrived', target: uid, detail: dump({ institutionId: resolved, ...byDevice }) } });
          return created;
        }, { maxWait: 4000, timeout: 8000 });
      } catch (error: any) {
        // A concurrent first list won the unique race: its row (and its one arrival audit) is the registration.
        if (error?.code !== 'P2002') throw error;
        row = await reread();
        if (!row) throw error;
      }
      byUid.set(uid, row);
    }
  }

  /**
   * Sending device per study UID. A stored instance's calling AE never changes, but the study gains instances, possibly
   * from another device, so an answer holds only under the arrival stamp read before it (stamp first: an instance that
   * lands between the two reads makes the next stamp differ, never a stale match). A failed read is "not observed" for
   * this pass and is asked again next time: it keeps the study held and never fails the institution's whole list.
   */
  private readonly devices = new Map<string, { stamp: string; device: string | null }>();
  private async sendingDevice(uid: string) {
    let stamp: string | null, device: string | null;
    try {
      stamp = await this.orthanc.studyArrivalStamp(uid);
      if (stamp === null) { this.devices.delete(uid); return null; }
      const known = this.devices.get(uid);
      if (known?.stamp === stamp) return known.device;
      device = await this.orthanc.sendingDevice(uid);
    } catch { return null; }
    this.devices.set(uid, { stamp, device });
    return device;
  }

  /**
   * Observes the archive once and runs the registration above over every UID; patient identity is observed too.
   * The device answers kept are those of UIDs this observation still holds or announces, so the cache is the held set.
   */
  private async observeArrivals() {
    const sources = groupSources(await this.orthanc.studyIdentities(true), st => OrthancService.tag(st, '0020000D'));
    const select = { uid: true, institutionId: true, createdAt: true } as const;
    const byUid = new Map<string, any>((await this.prisma.studyState.findMany({ select })).map(s => [s.uid, s]));
    await this.registerArrivals(sources, byUid, select);
    for (const uid of this.devices.keys())
      if (!sources.byUid.has(uid) || (byUid.get(uid)?.institutionId != null && sources.byUid.get(uid)!.length === 1)) this.devices.delete(uid);
    return { sources, byUid };
  }

  // D1887: the source patient, not a display overlay, must identify an image read's patient.
  // Re-observe it on every list so correcting the original releases an already attached study too.
  private patientIdentified(resources: any[]) {
    return resources.every(st => OrthancService.tag(st, '00100020').trim() !== '');
  }

  /**
   * D1882 operator alert: held studies grouped by sending device and the raw InstitutionName text, with arrival times
   * and a count. Nothing that names a patient or a study (no UID, name, ID, date, description, image or report) leaves
   * here, so reading it is not a medical-record read and opens nothing. Unknown sources are shown to administrators;
   * an attached study without PatientID (D1887) is shown only to its owning institution's administrator.
   */
  async heldSources(c: Caller) {
    need(c.roles, 'admin', '수신 보류 알림 조회');
    const me = inst(c);
    const { sources, byUid } = await this.observeArrivals();
    const groups = new Map<string, { device: string | null; institutionText: string; institutionNames: string[]; reason: string; sourceUnregistered: boolean; count: number; firstArrival: string; lastArrival: string }>();
    for (const uid of sources.uids) {
      const state = byUid.get(uid);
      if (!state) continue;
      const resources = sources.byUid.get(uid)!;
      const unidentified = !this.patientIdentified(resources);
      const sourceUnregistered = state.institutionId == null;
      if (!sourceUnregistered && (!unidentified || state.institutionId !== me)) continue;
      const reason = unidentified ? 'patient_not_identified' : 'unknown_source';
      const device = await this.sendingDevice(uid);
      // The distinct spellings travel as a list: a hospital's own name may contain " / ", so the joined display text
      // cannot tell one spelling from several.
      const names = [...new Set(resources.map(st => OrthancService.tag(st, '00080080').trim()))].sort();
      const at = new Date(state.createdAt).toISOString(), key = JSON.stringify([device, names, reason, sourceUnregistered]);
      const group = groups.get(key);
      if (!group) groups.set(key, { device, institutionText: names.join(' / '), institutionNames: names, reason, sourceUnregistered, count: 1, firstArrival: at, lastArrival: at });
      else Object.assign(group, { count: group.count + 1, firstArrival: at < group.firstArrival ? at : group.firstArrival,
        lastArrival: at > group.lastArrival ? at : group.lastArrival });
    }
    return { observedAt: new Date().toISOString(), institution: { id: me, name: this.institutions.instName(me) },
      groups: [...groups.values()].sort((a, b) => b.lastArrival.localeCompare(a.lastArrival)) };
  }

  /** D1882: register a device or a spelling for the own institution, then attach the held studies it now decides. */
  async registerSourceDevice(body: any, c: Caller) {
    return this.attachAfter(await this.institutions.registerSource('device', body, c));
  }

  async registerInstitutionAlias(body: any, c: Caller) {
    return this.attachAfter(await this.institutions.registerSource('alias', body, c));
  }

  private async attachAfter(registered: { institutionId: string }) {
    const held = await this.prisma.studyState.findMany({ where: { institutionId: null }, select: { uid: true } });
    // The registration is committed already; if this observation fails, the next list attaches the same studies.
    const { byUid } = await this.observeArrivals();
    return { ...registered, attached: held.filter(s => byUid.get(s.uid)?.institutionId === registered.institutionId).length };
  }

  // The clinician projections reuse this selection and its observed source identity.
  async selectStudies(c: Caller, query?: any) {
    const me = inst(c);
    const access=await this.studyAccess.snapshot(c);
    const requested = query?.uids;
    if (requested !== undefined && (typeof requested !== 'string' || Object.keys(query).some(key => key !== 'uids')))
      throw new BadRequestException('검사 조회 요청 형식이 잘못되었습니다');
    const uids = requested === undefined ? null : requested.split(',');
    const owner = [me, c.sub, c.actor, String(access.revision), String(access.windowOpen)], page = studyPageQuery(uids ? undefined : query, owner);
    // S4-U2 asks the paged enumeration for the indexed AccessionNumber too; the full QIDO carries it already.
    const qido = uids ? await this.orthanc.studiesByUid(uids) : page ? await this.orthanc.studyIdentities(true, true) : await this.orthanc.studies();
    // S4-U1b: the server time at which this successful enumeration returned. A failed QIDO throws
    // before this line, so no response ever carries an observation time it did not make.
    const observedAt = new Date().toISOString();
    // WORKLIST-SPLIT-UID: every original resource of a UID, grouped. A UID that two patient resources answer is
    // registered once, never projected as a normal row, and announced (identityIssues) only inside the caller's scope.
    const sources = groupSources(qido, st => OrthancService.tag(st, '0020000D'));
    const resolvedOf = (st: any) => this.institutions.resolveInstitution(OrthancService.tag(st, '00080080'));
    // The fields that decide who may see a row and read its report. The paged enumeration reads them too, so a change
    // made before the page's details are read is still a change.
    const accessFields = ['institutionId', 'teleInstitutionId', 'rs', 'preDoc', 'preReviewer', 'preDocSub', 'preReviewerSub'];
    const enumerated = { uid:true, institutionId:true, teleInstitutionId:true, origin:true, createdAt:true,
      rs:true, preDoc:true, preReviewer:true, preDocSub:true, preReviewerSub:true };

    const states = uids ? await this.prisma.studyState.findMany({ where: { uid: { in: uids } } }) : page ? await this.prisma.studyState.findMany({ select: enumerated }) : await this.prisma.studyState.findMany();
    const byUid = new Map(states.map(s => [s.uid, s as any]));

    // Both source paths carry indexed InstitutionName. Cold/held rows
    // resolve from that original tag without fetching patient details for all.
    await this.registerArrivals(sources, byUid, page ? enumerated : undefined);

    // The policy is applied to every resource of a UID; the announcement also needs the stored owner to be what every
    // resource's own institution tag says, so an ambiguous group is never announced on another institution's behalf.
    const normal: any[] = [], issues: string[] = [];
    for (const uid of sources.uids) {
      const resources = sources.byUid.get(uid)!, state = byUid.get(uid);
      if (!this.patientIdentified(resources)) continue;
      if (!state || !this.access.visible(state, me) || !resources.every(st => this.studyAccess.matches(access, uid, st))) continue;
      if (resources.length === 1) normal.push(resources[0]);
      // D1882: a UID attached by its registered sending device is announced on the same terms (every resource came from it).
      else if (state.institutionId != null && (resources.every(st => resolvedOf(st) === state.institutionId)
        || this.institutions.resolveDevice(await this.sendingDevice(uid)) === state.institutionId)) issues.push(uid);
    }
    const window = studyPageSlice(normal, st => OrthancService.tag(st, '0020000D'), page, owner);
    const pageUids = window.rows.map(st => OrthancService.tag(st, '0020000D'));
    // The list is complete with this answer: issues travel with it, like notObserved and orderReconciliation.
    // A targeted viewer lookup is not an archive enumeration; it cannot declare absence or reconcile orders.
    const completes = !uids && (!page || window.pagination?.next === null);
    const watched = completes ? [...pageUids, ...issues] : pageUids;
    // Compared with the enumeration's own rows (byUid is never replaced by later reads): the exact UID set, then
    // every access field of every row.
    const changedAccess = (rows: any[], expected: string[]) => !sameUidSet(rows.map(state => state.uid), expected)
      || rows.some(state => !this.access.visible(state, me)
        || accessFields.some(key => (state[key] ?? null) !== (byUid.get(state.uid)?.[key] ?? null)));
    const accessConflict = () => new ConflictException({ code:'STUDY_LIST_CHANGED', message:'검사 접근 범위가 바뀌었습니다. 새로고침하세요.' });
    const shown = new Map<string, any>(pageUids.map(uid => [uid, byUid.get(uid)]));
    if (page) {
      // Enumerate only identity/scope first; report state and overlays belong to the selected page.
      const details = await this.prisma.studyState.findMany({ where: { uid: { in: pageUids } } });
      if (changedAccess(details, pageUids)) throw accessConflict();
      for (const state of details) shown.set(state.uid, state);
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
    const linked = [...new Set(pageUids.map(uid => shown.get(uid))
      .filter(s => s?.institutionId === me && s.matched === 'M' && s.orderOid).map(s => s.orderOid))];
    const identityOrders = linked.length ? await this.prisma.order.findMany({
      where: { oid: { in: linked }, institutionId: me }, select: ORDER_IDENTITY_SELECT }) : [];
    const identityByOid = new Map(identityOrders.map(o => [o.oid, o]));
    let sourceRows = window.rows;
    if (page) {
      // The page's details must still be one resource per UID with the same access answer as the enumeration. A UID
      // that became a second resource since is a real change (the next first page excludes it); a stable split was
      // never on this page.
      const detail = groupSources(await this.orthanc.studiesByUid(pageUids), st => OrthancService.tag(st, '0020000D'));
      // spec §3.2: each selected UID still has its one resource with the access tags the enumeration saw (the
      // enumeration's row is the immutable reference); a changed source tag is a changed list even when both values
      // would pass the policy and the stored rows are unchanged.
      const withMetadata = this.studyAccess.needsMetadata(access);
      if (pageUids.some(uid => detail.byUid.get(uid)?.length !== 1 || !this.studyAccess.matches(access, uid, detail.byUid.get(uid)![0])
        || !this.patientIdentified(detail.byUid.get(uid)!)
        || !sameAccessTags(sources.byUid.get(uid)?.[0], detail.byUid.get(uid)![0], withMetadata)))
        throw accessConflict();
      sourceRows = pageUids.map(uid => detail.byUid.get(uid)![0]);
    }
    const out: any[] = [];
    for (const st of sourceRows) {
      const uid = OrthancService.tag(st, '0020000D');
      const s = shown.get(uid);
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
    // A concurrent Preliminary transition can change who may read the report too. The page rows and the announced
    // UIDs are held to the enumeration's own rows.
    const current = () => this.prisma.studyState.findMany({ where: { uid: { in: watched } },
      select: { uid:true, institutionId:true, teleInstitutionId:true, rs:true, preDoc:true, preReviewer:true, preDocSub:true, preReviewerSub:true } });
    if (changedAccess(await current(), watched)) throw accessConflict();
    // S4-U2: the order side is read with the page that completes the list and BEFORE the access
    // re-check below, so a policy change during this request refuses the whole answer.
    const orderRows = completes ? await this.orderSide(me) : null;
    // Absence is judged against the whole enumeration, never against this page's window. It is sent
    // once, with the page that completes the list, so a client never merges two absence answers.
    // A UID whose resources were excluded as unresolved is observed, so it is never "not observed".
    const notObserved = completes ? this.notObserved(qido, states, me, access, observedAt) : undefined;
    // S4-F01V: an own study with no observed image still has its last Gateway receipt. Only receipts this
    // institution's own credentials wrote are read, before the access re-check like every other tenant read here.
    const absentReceipts = notObserved?.length ? await this.prisma.gatewayReceipt.findMany({ where: { studyUid: { in: notObserved.map(row => row.uid) }, institutionId: me } }) : [];
    // The completing answer awaited the order side and the receipts after that check: the same comparison runs again
    // after them, so a change during those reads is not sent.
    if (completes && changedAccess(await current(), watched)) throw accessConflict();
    await this.studyAccess.unchanged(c,access);
    // The key is added only when such a receipt exists; without one the item keeps its three fields.
    const absentReceiptByUid = new Map(absentReceipts.map(r => [r.studyUid, r]));
    for (const row of notObserved ?? []) { const receipt = absentReceiptByUid.get(row.uid); if (receipt) Object.assign(row, { gatewayReceipt: projectGatewayReceipt(receipt) }); }
    const orderReconciliation = orderRows ? this.orderReconciliation(qido, orderRows, me, access) : undefined;
    const body = { studies: out, serverTime: new Date().toISOString(), observedAt,
      ...(notObserved === undefined ? {} : { notObserved }),
      ...(orderReconciliation === undefined ? {} : { orderReconciliation }),
      ...(completes ? { identityIssues: identityIssueList(issues) } : {}), ...(page ? { pagination: window.pagination } : {}) };
    const identities = new Map(sourceRows.map(st => [OrthancService.tag(st, '0020000D'), {
      sourcePatientId: OrthancService.tag(st, '00100020') || null, sourceInstitution: OrthancService.tag(st, '00080080') || null }]));
    return { body, identities, institutions: new Map([...byUid].map(([uid, state]) => [uid, state.institutionId])) };
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
    const observed = new Map<string, any>(), unresolved = new Set<string>();
    for (const st of qido) {
      const uid = OrthancService.tag(st, '0020000D');
      if (!uid) return null;
      if (observed.has(uid) || !this.patientIdentified([st])) unresolved.add(uid);
      observed.set(uid, st);
    }
    // A split UID has no single source accession; a patientless study stays held. Neither can be a pairing
    // candidate or a linked order's reconciled study.
    for (const uid of unresolved) observed.delete(uid);
    return reconcileOrders({ me, restricted: access.policy.restricted, orders,
      links: links.filter(s => !unresolved.has(s.uid)), observed,
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
    // WORKLIST-SPLIT-UID: a UID two patient resources answer is not restored as a normal study through the states map.
    // Leaving it out removes nothing stored; the lean (states=omit) path reads no state and no source.
    const unresolved = new Set<string>();
    if (!omitStates && stateRows.length) {
      const seen = new Set<string>();
      for (const st of await this.orthanc.studyIdentities(true)) {
        const uid = OrthancService.tag(st, '0020000D');
        if (seen.has(uid) || !this.patientIdentified([st])) unresolved.add(uid);
        seen.add(uid);
      }
    }
    const states=stateRows.filter(s=>permitted.has(s.uid)&&!unresolved.has(s.uid));
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

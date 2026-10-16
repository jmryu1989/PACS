import { canReadPreliminary } from './preliminary-reader';
import { StudyAccessService } from './study-access.service';
import { Injectable, BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { OrthancService } from './orthanc.service';
// Type-only: the report service now imports this one for the citation gate, and a value import
// back to it would close a runtime cycle around the Nest decorators.
import type { Caller } from './pacs.service';
import { REPORT_CITATION_LIMITS } from './report-citation';
import { canonical, viewerJson, viewerUid, viewerUuid } from './viewer-input';
import { comparisonStudies, copyJob, copySource, findingCommand, findingFingerprint, findingPage, FindingCommand, FindingJobSource, FindingSource,
  FindingSourceRef, FINDING_LIMITS, isJobRef, jobAbsent, jobFrame, jobLocation, jobMark, jobStudies, refKey, sourceRef, sourceStudies } from './finding-input';
import { holdAlive } from './pacs/values';
import type { SurfaceKey } from './emr-clinical/contract';
import type { ClinicalBody, ClinicalWritePlan, CommitOutcome } from './emr-clinical/records';
import { ClinicalServed, ProjectionRefused, clinicalCount, clinicalEchoRefusal, clinicalHttpError, clinicalRefusal, clinicalText, outcomeCode,
  projectedCaller, readClinicalRows, readClinicalSources, readClinicalUnits, registerClinicalProjection, requireClinicalRuntime } from './emr-clinical/services';
import { SourceRef, citedSource } from './emr-clinical/sources';

const denied = () => { throw new ForbiddenException('소견에 접근할 수 없습니다'); };
const conflict = () => { throw new ConflictException('소견 또는 요청이 변경되었습니다'); };
const absent = () => { throw new NotFoundException('소견이 없습니다'); };
const storageLimit = () => { throw new ConflictException({ code: 'FINDING_STORAGE_LIMIT', message: '소견 저장 한도에 도달했습니다' }); };
const oneComparison = () => {
  throw new ConflictException({ code: 'FINDING_COMPARISON_STUDY', message: '소견에는 비교 검사를 하나만 연결할 수 있습니다. 다른 비교 검사는 새 소견으로 기록하세요' });
};
const staleSource = (itemId: string, head: any) => {
  throw new ConflictException({ code: 'FINDING_SOURCE_STALE', message: '연결할 표식의 최신판을 확인하세요', itemId,
    headRevision: head ? head.revision : null, headHidden: head ? head.hidden : null });
};
const staleJob = (ref: { jobId: string; markId?: string }, head: any) => {
  throw new ConflictException({ code: 'FINDING_SOURCE_STALE', message: '연결할 저장 작업의 최신판을 확인하세요', jobId: ref.jobId,
    ...(ref.markId === undefined ? {} : { markId: ref.markId }), headRevision: head.revision, headHidden: head.hidden });
};
const schemaVersion = () => {
  throw new ConflictException({ code: 'FINDING_SCHEMA_VERSION', message: '이 소견은 새 판 형식입니다. 화면을 새로고침한 뒤 다시 시도하세요' });
};
const clientOutdated = () => {
  throw new ConflictException({ code: 'FINDING_CLIENT_OUTDATED', message: '이 화면 판은 새 소견 형식을 표시하지 못합니다. 새로고침하세요' });
};
const parsed = (value: unknown) => typeof value === 'string' ? JSON.parse(value) : null;
/** The service's own wording for each refusal of the clinical commit (D codes and its own projection codes). */
const OWN: Readonly<Record<string, () => HttpException>> = Object.freeze({
  StaleRevision: () => new ConflictException('소견 또는 요청이 변경되었습니다'), StateTransitionRefused: () => new ConflictException('소견 또는 요청이 변경되었습니다'),
  ProjectionConflict: () => new ConflictException('소견 또는 요청이 변경되었습니다'), RequestIdReused: () => new ConflictException('소견 또는 요청이 변경되었습니다'),
  UnitExists: () => new ConflictException('소견 또는 요청이 변경되었습니다'),
  FINDING_SOURCE_STALE: () => new ConflictException({ code: 'FINDING_SOURCE_STALE', message: '연결할 표식의 최신판을 확인하세요' }),
  FINDING_STORAGE_LIMIT: () => new ConflictException({ code: 'FINDING_STORAGE_LIMIT', message: '소견 저장 한도에 도달했습니다' }),
  FINDING_COMPARISON_STUDY: () => new ConflictException({ code: 'FINDING_COMPARISON_STUDY', message: '소견에는 비교 검사를 하나만 연결할 수 있습니다. 다른 비교 검사는 새 소견으로 기록하세요' }),
  FINDING_SCHEMA_VERSION: () => new ConflictException({ code: 'FINDING_SCHEMA_VERSION', message: '이 소견은 새 판 형식입니다. 화면을 새로고침한 뒤 다시 시도하세요' }),
  NotFound: () => new NotFoundException('소견이 없습니다'), ProjectionNotFound: () => new NotFoundException('소견이 없습니다'),
  ActorPathRefused: () => new ForbiddenException('소견에 접근할 수 없습니다'), ProjectionForbidden: () => new ForbiddenException('소견에 접근할 수 없습니다'),
  OwnerChanged: () => new ForbiddenException('소견에 접근할 수 없습니다'), ProjectionMismatch: () => new ConflictException('소견 또는 요청이 변경되었습니다'),
  ClinicalSourceMissing: () => new ConflictException({ code: 'FINDING_SOURCE_STALE', message: '연결할 표식의 최신판을 확인하세요' }),
});
/** The action a finding revision row records, from the version it projects (create, hide, restore, or an edit keeping visibility). */
const versionAction = (b: ClinicalBody) => b.sequence === 1 ? 'create' : b.state.from === 'Visible' && b.state.to === 'Hidden' ? 'hide' :
  b.state.from === 'Hidden' && b.state.to === 'Visible' ? 'restore' : 'edit';
/** The reason a revision row keeps: the author's typed line; a reason the server bound from the reading context is not typed. */
const typedReason = (b: ClinicalBody) => b.reasonSource === 'stated' ? b.reason : '';
/** The fixed source of one copied source (an item revision or a saved comparison revision); navigation alone is none. */
const sourceOf = (source: any): SourceRef => source?.kind === 'job' ? { kind: 'job', jobId: source.jobId, revision: source.revision }
  : { kind: 'item', itemId: source.itemId, revision: source.revision };
const sameReference = (a: any, b: any) => a.kind === b.kind && a.recordId === b.recordId && a.versionId === b.versionId && a.sha256 === b.sha256;
/** What the commit transaction needs besides the plan; kept with the original for recovery (no secret, no token). */
// The request body is kept as received (valid UTF-8, viewerJson): the commit parses it again with the same rules.
type FindingProjection = { caller: Caller; body: string; fingerprint: string; id: string | null;
  plan: { studies: string[]; checked: string[]; frames: [string, string][] } };

// R6: the shape a stored job copy must have to name its studies (finding-input.ts jobShape). Every WHEN is
// evaluated in order, so no array function sees a non-array.
const JOB_SHAPE = Prisma.sql`(CASE WHEN jsonb_typeof(s.value->'studies') IS DISTINCT FROM 'array' THEN false
  WHEN jsonb_array_length(s.value->'studies') NOT BETWEEN 1 AND 2 THEN false
  WHEN jsonb_typeof(s.value->'studies'->0) IS DISTINCT FROM 'string' THEN false
  WHEN jsonb_array_length(s.value->'studies') = 2 AND jsonb_typeof(s.value->'studies'->1) IS DISTINCT FROM 'string' THEN false
  WHEN (s.value->'studies'->>1) IS NOT DISTINCT FROM (s.value->'studies'->>0) THEN false
  WHEN (s.value->'studies'->>0) IS DISTINCT FROM (s.value->>'jobStudyUid') THEN false
  WHEN (s.value->>'studyUid') IS DISTINCT FROM COALESCE(s.value->'studies'->>1, s.value->'studies'->>0) THEN false
  ELSE true END)`;
// The studies one copied source `s` names: an item names its own study; a job names its projection, every
// study of its ordered set and its anchor, or the unreadable '' when its shape is not exactly that.
const SOURCE_STUDIES = Prisma.sql`CROSS JOIN LATERAL (SELECT s.value->>'studyUid' AS uid
  UNION ALL SELECT CASE WHEN ${JOB_SHAPE} THEN e.value ELSE '' END
    FROM jsonb_array_elements_text(CASE WHEN ${JOB_SHAPE} THEN s.value->'studies' ELSE '[""]'::jsonb END) e WHERE s.value->>'kind' = 'job'
  UNION ALL SELECT s.value->>'jobStudyUid' WHERE s.value->>'kind' = 'job') c`;
// Every study that finding `f`'s head or any of its immutable revisions copied a source from.
// The lineage only grows, and only under the anchor study's row lock.
const LINEAGE = Prisma.sql`SELECT c.uid AS uid FROM jsonb_array_elements(f.snapshot->'sources') s ${SOURCE_STUDIES}
  UNION ALL SELECT c.uid FROM "FindingRevision" r CROSS JOIN LATERAL jsonb_array_elements(r.snapshot->'sources') s ${SOURCE_STUDIES}
  WHERE r."findingId" = f.id`;
// Finding `f` is readable only when its whole lineage stays inside `studies` (the anchor plus the
// comparison studies this caller may read now). A missing study uid never matches. Applied before
// ORDER BY/LIMIT, so pages stay full and a cursor never names a finding the caller cannot read.
const readableLineage = (studies: string[]) => Prisma.sql`NOT EXISTS (SELECT 1 FROM (${LINEAGE}) l
  WHERE COALESCE(l.uid, '') NOT IN (${Prisma.join(studies)}))`;
// One vocabulary, one statement. The report citation check recomputes a source's link state with the
// very SQL the findings list renders from, so the same source can never read 'current' on one surface
// and 'revised' on the other - a difference the user would have to resolve with no way to see it.
const SOURCE_LINKS = Prisma.sql`(SELECT COALESCE(jsonb_agg(CASE WHEN s.value->>'kind' = 'job' THEN jsonb_build_object('jobId', s.value->>'jobId',
    'markId', s.value->'mark'->>'id',
    'linkState', CASE WHEN j.id IS NULL THEN 'missing' WHEN j.hidden THEN 'hidden'
      WHEN j.revision <> (s.value->>'revision')::int THEN 'metadata-changed' ELSE 'current' END,
    'headRevision', j.revision, 'headHidden', j.hidden)
  ELSE jsonb_build_object('itemId', s.value->>'itemId',
    'linkState', CASE WHEN i.id IS NULL THEN 'missing' WHEN i.hidden THEN 'hidden'
      WHEN i.revision <> (s.value->>'revision')::int THEN 'revised' ELSE 'current' END,
    'headRevision', i.revision, 'headHidden', i.hidden) END ORDER BY s.ordinality), '[]'::jsonb)
  FROM jsonb_array_elements(f.snapshot->'sources') WITH ORDINALITY s
  LEFT JOIN "ViewerItem" i ON s.value->>'kind' IS DISTINCT FROM 'job' AND i.id = (s.value->>'itemId')::uuid AND i."studyUid" = s.value->>'studyUid'
  LEFT JOIN "ViewerJob" j ON s.value->>'kind' = 'job' AND j."studyUid" = f."studyUid" AND j.id = (CASE
    WHEN s.value->>'jobId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (s.value->>'jobId')::uuid END))`;

// Identical boundary to viewer items: institution or tele institution, RS=P designated only,
// radiologist writes, author-only revisions, admin gets no extra path.
function member(c: Caller, write = false) {
  if (c.kind !== 'member' || !c.sub || !c.actor || !c.institution || (write && !c.roles.includes('radiologist'))) denied();
}
function viewable(study: any, c: Caller) {
  return !!study && (study.institutionId === c.institution || study.teleInstitutionId === c.institution) &&
    canReadPreliminary(study, c);
}
function visible(study: any, c: Caller) {
  if (!viewable(study, c)) denied();
}
// A comparison study must be viewable like the anchor and allowed by the caller's study-access
// policy (`reachable`); a `readable` one also shares the anchor's non-null institution. Tele access
// grants viewing but never makes two institutions equal (ViewerJob sameInstitution).
function comparable(anchor: any, rows: any[], allowed: Set<string>, c: Caller) {
  const reachable = new Set<string>(), readable = new Set<string>();
  for (const row of rows) {
    if (row.uid === anchor?.uid || !allowed.has(row.uid) || !viewable(row, c)) continue;
    reachable.add(row.uid);
    if (anchor?.institutionId && row.institutionId === anchor.institutionId) readable.add(row.uid);
  }
  return { reachable, readable };
}
function timestamp(value: Date | string) {
  return typeof value === 'string' ? new Date(value + 'Z') : value;
}
// A shipped (version 1) client reads only version 1 rows; anything else would be dropped by it silently.
const legacyOnly = (items: any[]) => items.every(item => item?.schemaVersion === 1);
// `item` is the signed version's snapshot; null when the finding has no D version (written before unit D, no text served).
function result(head: any, revision?: any) {
  const item = revision?.snapshot ?? head.snapshot ?? null;
  return { id: head.id, studyUid: head.studyUid, authorSub: head.authorSub, authorActor: head.authorActor,
    revision: revision?.revision ?? head.revision, createdAt: timestamp(head.createdAt), hidden: item ? item.hidden : head.hidden,
    updatedAt: timestamp(revision?.at ?? head.updatedAt), item };
}
function replayMismatch(replay: any, fingerprint: string, uid: string, c: Caller, id?: string) {
  return replay.fingerprint !== fingerprint || replay.finding.studyUid !== uid || replay.finding.authorSub !== c.sub ||
    (id !== undefined && replay.findingId !== id);
}

// A finding is anchored on its own study X and may copy sources from at most one comparison study P
// over its whole lifetime: same non-empty Orthanc PatientID, same institution, and the caller may
// read both. A finding whose lineage names a study the caller cannot read is excluded from every
// list, history and replay, and refused for every edit, hide and restore, exactly like an absent one.
// Storage budgets stay on X and count every finding, readable or not.
@Injectable()
export class FindingService {
  constructor(private prisma: PrismaService, private studyAccess: StudyAccessService, private orthanc: OrthancService) {
    registerClinicalProjection('finding', (tx, plan, projection, caller) => this.project(tx, plan, projection as FindingProjection, caller), { db: prisma, access: studyAccess });
  }

  private async bounded<T>(work: (tx: Prisma.TransactionClient) => Promise<T>, read = false): Promise<T> {
    try {
      return await this.prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
        await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
        return work(tx);
      }, { isolationLevel: read ? Prisma.TransactionIsolationLevel.RepeatableRead : Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 4000, timeout: 8000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (['P2002', 'P2003', 'P2034'].includes(error.code)) conflict();
        if (error.code === 'P2028' || (error.code === 'P2010' && ['55P03', '57014', '40P01'].includes(String(error.meta?.code))))
          throw new ServiceUnavailableException('소견 저장이 지연되었습니다. 같은 요청 ID로 다시 시도하세요');
        // The service refuses every bound before insert; the database CHECK is a fail-closed backstop, not a 500.
        if (error.code === 'P2010' && String(error.meta?.code) === '23514') storageLimit();
      }
      throw error;
    }
  }

  // Comparison studies (anchor excluded) of one finding's lineage.
  private async lineage(db: any, uid: string, findingId: string): Promise<string[]> {
    const rows = await db.$queryRaw`SELECT DISTINCT l.uid FROM "Finding" f CROSS JOIN LATERAL (${LINEAGE}) l
      WHERE f.id = ${clinicalText(findingId)}::uuid AND f."studyUid" = ${clinicalText(uid)}`;
    return comparisonStudies(uid, rows.map((row: any) => row.uid));
  }

  // Unlocked form for planning: without a transaction the access service prepares any Orthanc
  // metadata its policy needs, so the locked re-check below never has to fetch it.
  private async comparisons(c: Caller, anchor: any, uids: string[]) {
    if (!uids.length) return comparable(anchor, [], new Set(), c);
    const allowed = await this.studyAccess.allowed(c, uids);
    return comparable(anchor, await this.prisma.studyState.findMany({ where: { uid: { in: uids } } }), allowed, c);
  }

  // The replay receipt with both snapshots read as JSON text (the query engine's Json conversion can move a
  // 17-digit double by one ULP; viewer-job-snapshot.ts).
  private async replayRow(db: any, sub: string, requestId: string) {
    const [row] = await db.$queryRaw`SELECT r."findingId", r.revision, r.fingerprint, r.at, r.snapshot::text AS snapshot,
        f.id, f."studyUid", f."authorSub", f."authorActor", f."createdAt"
      FROM "FindingRevision" r JOIN "Finding" f ON f.id = r."findingId" WHERE r."authorSub" = ${clinicalText(sub)} AND r."requestId" = ${clinicalText(requestId)}::uuid`;
    if (!row) return null;
    return { findingId: row.findingId, revision: row.revision, fingerprint: row.fingerprint, at: row.at, snapshot: parsed(row.snapshot),
      finding: { id: row.id, studyUid: row.studyUid, authorSub: row.authorSub, authorActor: row.authorActor, createdAt: row.createdAt } };
  }

  /**
   * Finding text (a finding's snapshot: title, text, copied sources) of every listed finding or revision is the signed
   * version's, served only after the provide-prepared event naming exactly those versions is durable (EMR-D, DR2-02/03);
   * the page rows and the versions are read in one RepeatableRead snapshot and a row whose meaning differs from its
   * version is refused without text. A finding without a D unit (written before unit D) is listed without text (null), and
   * its revisions without their typed reasons (null).
   */
  private signedItem(row: { revision: number; snapshot: unknown; at: Date | string }, b: ClinicalBody | undefined) {
    if (!b) return null;
    if (b.sequence !== row.revision || b.text !== canonical(row.snapshot) || timestamp(row.at).toISOString() !== b.at) conflict();
    return JSON.parse(b.text);
  }

  // `schema` is the X-KIN-Finding-Schema request header: without '2' a page holding any other version is refused whole.
  async list(uid: string, query: any, c: Caller, id?: string, schema?: string, request?: unknown) {
    member(c); viewerUid(uid);
    const runtime = requireClinicalRuntime(), reader = { subject: c.sub, institutionId: c.institution };
    visible(await this.prisma.studyState.findUnique({ where: { uid } }), c);
    // Comparison studies are found only inside the read transaction, which cannot fetch access
    // metadata, so a metadata-rule policy is prepared for every study first (ViewerJob.list).
    await this.studyAccess.prepare(c);
    await this.studyAccess.require(c, [uid]);
    if (id !== undefined) viewerUuid(id);
    const page = findingPage(query, id !== undefined);
    // Permission predicate, page and per-source link state share one RepeatableRead statement:
    // a link state is never taken from a second, unlocked read of the item heads. The link state
    // is a database fact (head revision/hidden/presence) and is distinct from the viewer's
    // Orthanc-backed verified/unverified status, which stays on the viewer-items list.
    return this.clinical(() => this.bounded(async tx => {
      const parent = Prisma.sql`SELECT uid FROM "StudyState" WHERE uid = ${uid}
        AND ("institutionId" = ${c.institution} OR "teleInstitutionId" = ${c.institution})
        AND (rs <> 'P' OR (CASE WHEN "preDocSub" IS NOT NULL THEN "preDocSub" = ${c.sub} ELSE "preDoc" = ${c.actor} END) OR (CASE WHEN "preReviewerSub" IS NOT NULL THEN "preReviewerSub" = ${c.sub} ELSE "preReviewer" = ${c.actor} END))`;
      // The same snapshot names every comparison study in scope and decides which of them this
      // caller may read; the page statement then drops findings whose lineage leaves that set.
      const scope = id === undefined ? Prisma.empty : Prisma.sql`AND f.id = ${id}::uuid`;
      const foreign = comparisonStudies(uid, (await tx.$queryRaw<any[]>`SELECT DISTINCT l.uid
        FROM "Finding" f CROSS JOIN LATERAL (${LINEAGE}) l WHERE f."studyUid" = ${uid} ${scope}`).map(row => row.uid));
      const studies = [uid];
      if (foreign.length) {
        const allowed = await this.studyAccess.allowed(c, foreign, tx);
        const rows = await tx.studyState.findMany({ where: { uid: { in: [uid, ...foreign] } } });
        const { readable } = comparable(rows.find(row => row.uid === uid), rows, allowed, c);
        studies.push(...foreign.filter(study => readable.has(study)));
      }
      if (id !== undefined) {
        const [pageRow] = await tx.$queryRaw<any[]>`WITH parent AS (${parent}),
          head AS (SELECT f.id FROM "Finding" f JOIN parent p ON p.uid = f."studyUid" WHERE f.id = ${id}::uuid
            AND ${readableLineage(studies)})
          SELECT EXISTS(SELECT 1 FROM parent) AS allowed, EXISTS(SELECT 1 FROM head) AS present,
            COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page.revision) FROM (
              SELECT r.revision, r.snapshot, r.action, r.reason, r.actor, r."authorSub", r."payloadBytes", r.at
              FROM "FindingRevision" r JOIN head h ON h.id = r."findingId"
              WHERE (${page.cursor}::int IS NULL OR r.revision > ${page.cursor}::int)
              ORDER BY r.revision LIMIT ${page.limit + 1}) page), '[]'::jsonb)::text AS rows`;
        if (!pageRow.allowed) denied();
        // An unreadable finding answers exactly like an absent id.
        if (!pageRow.present) absent();
        const rows: any[] = parsed(pageRow.rows), shown = rows.slice(0, page.limit);
        return runtime.respond(request, { view: 'finding-history', route: 'GET studies/:uid/findings/:id/revisions',
          id: id.toLowerCase(), sequences: shown.map(row => row.revision), schema,
          nextCursor: rows.length > page.limit ? shown[shown.length - 1].revision : null }, { db: this.prisma, tx, caller: c, access: this.studyAccess });
      }
      // Item links are the shipped entries byte for byte; a job entry reports the job head of this anchor.
      const [pageRow] = await tx.$queryRaw<any[]>`WITH parent AS (${parent})
        SELECT EXISTS(SELECT 1 FROM parent) AS allowed,
          COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page.id) FROM (
            SELECT f.*, ${SOURCE_LINKS} AS links
            FROM "Finding" f JOIN parent p ON p.uid = f."studyUid"
            WHERE (${page.includeHidden} OR NOT f.hidden)
              AND (${page.cursor}::uuid IS NULL OR f.id > ${page.cursor}::uuid)
              AND ${readableLineage(studies)}
            ORDER BY f.id LIMIT ${page.limit + 1}) page), '[]'::jsonb)::text AS rows`;
      if (!pageRow.allowed) denied();
      const rows: any[] = parsed(pageRow.rows), shown = rows.slice(0, page.limit);
      return runtime.respond(request, { view: 'findings', route: 'GET studies/:uid/findings', ids: shown.map(row => row.id),
        links: shown.map(row => ({ id: row.id, links: row.links })), schema,
        nextCursor: rows.length > page.limit ? shown[shown.length - 1].id : null }, { db: this.prisma, tx, caller: c, access: this.studyAccess });
    }, true));
  }

  /**
   * 판독문 인용이 가리키는 소견을 이 호출자가 **지금** 읽을 수 있는가 — 그것만 답한다.
   *
   * 목록 경로는 답이 될 수 없다. 기본 50·최대 100건에 커서로 자르고 숨김을 빼므로,
   * 64건을 한 번에 물을 수 없고 **숨겨진 소견을 인용한 판독문이 조용히 「출처 없음」이 된다.**
   * 그래서 여기서는 숨김을 포함하고 페이지를 나누지 않는다. 판정 기준은 목록과 똑같이
   * `readableLineage` 하나뿐이며, 삽입 검사는 이 메서드를 한 건으로 쓴다.
   *
   * 호출자의 트랜잭션 안에서 돈다 — 인용 읽기와 삽입 검사는 같은 스냅샷에서 판정해야 한다.
   * 그래서 접근 정책 준비(`prepare`)는 트랜잭션 **밖에서** 끝나 있어야 한다:
   * 트랜잭션 안의 `allowed`는 준비를 하지 않고, 캐시가 없으면 409다.
   *
   * 돌려주는 것은 읽을 수 있는 건의 **부분집합**이다. 링크 상태와 출처 목록은 삽입 검사가
   * 한 건에 대해서만 쓰고, 전용 읽기는 id 집합만 본다 — 둘 다 응답으로 나가지 않는다.
   * 인용을 원본으로 되짚는 우회 해결기는 만들지 않는다.
   */
  async readableFindings(tx: any, c: Caller, uid: string, ids: string[]) {
    member(c); viewerUid(uid);
    const unique = [...new Set(ids)];
    if (!unique.length) return [] as any[];
    // 한 판독문의 한도가 그대로 이 질의의 한도다. 넘으면 조용히 자르지 않고 막는다.
    if (unique.length > REPORT_CITATION_LIMITS.entries) conflict();
    for (const id of unique) viewerUuid(id);
    const keys = Prisma.join(unique.map(id => Prisma.sql`${id}::uuid`));
    const parent = Prisma.sql`SELECT uid FROM "StudyState" WHERE uid = ${uid}
      AND ("institutionId" = ${c.institution} OR "teleInstitutionId" = ${c.institution})
      AND (rs <> 'P' OR (CASE WHEN "preDocSub" IS NOT NULL THEN "preDocSub" = ${c.sub} ELSE "preDoc" = ${c.actor} END) OR (CASE WHEN "preReviewerSub" IS NOT NULL THEN "preReviewerSub" = ${c.sub} ELSE "preReviewer" = ${c.actor} END))`;
    // The same snapshot names every comparison study these findings reach and decides which of them
    // this caller may read; the row statement then drops findings whose lineage leaves that set.
    const foreign = comparisonStudies(uid, (await tx.$queryRaw`SELECT DISTINCT l.uid
      FROM "Finding" f CROSS JOIN LATERAL (${LINEAGE}) l
      WHERE f."studyUid" = ${uid} AND f.id IN (${keys})`).map((row: any) => row.uid));
    const studies = [uid];
    if (foreign.length) {
      const allowed = await this.studyAccess.allowed(c, foreign, tx);
      const rows = await tx.studyState.findMany({ where: { uid: { in: [uid, ...foreign] } } });
      const { readable } = comparable(rows.find((row: any) => row.uid === uid), rows, allowed, c);
      studies.push(...foreign.filter(study => readable.has(study)));
    }
    const [row] = await tx.$queryRaw`WITH parent AS (${parent})
      SELECT COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page.id) FROM (
        SELECT f.id, f.revision, f.hidden, f.snapshot->'sources' AS sources, ${SOURCE_LINKS} AS links
        FROM "Finding" f JOIN parent p ON p.uid = f."studyUid"
        WHERE f.id IN (${keys}) AND ${readableLineage(studies)}) page), '[]'::jsonb)::text AS rows`;
    return (parsed(row.rows) ?? []) as any[];
  }

  // Resolves, without any lock, every study this command can touch, so access metadata and the
  // Orthanc patient identity are fetched before a row is locked. The transaction repeats each check
  // on locked rows; a plan made stale by a concurrent change ends in 409, never in an unchecked read
  // or copy. Studies the caller cannot open are left out: their items then fail in the source loop at
  // the same position and with the same body as unknown ids, and never reach Orthanc.
  // S2-L1 (B1): a job reference is first read raw, a job anchored elsewhere contributes nothing and later fails
  // as an unknown id, and an anchored job's whole study set joins the item studies in the unchanged
  // reachable/readable/N2/patient checks. Only then, and only for a point on a job every study of which
  // passed, is the Frame of Reference of its first original read: once per job, all within 20 s.
  private async plan(uid: string, anchor: any, command: FindingCommand, fingerprint: string, c: Caller, id?: string) {
    const checked = new Set<string>(), frames = new Map<string, string>();
    const readableFinding = async (findingId: string) => {
      const lineage = await this.lineage(this.prisma, uid, findingId);
      const { readable } = await this.comparisons(c, anchor, lineage);
      if (lineage.some(study => !readable.has(study))) absent();
      return lineage;
    };
    const replay = await this.replayRow(this.prisma, c.sub, command.requestId);
    if (replay) {
      if (replayMismatch(replay, fingerprint, uid, c, id)) conflict();
      return { studies: [uid, ...await readableFinding(replay.findingId)].sort(), checked, frames };
    }
    let lineage: string[] = [];
    const frozen = new Map<string, unknown[]>();
    if (id !== undefined) {
      const heads: any = await this.prisma.$queryRaw`SELECT "authorSub", snapshot::text AS snapshot FROM "Finding" WHERE id = ${id}::uuid AND "studyUid" = ${uid}`;
      if (!heads.length) return { studies: [uid], checked, frames };
      lineage = await readableFinding(id);
      if (heads[0].authorSub !== c.sub) denied();
      // Hide and restore keep the head's exact pairs, so they copy nothing and never reach Orthanc.
      if (command.action !== 'edit') return { studies: [uid, ...lineage].sort(), checked, frames };
      for (const source of parsed(heads[0].snapshot).sources) frozen.set(refKey(sourceRef(source)), sourceStudies(source));
    }
    const fresh = command.item.sources.filter(ref => !frozen.has(refKey(ref)));
    const itemRefs = fresh.filter((ref): ref is FindingSourceRef => !isJobRef(ref)), jobRefs = fresh.filter(isJobRef);
    const items = itemRefs.length ? await this.prisma.viewerItem.findMany({ where: { id: { in: itemRefs.map(ref => ref.itemId) } }, select: { studyUid: true } }) : [];
    const jobs = jobRefs.length ? await this.prisma.$queryRaw<any[]>`SELECT id::text AS id, "studyUid", studies,
        (snapshot->'version')::text AS version, (snapshot->'volume')::text AS volume, (snapshot->'marks')::text AS marks
      FROM "ViewerJob" WHERE id IN (${Prisma.join(jobRefs.map(ref => Prisma.sql`${ref.jobId}::uuid`))})` : [];
    const anchored = new Map<string, { studies: string[]; snapshot: any }>();
    for (const job of jobs) {
      let studies: string[];
      try { studies = jobStudies(uid, job); } catch { continue; }
      anchored.set(job.id, { studies, snapshot: { version: parsed(job.version), volume: parsed(job.volume), marks: parsed(job.marks) } });
    }
    const candidates = comparisonStudies(uid, [...items.map(item => item.studyUid), ...[...anchored.values()].flatMap(job => job.studies)]);
    const { reachable, readable } = await this.comparisons(c, anchor, candidates);
    const linked = candidates.filter(study => reachable.has(study));
    const kept = command.item.sources.filter(ref => frozen.has(refKey(ref))).flatMap(ref => frozen.get(refKey(ref)));
    if (comparisonStudies(uid, [...kept, ...linked]).length > 1) throw new BadRequestException('소견에는 비교 검사 하나의 표식만 함께 연결할 수 있습니다');
    if (linked.some(study => !readable.has(study))) denied();
    if (comparisonStudies(uid, [...lineage, ...kept, ...linked]).length > 1) oneComparison();
    if (linked.length) {
      // Only a new copy from the comparison study proves the patient again; Orthanc 400/503 pass through.
      const own = await this.orthanc.connectStudyIdentity(uid), other = await this.orthanc.connectStudyIdentity(linked[0]);
      if (own.patientId !== other.patientId) throw new BadRequestException('같은 환자의 검사만 소견에 연결할 수 있습니다');
      checked.add(linked[0]);
    }
    const permitted = new Set([uid, ...linked]), points = new Map<string, { study: string; series: string; sop: string }>();
    for (const ref of jobRefs) {
      const job = anchored.get(ref.jobId);
      if (ref.markId === undefined || !job || points.has(ref.jobId) || !job.studies.every(study => permitted.has(study))) continue;
      // A point the write will refuse (W4) is never looked up; the refusal keeps its position there.
      const mark = (() => { try { return jobMark(job.snapshot, job.studies, ref.markId); } catch { return null; } })();
      if (mark) points.set(ref.jobId, mark.volume);
    }
    if (points.size) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
      try {
        for (const [jobId, volume] of points) frames.set(jobId, jobFrame(await this.orthanc.viewerReference(volume.sop, false, controller.signal), volume));
      } finally { clearTimeout(timer); controller.abort(); }
    }
    return { studies: [...new Set([uid, ...lineage, ...linked])].sort(), checked, frames };
  }

  /**
   * EMR-D: a finding version is the radiologist's own clinical entry over the server's canonical snapshot (the frozen
   * source copies included, never the client item). The snapshot is composed once under the write locks before
   * admission so that the author's device can sign exactly it, and composed again under the same locks inside the
   * clinical commit transaction; a source that moved in between rolls the commit back. A registered request ID is
   * answered from its register before any source copy or lock.
   */
  async write(uid: string, raw: Buffer, c: Caller, id?: string, request?: unknown) {
    member(c, true); viewerUid(uid); if (id !== undefined) viewerUuid(id);
    const runtime = requireClinicalRuntime();
    const command = findingCommand(raw, id === undefined), fingerprint = findingFingerprint(uid, id ?? null, command);
    const body = viewerJson(raw);
    const anchor = await this.prisma.studyState.findUnique({ where: { uid } });
    visible(anchor, c);
    await this.studyAccess.require(c, [uid]);
    const surface = (id === undefined ? 'finding.create' : 'finding.' + command.action) as SurfaceKey;
    const caller = { subject: c.sub, institutionId: c.institution };
    // A new finding's ID is its request ID (as for questions, requests and consultations): the author's device signs the
    // version of exactly this record before the server has written anything.
    const recordId = id ?? command.requestId.toLowerCase();
    const known = await this.clinical(() => runtime.lookup(request, { surface, studyId: uid, recordId, body, caller, projection: null }));
    if (known) return this.answer(known, c, command.requestId, request, id);
    const reading = holdAlive(anchor) && anchor.holder === c.actor ? { referenceId: 'hold:' + anchor.draftEpoch } : null;
    const result = await this.clinical(() => runtime.write(request, { surface, studyId: uid, recordId, body, reading, caller, projection: null,
      prepare: async () => {
        const plan = await this.plan(uid, anchor, command, fingerprint, c, id);
        const composed = await this.bounded(async tx => {
          const made = await this.compose(tx, uid, c, command, plan, id);
          return { ...made, attachments: await readClinicalSources(tx, made.refs) };
        });
        const projection: FindingProjection = { caller: { kind: c.kind, institution: c.institution, sub: c.sub, actor: c.actor, roles: [...c.roles] },
          body: raw.toString('utf8'), fingerprint, id: id ?? null,
          plan: { studies: [...plan.studies], checked: [...plan.checked], frames: [...plan.frames] } };
        return { projection, content: composed.serialized, attachments: composed.attachments, navigation: composed.navigation };
      } }));
    return this.answer(result.outcome, c, command.requestId, request, id);
  }

  private async clinical<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (error) { throw clinicalRefusal(error, OWN); }
  }

  /**
   * The stored revision row of a committed or replayed request, its snapshot the signed version's and handed back only
   * after the provide-prepared event for that version is durable (DR2-03). A failure carries this service's wording and no
   * text; a committed write whose answer cannot be provided yet stays pending for the same request.
   */
  private async answer(outcome: CommitOutcome, c: Caller, requestId: string, request: unknown, id?: string) {
    const code = outcomeCode(outcome);
    if (code === 'ReasonRequired') throw new BadRequestException('숨김/복원에는 사유가 필요합니다');
    if (code !== null) throw clinicalHttpError(code, OWN);
    const runtime = requireClinicalRuntime();
    try {
      await this.studyAccess.prepare(c);
      return await this.bounded(tx => runtime.respond(request, { view: 'finding-write',
        route: id === undefined ? 'POST studies/:uid/findings' : 'POST studies/:uid/findings/:id/revisions',
        receipt: (outcome as any).receipt }, { db: this.prisma, tx, caller: c, access: this.studyAccess }), true);
    } catch (error) { throw clinicalEchoRefusal(error, OWN); }
  }

  /**
   * Everything a write checks and copies under its locks, without writing: the access policy, the anchor and comparison
   * study rows, the head's author/revision/state/version, the frozen or freshly copied sources, the bounds. Returns the
   * canonical snapshot text both rows store and the device signs.
   */
  private async compose(tx: any, uid: string, c: Caller, command: FindingCommand, plan: { studies: string[]; checked: Set<string>; frames: Map<string, string> }, id?: string) {
    const studyUid = clinicalText(uid), lockedStudies = plan.studies.map(study => clinicalText(study));
    // The shared policy lock is taken first, so a concurrent access change is wholly before or
    // wholly after this write.
    await this.studyAccess.require(c, [uid], tx);
    const allowed = plan.studies.length > 1 ? await this.studyAccess.allowed(c, plan.studies, tx) : new Set<string>();
    // The anchor and planned comparison study rows are locked by ONE statement in the database's
    // uid order, as ViewerJob, favorites and study tags lock theirs; a JS sort could disagree with
    // the collation and invert the order. The anchor lock is the serialization point shared with
    // viewer-item writes, and each item write locks its own study row, so every source head read
    // below happens after the writes that could move it: a cooperating item edit is either fully
    // before (its new revision is seen) or fully after (it finds the copied revision).
    const studies = await tx.$queryRaw`SELECT * FROM "StudyState" WHERE uid = ANY(${lockedStudies}::text[]) ORDER BY uid FOR UPDATE` as any[];
    const locked = studies.find(row => row.uid === uid);
    visible(locked, c);
    const { reachable, readable } = comparable(locked, studies, allowed, c);
    // An unreadable lineage answers like an absent finding. A lineage study missing from the plan
    // is a concurrent change: nothing is written and the same request id can be retried.
    const readableFinding = async (findingId: string) => {
      const lineage = await this.lineage(tx, uid, findingId);
      if (lineage.some(study => plan.studies.includes(study) && !readable.has(study))) absent();
      if (lineage.some(study => !plan.studies.includes(study))) conflict();
      return lineage;
    };
    let head: any = null, lineage: string[] = [];
    if (id !== undefined) {
      const heads = await tx.$queryRaw`SELECT id, "studyUid", "authorSub", "authorActor", revision, hidden, "createdAt", "updatedAt",
        snapshot::text AS snapshot FROM "Finding" WHERE id = ${clinicalText(id)}::uuid AND "studyUid" = ${studyUid} FOR UPDATE` as any[];
      head = heads[0] ? { ...heads[0], snapshot: parsed(heads[0].snapshot) } : null;
      if (!head) throw new NotFoundException('소견이 없습니다');
      // Edit, hide and restore alike: checked before the author and revision checks.
      lineage = await readableFinding(id);
      if (head.authorSub !== c.sub) denied();
      if (head.revision !== command.expectedRevision) conflict();
      if ((command.action === 'hide' && head.hidden) || (command.action === 'restore' && !head.hidden)) conflict();
      if (head.revision + 1 > FINDING_LIMITS.history) storageLimit();
      // Version rule: an edit may promote version 1 to 2 but never write version 1 over version 2, whose
      // characteristics and job copies a shipped client cannot carry. Hide and restore keep the head's
      // version; on version 2 they also keep its content exactly.
      const from = head.snapshot?.schemaVersion, to = command.item.schemaVersion, item = command.item;
      if (![1, 2].includes(from) || (command.action === 'edit' ? from === 2 && to !== 2 : to !== from)) schemaVersion();
      if (command.action !== 'edit' && from === 2 && (item.title !== head.snapshot.title || item.text !== head.snapshot.text ||
          item.characteristics !== head.snapshot.characteristics || item.primary !== head.snapshot.primary)) schemaVersion();
    }
    // An unchanged {itemId, revision} pair (or job key) keeps its frozen copy byte for byte, even when that
    // item or job was edited, hidden or lost since. Only a new pair or an explicitly refreshed one is
    // validated against the current head and copied again.
    const frozen = new Map<string, any>(), identities = new Map<string, any>();
    for (const source of (head?.snapshot?.sources ?? []) as any[]) {
      frozen.set(refKey(sourceRef(source)), source);
      if (source?.kind === 'job') identities.set(source.jobId + ':' + (source.mark?.id ?? ''), source);
    }
    // Hide/restore is not an edit: the pair sequence must be exactly the head's, so no refresh
    // or relink can ride along with a hide reason.
    if (head && command.action !== 'edit' && canonical(command.item.sources) !==
        canonical((head.snapshot.sources as any[]).map(sourceRef))) conflict();
    const sources: (FindingSource | FindingJobSource)[] = [];
    for (const ref of command.item.sources) {
      const kept = frozen.get(refKey(ref));
      if (kept) { sources.push(kept); continue; }
      if (isJobRef(ref)) {
        // S2-L1: the job head of this anchor, its immutable snapshot as text, W1-W4, then staleness.
        const [job] = await tx.$queryRaw`SELECT id::text AS id, "studyUid", studies, hidden, revision, title, "authorActor",
          snapshot::text AS snapshot FROM "ViewerJob" WHERE id = ${clinicalText(ref.jobId)}::uuid` as any[];
        const jobStudyUids = jobStudies(uid, job);
        // A comparison study that is not locked and reachable here is indistinguishable from an unknown job.
        if (jobStudyUids.length > 1) {
          if (!reachable.has(jobStudyUids[1])) jobAbsent();
          if (!readable.has(jobStudyUids[1])) denied();
          if (!plan.checked.has(jobStudyUids[1])) conflict();
        }
        const snapshot = parsed(job.snapshot), mark = jobMark(snapshot, jobStudyUids, ref.markId);
        if (job.hidden || job.revision !== ref.revision) staleJob(ref, job);
        // The Frame of Reference was read for this job before the locks; a reference outside that plan is a
        // concurrent change and the same request id can be retried.
        if (mark && !plan.frames.has(ref.jobId)) conflict();
        const copy = copyJob(job, jobStudyUids, snapshot, mark, mark ? plan.frames.get(ref.jobId) : null);
        // A refresh re-copies the title and author only; the location it names must be the frozen one.
        const previous = identities.get(ref.jobId + ':' + (ref.markId ?? ''));
        if (previous && jobLocation(previous) !== jobLocation(copy)) conflict();
        sources.push(copy);
        continue;
      }
      const rows = await tx.$queryRaw`SELECT id, "studyUid", revision, hidden, "authorActor", snapshot::text AS snapshot
        FROM "ViewerItem" WHERE id = ${clinicalText(ref.itemId)}::uuid` as any[];
      const item = rows[0] ? { ...rows[0], snapshot: parsed(rows[0].snapshot) } : null;
      // An item of a study that is not locked and reachable here is indistinguishable from a missing one.
      if (!item || (item.studyUid !== uid && !reachable.has(item.studyUid))) throw new NotFoundException('연결할 표식이 이 검사에 없습니다');
      if (item.studyUid !== uid) {
        if (!readable.has(item.studyUid)) denied();
        if (!plan.checked.has(item.studyUid)) conflict();
      }
      if (item.hidden || item.revision !== ref.revision) staleSource(ref.itemId, item);
      sources.push(copySource(item));
    }
    if (comparisonStudies(uid, [...lineage, ...sources.flatMap(sourceStudies)]).length > 1) oneComparison();
    const hidden = command.action === 'hide' || (command.action === 'edit' && head?.hidden === true);
    const snapshot = command.item.schemaVersion === 2
      ? { schemaVersion: 2, title: command.item.title, text: command.item.text, characteristics: command.item.characteristics, hidden, primary: command.item.primary, sources }
      : { schemaVersion: 1, title: command.item.title, text: command.item.text, hidden, primary: command.item.primary, sources };
    const serialized = canonical(snapshot);
    const sizes = await tx.$queryRaw`SELECT octet_length(convert_to(${serialized}::jsonb::text, 'UTF8')) AS bytes` as { bytes: number }[];
    const bytes = sizes[0].bytes;
    if (bytes > FINDING_LIMITS.snapshot) storageLimit();
    // Lifetime counts under the parent lock; revisions are append-only so the aggregate is the
    // lifetime figure and hiding never recovers budget. They count every finding of this study,
    // including those this caller cannot read, and the refusal names no finding or count.
    const [usage] = await tx.$queryRaw`SELECT
      (SELECT count(*)::int FROM "Finding" WHERE "studyUid" = ${studyUid}) AS findings,
      (SELECT count(*)::int FROM "FindingRevision" r JOIN "Finding" f ON f.id = r."findingId" WHERE f."studyUid" = ${studyUid}) AS revisions,
      (SELECT COALESCE(sum(r."payloadBytes"), 0)::bigint FROM "FindingRevision" r JOIN "Finding" f ON f.id = r."findingId" WHERE f."studyUid" = ${studyUid}) AS bytes` as any[];
    const added = head ? 0 : 1;
    if (usage.findings + added > FINDING_LIMITS.findings || usage.revisions + 1 > FINDING_LIMITS.revisions ||
        Number(usage.bytes) + bytes > FINDING_LIMITS.bytes) storageLimit();
    // Comparison studies linked for navigation only (never incorporated components of the version); every copied source is
    // incorporated and is cited by the fixed reference of the version it was copied from.
    return { head, serialized, bytes, hidden, sources: sources.length, refs: sources.map(sourceOf),
      navigation: comparisonStudies(uid, sources.flatMap(sourceStudies)) };
  }

  /** The finding rows of one committed version: the head and its revision carry the exact counted JSON. */
  private async persist(tx: any, uid: string, c: Caller, command: FindingCommand, fingerprint: string,
    composed: Awaited<ReturnType<FindingService['compose']>>, recordId: string, now: Date) {
    const previous = composed.head;
    const revision = clinicalCount(previous ? previous.revision + 1 : 1, 1), serialized = clinicalText(composed.serialized), hidden = composed.hidden === true;
    const id = clinicalText(recordId), studyUid = clinicalText(uid), sub = clinicalText(c.sub), actor = clinicalText(c.actor), bytes = clinicalCount(composed.bytes);
    // The exact JSON counted above is stored in both rows; the byte-equality CHECK is not weakened.
    const rows = previous ? await tx.$queryRaw`UPDATE "Finding" SET snapshot = ${serialized}::jsonb,
      hidden = ${hidden}, revision = ${revision}, "updatedAt" = ${now} WHERE id = ${id}::uuid
      RETURNING id, "studyUid", "authorSub", "authorActor", revision, hidden, "createdAt", "updatedAt", snapshot::text AS snapshot` as any[]
      : await tx.$queryRaw`INSERT INTO "Finding"
      (id, "studyUid", "authorSub", "authorActor", snapshot, hidden, revision, "createdAt", "updatedAt")
      VALUES (${id}::uuid, ${studyUid}, ${sub}, ${actor}, ${serialized}::jsonb, ${hidden}, ${revision}, ${now}, ${now})
      RETURNING id, "studyUid", "authorSub", "authorActor", revision, hidden, "createdAt", "updatedAt", snapshot::text AS snapshot` as any[];
    const head = rows[0];
    await tx.$executeRaw`INSERT INTO "FindingRevision"
      ("findingId", revision, snapshot, action, reason, actor, "authorSub", "requestId", fingerprint, "payloadBytes", at)
      VALUES (${clinicalText(head.id)}::uuid, ${revision}, ${serialized}::jsonb, ${clinicalText(command.action)}, ${clinicalText(command.reason, true)}, ${actor}, ${sub},
        ${clinicalText(command.requestId)}::uuid, ${clinicalText(fingerprint)}, ${bytes}, ${now})`;
    await tx.auditLog.create({ data: { actor: c.actor, action: 'finding.' + command.action, target: uid,
      detail: JSON.stringify({ findingId: head.id, revision, authorSub: c.sub, payloadBytes: composed.bytes, sources: composed.sources }) } });
  }

  /**
   * The legacy rows of one committed finding version, inside the clinical commit transaction (registered projector):
   * the snapshot is composed again under the locks and must be the very text the version (and its signature) holds.
   */
  private async project(tx: any, plan: Readonly<ClinicalWritePlan>, p: FindingProjection, trusted?: Caller) {
    const c = projectedCaller(p.caller, trusted), v = plan.version;
    const studyId = clinicalText(v.studyId), recordId = clinicalText(v.recordId), id = p.id === null ? undefined : clinicalText(p.id);
    // The same parse as the write: a stored body that no longer gives the fingerprint the original was admitted with is not its own.
    const command = findingCommand(Buffer.from(clinicalText(p.body), 'utf8'), id === undefined), fingerprint = clinicalText(p.fingerprint);
    if (findingFingerprint(studyId, id ?? null, command) !== fingerprint) throw new ProjectionRefused('ProjectionConflict');
    const planned = { studies: p.plan.studies.map(study => clinicalText(study)), checked: new Set(p.plan.checked.map(study => clinicalText(study))),
      frames: new Map(p.plan.frames.map(([jobId, frame]) => [clinicalText(jobId), clinicalText(frame)] as [string, string])) };
    // The source versions this version cites are read again first (DR3-04): one gone since admission is that source's change,
    // refused as the stale source (ClinicalSourceMissing) - never as a missing record, whatever compose would say of a head
    // that went with it (a head is removed only after its revisions).
    await readClinicalSources(tx, v.attachments.map(citedSource));
    const composed = await this.compose(tx, studyId, c, command, planned, id);
    if (composed.serialized !== v.text) throw new ProjectionRefused('FINDING_SOURCE_STALE');
    // The version cites exactly the source versions this commit copies, in the same order (DR2-05).
    const cited = await readClinicalSources(tx, composed.refs);
    if (cited.length !== v.attachments.length || cited.some((r, i) => !r.kinds.includes(v.attachments[i].kind) ||
        !sameReference({ kind: v.attachments[i].kind, recordId: r.recordId, versionId: r.event.versionId, sha256: r.event.sha256 }, v.attachments[i])))
      throw new ProjectionRefused('FINDING_SOURCE_STALE');
    if (id === undefined ? composed.head !== null || v.sequence !== 1 : composed.head?.revision !== v.sequence - 1) throw new ProjectionRefused('ProjectionConflict');
    await this.persist(tx, studyId, c, command, fingerprint, composed, recordId, new Date(v.at));
  }
}

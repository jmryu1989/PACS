/*
 * 판독문 인용·구조화의 검증·한도·선택, 판독 이력과 인용·구조화 읽기. 구조화 서식 목록은 이 객체 하나에만 있다.
 * PacsService가 만들어 소유하는 평범한 객체다(Nest provider가 아니다). 생성자는 참조만 저장한다.
 */
import { canReadPreliminary } from '../preliminary-reader';
import type { StudyAccessService } from '../study-access.service';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../prisma.service';
import type { FindingService } from '../finding.service';
import { canonical } from '../viewer-input';
import { applyKeepList, blockIsBlank, citationArray, citationIdList, citationInsertInput, citationSourceRef,
  CitationInputError, lineBlockOccurrences, presenceState, projectCitation, sameTextCounts, REPORT_CITATION_FIELDS,
  REPORT_CITATION_LIMITS, REPORT_CITATION_SCHEMA, SOURCE_UNAVAILABLE } from '../report-citation';
import { applyStructureKeepList, isStructureEntry, projectStructure, structureApplyInput, structureArray,
  structureIdList, structureItemKey, structureSameTextCounts, structureUnion, StructureInputError, STRUCTURE_CATALOG,
  REPORT_STRUCTURE_LIMITS, REPORT_STRUCTURE_SCHEMA, validateCatalog } from '../report-structure';
import type { StructureTemplate } from '../report-structure';
import { draftToken } from './values';
import type { Caller, PacsAccess } from './access';

/**
 * **서명 순간에 새로 생기는 유일한 거절이다.**
 *
 * 삽입 시점의 한도 검사는 머리 판을 잠그지 않고 읽으므로 예방적일 뿐이다 — 그 뒤 머리가
 * 움직였거나 옛 탭이 유지 목록을 보내지 않았으면 확정에서 합집합이 한도를 넘을 수 있다.
 * 그때 트랜잭션을 되돌린다: 초안과 인용은 그대로 남고, 출구는 **제거**다. 그래서 문구가
 * 그 출구를 분명히 말해야 한다.
 *
 * 문구에 `저장했습니다`를 넣지 않는다. 옛 탭은 그 부분 문자열로 분기해 서버 내용을
 * 편집기에 덮어쓰는 복구 경로로 들어간다 — 쓰던 글을 잃는다(R2와 같은 규칙).
 */
export const citationLimit = () => {
  throw new ConflictException({ code: 'REPORT_CITATION_LIMIT',
    message: `인용이 한도(${REPORT_CITATION_LIMITS.entries}건 · ${REPORT_CITATION_LIMITS.bytes}바이트)를 넘습니다 — ` +
      '인용을 일부 제거한 뒤 다시 확정해 주세요' });
};

/** 마이그레이션이 두 칸에 건 이름. 이 이름이 보일 때만 우리 CHECK다. */
const CITATION_CHECKS = ['ReportDraft_citations_check', 'ReportVersion_citations_check'];

/**
 * 구조화 칸의 CHECK도 같은 백스톱이다. 이름을 따로 두는 이유는 **어느 한도를 넘었는지**
 * 사용자에게 말해야 하기 때문이다 — 구조화 항목을 지우라는 안내와 인용을 지우라는 안내는
 * 서로 할 수 있는 일이 다르다.
 */
const STRUCTURE_CHECKS = ['ReportDraft_structured_check', 'ReportVersion_structured_check'];

export const structureLimit = () => {
  throw new ConflictException({ code: 'REPORT_STRUCTURE_LIMIT',
    message: `구조화 항목이 한도(${REPORT_STRUCTURE_LIMITS.entries}건 · ${REPORT_STRUCTURE_LIMITS.bytes}바이트)를 넘습니다 — ` +
      '항목을 일부 제거한 뒤 다시 시도해 주세요' });
};

export function isStructureCheck(error: any): boolean {
  const meta: any = error?.meta ?? {};
  const text = [meta.constraint, meta.message, meta.detail, error?.message].filter(Boolean).join(' ');
  return STRUCTURE_CHECKS.some(name => text.includes(name));
}

/**
 * DB CHECK는 fail-closed 백스톱이지 서버 고장이 아니다. 500으로 내보내면 사용자는
 * "다시 해보세요" 말고 할 수 있는 게 없고, 실제로 필요한 행동(제거)을 못 듣는다.
 *
 * **좁게 본다.** 드라이버가 이 위반을 어떤 클래스로 올리는지는 실제 PostgreSQL에서만
 * 확인되므로(선례 `finding.service.ts:124`는 원시 질의의 `P2010`/`23514`를 보지만, 여기 세
 * 경로는 Prisma Client 호출이다) 코드 모양이 아니라 **우리가 지은 제약 이름**으로 가른다.
 * 이름이 없으면 우리 것이라고 단정하지 않고 그대로 올려보낸다 — 다른 DB 오류를 삼키면
 * 진짜 고장이 "인용을 제거하세요"로 위장된다.
 */
export function isCitationCheck(error: any): boolean {
  const meta: any = error?.meta ?? {};
  const text = [meta.constraint, meta.message, meta.detail, error?.message].filter(Boolean).join(' ');
  return CITATION_CHECKS.some(name => text.includes(name));
}

export class PacsReportEvidence {
  constructor(
    private readonly prisma: PrismaService,
    private readonly studyAccess: StudyAccessService,
    // 인용이 가리키는 소견의 가독은 소견 쪽 관문이 판정한다. 판독문 관문(기관·예비판독)은
    // 그보다 넓어서, 그것만으로 통과시키면 읽을 수 없는 비교 검사가 인용을 통해 새어 나온다.
    private readonly findings: FindingService,
    private readonly access: PacsAccess) {}

  /**
   * 구조화 서식 목록 (P7의 주입 이음매).
   *
   * 제품에서는 언제나 `STRUCTURE_CATALOG`이고 그것은 **비어 있다**(P6). 시험만이 자기
   * 인스턴스의 이 칸을 합성 목록으로 덮는다 — 환경변수도, 헤더도, 라우트도 아니다.
   * 제품 코드나 HTTP로 합성 항목에 닿을 방법이 없어야 지어낸 임상 내용이 새지 않는다.
   */
  private structureCatalogValue: readonly StructureTemplate[] = STRUCTURE_CATALOG;
  protected get structureCatalog(): readonly StructureTemplate[] { return this.structureCatalogValue; }
  /**
   * 목록을 갈아끼우는 **유일한 길**이고, 그 길에는 관문이 있다 (P12).
   *
   * 검사는 갈아끼우기 **전에** 한다. 규칙을 어긴 목록은 던지면서 지나가고, 그때 이미 서 있던
   * 유효한 목록은 그대로 남는다 — 잘못된 배정이 멀쩡한 목록을 치우고 그 자리를 비워두는 일은
   * 없다. 제품 인스턴스는 언제나 비어 있는 `STRUCTURE_CATALOG`으로 시작한다.
   */
  protected set structureCatalog(next: readonly StructureTemplate[]) {
    validateCatalog(next);
    this.structureCatalogValue = next;
  }

  /**
   * PUT 한 번에 들어온 인용 변경을 본문과 **같은 쓰기**로 풀어낸다.
   * `locked`는 `ownDraft`가 잠그고 경계를 대조한 내 행이다 — 두 탭의 PUT은 그 경계에서 하나만 이긴다.
   */
  async draftCitations(tx: any, uid: string, locked: any, body: any, content: any, c: Caller, headVersion: number) {
    const keep = this.citationKeys(body.citationIds, 'citationIds');
    const wantsInsert = body.insert !== undefined;
    const { kept, ignored } = applyKeepList(citationArray(locked?.citations), keep);
    let inserted: { cid: string; field: string; insertedAt: string } | null = null;
    if (wantsInsert) {
      const entry = await this.verifiedInsertion(tx, uid, body.insert, content, c);
      kept.push(entry);
      inserted = { cid: entry.cid, field: entry.field, insertedAt: entry.insertedAt };
      /**
       * 예방적 검사다. 머리 판을 **잠그지 않고** 읽으므로 두 방향 모두 틀릴 수 있다 —
       * 넘치는데 통과하거나, 여유가 있는데 거절할 수 있다. 실제 상한은 확정 시의
       * `REPORT_CITATION_LIMIT`과 DB CHECK가 잡는다. 유지 목록만 온 PUT은 줄어들기만
       * 하므로 여기 오지 않는다 — 자동 저장을 한도로 거절하지 않는다.
       */
      await this.citationBudget(tx, [...await this.versionCitations(tx, uid, headVersion), ...kept]);
    }
    const detail = (kept.length || ignored) ? { n: kept.length,
      ...(inserted ? { add: [{ cid: inserted.cid, field: inserted.field }] } : {}),
      ...(ignored ? { ignored } : {}) } : null;
    return { entries: kept, inserted, detail };
  }

  /**
   * PUT 한 번에 들어온 구조화 변경을 본문과 **같은 쓰기**로 풀어낸다. `locked`는 인용과 같은, 이미 잠근 내 행이다.
   *
   * `studyAccess.prepare(c)`를 부르지 않는다(P14). 구조화 항목은 소견 계보를 가리키지 않으므로
   * 비교 검사 정책을 준비할 이유가 없고, 준비하면 이 경로가 넓은 정책 읽기를 끌고 들어온다.
   */
  async draftStructure(tx: any, uid: string, locked: any, body: any, content: any, c: Caller, headVersion: number) {
    const keep = this.structureKeys(body.structureIds, 'structureIds');
    const wantsApply = body.structure !== undefined;
    const { kept, ignored } = applyStructureKeepList(structureArray(locked?.structured), keep);
    let applied: { sid: string; field: string; enteredAt: string } | null = null;
    if (wantsApply) {
      const input = this.structureInput(body.structure);
      const head = await this.versionStructured(tx, uid, headVersion);
      /**
       * **살아 있음의 규칙은 확정의 규칙과 같다** (P1/B3).
       *
       * 머리 건은 그 문장이 **이 요청의 본문에 있을 때만** 살아 있다. 한 번 Save한 뒤 값을
       * 고치면 머리 건의 문장은 본문을 떠나지만 행 자체는 불변이라 그대로 남는데, 그것을
       * 살아 있다고 세면 같은 항목을 **두 번째로** 고치려는 사람에게 "이미 입력한 항목입니다"를
       * 돌려주게 된다 — 고치라고 안내해놓고 고치지 못하게 하는 답이다.
       *
       * 대상 찾기(`all`)는 좁히지 않는다. `replace`는 옛 문장이 본문에 **없을 것**을 요구하므로,
       * 바꿀 머리 건은 정의상 `live`에 없기 때문이다.
       */
      const all = structureUnion(head, kept);
      const headLive = head.filter(entry => lineBlockOccurrences(
        String(content[String(entry?.field ?? '')] ?? ''), String(entry?.renderedText ?? '')) >= 1);
      let live = structureUnion(headLive, kept);
      if (input.op === 'replace') {
        /**
         * 바꿀 건은 내 초안에도, **머리 판에도** 있을 수 있다 (P3/B3).
         * 확정은 매번 초안 행을 지우므로(`:2158`) 한 번 저장한 뒤의 모든 건은 머리 건이고,
         * 머리를 못 가리키면 값을 고치는 일이 첫 저장 이후로 영영 불가능해진다.
         * 머리 행은 불변이므로 여기서 **고치지 않는다** — 그 건은 문장이 본문을 떠난 사실로
         * 확정 때 P1이 떨어뜨린다.
         */
        const target = all.find(entry => String(entry?.sid ?? '') === input.replacesSid);
        if (!target)
          throw new ConflictException({ code: 'REPORT_STRUCTURE_REPLACE',
            message: '바꿀 항목을 찾을 수 없습니다 — 화면을 다시 불러오세요' });
        if (String(target.field) !== input.field || String(target.templateId) !== input.templateId
            || String(target.itemCode) !== input.itemCode)
          throw new ConflictException({ code: 'REPORT_STRUCTURE_REPLACE',
            message: '같은 서식의 같은 항목만 바꿀 수 있습니다' });
        // 옛 문장이 아직 본문에 있으면 두 값이 동시에 적힌 판독문이 된다.
        if (lineBlockOccurrences(content[String(target.field)], String(target.renderedText ?? '')))
          throw new ConflictException({ code: 'REPORT_STRUCTURE_REPLACE',
            message: '이전 값의 문장이 아직 본문에 남아 있습니다 — 화면을 다시 불러오세요' });
        const at = kept.findIndex(entry => String(entry?.sid ?? '') === input.replacesSid);
        if (at >= 0) kept.splice(at, 1);
        live = live.filter(entry => String(entry?.sid ?? '') !== input.replacesSid);
      }
      // 같은 항목은 한 번만 산다(P3). 되풀이되는 항목(결절 여러 개)은 v1의 범위 밖이다.
      const wanted = structureItemKey({ templateId: input.templateId, itemCode: input.itemCode });
      if (live.some(entry => structureItemKey(entry) === wanted))
        throw new ConflictException({ code: 'REPORT_STRUCTURE_EXISTS',
          message: '이미 입력한 항목입니다 — 값을 바꾸려면 수정을 사용하세요' });
      /**
       * 서버가 확인하는 것은 이 글이 **이 요청의 본문에 줄 블록으로 실재하는지**뿐이다.
       * 본문을 쓰는 것은 화면이고, 서버는 화면이 넣었다고 말한 것을 대조만 한다 —
       * 인용과 같은 구조적 방어다.
       */
      if (!lineBlockOccurrences(content[input.field], input.renderedText))
        throw new ConflictException({ code: 'REPORT_STRUCTURE_TEXT',
          message: '구조화 항목의 문장이 그 칸의 본문에 줄 단위로 그대로 있지 않습니다' });
      const template = this.structureCatalog.find(t => t.templateId === input.templateId);
      const item = template?.items.find(i => i.code === input.itemCode);
      const entry = { v: REPORT_STRUCTURE_SCHEMA, sid: randomUUID(), field: input.field,
        templateId: input.templateId, templateRevision: input.templateRevision, itemCode: input.itemCode,
        valueType: input.valueType, value: input.value, unit: item?.unit ?? null,
        renderedText: input.renderedText, enteredAt: new Date().toISOString(), enteredBy: c.actor };
      kept.push(entry);
      applied = { sid: entry.sid, field: entry.field, enteredAt: entry.enteredAt };
      // 예방적 검사다. 머리 판을 잠그지 않고 읽으므로 양방향 모두 틀릴 수 있고, 실제 상한은
      // 확정 시의 검사와 DB CHECK가 잡는다. 유지 목록만 온 PUT은 줄어들기만 하므로 오지 않는다.
      await this.structureBudget(tx, [...head, ...kept]);
    }
    const detail = (kept.length || ignored) ? { n: kept.length,
      ...(applied ? { add: [applied.sid] } : {}),
      ...(ignored ? { ignored } : {}) } : null;
    return { entries: kept, applied, detail };
  }

  /** 머리 판의 구조화 증언. 인용과 같은 규칙 — 머리는 `ReportVersion(uid, Report.version)` 한 행이다. */
  async versionStructured(tx: any, uid: string, version: number) {
    if (!version) return [] as any[];
    const row = await tx.reportVersion.findUnique({
      where: { uid_version: { uid, version } }, select: { structured: true } });
    return structureArray(row?.structured);
  }

  /** 한도는 데이터베이스가 센다. CHECK와 같은 자(canonical `jsonb::text`의 UTF-8 바이트)를 쓴다. */
  async structureBudget(tx: any, entries: any[]) {
    if (entries.length > REPORT_STRUCTURE_LIMITS.entries) structureLimit();
    if (!entries.length) return;
    const [row] = await tx.$queryRaw`
      SELECT octet_length(convert_to(${canonical(entries)}::jsonb::text, 'UTF8')) AS bytes`;
    if (Number(row.bytes) > REPORT_STRUCTURE_LIMITS.bytes) structureLimit();
  }

  /** 모양이 틀린 입력만 400으로 옮긴다. 다른 실패는 그대로 올려보낸다. */
  structureKeys(value: any, what: string) {
    try { return structureIdList(value, what); }
    catch (e: any) { if (e instanceof StructureInputError) throw new BadRequestException(e.message); throw e; }
  }
  private structureInput(value: any) {
    try { return structureApplyInput(value, this.structureCatalog); }
    catch (e: any) { if (e instanceof StructureInputError) throw new BadRequestException(e.message); throw e; }
  }

  /**
   * 검사 순서가 곧 계약이다: 모양 → 같은 검사 → 소견 가독 → 소견 판·숨김 →
   * 링크 상태 재계산 → 본문에 줄 블록으로 실재.
   *
   * 증언 값은 전부 **여기서 서버가** 쓴다 — `cid`(난수), 사람, 시각, 링크 상태, 머리 판.
   * 클라이언트가 보낸 같은 이름의 칸은 `citationInsertInput`이 읽지 않아 그대로 사라진다.
   */
  private async verifiedInsertion(tx: any, uid: string, raw: any, content: any, c: Caller) {
    const insert = this.citationInput(raw);
    // `Finding.studyUid === uid`는 이 메서드가 uid로 묻는 것 자체가 보장한다 —
    // 다른 검사의 소견은 애초에 답에 들어오지 않는다.
    const [row] = await this.findings.readableFindings(tx, c, uid, [insert.findingId]);
    // 읽을 수 없는 소견과 없는 소견은 **같은 답**이다. 어느 쪽인지 말하면 그 자체가 정보다.
    if (!row) throw new ConflictException({ code: 'REPORT_CITATION_SOURCE',
      message: '그 소견을 인용할 수 없습니다 — 소견 목록을 다시 불러오세요' });
    if (row.revision !== insert.findingRevision || row.hidden)
      throw new ConflictException({ code: 'REPORT_CITATION_STALE',
        message: '소견이 그 사이 바뀌었습니다 — 소견 패널을 다시 불러온 뒤 인용하세요' });
    const source = citationArray(row.sources)[insert.sourceIndex];
    const link = citationArray(row.links)[insert.sourceIndex];
    if (!source || !link) throw new ConflictException({ code: 'REPORT_CITATION_SOURCE',
      message: '그 출처를 찾을 수 없습니다 — 소견 목록을 다시 불러오세요' });
    // 판정은 핀이 아니라 **삽입 시점에 서버가 다시 계산한** 링크 상태로 한다.
    if (link.linkState === 'hidden' || link.linkState === 'missing')
      throw new ConflictException({ code: 'REPORT_CITATION_SOURCE',
        message: '숨겨졌거나 사라진 출처는 인용할 수 없습니다' });
    if (link.linkState !== insert.expectedLinkState || (link.headRevision ?? null) !== insert.expectedHeadRevision)
      throw new ConflictException({ code: 'REPORT_CITATION_STALE',
        message: '출처 상태가 그 사이 바뀌었습니다 — 확인한 뒤 다시 인용하세요' });
    /**
     * 서버가 확인하는 것은 이 글이 **이 요청의 본문에 줄 블록으로 실재하는지**뿐이다.
     * `insertedText`는 출처의 사본이 아니라 작성자가 자기 판독문에 넣은 글 그 자체이며,
     * 그것이 출처를 재현한다고는 어떤 표면도 말하지 않는다.
     */
    if (blockIsBlank(insert.insertedText) || !lineBlockOccurrences(content[insert.field], insert.insertedText))
      throw new ConflictException({ code: 'REPORT_CITATION_TEXT',
        message: '삽입한 문구가 그 칸의 본문에 줄 단위로 그대로 있지 않습니다' });
    return { v: REPORT_CITATION_SCHEMA, cid: randomUUID(), field: insert.field,
      findingId: insert.findingId, findingRevision: insert.findingRevision, sourceIndex: insert.sourceIndex,
      sourceRef: citationSourceRef(source), linkStateAtInsert: link.linkState,
      headRevisionAtInsert: link.headRevision ?? null, insertedText: insert.insertedText,
      insertedAt: new Date().toISOString(), insertedBy: c.actor };
  }

  /** 머리 판은 오직 `ReportVersion(uid, Report.version)` 한 행이다. 없으면 빈 배열이다. */
  async versionCitations(tx: any, uid: string, version: number) {
    if (!version) return [] as any[];
    const row = await tx.reportVersion.findUnique({
      where: { uid_version: { uid, version } }, select: { citations: true } });
    return citationArray(row?.citations);
  }

  /**
   * 한도는 **데이터베이스가 센다.** canonical `jsonb::text`의 UTF-8 바이트가 CHECK와 같은
   * 자이며, JS의 더 짧은 직렬화로 재면 서버가 통과시킨 것을 CHECK가 거절해 500이 된다.
   * 선례는 소견 스냅샷의 같은 측정이다(`finding.service.ts`).
   */
  async citationBudget(tx: any, entries: any[]) {
    if (entries.length > REPORT_CITATION_LIMITS.entries) citationLimit();
    if (!entries.length) return;
    const [row] = await tx.$queryRaw`
      SELECT octet_length(convert_to(${canonical(entries)}::jsonb::text, 'UTF8')) AS bytes`;
    if (Number(row.bytes) > REPORT_CITATION_LIMITS.bytes) citationLimit();
  }

  /** 모양이 틀린 입력만 400으로 옮긴다. 다른 실패는 그대로 올려보낸다. */
  citationKeys(value: any, what: string) {
    try { return citationIdList(value, what); }
    catch (e: any) { if (e instanceof CitationInputError) throw new BadRequestException(e.message); throw e; }
  }
  private citationInput(value: any) {
    try { return citationInsertInput(value); }
    catch (e: any) { if (e instanceof CitationInputError) throw new BadRequestException(e.message); throw e; }
  }

  /**
   * DB CHECK를 **이름으로** 알아보고 같은 409로 옮긴다. 우리 제약이 아니면 손대지 않는다 —
   * 다른 데이터베이스 오류를 삼키면 진짜 고장이 "인용을 제거하세요"로 위장된다.
   */
  async reportLimitChecked<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error: any) {
      if (isCitationCheck(error)) citationLimit();
      if (isStructureCheck(error)) structureLimit();
      throw error;
    }
  }

  /** 판독문 이력 (최신순) */
  async versions(uid: string, c: Caller) {
    const prev = await this.access.gate(uid, c);
    /**
     * 행이 없는 uid는 없는 검사다. gate()는 "안 보이는 검사"만 404로 바꾸고 "없는 검사"는 null로
     * 흘려보내는데, 그러면 삭제된 검사에 남은 discarded 이력이 **모든 기관**에 읽혔다(v0.6.3 회귀 확충에서
     * 발견). 이력의 조회 관문은 StudyState 행이다 — 행이 없으면 기관을 가를 수 없고, 가를 수 없으면 거절한다.
     */
    if (!prev) throw new NotFoundException('검사를 찾을 수 없습니다');
    // 본문을 가려놓고 이력에서 읽히면 가린 게 아니다. 같은 규칙을 여기에도 건다.
    if (!canReadPreliminary(prev, c))
      throw new ForbiddenException(
        `예비 판독(RS: P) 중입니다. ${prev?.preReviewer ?? '지정된 판독의'}만 볼 수 있습니다.`);
    /**
     * 칸을 **명시해서** 고른다. 행 전체를 돌려주면 새로 생긴 인용 칸이 이력 응답으로
     * 그대로 나간다 — 관문을 하나도 새로 만들지 않았는데 노출면만 넓어지는 것이다.
     * 인용은 전용 읽기 하나에서만, 소견 가독을 다시 건 뒤에 나간다.
     */
    return this.prisma.reportVersion.findMany({ where: { uid }, orderBy: { version: 'desc' },
      select: { id: true, uid: true, version: true, action: true, findings: true, conclusion: true,
        recommendation: true, reason: true, author: true, at: true } });
  }

  /**
   * 인용 전용 읽기 — **소견 가독을 다시 거는 유일한 표면**이다.
   *
   * 판독문 관문(기관·예비 판독)은 소견 관문보다 넓다. 소견은 계보에 읽을 수 없는 검사가
   * 하나라도 있으면 목록·이력·재생에서 통째로 빠지는데, 인용을 판독문 관문만으로 내보내면
   * 그 좁은 관문이 이 통로로 우회된다. 그래서 여기서 한 번 더 건다.
   *
   * 한 `RepeatableRead` 트랜잭션 안에서 머리 판과 내 초안을 함께 읽는다 — 두 번 읽으면
   * 그 사이 확정이 끼어들어 "머리에는 없고 초안에는 있는" 없는 상태를 그릴 수 있다.
   */
  async reportCitations(uid: string, c: Caller) {
    const prev = await this.access.gate(uid, c);
    if (!prev) throw new NotFoundException('검사를 찾을 수 없습니다');
    // 본문을 가려놓고 그 증언이 읽히면 가린 게 아니다. `versions()`와 같은 규칙을 건다.
    if (!canReadPreliminary(prev, c))
      throw new ForbiddenException(
        `예비 판독(RS: P) 중입니다. ${prev?.preReviewer ?? '지정된 판독의'}만 볼 수 있습니다.`);
    // 소견 계보의 접근 정책은 트랜잭션 밖에서 준비한다(`putReport`와 같은 이유).
    await this.studyAccess.prepare(c);
    return this.prisma.$transaction(async tx => {
      await this.studyAccess.require(c,[uid],tx);
      const report = await tx.report.findUnique({ where: { uid }, select: { version: true } });
      const head = await this.versionCitations(tx, uid, report?.version ?? 0);
      const draft = await tx.reportDraft.findUnique({
        where: { uid_author: { uid, author: c.actor } }, select: { citations: true, revision: true, present: true } });
      // 같은 스냅숏의 세대 — 이 목록이 어느 경계의 것인지 화면이 알아야 유지 목록을 그 경계에 묶어 보낼 수 있다.
      const epoch = await tx.studyState.findUnique({ where: { uid }, select: { draftEpoch: true } });
      if (!epoch) throw new NotFoundException('검사를 찾을 수 없습니다');
      const mine = citationArray(draft?.present ? draft.citations : null);
      /**
       * **행마다 따로 묻는다.** 한 행은 CHECK가 64건으로 묶지만 머리 + 초안은 128건까지 갈 수
       * 있고, 바로 그 상태(머리 40 + 초안 30)가 확정이 `REPORT_CITATION_LIMIT`으로 거절하는
       * 경우다. 한 번에 물으면 그 질의가 64 한도에 먼저 걸려 409가 되고, **어떤 `cid`를 지워야
       * 하는지 알려주는 유일한 표면**이 닫힌다 — "제거하면 서명할 수 있다"고 말해놓고 제거할
       * 대상을 못 보여주는 셈이다.
       */
      const findingIds = (entries: any[]) =>
        [...new Set(entries.map(entry => String(entry?.findingId ?? '')).filter(Boolean))];
      const readable = new Set<string>();
      for (const ids of [findingIds(head), findingIds(mine)])
        for (const row of await this.findings.readableFindings(tx, c, uid, ids)) readable.add(String(row.id));
      /**
       * `sameTextCount`는 **그 행 전체**(축약된 건 포함)에서 센다. 화면이 자기가 받은
       * 건수로 세면 축약된 건이 빠져, `ambiguous`여야 할 것이 `present`로 보인다.
       * 머리 판과 초안은 서로 다른 본문을 가진 다른 행이므로 따로 센다.
       */
      const project = (entries: any[]) => {
        const counts = sameTextCounts(entries);
        return entries.map((entry, i) => projectCitation(entry, readable.has(String(entry?.findingId ?? '')), counts[i]));
      };
      return { version: report?.version ?? 0, head: project(head), draft: project(mine),
        draftRevision: draftToken(epoch.draftEpoch, draft?.revision ?? 0) };
    }, { isolationLevel: 'RepeatableRead', maxWait: 2000, timeout: 5000 });
  }

  /**
   * 구조화 전용 읽기 — 머리 판과 내 초안의 타입 있는 값.
   *
   * 관문은 `versions()`와 **같은 것**이다(기관 + 예비 판독). 인용 읽기가 소견 가독을 한 번 더
   * 거는 이유는 인용이 소견 계보를 가리키기 때문인데, 구조화 건은 자기 문장 말고 아무것도
   * 가리키지 않는다. 그래서 그 좁은 관문을 여기에 옮겨 붙이지 않고(가짜 안전), 인용 읽기의
   * 의미를 넓히지도 않는다. 나가는 내용은 이미 `versions()`가 내보내는 본문의 부분집합이다.
   *
   * 확정은 매번 초안 행을 지우므로(`:2353`) 한 번 저장한 뒤의 값은 전부 머리 판에 있다.
   * 그래서 이 읽기가 없으면 Save 한 번에 화면의 구조화 상태가 통째로 사라진다.
   *
   * 한 `RepeatableRead` 트랜잭션 안에서 머리와 초안을 함께 읽는다 — 두 번 읽으면 그 사이
   * 확정이 끼어들어 "머리에는 없고 초안에는 있는" 없는 상태를 그릴 수 있다.
   */
  async reportStructure(uid: string, c: Caller) {
    const prev = await this.access.gate(uid, c);
    if (!prev) throw new NotFoundException('검사를 찾을 수 없습니다');
    if (!canReadPreliminary(prev, c))
      throw new ForbiddenException(
        `예비 판독(RS: P) 중입니다. ${prev?.preReviewer ?? '지정된 판독의'}만 볼 수 있습니다.`);
    return this.prisma.$transaction(async tx => {
      const report = await tx.report.findUnique({ where: { uid },
        select: { version: true, findings: true, conclusion: true, recommendation: true } });
      const head = await this.versionStructured(tx, uid, report?.version ?? 0);
      const stored = await tx.reportDraft.findUnique({
        where: { uid_author: { uid, author: c.actor } },
        select: { findings: true, conclusion: true, recommendation: true, structured: true, revision: true, present: true } });
      const epoch = await tx.studyState.findUnique({ where: { uid }, select: { draftEpoch: true } });
      if (!epoch) throw new NotFoundException('검사를 찾을 수 없습니다');
      const draftRevision = draftToken(epoch.draftEpoch, stored?.revision ?? 0);
      // 비운 자리(present=false)는 초안이 아니다 — 구조화 건도 본문도 없다.
      const draftRow = stored?.present ? stored : null;
      const mine = structureArray(draftRow?.structured);
      /**
       * 한 건이라도 모양이 틀리면 **답 전체가 모른다**가 된다. 틀린 건만 빼고 나머지를
       * 정상처럼 돌려주면, 화면은 자기가 본 것이 전부라고 믿고 유지 목록을 만들어 보낸다 —
       * 그 순간 읽지 못한 건이 조용히 지워진다.
       */
      if (!head.every(isStructureEntry) || !mine.every(isStructureEntry))
        return { version: report?.version ?? 0, unknown: true, head: null, draft: null, draftRevision };
      const project = (entries: any[], body: any) => {
        const counts = structureSameTextCounts(entries);
        return entries.map((entry, i) =>
          projectStructure(entry, String(body?.[String(entry.field)] ?? ''), counts[i]));
      };
      return { version: report?.version ?? 0, unknown: false,
        head: project(head, report), draft: project(mine, draftRow), draftRevision };
    }, { isolationLevel: 'RepeatableRead', maxWait: 2000, timeout: 5000 });
  }

  /**
   * 과거 판의 인용 — **보존된 한 행**의 증언.
   *
   * 머리 읽기(위)는 지금 열려 있는 판독문의 것이고, 이력에 쌓인 판의 증언은 `versions()`가
   * 칸을 명시해 빼고 있어 **어떤 표면도 읽지 않았다.** 그 행은 확정과 같은 트랜잭션에서 쓰이고
   * 다시 바뀌지 않으므로 본문과 증언이 어긋날 수 없다.
   *
   * 나가는 것은 **메타데이터뿐**이다. 머리 읽기가 `insertedText`·`cid`를 싣는 이유는 편집 화면이
   * 제거를 고르고 **살아 있는** 본문과 대조해야 하기 때문인데, 과거 판에는 지울 것도 바뀔 본문도
   * 없다. 그래서 존재 상태는 **여기서, 그 행 자신의 본문에 대해** 계산해 한 낱말로 보내고 문구와
   * 식별자는 서버를 떠나지 않는다. 화면이 본문을 갖지 않으므로 **틀린 본문으로 셀 방법이 없다.**
   */
  async reportVersionCitations(uid: string, version: string, c: Caller) {
    /**
     * 표준 십진 · `Int` 범위만 받는다. 어떤 DB 읽기보다 **먼저** 거절한다 — `prepare()`도
     * 정책 읽기다. 관용 변환(`Number()`)을 쓰면 `'1e2'`·`'0x10'`·`' 1'`·`'01'`·`'+1'`이 실제
     * 판의 별칭이 되고, 2^31 이상은 `Int` 컬럼에 닿아 400도 404도 아닌 실패가 된다.
     */
    if (!/^[1-9][0-9]{0,9}$/.test(version) || Number(version) > 2147483647)
      throw new BadRequestException('판 번호를 확인하세요');
    const want = Number(version);
    /**
     * uid 목록 **없이** 준비한다. 이 메서드에는 트랜잭션 밖 `gate()`가 없어 밖에서 도는
     * `require`도 없으므로, 아래 트랜잭션 안의 재검사는 이 호출이 채운 캐시에만 기댈 수 있다.
     */
    await this.studyAccess.prepare(c);
    return this.prisma.$transaction(async tx => {
      /**
       * 관문과 판 읽기가 **한 스냅샷** 안에 있다. 밖에서 읽으면 그 사이에 예비 판독이 끼어들어
       * RS=P가 된 판을 그 관문을 거치지 않은 채 답할 수 있다.
       */
      const prev = await this.access.gate(uid, c, tx);
      if (!prev) throw new NotFoundException('검사를 찾을 수 없습니다');
      if (!canReadPreliminary(prev, c))
        throw new ForbiddenException(
          `예비 판독(RS: P) 중입니다. ${prev?.preReviewer ?? '지정된 판독의'}만 볼 수 있습니다.`);
      const row = await tx.reportVersion.findUnique({
        where: { uid_version: { uid, version: want } },
        // 네 칸뿐이다. `action`·`author`·`at`·`reason`은 이력 응답의 것이고, 여기서 다시 나가면
        // 관문을 하나도 새로 만들지 않은 채 노출면만 넓어진다.
        select: { citations: true, findings: true, conclusion: true, recommendation: true },
      });
      // 없는 판을 「인용 없음」으로 답하면 그 자체가 거짓말이다.
      if (!row) throw new NotFoundException('그 판을 찾을 수 없습니다');
      const entries = citationArray(row.citations);
      // `n`은 **행 전체**에서 센다. 축약된 건이 빠지면 `ambiguous`여야 할 것이 `present`가 된다.
      const counts = sameTextCounts(entries);
      const ids = [...new Set(entries.map(entry => String(entry?.findingId ?? '')).filter(Boolean))];
      const readable = new Set<string>();
      for (const found of await this.findings.readableFindings(tx, c, uid, ids)) readable.add(String(found.id));
      return { version: want, actor: c.actor, entries: entries.map((entry, index) => {
        if (!readable.has(String(entry?.findingId ?? '')))
          return { field: entry?.field ?? null, insertedAt: entry?.insertedAt ?? null,
            insertedBy: entry?.insertedBy ?? null, state: SOURCE_UNAVAILABLE };
        /**
         * 셀 수 없는 건은 **모른다고 말한다.** `lineBlockOccurrences`는 문자열이 아닌 값을
         * `''`로 바꾸므로 그대로 세면 0회 → `absent`가 되어, 확인하지 못한 것을 「더는
         * 없습니다」로 지어내게 된다. 화면은 이 `null`을 보고 그 판 전체를 미확인으로 만든다.
         */
        const countable = REPORT_CITATION_FIELDS.includes(entry?.field)
          && typeof entry?.insertedText === 'string';
        return { field: entry?.field ?? null, findingRevision: entry?.findingRevision ?? null,
          sourceIndex: entry?.sourceIndex ?? null, linkStateAtInsert: entry?.linkStateAtInsert ?? null,
          insertedAt: entry?.insertedAt ?? null, insertedBy: entry?.insertedBy ?? null,
          presence: countable
            ? presenceState(lineBlockOccurrences(String((row as any)[entry.field] ?? ''), entry.insertedText), counts[index])
            : null };
      }) };
    }, { isolationLevel: 'RepeatableRead', maxWait: 2000, timeout: 5000 });
  }
}

/*
 * 관리자 운영 지표(S5-U6b). 순수 계산(adminMetricRows)과 원천 읽기, 관측 시계·대기 상한(이 객체 하나의 상태).
 * PacsService가 만들어 소유하는 평범한 객체다(Nest provider가 아니다). 생성자는 참조만 저장한다.
 */
import type { StudyAccessService } from '../study-access.service';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../prisma.service';
import type { OrthancService } from '../orthanc.service';
import { need, inst } from './access';
import type { Caller, PacsAccess } from './access';

/**
 * ── S5-U6b 관리자 운영 지표 (REQ-S5-U6b-OPS-METRICS → RISK-S5-U6b-UNKNOWN-AS-ZERO/INVENTED-THRESHOLD/TENANT-AGGREGATE) ──
 *
 * 한 줄은 값과 함께 **출처·관측 시각·단위·분모·범위**를 싣는다. 값을 모르면 `value: null`이고 `state`가 이유를
 * 말한다 — 0은 원천이 실제로 0을 말했을 때만 나간다. 수집 실패가 0으로 보이면 관리자는 "비어 있다"와 "모른다"를
 * 가를 수 없다(main.html `#storage`의 기본값 '0.0GB / -'가 그 반례다).
 *  observed      원천이 답했고 값이 있다
 *  empty         원천은 답했지만 대상이 0건이라 중앙값·최댓값이 없다 — 0분이 아니다
 *  unobservable  원천이 실패했거나(source_failed·invalid_answer·timeout) 제품에 원천이 없다(no_source)
 * 임계값·정상/이상 판정은 싣지 않는다. 출처 있는 사이트 설정이 없다(C-7 — 목업의 30/240분은 원천이 아니다).
 * 대기·TAT의 입력은 사람이 입력한 Emergency 표시(em)와 서버 시각뿐이고, 영상·판독 본문·외부 결과는 읽지 않는다
 * (UXR-S5-17). 서버 전체 값은 Orthanc 저장량 하나뿐이고(D11), 기관별 저장량은 원천이 없어 늘 관측 불가다.
 */
export const ADMIN_METRIC_KEYS = Object.freeze([
  'storage.server', 'storage.institution', 'studies.own', 'studies.tele', 'studies.flag_unreadable',
  'studies.registered_24h', 'studies.registered_7d', 'tat.emergency', 'tat.normal', 'waiting.emergency', 'waiting.normal',
]);
export const ADMIN_METRIC_DAY_MS = 24 * 3600 * 1000;
export const ADMIN_METRIC_WEEK_MS = 7 * ADMIN_METRIC_DAY_MS;
/** 승인 전 상태. 그 밖의 값(A가 아닌 모르는 값)은 대기로 세지 않고 제외 건수에 넣는다. */
const ADMIN_METRIC_WAITING_RS = ['W', 'T', 'P', 'H'];

export type AdminMetricFailure = 'source_failed' | 'invalid_answer' | 'timeout';
export interface AdminMetricStorage { bytes?: number; observedAt?: string; failure?: AdminMetricFailure }
export interface AdminMetricStudies { observedAt: string; states: any[]; firstApproved: Map<string, unknown> }

/** Orthanc `/statistics`의 TotalDiskSize(바이트, 문자열). 음수·소수·지수·안전 정수 밖은 모름이다. */
export function orthancDiskBytes(answer: unknown): number | null {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return null;
  const raw = (answer as any).TotalDiskSize;
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

const metricTime = (value: unknown): number | null => {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

/** 중앙값(짝수 건이면 가운데 두 값의 평균을 내림)과 최댓값, 초 단위 정수. 0건이면 둘 다 없음이다. */
function metricDurations(seconds: number[]) {
  if (!seconds.length) return { value: null, max: null };
  const sorted = [...seconds].sort((a, b) => a - b), mid = sorted.length >> 1;
  const value = sorted.length % 2 ? sorted[mid] : Math.floor((sorted[mid - 1] + sorted[mid]) / 2);
  return { value, max: sorted[sorted.length - 1] };
}

/**
 * 입력 사실에서 지표 줄을 만든다(순수). `studies`가 null이면 DB 읽기가 실패한 것이고 DB 줄은 전부 관측 불가다.
 * 행 거르기는 `visible()`과 같은 경계다 — 소유 기관이거나 원격판독으로 받은 기관. 호출측이 이미 걸렀어도 여기서
 * 한 번 더 걸러, 다른 기관 행이 섞여 들어와도 어느 합계에도 들어가지 않게 한다.
 */
export function adminMetricRows(institution: string, storage: AdminMetricStorage, studies: AdminMetricStudies | null) {
  const row = (key: string, scope: 'server' | 'institution', unit: 'byte' | 'study' | 'second', rest: any) => ({
    key, state: 'observed', reason: null, scope, source: null, observedAt: null, unit, value: null, max: null,
    denominator: null, excluded: null, window: null, ...rest });
  const rows: any[] = [];
  const disk = storage.failure === undefined && Number.isSafeInteger(storage.bytes) && (storage.bytes as number) >= 0
    && metricTime(storage.observedAt) !== null;
  // 분모(전체 용량)는 제품 어디에도 원천이 없다. 그래서 사용률(%)도 만들지 않는다.
  rows.push(row('storage.server', 'server', 'byte', disk
    ? { source: 'Orthanc GET /statistics TotalDiskSize', observedAt: storage.observedAt, value: storage.bytes,
        denominator: { unit: 'byte', value: null } }
    : { state: 'unobservable', reason: storage.failure ?? 'invalid_answer', source: 'Orthanc GET /statistics TotalDiskSize',
        denominator: { unit: 'byte', value: null } }));
  rows.push(row('storage.institution', 'institution', 'byte',
    { state: 'unobservable', reason: 'no_source', denominator: { unit: 'byte', value: null } }));

  const now = studies ? metricTime(studies.observedAt) : null;
  const sources: Record<string, string> = {
    studies: 'KIN DB StudyState', registered: 'KIN DB StudyState.createdAt',
    tat: 'KIN DB StudyState.createdAt, ReportVersion(action=approve).at, StudyState.em',
    waiting: 'KIN DB StudyState.createdAt, StudyState.rs, StudyState.em',
  };
  const durationKeys = ['tat.emergency', 'tat.normal', 'waiting.emergency', 'waiting.normal'];
  if (!studies || now === null) {
    for (const key of ADMIN_METRIC_KEYS.slice(2)) {
      const family = key.startsWith('tat.') ? 'tat' : key.startsWith('waiting.') ? 'waiting'
        : key.startsWith('studies.registered') ? 'registered' : 'studies';
      rows.push(row(key, 'institution', durationKeys.includes(key) ? 'second' : 'study', {
        state: 'unobservable', reason: 'source_failed', source: sources[family],
        denominator: durationKeys.includes(key) ? { unit: 'study', value: null } : null }));
    }
    return rows;
  }

  const observedAt = new Date(now).toISOString();
  const windowOf = (span: number) => ({ from: new Date(now - span).toISOString(), to: observedAt });
  const scoped = (Array.isArray(studies.states) ? studies.states : [])
    .filter(s => s && (s.institutionId === institution || s.teleInstitutionId === institution));
  const own = scoped.filter(s => s.institutionId === institution).length;
  const flagged = (em: unknown) => em === 'E' ? 'emergency' : em === 'N' ? 'normal' : null;
  const counts = (span: number) => {
    let value = 0, excluded = 0;
    for (const s of scoped) {
      const at = metricTime(s.createdAt);
      if (at === null) excluded++;
      else if (at >= now - span && at <= now) value++;
    }
    return { value, excluded };
  };
  const day = counts(ADMIN_METRIC_DAY_MS), week = counts(ADMIN_METRIC_WEEK_MS);
  rows.push(row('studies.own', 'institution', 'study', { source: sources.studies, observedAt, value: own }));
  rows.push(row('studies.tele', 'institution', 'study', { source: sources.studies, observedAt, value: scoped.length - own }));
  rows.push(row('studies.flag_unreadable', 'institution', 'study',
    { source: sources.studies, observedAt, value: scoped.filter(s => flagged(s.em) === null).length }));
  rows.push(row('studies.registered_24h', 'institution', 'study',
    { source: sources.registered, observedAt, value: day.value, excluded: day.excluded, window: windowOf(ADMIN_METRIC_DAY_MS) }));
  rows.push(row('studies.registered_7d', 'institution', 'study',
    { source: sources.registered, observedAt, value: week.value, excluded: week.excluded, window: windowOf(ADMIN_METRIC_WEEK_MS) }));

  // TAT: 첫 승인 판(ReportVersion approve의 가장 이른 at)이 최근 7일 안인 검사, KIN 등록(createdAt)부터 그 시각까지.
  // 대기: 지금 승인 전(RS W·T·P·H)인 검사, KIN 등록부터 지금까지. 시각 순서가 맞지 않거나 읽을 수 없으면 제외로 센다.
  const from = now - ADMIN_METRIC_WEEK_MS;
  const groups: Record<string, { tat: number[]; tatExcluded: number; waiting: number[]; waitingExcluded: number }> = {
    emergency: { tat: [], tatExcluded: 0, waiting: [], waitingExcluded: 0 },
    normal: { tat: [], tatExcluded: 0, waiting: [], waitingExcluded: 0 },
  };
  for (const s of scoped) {
    const group = flagged(s.em);
    if (group === null) continue;
    const start = metricTime(s.createdAt), g = groups[group];
    const approved = studies.firstApproved instanceof Map ? metricTime(studies.firstApproved.get(s.uid)) : null;
    if (approved !== null && approved >= from && approved <= now) {
      if (start === null || approved < start) g.tatExcluded++;
      else g.tat.push(Math.floor((approved - start) / 1000));
    }
    if (s.rs === 'A') continue;
    if (!ADMIN_METRIC_WAITING_RS.includes(s.rs) || start === null || start > now) g.waitingExcluded++;
    else g.waiting.push(Math.floor((now - start) / 1000));
  }
  for (const family of ['tat', 'waiting'] as const) {
    for (const group of ['emergency', 'normal']) {
      const seconds = groups[group][family], stats = metricDurations(seconds);
      rows.push(row(`${family}.${group}`, 'institution', 'second', {
        state: seconds.length ? 'observed' : 'empty', source: sources[family], observedAt,
        value: stats.value, max: stats.max, denominator: { unit: 'study', value: seconds.length },
        excluded: groups[group][family === 'tat' ? 'tatExcluded' : 'waitingExcluded'],
        window: family === 'tat' ? windowOf(ADMIN_METRIC_WEEK_MS) : null }));
    }
  }
  return rows;
}

export class PacsMetrics {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orthanc: OrthancService,
    private readonly studyAccess: StudyAccessService,
    private readonly access: PacsAccess) {}

  /** 운영 지표 원천 한 곳의 대기 상한. 느린 Orthanc가 DB 지표까지 붙잡지 않게 한다(시험은 인스턴스 값을 줄인다). */
  protected metricsTimeoutMs = 5000;
  /** 운영 지표의 관측 시각·기간 기준 시계. 제품은 서버 시계이고, 시험만 인스턴스 값을 고정해 기간 경계를 재현한다. */
  protected metricsClock = () => Date.now();

  /**
   * S5-U6b 관리자 운영 지표(`GET /api/admin/metrics`). 줄의 모양과 규칙은 `adminMetricRows`에 있다.
   *
   * 기관 범위는 서버가 정한다: DB 읽기(범위 재확인 포함)가 모두 `institutionId = me OR teleInstitutionId = me`로 걸리고
   * (워크리스트와 같은 visible 경계), 원천 행은 응답에 나가지 않고 합계만 나간다. Orthanc `/statistics`에서는
   * TotalDiskSize 하나만 읽는다 — 같은 답에 있는 서버 전체 검사·영상 수는 다른 기관 검사를 세는 값이라 싣지 않는다.
   */
  async adminMetrics(c: Caller) {
    need(c.roles, 'admin', '운영 지표 조회');
    const me = inst(c);
    const access = await this.studyAccess.snapshot(c);
    // 검사 접근이 제한된 계정에게 기관·서버 합계는 범위 밖 검사를 세어 주는 창이다(`/statistics`를 닫은 S5-U1b
    // COUNT-LEAK와 같은 이유). 제한 범위만 다시 센 값을 기관 지표라고 부를 수도 없으므로 주지 않는다.
    if (access.policy.restricted)
      throw new ForbiddenException({ code: 'ADMIN_METRICS_RESTRICTED',
        message: '검사 접근 범위가 제한된 계정은 기관 운영 지표를 볼 수 없습니다' });
    const [storage, read] = await Promise.all([this.metricsStorage(), this.metricsStudies(me)]);
    // 기관 범위 재확인은 모든 원천이 답한 뒤(Orthanc 대기 포함)에 한다. 범위가 바뀐 것은 원천 실패가 아니므로
    // metricsStudies의 catch 밖에서 409로 던진다 — 관측 불가 줄로 바꿔 내보내지 않는다.
    const studies = read && await this.metricsScopeHeld(me, read);
    const metrics = adminMetricRows(me, storage, studies);
    // AdminController는 정책 관리 통로를 지키려고 응답 뒤 재확인 interceptor를 건너뛴다. 그 확인을 여기서 한다 —
    // 읽는 동안 접근 조건이 바뀌었으면 그 전 조건으로 센 합계를 내보내지 않는다.
    await this.studyAccess.unchanged(c, access);
    return { institutionId: me, generatedAt: new Date(this.metricsClock()).toISOString(), metrics };
  }

  /**
   * Orthanc 서버 전체 저장량(D11). OrthancService의 인증된 `get`을 그대로 쓴다 — 자격증명 처리를 한 곳에 두려는
   * 것이고, 이 단위의 쓰기 범위에 orthanc.service.ts가 없어 공개 메서드를 새로 두지 못했다(후속에서 옮길 자리).
   * 실패 문구(원천 주소가 섞일 수 있다)는 응답에 싣지 않고 이유 코드만 남긴다.
   */
  private async metricsStorage(): Promise<AdminMetricStorage> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), this.metricsTimeoutMs); });
    try {
      const answer = await Promise.race([this.orthanc['get']('/statistics'), late]);
      if (answer === 'timeout') return { failure: 'timeout' };
      const bytes = orthancDiskBytes(answer);
      return bytes === null ? { failure: 'invalid_answer' } : { bytes, observedAt: new Date(this.metricsClock()).toISOString() };
    } catch {
      return { failure: 'source_failed' };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 기관 범위 DB 사실. 실패는 null(관측 불가)이며 0건으로 바꾸지 않는다. */
  private async metricsStudies(me: string): Promise<AdminMetricStudies | null> {
    try {
      const states = await this.prisma.studyState.findMany({
        where: { OR: [{ institutionId: me }, { teleInstitutionId: me }] },
        select: { uid: true, institutionId: true, teleInstitutionId: true, rs: true, em: true, createdAt: true },
      });
      // 첫 승인 시각은 전체 이력에서 고른다. 기간으로 먼저 거르면 오래전에 승인되고 최근 다시 승인된 검사가
      // 이번 주의 첫 승인처럼 보인다. IN 목록 대신 JOIN으로 기관을 걸어 매개변수 개수 한도에 닿지 않는다.
      const approvals = await this.prisma.$queryRaw<{ uid: string; firstApprovedAt: Date }[]>`
        SELECT v.uid, MIN(v.at) AS "firstApprovedAt"
        FROM "ReportVersion" v JOIN "StudyState" s ON s.uid = v.uid
        WHERE v.action = 'approve' AND (s."institutionId" = ${me} OR s."teleInstitutionId" = ${me})
        GROUP BY v.uid`;
      return { observedAt: new Date(this.metricsClock()).toISOString(), states: states.filter(s => this.access.visible(s, me)),
        firstApproved: new Map(approvals.map(a => [a.uid, a.firstApprovedAt])) };
    } catch (e: any) {
      console.warn(`[KIN API] 운영 지표 DB 읽기 실패: ${e?.code ?? e?.name ?? 'unknown'}`);
      return null;
    }
  }

  /**
   * 집계에 쓴 검사가 아직 같은 기관 범위에 있는가(S5-U6b-F01). `studyAccess.unchanged`는 계정의 접근 정책만 비교하므로,
   * 읽는 동안 원격판독 의뢰가 취소되어(teleInstitutionId → null) 통로가 닫힌 검사를 보지 못한다. 그래서 첫 읽기와 같은
   * 조건으로 한 번 더 읽어, 쓴 검사마다 institutionId·teleInstitutionId가 그대로인지 본다(워크리스트의 응답 전 재확인과
   * 같은 두 칸). IN 목록 대신 같은 기관 조건을 다시 걸어 매개변수 개수 한도에 닿지 않는다. 빠지거나 바뀐 검사가 하나라도
   * 있으면 합계 전체를 409로 거절한다. 읽는 동안 새로 범위에 들어온 검사는 거절 사유가 아니다 — 합계에 들어가지 않았으니
   * 범위 밖을 센 것이 없다. 재확인 읽기가 실패하면 범위를 확인하지 못한 것이므로 DB 줄 전부를 관측 불가(null)로 돌린다.
   */
  private async metricsScopeHeld(me: string, read: AdminMetricStudies): Promise<AdminMetricStudies | null> {
    let current: { uid: string; institutionId: string | null; teleInstitutionId: string | null }[];
    try {
      current = await this.prisma.studyState.findMany({
        where: { OR: [{ institutionId: me }, { teleInstitutionId: me }] },
        select: { uid: true, institutionId: true, teleInstitutionId: true },
      });
    } catch (e: any) {
      console.warn(`[KIN API] 운영 지표 범위 재확인 실패: ${e?.code ?? e?.name ?? 'unknown'}`);
      return null;
    }
    const held = new Map(current.map(s => [s.uid, s]));
    if (read.states.some(s => {
      const now = held.get(s.uid);
      return !now || now.institutionId !== s.institutionId || now.teleInstitutionId !== s.teleInstitutionId;
    })) throw new ConflictException({ code: 'STUDY_LIST_CHANGED', message: '집계하는 동안 검사의 기관 범위(원격판독 포함)가 바뀌었습니다. 다시 조회하세요.' });
    return read;
  }
}

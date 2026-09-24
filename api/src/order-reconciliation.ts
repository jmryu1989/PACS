/**
 * S4-U2 오더 측 대사 — **엔지니어링 전용**.
 *
 * 권위 있는 병원 오더 출처(HL7/FHIR, schema.prisma의 Order 주석)가 아직 연결되지 않았다. 제품이 쓰는
 * 오더는 시드뿐이고 그 accession은 NULL이다. 그러므로 이 결과는 Modality Worklist·검사 예정 환자·
 * Accession 대사나 IF-W09를 닫지 못하고, 응답의 `source`가 그 사실을 스스로 말한다(P10).
 *
 * 경계(P11): Order.institutionId === 호출자 기관 === StudyState.institutionId. 원격판독으로 받은 검사는
 * 호출자 기관의 StudyState가 아니므로 짝도 후보도 되지 못한다. 접근 제한 호출자는 미연결 오더를
 * 0건 받는다 — 미연결 오더에는 판정할 검사 UID가 없고, 후보 목록은 제한 밖 검사를 드러낸다.
 *
 * 짝은 **제안**일 뿐 연결이 아니다. 연결은 기존 /match 관문만 한다.
 */
export const ORDER_RECONCILIATION_SOURCE = 'engineering_only' as const;

export type AccessionRelation = 'match' | 'mismatch' | 'not_comparable';

/**
 * 세 값이다. 어느 쪽이든 공백이면 비교할 수 없다 — 같음도 불일치도 아니다. 시드 오더의 NULL과
 * 태그가 빈 검사가 '같다'로 읽히면 모르는 두 값이 짝이 된다. DICOM SH의 앞뒤 공백만 무시하고
 * 대소문자와 내부 문자는 그대로 비교한다.
 */
export function accessionRelation(order: unknown, study: unknown): AccessionRelation {
  const left = typeof order === 'string' ? order.trim() : '';
  const right = typeof study === 'string' ? study.trim() : '';
  if (!left || !right) return 'not_comparable';
  return left === right ? 'match' : 'mismatch';
}

export interface OrderSideRow { oid: string; institutionId: string; accession: string | null; matched: string; studyUid: string | null }
export interface StudyLinkRow { uid: string; institutionId: string | null; matched: string; orderOid: string | null }
export type ReconciledOrder =
  | { oid: string; link: 'observed' | 'not_observed'; studyUid: string }
  | { oid: string; link: 'unlinked'; accession: 'present' | 'absent'; candidates: string[] };

export function reconcileOrders(input: {
  me: string;
  restricted: boolean;
  orders: OrderSideRow[];
  links: StudyLinkRow[];
  /** 성공한 열거의 행. 키가 있으면 KIN이 그 검사의 영상 행을 관측했다. */
  observed: Map<string, any>;
  accessionOf: (row: any) => string;
  permitted: (uid: string, row?: any) => boolean;
}): { source: typeof ORDER_RECONCILIATION_SOURCE; orders: ReconciledOrder[] } {
  const { me } = input;
  // 자기 기관 StudyState만 짝의 상대가 된다. 원격판독 수신 검사는 보낸 기관의 행이다.
  const own = new Map<string, StudyLinkRow>();
  for (const s of input.links) if (s.institutionId === me) own.set(s.uid, s);

  // 후보: 자기 기관, 검사 쪽도 미연결, 이번 열거에 있고, 호출자 접근 범위 안. 제한 호출자에게는 없다.
  const open: { uid: string; accession: string }[] = [];
  if (!input.restricted) for (const [uid, s] of own) {
    const row = input.observed.get(uid);
    if (!row || s.matched !== 'U' || s.orderOid != null || !input.permitted(uid, row)) continue;
    open.push({ uid, accession: input.accessionOf(row) });
  }

  const out: ReconciledOrder[] = [];
  for (const o of input.orders) {
    if (o.institutionId !== me) continue;
    if (o.matched === 'U' && o.studyUid == null) {
      if (input.restricted) continue;
      const present = typeof o.accession === 'string' && o.accession.trim() !== '';
      const candidates = present
        ? open.filter(s => accessionRelation(o.accession, s.accession) === 'match').map(s => s.uid).sort()
        : [];
      out.push({ oid: o.oid, link: 'unlinked', accession: present ? 'present' : 'absent', candidates });
      continue;
    }
    // 연결된 오더는 그 검사가 자기 기관 행이고 같은 오더를 되가리킬 때만 짝이다. 어긋난 연결은
    // 이 기관 안에서 대사할 수 없으므로 내보내지 않는다(남의 UID를 드러내지 않는다).
    const s = o.studyUid == null ? undefined : own.get(o.studyUid);
    if (!s || s.matched !== 'M' || s.orderOid !== o.oid) continue;
    const row = input.observed.get(s.uid);
    if (!input.permitted(s.uid, row)) continue;
    out.push({ oid: o.oid, link: row ? 'observed' : 'not_observed', studyUid: s.uid });
  }
  out.sort((a, b) => a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0);
  return { source: ORDER_RECONCILIATION_SOURCE, orders: out };
}

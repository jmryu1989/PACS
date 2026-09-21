import { blockIsBlank, comparisonKey, lineBlockOccurrences, presenceState } from './report-citation';

/**
 * 구조화 판독 본문 입력의 **규칙만** 있는 파일 (S3-structured-report · R15).
 *
 * 무엇이 아닌가: 수동 측정의 DICOM SR(`manual-sr.*`)은 측정값의 구조화이고 이 파일과 무관하다.
 * 여기서 다루는 것은 **판독문 본문**에 들어가는 타입 있는 항목이다.
 *
 * 기록의 본체는 여전히 자유문 세 칸이다. 이 파일이 만드는 것은 그 문장 옆에 나란히 서는
 * **증언**이다 — 무엇을 골랐는가(`value`)와 그래서 본문에 무엇이 들어갔는가(`renderedText`)를
 * 둘 다 남긴다. 인용(`report-citation.ts`)이 이미 증명한 구조를 그대로 따른다: 서버는 본문을
 * 쓰지 않고, 클라이언트가 "넣었다"고 말한 문장이 **같은 요청의 본문에 줄 블록으로 실재하는지**만
 * 확인한다.
 *
 * Nest를 모르는 채로 남는다. 컴파일된 그대로 단위 시험에 불려 나와야 하기 때문이다
 * (`report-citation.ts:28-32`와 같은 이유).
 */

export const REPORT_STRUCTURE_LIMITS = Object.freeze({ entries: 64, bytes: 65536, renderedText: 512 });
export const REPORT_STRUCTURE_FIELDS = Object.freeze(['findings', 'conclusion', 'recommendation'] as const);
export type ReportStructureField = typeof REPORT_STRUCTURE_FIELDS[number];
export const REPORT_STRUCTURE_VALUE_TYPES = Object.freeze(['choice', 'number', 'text', 'boolean'] as const);
export type ReportStructureValueType = typeof REPORT_STRUCTURE_VALUE_TYPES[number];
/** 저장 형식의 판. 서식 목록의 `revision`과 별개다. */
export const REPORT_STRUCTURE_SCHEMA = 1;
/** 서식 문장 안에서 값이 들어갈 자리. 정확히 한 번만 나와야 한다. */
export const STRUCTURE_VALUE_SLOT = '{value}';

export interface StructureChoice { code: string; text: string }

export interface StructureItem {
  code: string;
  field: ReportStructureField;
  valueType: ReportStructureValueType;
  /** 값이 들어갈 자리 하나를 가진 **한 줄** 문장. 문면은 서식 작성자의 것이다. */
  template: string;
  /** 화면에 보이는 항목 이름. 임상 문구이므로 서식 작성자가 준다. */
  label: string;
  /** **화면 표시용 권고일 뿐이다**(P11). 서버는 완결성을 저장·응답·감사하지 않는다. */
  required?: boolean;
  choices?: StructureChoice[];
  trueText?: string;
  falseText?: string;
  min?: number;
  max?: number;
  decimals?: number;
  unit?: string | null;
}

export interface StructureTemplate {
  templateId: string;
  revision: number;
  title: string;
  items: StructureItem[];
}

/**
 * **제품 서식 목록은 비어 있다** (P6·D2).
 *
 * 어느 검사의 어떤 항목을 구조화할지는 사용자(평가 판독의)만 답할 수 있다. 구현자가 임상
 * 항목·라벨·단위·범위·문장을 지어내면 그것은 요구를 충족한 것이 아니라 **지어낸 임상 내용**이다.
 * 그래서 이 단위는 기반만 만들고 목록은 빈 채로 나간다. 목록이 비면 화면은 단추를 **아예 그리지
 * 않고**(비활성이 아니라) 서버는 모든 적용을 400으로 거절한다. 답이 오면 이 상수만 채운다.
 */
export const STRUCTURE_CATALOG: readonly StructureTemplate[] = Object.freeze([]);

/** 모양이 틀린 요청. 호출자가 400으로 옮긴다. */
export class StructureInputError extends Error {}
/** 서식 목록 자체가 규칙을 어겼다. 적재 시점에 터지는 것이 맞다 — 조용히 쓰면 기록이 모호해진다. */
export class StructureCatalogError extends Error {}

export interface ReportStructureApply {
  op: 'apply' | 'replace';
  field: ReportStructureField;
  templateId: string;
  templateRevision: number;
  itemCode: string;
  valueType: ReportStructureValueType;
  value: string | number | boolean;
  renderedText: string;
  replacesSid: string | null;
}

const isPlainString = (value: any) => typeof value === 'string';
const isIndex = (value: any) => Number.isSafeInteger(value) && value >= 0;

/**
 * `jsonb`는 NUL도 짝 없는 서러게이트도 담지 못한다. 걸러내지 않으면 한도를 재는 질의에서
 * 데이터베이스 오류로 터져 **500**이 되고 사용자는 무엇이 잘못됐는지 듣지 못한다
 * (`report-citation.ts:198-210`의 같은 이유·같은 선례).
 */
function storable(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    if (code === 0 || (code >= 0xd800 && code <= 0xdfff)) return false;
  }
  return true;
}

/**
 * v1의 `renderedText`는 **정확히 한 줄**이다 (P10).
 *
 * 여러 줄을 허용하면 커서 삽입의 보호 구간(`citationGuards`)이 구조화 블록까지 합집합으로
 * 들고 가야 하고, 그것은 U6가 고정한 답을 바꾸는 별도 단위의 일이다. 한 줄로 묶어두면
 * `citationGuards`는 **그대로** 재사용된다.
 */
export function isSingleLine(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) return false;
  }
  return true;
}

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

/** 저장된 값이 배열이 아니면(없음·손상·옛 행) 빈 배열이다. 조용히 고치지 않는다. */
export function structureArray(value: any): any[] {
  return Array.isArray(value) ? value : [];
}

/** 같은 항목은 한 번만 산다(P3). 살아 있는 건의 키는 서식과 항목이다. */
export function structureItemKey(entry: any): string {
  return String(entry?.templateId ?? '') + '\u0000' + String(entry?.itemCode ?? '');
}

/**
 * 유지 목록은 **내 초안 행의 건에 대한 교집합**이다. 인용과 같은 세 가지 뜻:
 *   키 없음(undefined) = 변경 없음, `[]` = 내 초안 건 전부 제거, 모르는 sid = 거절이 아니라 무시.
 */
export function applyStructureKeepList(entries: any[], keep: string[] | undefined): { kept: any[]; ignored: number } {
  if (keep === undefined) return { kept: entries.slice(), ignored: 0 };
  const wanted = new Set(keep);
  const known = new Set(entries.map(entry => String(entry?.sid ?? '')));
  let ignored = 0;
  for (const sid of wanted) if (!known.has(sid)) ignored += 1;
  return { kept: entries.filter(entry => wanted.has(String(entry?.sid ?? ''))), ignored };
}

/** 클라이언트가 보낸 sid 목록. 모양이 아니면 거절한다 — 모르는 **값**만 무시 대상이다. */
export function structureIdList(value: any, what: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > REPORT_STRUCTURE_LIMITS.entries * 2 || !value.every(isPlainString))
    throw new StructureInputError(`${what}은(는) 문자열 배열이어야 합니다`);
  return value.map(String);
}

export function findTemplate(catalog: readonly StructureTemplate[], templateId: string): StructureTemplate | null {
  for (const template of catalog ?? []) if (template.templateId === templateId) return template;
  return null;
}

export function findItem(template: StructureTemplate | null, itemCode: string): StructureItem | null {
  for (const item of template?.items ?? []) if (item.code === itemCode) return item;
  return null;
}

/**
 * 값 하나를 사람이 읽는 글자로. **결정적**이다 — 같은 (항목, 값)은 언제나 같은 글자다.
 * 숫자의 소수 자릿수는 서식이 고정하므로 `1.50`과 `1.5`가 같은 항목에서 둘 다 나올 수 없다.
 */
export function valueText(item: StructureItem, value: any): string {
  if (item.valueType === 'choice') {
    for (const choice of item.choices ?? []) if (choice.code === value) return choice.text;
    throw new StructureInputError('choice 값이 서식의 선택지에 없습니다');
  }
  if (item.valueType === 'boolean') return value ? String(item.trueText ?? '') : String(item.falseText ?? '');
  if (item.valueType === 'number') return Number(value).toFixed(item.decimals ?? 0);
  return String(value);
}

/**
 * 본문에 들어갈 그 한 줄. 서버와 화면이 **같은 규칙**으로 만들고, 서버는 요청이 보낸
 * `renderedText`가 이 함수의 답과 **바이트가 같을 때만** 받는다 — 문면을 고르는 것은
 * 클라이언트의 몫이 아니다.
 */
export function renderItem(item: StructureItem, value: any): string {
  /**
   * **`String.replace`의 문자열 치환을 쓰지 않는다.** 그 함수는 치환 문자열 안의 `$$`·`$&`·
   * `` $` ``·`$'`를 패턴으로 해석해서, 사람이 친 `a$$b`가 본문에는 `a$b`로 들어간다. 그러면
   * 저장된 `value`와 `renderedText`가 서로 다른 말을 하고(값-문장 어긋남), 같은 서식이 서로 다른
   * 값에서 같은 줄을 만들어 단사성도 깨진다. 자리를 직접 잘라 붙이면 그 해석이 아예 없다.
   */
  const template = String(item.template);
  const at = template.indexOf(STRUCTURE_VALUE_SLOT);
  if (at < 0) throw new StructureCatalogError(`서식 문장에 ${STRUCTURE_VALUE_SLOT}가 없습니다: ${item.code}`);
  return template.slice(0, at) + valueText(item, value) + template.slice(at + STRUCTURE_VALUE_SLOT.length);
}

/**
 * 서식 목록이 지켜야 하는 것. **적재 시점에** 확인한다.
 *
 * 마지막 규칙(충돌 없음)이 핵심이다: 한 서식 안에서 서로 다른 (항목, 값)이 **같은 한 줄**을
 * 만들면, 그 줄이 본문에서 누구의 것인지 셀 수 없어 존재 상태가 조용히 `ambiguous`가 된다.
 * 열거 가능한 값(choice·boolean)은 전부 펼쳐서 실제로 대조하고, 열거할 수 없는 값(number·text)은
 * **자리 앞뒤의 고정 문자열 쌍**이 서식 안에서 유일할 것을 요구한다. 후자는 필요조건이지
 * 충분조건이 아니다 — 자유 입력 값이 다른 항목의 문장을 통째로 흉내 내는 경우까지는 막지 못하며,
 * 그 경우의 답은 `presenceState`의 `ambiguous`다(거짓이 아니라 모른다고 말한다).
 *
 * **그래서 단사성(P12)은 부분이고, 완료가 아니다.** 제품 목록이 비어 있는 동안 이 구멍은 도달할
 * 수 없다. 비어 있지 않은 제품 서식을 켜기 전에 (1) 항목 간 충돌을 충분히 막는 규칙, (2) 서버와
 * 화면 **양쪽의 적재 시점 검증**, (3) 목록 전체에 대한 시험이 모두 선행해야 한다.
 * 이 함수를 적재 시점에 부르는 곳은 아직 없다 — 목록이 비어 있어 부를 것이 없기 때문이고,
 * 목록이 채워지는 변경이 그 호출을 함께 들여와야 한다.
 */
export function validateCatalog(catalog: readonly StructureTemplate[]): void {
  const templateIds = new Set<string>();
  for (const template of catalog ?? []) {
    if (!isPlainString(template?.templateId) || !template.templateId)
      throw new StructureCatalogError('templateId가 필요합니다');
    if (templateIds.has(template.templateId))
      throw new StructureCatalogError(`templateId가 중복입니다: ${template.templateId}`);
    templateIds.add(template.templateId);
    if (!Number.isSafeInteger(template.revision) || template.revision < 1)
      throw new StructureCatalogError(`revision은 1 이상의 정수여야 합니다: ${template.templateId}`);
    if (!isPlainString(template?.title) || !template.title)
      throw new StructureCatalogError(`title이 필요합니다: ${template.templateId}`);

    const codes = new Set<string>();
    const literals = new Set<string>();
    const rendered = new Map<string, string>();
    for (const item of template.items ?? []) {
      if (!isPlainString(item?.code) || !item.code)
        throw new StructureCatalogError(`항목 code가 필요합니다: ${template.templateId}`);
      if (codes.has(item.code))
        throw new StructureCatalogError(`항목 code가 중복입니다: ${template.templateId}/${item.code}`);
      codes.add(item.code);
      if (!REPORT_STRUCTURE_FIELDS.includes(item.field as any))
        throw new StructureCatalogError(`항목 field가 잘못됐습니다: ${template.templateId}/${item.code}`);
      if (!REPORT_STRUCTURE_VALUE_TYPES.includes(item.valueType as any))
        throw new StructureCatalogError(`항목 valueType이 잘못됐습니다: ${template.templateId}/${item.code}`);
      if (!isPlainString(item?.label) || !item.label)
        throw new StructureCatalogError(`항목 label이 필요합니다: ${template.templateId}/${item.code}`);
      if (!isPlainString(item?.template) || item.template.split(STRUCTURE_VALUE_SLOT).length !== 2)
        throw new StructureCatalogError(
          `항목 template에는 ${STRUCTURE_VALUE_SLOT}가 정확히 한 번 있어야 합니다: ${template.templateId}/${item.code}`);
      if (!isSingleLine(item.template.split(STRUCTURE_VALUE_SLOT).join('')))
        throw new StructureCatalogError(`항목 template은 한 줄이어야 합니다: ${template.templateId}/${item.code}`);

      const [prefix, suffix] = item.template.split(STRUCTURE_VALUE_SLOT);
      if (item.valueType === 'choice') {
        const list = item.choices ?? [];
        if (!list.length) throw new StructureCatalogError(`choice 항목에 선택지가 없습니다: ${item.code}`);
        const seen = new Set<string>();
        for (const choice of list) {
          if (!isPlainString(choice?.code) || !choice.code || !isPlainString(choice?.text) || !choice.text)
            throw new StructureCatalogError(`선택지 code·text가 필요합니다: ${item.code}`);
          if (seen.has(choice.code)) throw new StructureCatalogError(`선택지 code가 중복입니다: ${item.code}`);
          seen.add(choice.code);
        }
      } else if (item.valueType === 'boolean') {
        if (!isPlainString(item.trueText) || !item.trueText || !isPlainString(item.falseText) || !item.falseText)
          throw new StructureCatalogError(`boolean 항목에는 trueText·falseText가 필요합니다: ${item.code}`);
      } else if (item.valueType === 'number') {
        if (!Number.isFinite(item.min as number) || !Number.isFinite(item.max as number) || (item.min as number) > (item.max as number))
          throw new StructureCatalogError(`number 항목에는 min <= max가 필요합니다: ${item.code}`);
        if (!isIndex(item.decimals) || (item.decimals as number) > 6)
          throw new StructureCatalogError(`number 항목의 decimals는 0..6이어야 합니다: ${item.code}`);
      }

      if (item.valueType === 'choice' || item.valueType === 'boolean') {
        const values: any[] = item.valueType === 'choice'
          ? (item.choices ?? []).map(choice => choice.code) : [true, false];
        for (const value of values) {
          const line = renderItem(item, value);
          if (!isSingleLine(line) || blockIsBlank(line))
            throw new StructureCatalogError(`서식 문장이 한 줄의 글이 아닙니다: ${item.code}`);
          if (utf8Bytes(line) > REPORT_STRUCTURE_LIMITS.renderedText)
            throw new StructureCatalogError(`서식 문장이 ${REPORT_STRUCTURE_LIMITS.renderedText}바이트를 넘습니다: ${item.code}`);
          const key = comparisonKey(line);
          const owner = rendered.get(key);
          if (owner && owner !== item.code)
            throw new StructureCatalogError(`서로 다른 항목이 같은 문장을 만듭니다: ${owner} / ${item.code}`);
          rendered.set(key, item.code);
        }
      } else {
        const key = prefix + '\u0000' + suffix;
        if (literals.has(key))
          throw new StructureCatalogError(`자유 입력 항목의 문장 골격이 중복입니다: ${item.code}`);
        literals.add(key);
      }
    }
  }
}

/**
 * 값 하나의 타입 검사. 통과한 값은 **그대로** 저장된다 — 반올림·다듬기·번역을 하지 않는다.
 */
export function validateValue(item: StructureItem, value: any): string | number | boolean {
  if (item.valueType === 'choice') {
    if (!isPlainString(value)) throw new StructureInputError('choice 값은 문자열이어야 합니다');
    for (const choice of item.choices ?? []) if (choice.code === value) return value;
    throw new StructureInputError('choice 값이 서식의 선택지에 없습니다');
  }
  if (item.valueType === 'boolean') {
    if (typeof value !== 'boolean') throw new StructureInputError('boolean 값은 true 또는 false여야 합니다');
    return value;
  }
  if (item.valueType === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new StructureInputError('number 값은 유한한 수여야 합니다');
    if (value < (item.min as number) || value > (item.max as number))
      throw new StructureInputError(`number 값은 ${item.min}..${item.max} 범위여야 합니다`);
    // 서식이 고정한 자릿수로 되돌아오지 않는 값은 받지 않는다. 받으면 저장된 수와 본문의
    // 글자가 서로 다른 것을 말하게 된다(`12.345` 저장 / `12.3` 출력).
    if (Number(value.toFixed(item.decimals ?? 0)) !== value)
      throw new StructureInputError(`number 값의 소수 자릿수는 ${item.decimals ?? 0}자리여야 합니다`);
    return value;
  }
  if (!isPlainString(value) || !value.length) throw new StructureInputError('text 값이 필요합니다');
  if (blockIsBlank(value)) throw new StructureInputError('공백만 있는 값은 저장할 수 없습니다');
  if (!isSingleLine(value)) throw new StructureInputError('text 값은 한 줄이어야 합니다');
  if (!storable(value)) throw new StructureInputError('잘못된 문자 인코딩입니다');
  if (utf8Bytes(value) > REPORT_STRUCTURE_LIMITS.renderedText)
    throw new StructureInputError(`값이 ${REPORT_STRUCTURE_LIMITS.renderedText}바이트를 넘습니다`);
  return value;
}

/**
 * 적용 요청의 모양. **허용된 아홉 칸만 읽는다** — `sid`·`enteredBy`·`enteredAt`·`unit`·`v`를
 * 클라이언트가 보내도 여기서 사라진다. 서버가 만들어야 할 값을 **읽지 않는 것**이 유일한
 * 구조적 방어다(`report-citation.ts:220-225`와 같은 이유).
 */
export function structureApplyInput(value: any, catalog: readonly StructureTemplate[]): ReportStructureApply {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new StructureInputError('structure는 객체여야 합니다');
  const op = value.op;
  if (op !== 'apply' && op !== 'replace')
    throw new StructureInputError('structure.op은 apply 또는 replace여야 합니다');
  if (!REPORT_STRUCTURE_FIELDS.includes(value.field))
    throw new StructureInputError(`structure.field는 ${REPORT_STRUCTURE_FIELDS.join('·')} 중 하나여야 합니다`);
  if (!isPlainString(value.templateId) || !value.templateId)
    throw new StructureInputError('structure.templateId가 필요합니다');
  const template = findTemplate(catalog, value.templateId);
  // 서식이 없는 것과 판이 다른 것을 구분한다 — 빈 목록(P6)에서는 언제나 전자다.
  if (!template) throw new StructureInputError('그 서식을 찾을 수 없습니다');
  if (!Number.isSafeInteger(value.templateRevision) || value.templateRevision !== template.revision)
    throw new StructureInputError(`서식이 그 사이 바뀌었습니다 (현재 revision ${template.revision})`);
  if (!isPlainString(value.itemCode) || !value.itemCode)
    throw new StructureInputError('structure.itemCode가 필요합니다');
  const item = findItem(template, value.itemCode);
  if (!item) throw new StructureInputError('그 항목을 찾을 수 없습니다');
  if (item.field !== value.field)
    throw new StructureInputError('그 항목이 들어갈 칸이 아닙니다');
  if (value.valueType !== item.valueType)
    throw new StructureInputError('structure.valueType이 서식과 다릅니다');
  const checked = validateValue(item, value.value);
  if (!isPlainString(value.renderedText) || value.renderedText !== renderItem(item, checked))
    throw new StructureInputError('structure.renderedText가 서식이 만드는 문장과 다릅니다');
  if (utf8Bytes(value.renderedText) > REPORT_STRUCTURE_LIMITS.renderedText)
    throw new StructureInputError(`문장이 ${REPORT_STRUCTURE_LIMITS.renderedText}바이트를 넘습니다`);
  if (op === 'replace' && (!isPlainString(value.replacesSid) || !value.replacesSid))
    throw new StructureInputError('structure.replacesSid가 필요합니다');
  if (op === 'apply' && value.replacesSid !== undefined)
    throw new StructureInputError('apply에는 replacesSid를 보낼 수 없습니다');
  return {
    op, field: value.field, templateId: value.templateId, templateRevision: value.templateRevision,
    itemCode: value.itemCode, valueType: item.valueType, value: checked, renderedText: value.renderedText,
    replacesSid: op === 'replace' ? String(value.replacesSid) : null,
  };
}

/** 한 건이 저장 형식을 지키는가. 하나라도 틀리면 **답 전체가 모른다**가 된다. */
export function isStructureEntry(entry: any): boolean {
  return !!entry && typeof entry === 'object' && !Array.isArray(entry)
    && isPlainString(entry.sid) && !!entry.sid
    && REPORT_STRUCTURE_FIELDS.includes(entry.field)
    && REPORT_STRUCTURE_VALUE_TYPES.includes(entry.valueType)
    && isPlainString(entry.templateId) && isPlainString(entry.itemCode)
    && isPlainString(entry.renderedText) && !!entry.renderedText;
}

/**
 * 같은 칸·같은 글을 가진 건의 수. 인용과 **같은 등식**(`comparisonKey`)을 쓴다 —
 * 두 벌의 셈법이 생기는 순간 한쪽은 `present`, 다른 쪽은 `ambiguous`를 말하게 된다.
 */
export function structureSameTextCounts(entries: any[]): number[] {
  const tally = new Map<string, number>();
  const keys = entries.map(entry => {
    const key = String(entry?.field ?? '') + '\u0000' + comparisonKey(entry?.renderedText ?? '');
    tally.set(key, (tally.get(key) ?? 0) + 1);
    return key;
  });
  return keys.map(key => tally.get(key) ?? 0);
}

/** 화면으로 나가는 투영. 존재 상태는 **읽는 시점에** 계산하고 저장하지 않는다. */
export function projectStructure(entry: any, body: string, sameTextCount: number) {
  return { ...entry, sameTextCount,
    state: presenceState(lineBlockOccurrences(body, String(entry?.renderedText ?? '')), sameTextCount || 1) };
}

/**
 * 확정에 실릴 건을 고르는 **단 하나의 규칙** (P1).
 *
 * 머리에서 왔든 내 초안에서 왔든 똑같이 묻는다: 그 문장이 **확정될 본문에 지금 있는가.**
 * 이 규칙이 없으면, 사람이 `12 mm`를 손으로 `15 mm`로 고친 뒤 서명한 판에 `value=12`가
 * 남는다 — 기계가 읽는 값이 의무기록과 다른 말을 하게 된다.
 * 어떤 건도 다시 렌더하거나 고치지 않는다. 떨어진 건의 `sid`는 감사로 남는다.
 */
export function commitStructureSelection(candidates: any[], content: any, blank: boolean, reset: boolean)
  : { entries: any[]; dropped: string[] } {
  if (blank || reset) return { entries: [], dropped: candidates.map(entry => String(entry?.sid ?? '')) };
  const entries: any[] = [];
  const dropped: string[] = [];
  for (const entry of candidates) {
    const body = String(content?.[String(entry?.field ?? '')] ?? '');
    if (lineBlockOccurrences(body, String(entry?.renderedText ?? '')) >= 1) entries.push(entry);
    else dropped.push(String(entry?.sid ?? ''));
  }
  return { entries, dropped };
}

/** 머리 ∪ 내 초안. `sid`로 중복을 제거하고 **머리의 바이트가 이긴다**(머리 행은 불변이다). */
export function structureUnion(head: any[], draft: any[]): any[] {
  const seen = new Set(head.map(entry => String(entry?.sid ?? '')));
  const entries = head.slice();
  for (const entry of draft) {
    const sid = String(entry?.sid ?? '');
    if (seen.has(sid)) continue;
    seen.add(sid);
    entries.push(entry);
  }
  return entries;
}

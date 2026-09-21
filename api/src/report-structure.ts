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

/** 목록 검사의 규칙 이름. 거절은 언제나 **어느 규칙**인지 말한다. */
export type StructureRule = 'R-D' | 'R-S' | 'R-C' | 'R-A' | 'R-B';

/**
 * 서식 목록 자체가 규칙을 어겼다. 적재 시점에 터지는 것이 맞다 — 조용히 쓰면 기록이 모호해진다.
 * 규칙 이름을 들고 다니므로 시험이 "무언가 던졌다"가 아니라 **무엇을 어겼는지**를 단언한다.
 */
export class StructureCatalogError extends Error {
  readonly rule: StructureRule;
  constructor(rule: StructureRule, message: string) {
    super(`${rule}: ${message}`);
    this.rule = rule;
  }
}

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

/**
 * 짝 없는 서러게이트가 하나라도 있으면 그 문자열은 UTF-16으로 온전하지 않다 (R-D).
 *
 * `storable()`은 **값**을 코드포인트로 훑어 이미 막지만, 서식의 고정 문자열(문장 앞뒤, 선택지
 * 문면, boolean 낱말)은 그 길을 지나지 않는다. 온전하지 않은 문자열은 정규화·저장·비교가
 * 저마다 다르게 굴 수 있으므로 목록을 받는 자리에서 막는다.
 */
export function wellFormedUtf16(text: string): boolean {
  const value = String(text ?? '');
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

const nfc = (text: string) => String(text ?? '').normalize('NFC');

/**
 * **경계 안정성** (R-S). 충돌 방지의 모든 증명이 이 하나에 기댄다.
 *
 * 존재 판정이 쓰는 등식은 `comparisonKey`(CR/CRLF→LF, NFC, 끝 LF 하나 제거)다. 그런데 정규화는
 * **경계를 넘어 합성할 수 있다.** 앞머리가 `ᄀ`(U+1100)로 끝나고 값이 `ᅡ`(U+1161)로 시작하면
 * NFC는 둘을 `가`(U+AC00) 하나로 합친다 — 둘 다 결합 등급이 0이라 "결합 문자 금지" 같은 규칙으로는
 * 잡히지 않는다. 그러면 서로 다른 (항목, 값)이 같은 키를 갖고, 앞뒤 문자열로 항목을 가른다는
 * R-B의 논증이 통째로 무너진다.
 *
 * 그래서 표를 들추는 대신 **실제 정규화기에게 직접 묻는다**: 이 문장의 키가 앞머리·값·꼬리의
 * 키를 이어 붙인 것과 같은가. 같으면 경계에서 아무 일도 일어나지 않았다는 뜻이고, 다르면
 * 거절한다. 유니코드 판이 올라가도 이 질문의 뜻은 변하지 않는다.
 *
 * 고치지 않는다 — 사람이 친 글자도, 이미 기록된 바이트도 다시 쓰지 않는다. 거절만 한다.
 */
export function boundaryStable(prefix: string, valueText: string, suffix: string): boolean {
  return comparisonKey(String(prefix) + String(valueText) + String(suffix))
    === nfc(prefix) + comparisonKey(String(valueText)) + nfc(suffix);
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
  if (at < 0) throw new StructureCatalogError('R-D', `서식 문장에 ${STRUCTURE_VALUE_SLOT}가 없습니다: ${item.code}`);
  return template.slice(0, at) + valueText(item, value) + template.slice(at + STRUCTURE_VALUE_SLOT.length);
}

/**
 * 서식 목록이 지켜야 하는 것. **적재 시점에** 확인한다 — 이 모듈의 마지막 문장이 제품 목록을
 * 들고 스스로를 부르고, 시험이 갈아 끼우는 자리(`pacs.service.ts`의 setter)도 같은 검사를 지난다.
 *
 * 막으려는 것은 하나다: 한 칸(`findings`·`conclusion`·`recommendation`) 안에서 서로 다른
 * (항목, 값)이 **같은 한 줄**을 만드는 것. 그러면 본문의 그 줄이 누구의 것인지 셀 수 없어
 * 존재 판정이 조용히 틀린다(P12).
 *
 * 다섯 규칙이고, 전부 **표본 없이** 결정된다 — 값을 하나도 지어내지 않는다:
 *   R-D 모양. 슬롯이 정확히 한 번, 한 줄, 온전한 UTF-16, 고정 문자열은 이미 NFC, 바이트 여유.
 *   R-S 경계 안정성(`boundaryStable`). 정규화가 앞뒤 경계를 넘어 합치지 않을 것.
 *   R-C 한 항목 안의 단사성. 한 항목의 두 값이 같은 줄을 만들지 않을 것.
 *   R-A 열거 가능한 두 항목은 값 공간이 유한하고 전부 적혀 있으므로 **전수로** 대조한다.
 *   R-B 그 밖의 모든 쌍은 앞머리만으로, 또는 꼬리만으로 갈린다. 이 논증(아래)은 값 공간을
 *       한 번도 말하지 않으므로 자유 입력·숫자·나중에 늘어날 형식에도 그대로 선다.
 *
 * R-S와 R-B가 함께 서면 같은 칸의 두 항목은 어떤 값을 넣어도 같은 줄을 만들 수 없다. 즉 이 함수를
 * 통과한 목록에서 **항목 간** 충돌은 도달 불가능하다. 남는 것은 한 항목이 같은 값을 두 번 살게 할
 * 때인데 그것은 P3가 막는다. 자유 입력이 **자기 항목의** 다른 값을 흉내 내는 경우는 여전히
 * `presenceState`의 `ambiguous`가 답이다 — 거짓이 아니라 모른다고 말한다.
 *
 * 이 검사는 문면을 **고치지 않는다**. 사람이 친 글자도, 이미 기록된 바이트도 다시 쓰지 않고
 * 거절만 한다. 제품 목록은 여전히 비어 있고, 이 단위가 여는 것은 내용이 아니라 **안전장치**다.
 */
export function validateCatalog(catalog: readonly StructureTemplate[]): void {
  const templateIds = new Set<string>();
  /** 한 칸 안의 모든 항목을 **목록 전체에서** 모은다. 충돌은 서식 경계를 넘어 일어난다. */
  const flat: {
    id: string; field: string; prefix: string; suffix: string;
    enumerable: boolean; lines: Set<string>;
  }[] = [];

  for (const template of catalog ?? []) {
    if (!isPlainString(template?.templateId) || !template.templateId)
      throw new StructureCatalogError('R-D', 'templateId가 필요합니다');
    if (templateIds.has(template.templateId))
      throw new StructureCatalogError('R-D', `templateId가 중복입니다: ${template.templateId}`);
    templateIds.add(template.templateId);
    if (!Number.isSafeInteger(template.revision) || template.revision < 1)
      throw new StructureCatalogError('R-D', `revision은 1 이상의 정수여야 합니다: ${template.templateId}`);
    if (!isPlainString(template?.title) || !template.title)
      throw new StructureCatalogError('R-D', `title이 필요합니다: ${template.templateId}`);

    const codes = new Set<string>();
    for (const item of template.items ?? []) {
      const where = `${template.templateId}/${item?.code ?? '(code 없음)'}`;

      /* ── R-D: 모양 ─────────────────────────────────────────────────────────────── */
      if (!isPlainString(item?.code) || !item.code)
        throw new StructureCatalogError('R-D', `항목 code가 필요합니다: ${template.templateId}`);
      if (codes.has(item.code))
        throw new StructureCatalogError('R-D', `항목 code가 중복입니다: ${where}`);
      codes.add(item.code);
      if (!REPORT_STRUCTURE_FIELDS.includes(item.field as any))
        throw new StructureCatalogError('R-D', `항목 field가 잘못됐습니다: ${where}`);
      if (!REPORT_STRUCTURE_VALUE_TYPES.includes(item.valueType as any))
        throw new StructureCatalogError('R-D', `항목 valueType이 잘못됐습니다: ${where}`);
      if (!isPlainString(item?.label) || !item.label)
        throw new StructureCatalogError('R-D', `항목 label이 필요합니다: ${where}`);
      if (!isPlainString(item?.template) || item.template.split(STRUCTURE_VALUE_SLOT).length !== 2)
        throw new StructureCatalogError('R-D',
          `항목 template에는 ${STRUCTURE_VALUE_SLOT}가 정확히 한 번 있어야 합니다: ${where}`);
      const [prefix, suffix] = item.template.split(STRUCTURE_VALUE_SLOT);
      if (!isSingleLine(prefix + suffix))
        throw new StructureCatalogError('R-D', `항목 template은 한 줄이어야 합니다: ${where}`);
      // 온전하지 않은 UTF-16은 정규화도 저장도 비교도 저마다 다르게 군다.
      if (!wellFormedUtf16(prefix) || !wellFormedUtf16(suffix))
        throw new StructureCatalogError('R-D', `항목 template이 온전한 UTF-16이 아닙니다: ${where}`);
      // 앞뒤 고정 문자열은 이미 NFC여야 한다 — R-B가 바로 그 바이트로 항목을 가른다.
      if (nfc(prefix) !== prefix || nfc(suffix) !== suffix)
        throw new StructureCatalogError('R-D', `항목 template의 고정 문자열이 NFC가 아닙니다: ${where}`);
      // 앞뒤만으로 한도를 다 쓰면 어떤 값도 들어갈 자리가 없다.
      if (utf8Bytes(prefix + suffix) >= REPORT_STRUCTURE_LIMITS.renderedText)
        throw new StructureCatalogError('R-D',
          `앞뒤 고정 문자열이 ${REPORT_STRUCTURE_LIMITS.renderedText}바이트를 채워 값이 들어갈 자리가 없습니다: ${where}`);

      if (item.valueType === 'choice') {
        const list = item.choices ?? [];
        if (!list.length) throw new StructureCatalogError('R-D', `choice 항목에 선택지가 없습니다: ${where}`);
        const seenCode = new Set<string>();
        for (const choice of list) {
          if (!isPlainString(choice?.code) || !choice.code || !isPlainString(choice?.text) || !choice.text)
            throw new StructureCatalogError('R-D', `선택지 code·text가 필요합니다: ${where}`);
          if (!wellFormedUtf16(choice.text))
            throw new StructureCatalogError('R-D', `선택지 text가 온전한 UTF-16이 아닙니다: ${where}`);
          if (seenCode.has(choice.code))
            throw new StructureCatalogError('R-D', `선택지 code가 중복입니다: ${where}`);
          seenCode.add(choice.code);
        }
      } else if (item.valueType === 'boolean') {
        if (!isPlainString(item.trueText) || !item.trueText || !isPlainString(item.falseText) || !item.falseText)
          throw new StructureCatalogError('R-D', `boolean 항목에는 trueText·falseText가 필요합니다: ${where}`);
        if (!wellFormedUtf16(item.trueText) || !wellFormedUtf16(item.falseText))
          throw new StructureCatalogError('R-D', `boolean 낱말이 온전한 UTF-16이 아닙니다: ${where}`);
      } else if (item.valueType === 'number') {
        if (!Number.isFinite(item.min as number) || !Number.isFinite(item.max as number)
            || (item.min as number) > (item.max as number))
          throw new StructureCatalogError('R-D', `number 항목에는 min <= max가 필요합니다: ${where}`);
        if (!isIndex(item.decimals) || (item.decimals as number) > 6)
          throw new StructureCatalogError('R-D', `number 항목의 decimals는 0..6이어야 합니다: ${where}`);
      }

      const enumerable = item.valueType === 'choice' || item.valueType === 'boolean';
      const values: any[] = item.valueType === 'choice'
        ? (item.choices ?? []).map(choice => choice.code)
        : item.valueType === 'boolean' ? [true, false] : [];

      /* ── R-S: 경계 안정성 — 열거 가능한 값 전부 ────────────────────────────────── */
      for (const value of values)
        if (!boundaryStable(prefix, valueText(item, value), suffix))
          throw new StructureCatalogError('R-S',
            `정규화가 문장의 경계를 넘어 합쳐집니다 — 그 값의 문면을 바꾸세요: ${where}`);

      /* ── R-C: 한 항목 안의 단사성 ──────────────────────────────────────────────── */
      const lines = new Set<string>();
      for (const value of values) {
        const line = renderItem(item, value);
        if (!isSingleLine(line) || blockIsBlank(line))
          throw new StructureCatalogError('R-D', `서식 문장이 한 줄의 글이 아닙니다: ${where}`);
        if (utf8Bytes(line) > REPORT_STRUCTURE_LIMITS.renderedText)
          throw new StructureCatalogError('R-D',
            `서식 문장이 ${REPORT_STRUCTURE_LIMITS.renderedText}바이트를 넘습니다: ${where}`);
        const key = comparisonKey(line);
        if (lines.has(key))
          throw new StructureCatalogError('R-C',
            `한 항목의 두 값이 같은 문장을 만듭니다 — 기록된 값을 문장에서 되짚을 수 없습니다: ${where}`);
        lines.add(key);
      }

      flat.push({ id: where, field: String(item.field), prefix, suffix, enumerable, lines });
    }
  }

  /* ── 쌍 검사: 같은 칸의 모든 항목 쌍에 R-A → R-B ─────────────────────────────────
   *
   * 다른 칸의 문장은 서로 만나지 않는다 — 존재 판정이 칸별로 센다.
   * R-A: 둘 다 열거 가능하면 값 공간이 유한하고 **전부** 적혀 있으므로 실제로 대조한다.
   *      표본이 아니라 전수다.
   * R-B: 그 밖의 모든 쌍은 값이 무엇이든 앞머리만으로, 또는 꼬리만으로 갈려야 한다.
   *      한 문자열의 서로 다른 길이의 앞머리는 서로 포개지므로, 두 앞머리가 서로의 앞머리가
   *      아니면 두 문장은 같을 수 없다. 이 논증은 값 공간을 한 번도 말하지 않는다 —
   *      그래서 자유 입력에도, 숫자에도, 나중에 늘어날 형식에도 그대로 선다.
   *      빈 문자열은 모든 문자열의 앞머리이자 꼬리다: 앞머리가 빈 항목은 꼬리로만 갈린다.
   */
  for (let i = 0; i < flat.length; i++)
    for (let j = i + 1; j < flat.length; j++) {
      const a = flat[i], b = flat[j];
      if (a.field !== b.field) continue;
      if (a.enumerable && b.enumerable) {
        for (const line of a.lines)
          if (b.lines.has(line))
            throw new StructureCatalogError('R-A',
              `서로 다른 항목이 같은 문장을 만듭니다: ${a.id} / ${b.id}`);
        continue;
      }
      const prefixSeparates = !a.prefix.startsWith(b.prefix) && !b.prefix.startsWith(a.prefix);
      const suffixSeparates = !a.suffix.endsWith(b.suffix) && !b.suffix.endsWith(a.suffix);
      if (!prefixSeparates && !suffixSeparates)
        throw new StructureCatalogError('R-B',
          `두 항목의 문장을 앞머리로도 꼬리로도 가를 수 없습니다 — 한쪽 문면을 바꾸세요: ${a.id} / ${b.id}`);
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
  /**
   * R-S는 목록만으로 끝나지 않는다. 자유 입력 값은 목록이 쓰일 때가 아니라 **이 요청에서** 처음
   * 나타나므로, 경계에서 합쳐지는 값은 여기서 막아야 한다. 바이트 동일성 검사 **뒤**에 둔다 —
   * 먼저 "이 문장이 서식이 만드는 그 문장인가"를 묻고, 그다음 "그 문장의 키가 조각의 키를 이어
   * 붙인 것과 같은가"를 묻는다. 값을 고치지 않는다: 거절만 한다.
   */
  const [applyPrefix, applySuffix] = item.template.split(STRUCTURE_VALUE_SLOT);
  if (!boundaryStable(applyPrefix, valueText(item, checked), applySuffix))
    throw new StructureInputError(
      '값이 문장의 경계에서 합쳐져 다른 항목의 문장과 구분되지 않습니다 — 다른 표현을 쓰세요');
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

/**
 * **적재 시점 검사** (P12).
 *
 * 이 파일의 마지막 문장이다. 목록이 규칙을 어기면 모듈이 적재되지 않고, 그러면 API도 뜨지
 * 않는다 — 모호한 목록으로 판독문을 받는 것보다 서지 않는 편이 낫다. 지금 제품 목록은 비어
 * 있어 이 호출은 아무것도 하지 않지만, 목록을 채우는 변경은 이 관문을 반드시 지나간다.
 */
validateCatalog(STRUCTURE_CATALOG);

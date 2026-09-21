/**
 * 구조화 판독 본문 입력의 화면 쪽 규칙 (S3-structured-report · R15).
 *
 * 서버(`api/src/report-structure.ts`)와 **같은 규칙**을 따로 구현한다. 둘을 묶는 것은 공용
 * 벡터(`tests/report_structure_vectors.json`)이고, 그 벡터는 제3의 독립 규칙이 다시 검사한다 —
 * 인용이 쓰는 방식 그대로다. 한쪽만 고치면 벡터가 먼저 깨진다.
 *
 * DOM을 모른다. `require` 시점에 문서를 건드리지 않으므로 그냥 `node --test`에 불려 나온다.
 * 인용 라이브러리는 **인자로 받는다**(P7) — 전역에서 집어오면 페이지에서만 도는 파일이 되고,
 * 순수 시험이 같은 코드를 실행할 수 없다.
 */
(function () {
  'use strict';

  var VALUE_SLOT = '{value}';
  var LIMITS = Object.freeze({ entries: 64, bytes: 65536, renderedText: 512 });
  var FIELDS = Object.freeze(['findings', 'conclusion', 'recommendation']);
  var VALUE_TYPES = Object.freeze(['choice', 'number', 'text', 'boolean']);
  var SCHEMA = 1;

  /**
   * **제품 서식 목록은 비어 있다** (P6 · D2).
   *
   * 어느 검사의 어떤 항목을 구조화할지는 사용자(평가 판독의)만 답할 수 있다. 구현자가
   * 임상 항목·라벨·단위·범위·문장을 지어내면 그것은 요구 충족이 아니라 지어낸 임상 내용이다.
   * 목록이 비어 있는 동안 Structured 단추는 **그려지지 않는다**(비활성이 아니다).
   */
  var PRODUCT_CATALOG = Object.freeze([]);

  var MSG = Object.freeze({
    ambiguous: '같은 문장이 본문에 여러 번 있어 어느 것을 바꿔야 할지 알 수 없습니다 — 본문에서 직접 고쳐 주세요',
    lineEndings: '이 칸의 줄 끝이 섞여 있어 자리를 정확히 말할 수 없습니다 — 본문에서 직접 고쳐 주세요',
    guarded: '바꿀 문장이 인용된 블록 안에 있습니다 — 본문에서 직접 고쳐 주세요',
    stale: '열어둔 사이에 본문이나 커서 자리가 바뀌었습니다 — 자리를 다시 확인한 뒤 적용하세요',
    unknownRevision: '이 판독문의 구조화 서식은 현재 버전과 다릅니다 — 값은 그대로 보존되며 여기서 수정할 수 없습니다',
    empty: '값을 입력하세요',
    choice: '선택지에서 고르세요',
    number: '숫자를 입력하세요',
    oneLine: '값은 한 줄이어야 합니다',
    tooLong: '값이 ' + LIMITS.renderedText + '바이트를 넘습니다',
  });

  function utf8Bytes(text) {
    return new TextEncoder().encode(String(text === null || text === undefined ? '' : text)).length;
  }

  /** 한 줄인가. 서버의 `isSingleLine`과 같은 금지 문자 집합이다(LF·CR·TAB·제어문자·U+2028/9). */
  function isSingleLine(text) {
    var value = String(text === null || text === undefined ? '' : text);
    for (var i = 0; i < value.length; i++) {
      var code = value.codePointAt(i);
      if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) return false;
      if (code > 0xffff) i++;
    }
    return true;
  }

  function structureArray(value) { return Array.isArray(value) ? value : []; }

  function itemKey(entry) {
    return String((entry && entry.templateId) || '') + '\u0000' + String((entry && entry.itemCode) || '');
  }

  /** 머리 ∪ 내 초안. `sid`로 중복을 지우고 **머리의 바이트가 이긴다**(머리 행은 불변이다). */
  function liveEntries(head, draft) {
    var seen = Object.create(null);
    var out = [];
    structureArray(head).forEach(function (entry) {
      var sid = String((entry && entry.sid) || '');
      seen[sid] = true;
      out.push(entry);
    });
    structureArray(draft).forEach(function (entry) {
      var sid = String((entry && entry.sid) || '');
      if (seen[sid]) return;
      seen[sid] = true;
      out.push(entry);
    });
    return out;
  }

  var countLf = function (text) { return String(text).split('\n').length - 1; };

  function create(citationLib, catalog) {
    if (!citationLib) throw new Error('report-structure: citation library is required');
    var list = Object.freeze((catalog || []).slice());

    function findTemplate(templateId) {
      for (var i = 0; i < list.length; i++) if (list[i].templateId === templateId) return list[i];
      return null;
    }
    function findItem(templateId, itemCode) {
      var template = findTemplate(templateId);
      var items = (template && template.items) || [];
      for (var i = 0; i < items.length; i++) if (items[i].code === itemCode) return items[i];
      return null;
    }

    /** 값 하나를 사람이 읽는 글자로. 서버 `valueText`와 **같은 답**이어야 한다. */
    function valueText(item, value) {
      if (!item) return null;
      if (item.valueType === 'choice') {
        var choices = item.choices || [];
        for (var i = 0; i < choices.length; i++) if (choices[i].code === value) return choices[i].text;
        return null;
      }
      if (item.valueType === 'boolean') return value ? String(item.trueText) : String(item.falseText);
      if (item.valueType === 'number') {
        if (typeof value !== 'number' || !isFinite(value)) return null;
        return value.toFixed(item.decimals || 0);
      }
      return String(value);
    }

    /** 본문에 들어갈 그 한 줄. 화면이 보여주는 글자와 서버에 보내는 글자는 이 함수 하나에서 나온다. */
    function renderItem(item, value) {
      var text = valueText(item, value);
      if (text === null) return null;
      // 서버 `renderItem`과 같은 이유로 `String.replace`의 문자열 치환을 쓰지 않는다:
      // 치환 문자열의 `$$`·`$&`·`` $` ``·`$'`가 패턴으로 해석되어, 사람이 친 글자와 본문에
      // 들어가는 글자가 달라진다. 자리를 직접 잘라 붙이면 그 해석이 아예 없다.
      var template = String(item.template);
      var at = template.indexOf(VALUE_SLOT);
      if (at < 0) return null;
      return template.slice(0, at) + text + template.slice(at + VALUE_SLOT.length);
    }

    /** 값의 타입 검사. 통과하면 `null`, 아니면 사용자에게 보일 한국어 한 줄. */
    function validateValue(item, value) {
      if (!item) return MSG.empty;
      if (item.valueType === 'choice') {
        var choices = item.choices || [];
        for (var i = 0; i < choices.length; i++) if (choices[i].code === value) return null;
        return MSG.choice;
      }
      if (item.valueType === 'boolean') return typeof value === 'boolean' ? null : MSG.empty;
      if (item.valueType === 'number') {
        if (typeof value !== 'number' || !isFinite(value)) return MSG.number;
        if (value < item.min || value > item.max) return '값은 ' + item.min + '..' + item.max + ' 범위여야 합니다';
        if (Number(value.toFixed(item.decimals || 0)) !== value)
          return '소수 ' + (item.decimals || 0) + '자리까지 입력할 수 있습니다';
        return null;
      }
      if (typeof value !== 'string' || !value.length) return MSG.empty;
      if (citationLib.blockIsBlank(value)) return MSG.empty;
      if (!isSingleLine(value)) return MSG.oneLine;
      if (utf8Bytes(value) > LIMITS.renderedText) return MSG.tooLong;
      return null;
    }

    /**
     * 새 항목이 들어갈 자리. **U6의 `placeBlock` 그대로**이고 보호 구간도 인용의 것을
     * 그대로 받는다(P10) — v1의 문장이 한 줄이라 보호 구간을 넓힐 이유가 없다.
     */
    function placePlan(text, block, at, guards) {
      var plan = citationLib.placeBlock(text, block, at, guards);
      plan.mode2 = 'place';
      plan.removedLine = null;
      return plan;
    }

    /**
     * 값을 고칠 때의 계획.
     *
     * 옛 문장이 **정확히 한 번** 있을 때만 그 자리에서 바꾼다. 0번이면(사람이 지웠다) 새 문장을
     * 커서 자리에 넣는다 — 아무것도 지우지 않는다. 2번 이상이면 어느 것이 이 항목의 것인지
     * 말할 수 없으므로 **아무것도 보내지 않고** 거절한다. 인용된 블록 안이면 같은 이유로 거절한다.
     */
    function replacePlan(text, oldBlock, newBlock, at, guards) {
      var value = text === null || text === undefined ? '' : String(text);
      var occurrences = citationLib.lineBlockOccurrences(value, oldBlock);
      if (occurrences >= 2) return { mode2: 'refuse', message: MSG.ambiguous };
      if (occurrences === 0) return placePlan(value, newBlock, at, guards);
      if (countLf(value) !== countLf(citationLib.normalizeForCompare(value)))
        return { mode2: 'refuse', message: MSG.lineEndings };
      var span = citationLib.blockSpans(value, oldBlock)[0];
      var from = span[0], to = span[1];
      var blocked = (guards || []).some(function (guard) {
        return citationLib.blockSpans(value, guard).some(function (g) { return g[0] < to && from < g[1]; });
      });
      if (blocked) return { mode2: 'refuse', message: MSG.guarded };
      var lines = value.split('\n');
      var before = lines.slice(0, from);
      var after = lines.slice(to);
      var inserted = String(newBlock).split('\n');
      var start = before.join('\n').length + (before.length ? 1 : 0);
      return {
        mode2: 'replace',
        text: before.concat(inserted, after).join('\n'),
        start: start,
        end: start + String(newBlock).length,
        line: from + 1,
        removedLine: from + 1,
        anchor: null,
        snapped: null,
      };
    }

    /** 두 계획이 같은가. 열어둔 사이에 본문·커서·보호 구간이 바뀌었는지 이것으로만 판정한다. */
    function samePlan(a, b) {
      if (!a || !b) return false;
      return a.mode2 === b.mode2 && a.text === b.text && a.start === b.start && a.end === b.end
        && a.line === b.line && a.removedLine === b.removedLine;
    }

    /** 저장된 건이 지금 서식으로 편집 가능한가. 아니면 값은 보존한 채 읽기 전용으로만 보인다. */
    function unknownRevision(entry) {
      var template = findTemplate(String((entry && entry.templateId) || ''));
      if (!template) return true;
      if (template.revision !== (entry && entry.templateRevision)) return true;
      return !findItem(entry.templateId, entry.itemCode);
    }

    return {
      catalog: list,
      empty: list.length === 0,
      templates: function () { return list.slice(); },
      findTemplate: findTemplate,
      findItem: findItem,
      valueText: valueText,
      renderItem: renderItem,
      validateValue: validateValue,
      placePlan: placePlan,
      replacePlan: replacePlan,
      samePlan: samePlan,
      unknownRevision: unknownRevision,
      liveEntries: liveEntries,
      itemKey: itemKey,
      messages: MSG,
    };
  }

  /**
   * 검사별 구조화 상태. 인용과 같은 이유로 `appState[uid].draft` **바깥**에 산다 —
   * 초안 객체는 저장할 때마다 새로 만들어지고 서버 투영이 통째로 갈아끼운다.
   *
   * **사라진 것과 아직 모르는 것은 다르다.** 확인되지 않은 동안 `keepIds`는 `undefined`이고,
   * 그러면 자동 저장이 `structureIds` 키를 아예 보내지 않아 아무것도 지우지 않는다.
   * `[]`는 "내 초안의 구조화 건을 전부 지워라"라는 뜻이라서 지어낼 수 없다.
   */
  function createState() {
    var rows = new Map();
    return {
      known: function (uid) { var row = rows.get(uid); return !!row && row.confirmed; },
      get: function (uid) { return rows.get(uid) || null; },
      confirm: function (uid, answer) {
        if (!uid || !answer || typeof answer !== 'object') return false;
        // 서버가 "모른다"고 답하면 우리도 모르는 것이다. 목록을 지어내지 않는다.
        if (answer.unknown === true) {
          rows.set(uid, { confirmed: false, unknown: true, version: 0, head: [], draft: [] });
          return true;
        }
        rows.set(uid, {
          confirmed: true, unknown: false,
          version: Number.isSafeInteger(answer.version) ? answer.version : 0,
          head: structureArray(answer.head), draft: structureArray(answer.draft),
        });
        return true;
      },
      unconfirm: function (uid) {
        var row = rows.get(uid);
        if (!row || !row.confirmed) return false;
        row.confirmed = false;
        return true;
      },
      /** 빈 PUT이 행을 지웠다 — 그 행의 건도 함께 없어진 것이 **사실**이다. */
      emptied: function (uid) {
        var row = rows.get(uid);
        if (!row) return false;
        row.draft = [];
        return true;
      },
      forget: function (uid) { return rows.delete(uid); },
      keepIds: function (uid) {
        var row = rows.get(uid);
        if (!row || !row.confirmed) return undefined;
        return row.draft.map(function (entry) { return String((entry && entry.sid) || ''); });
      },
    };
  }

  var api = {
    create: create,
    createState: createState,
    PRODUCT_CATALOG: PRODUCT_CATALOG,
    VALUE_SLOT: VALUE_SLOT,
    LIMITS: LIMITS,
    FIELDS: FIELDS,
    VALUE_TYPES: VALUE_TYPES,
    SCHEMA: SCHEMA,
    MESSAGES: MSG,
    utf8Bytes: utf8Bytes,
    isSingleLine: isSingleLine,
    structureArray: structureArray,
    itemKey: itemKey,
    liveEntries: liveEntries,
  };

  if (typeof window !== 'undefined') window.KinReportStructure = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

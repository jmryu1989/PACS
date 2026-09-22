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
    boundary: '이 값은 문장의 경계에서 앞뒤 글자와 합쳐져 다른 항목의 문장과 구분되지 않습니다 — 다른 표현을 쓰세요',
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

  /** 목록 검사가 어긴 규칙의 이름. 서버 `StructureRule`과 같은 다섯이다. */
  function CatalogError(rule, message) {
    this.name = 'KinStructureCatalogError';
    this.rule = rule;
    this.message = rule + ': ' + message;
  }
  CatalogError.prototype = Object.create(Error.prototype);
  CatalogError.prototype.constructor = CatalogError;

  /**
   * 담는 그릇도 규칙으로 거절한다 (P12 D1). 서버 `catalogArray`의 거울이다.
   *
   * `||`를 쓰면 `0`·`''`·`false`가 빈 배열로 둔갑해 **서버가 R-D를 주는 자리에서 화면만 통과한다.**
   * 서버는 `x ?? []`라서 null·undefined만 빈 배열이므로, 여기서도 같은 질문을 쓴다. 배열이 아닌
   * 그릇은 타입 있는 R-D다 — 그러지 않으면 `items: {}`가 `.length === undefined`로 조용히 건너뛰어
   * **닿을 수 없는 항목을 가진 목록이 살아 있는 형태로** 나가고, 배열이 아닌 목록은 `create()`의
   * `try` 밖에서 터져 이 스크립트 전체(워크리스트·판독문·자동 저장)를 함께 죽인다.
   */
  function catalogArray(value, message) {
    var list = value === null || value === undefined ? [] : value;
    if (!Array.isArray(list)) throw new CatalogError('R-D', message);
    return list;
  }

  function nfc(text) { return String(text === null || text === undefined ? '' : text).normalize('NFC'); }

  /** 짝 없는 서러게이트가 하나라도 있으면 온전한 UTF-16이 아니다 (R-D). 서버와 같은 규칙이다. */
  function wellFormedUtf16(text) {
    var value = String(text === null || text === undefined ? '' : text);
    for (var i = 0; i < value.length; i++) {
      var unit = value.charCodeAt(i);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        var next = value.charCodeAt(i + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
        i += 1;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    }
    return true;
  }

  /**
   * **경계 안정성** (R-S). 서버 `boundaryStable`과 같은 질문을 **같은 정규화기**에게 한다.
   *
   * 정규화는 경계를 넘어 합성한다 — 앞머리가 `ᄀ`(U+1100)로 끝나고 값이 `ᅡ`(U+1161)로 시작하면
   * NFC는 `가`(U+AC00) 하나를 만든다. 둘 다 결합 등급 0이라 문자 표로는 잡히지 않는다. 표를
   * 들추는 대신 실제 답을 대조한다: 이 문장의 키가 조각들의 키를 이어 붙인 것과 같은가.
   */
  function boundaryStable(citationLib, prefix, valueText, suffix) {
    return citationLib.comparisonKey(String(prefix) + String(valueText) + String(suffix))
      === nfc(prefix) + citationLib.comparisonKey(String(valueText)) + nfc(suffix);
  }

  function itemValueText(item, value) {
    if (item.valueType === 'choice') {
      var choices = item.choices || [];
      for (var i = 0; i < choices.length; i++) if (choices[i].code === value) return choices[i].text;
      return null;
    }
    if (item.valueType === 'boolean') return value ? String(item.trueText) : String(item.falseText);
    if (item.valueType === 'number') return Number(value).toFixed(item.decimals || 0);
    return String(value);
  }

  /**
   * 서버 `validateCatalog`의 거울. 같은 다섯 규칙을 **같은 순서**(R-D → R-S → R-C → 쌍 R-A → R-B)로
   * 보고, 어긴 규칙의 이름을 들고 던진다. 두 벌이 갈라지지 않게 묶는 것은 공용 벡터 파일이다.
   */
  function validateCatalog(citationLib, catalog) {
    var templateIds = Object.create(null);
    var flat = [];
    var list = catalogArray(catalog, '서식 목록은 배열이어야 합니다');
    for (var t = 0; t < list.length; t++) {
      var template = list[t];
      /**
       * 서버는 `template?.templateId`라서 `null`·구멍(`[a, , b]`)·원시값에 **타입 있는 R-D**를 준다.
       * 여기서 그냥 파고들면 `TypeError`가 나고, 그것은 `CatalogError`가 아니라서 `create()`가
       * 다시 던진다 — 그러면 서식 목록 하나 때문에 `main.html`의 스크립트 전체가 죽는다(B3/F4가
       * 막으려는 바로 그 모양이다). 거울이 되려면 여기서도 **규칙 이름을 들고** 거절해야 한다.
       */
      if (!template || typeof template.templateId !== 'string' || !template.templateId)
        throw new CatalogError('R-D', 'templateId가 필요합니다');
      if (templateIds[template.templateId])
        throw new CatalogError('R-D', 'templateId가 중복입니다: ' + template.templateId);
      templateIds[template.templateId] = true;
      if (!Number.isSafeInteger(template.revision) || template.revision < 1)
        throw new CatalogError('R-D', 'revision은 1 이상의 정수여야 합니다: ' + template.templateId);
      if (typeof template.title !== 'string' || !template.title)
        throw new CatalogError('R-D', 'title이 필요합니다: ' + template.templateId);

      var codes = Object.create(null);
      var items = catalogArray(template.items, '서식의 items는 배열이어야 합니다: ' + template.templateId);
      for (var n = 0; n < items.length; n++) {
        var item = items[n];
        var where = template.templateId + '/' + ((item && item.code) || '(code 없음)');

        // 서버 `item?.code`와 같은 자리, 같은 규칙. `null` 항목도 배열의 구멍도 여기서 걸린다.
        if (!item || typeof item.code !== 'string' || !item.code)
          throw new CatalogError('R-D', '항목 code가 필요합니다: ' + template.templateId);
        if (codes[item.code]) throw new CatalogError('R-D', '항목 code가 중복입니다: ' + where);
        codes[item.code] = true;
        if (FIELDS.indexOf(item.field) < 0) throw new CatalogError('R-D', '항목 field가 잘못됐습니다: ' + where);
        if (VALUE_TYPES.indexOf(item.valueType) < 0)
          throw new CatalogError('R-D', '항목 valueType이 잘못됐습니다: ' + where);
        if (typeof item.label !== 'string' || !item.label)
          throw new CatalogError('R-D', '항목 label이 필요합니다: ' + where);
        if (typeof item.template !== 'string' || item.template.split(VALUE_SLOT).length !== 2)
          throw new CatalogError('R-D', '항목 template에는 ' + VALUE_SLOT + '가 정확히 한 번 있어야 합니다: ' + where);
        var split = item.template.split(VALUE_SLOT), prefix = split[0], suffix = split[1];
        if (!isSingleLine(prefix + suffix))
          throw new CatalogError('R-D', '항목 template은 한 줄이어야 합니다: ' + where);
        if (!wellFormedUtf16(prefix) || !wellFormedUtf16(suffix))
          throw new CatalogError('R-D', '항목 template이 온전한 UTF-16이 아닙니다: ' + where);
        if (nfc(prefix) !== prefix || nfc(suffix) !== suffix)
          throw new CatalogError('R-D', '항목 template의 고정 문자열이 NFC가 아닙니다: ' + where);
        if (utf8Bytes(prefix + suffix) >= LIMITS.renderedText)
          throw new CatalogError('R-D',
            '앞뒤 고정 문자열이 ' + LIMITS.renderedText + '바이트를 채워 값이 들어갈 자리가 없습니다: ' + where);

        var values = [];
        if (item.valueType === 'choice') {
          var choices = catalogArray(item.choices, 'choice 항목의 선택지는 배열이어야 합니다: ' + where);
          if (!choices.length) throw new CatalogError('R-D', 'choice 항목에 선택지가 없습니다: ' + where);
          var seenCode = Object.create(null);
          for (var c = 0; c < choices.length; c++) {
            var choice = choices[c];
            // 서버 `choice?.code` / `choice?.text`와 같다.
            if (!choice || typeof choice.code !== 'string' || !choice.code
                || typeof choice.text !== 'string' || !choice.text)
              throw new CatalogError('R-D', '선택지 code·text가 필요합니다: ' + where);
            if (!wellFormedUtf16(choice.text))
              throw new CatalogError('R-D', '선택지 text가 온전한 UTF-16이 아닙니다: ' + where);
            if (seenCode[choice.code]) throw new CatalogError('R-D', '선택지 code가 중복입니다: ' + where);
            seenCode[choice.code] = true;
            values.push(choice.code);
          }
        } else if (item.valueType === 'boolean') {
          if (typeof item.trueText !== 'string' || !item.trueText
              || typeof item.falseText !== 'string' || !item.falseText)
            throw new CatalogError('R-D', 'boolean 항목에는 trueText·falseText가 필요합니다: ' + where);
          if (!wellFormedUtf16(item.trueText) || !wellFormedUtf16(item.falseText))
            throw new CatalogError('R-D', 'boolean 낱말이 온전한 UTF-16이 아닙니다: ' + where);
          values = [true, false];
        } else if (item.valueType === 'number') {
          /**
           * 전역 `isFinite`는 **값을 숫자로 바꿔 보고** 판단한다 — `null`도 `'12'`도 통과시킨다.
           * 서버는 `Number.isFinite`라 둘 다 R-D다. 범위가 충돌 안전에 쓰이지는 않지만 두 벌이
           * 갈라지면 화면이 받은 서식을 서버가 거절하는 일이 생기므로 같은 질문을 쓴다.
           */
          if (!Number.isFinite(item.min) || !Number.isFinite(item.max) || item.min > item.max)
            throw new CatalogError('R-D', 'number 항목에는 min <= max가 필요합니다: ' + where);
          if (!Number.isSafeInteger(item.decimals) || item.decimals < 0 || item.decimals > 6)
            throw new CatalogError('R-D', 'number 항목의 decimals는 0..6이어야 합니다: ' + where);
        }

        for (var v = 0; v < values.length; v++)
          if (!boundaryStable(citationLib, prefix, itemValueText(item, values[v]), suffix))
            throw new CatalogError('R-S', '정규화가 문장의 경계를 넘어 합쳐집니다 — 그 값의 문면을 바꾸세요: ' + where);

        var lines = Object.create(null), lineList = [];
        for (var w = 0; w < values.length; w++) {
          var line = prefix + itemValueText(item, values[w]) + suffix;
          if (!isSingleLine(line) || citationLib.blockIsBlank(line))
            throw new CatalogError('R-D', '서식 문장이 한 줄의 글이 아닙니다: ' + where);
          if (utf8Bytes(line) > LIMITS.renderedText)
            throw new CatalogError('R-D', '서식 문장이 ' + LIMITS.renderedText + '바이트를 넘습니다: ' + where);
          var key = citationLib.comparisonKey(line);
          if (lines[key])
            throw new CatalogError('R-C',
              '한 항목의 두 값이 같은 문장을 만듭니다 — 기록된 값을 문장에서 되짚을 수 없습니다: ' + where);
          lines[key] = true;
          lineList.push(key);
        }

        flat.push({ id: where, field: item.field, prefix: prefix, suffix: suffix,
                    enumerable: values.length > 0 && item.valueType !== 'number' && item.valueType !== 'text',
                    lines: lines, lineList: lineList });
      }
    }

    for (var i = 0; i < flat.length; i++)
      for (var j = i + 1; j < flat.length; j++) {
        var a = flat[i], b = flat[j];
        if (a.field !== b.field) continue;
        if (a.enumerable && b.enumerable) {
          for (var k = 0; k < a.lineList.length; k++)
            if (b.lines[a.lineList[k]])
              throw new CatalogError('R-A', '서로 다른 항목이 같은 문장을 만듭니다: ' + a.id + ' / ' + b.id);
          continue;
        }
        var prefixSeparates = a.prefix.indexOf(b.prefix) !== 0 && b.prefix.indexOf(a.prefix) !== 0;
        var suffixSeparates = !endsWith(a.suffix, b.suffix) && !endsWith(b.suffix, a.suffix);
        if (!prefixSeparates && !suffixSeparates)
          throw new CatalogError('R-B',
            '두 항목의 문장을 앞머리로도 꼬리로도 가를 수 없습니다 — 한쪽 문면을 바꾸세요: ' + a.id + ' / ' + b.id);
      }
  }

  function endsWith(text, tail) {
    return tail.length <= text.length && text.slice(text.length - tail.length) === tail;
  }

  /**
   * 목록이 규칙을 어기면 **닫힌 형태**로 돌아간다 — 예외를 밖으로 내보내지 않는다 (B3).
   *
   * 이 파일은 `main.html`의 한 스크립트 안에서 최상위로 불린다. 여기서 던지면 그 스크립트 전체가
   * 적재되다 말고, 구조화와 아무 상관 없는 자동 저장·워크리스트까지 함께 죽는다. 그래서 목록
   * 검사 실패만 잡아 **빈 목록과 같은 무력한 형태**를 돌려주고(그러면 단추가 아예 그려지지 않는다)
   * `invalid`에 어긴 규칙을 적어 남긴다. 프로그래밍 오류는 잡지 않는다 — 그것은 드러나야 한다.
   * 정상적인 빈 목록은 아무 말도 하지 않는다.
   */
  function create(citationLib, catalog) {
    if (!citationLib) throw new Error('report-structure: citation library is required');
    /**
     * 복사는 **검사를 통과한 뒤에** 한다. `(catalog || []).slice()`를 `try` 앞에 두면 배열이 아닌
     * 목록에서 `slice`가 없어 `TypeError`가 나고, 그것은 `CatalogError`가 아니므로 아래 catch가
     * 다시 던진다 — 닫힌 형태로 물러서려고 만든 길이 바로 그 자리에서 페이지를 죽인다.
     */
    var wanted = catalog === null || catalog === undefined ? [] : catalog;
    var invalid = null;
    try {
      validateCatalog(citationLib, wanted);
      wanted = wanted.slice();
    } catch (e) {
      if (!(e instanceof CatalogError)) throw e;
      invalid = e.message;
      wanted = [];
      if (typeof console !== 'undefined' && console.error)
        console.error('report-structure: 구조화 서식 목록을 쓰지 않습니다 — ' + e.message);
    }
    var list = Object.freeze(wanted);

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

    function typeMessage(item, value) {
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
     * 값의 검사. 통과하면 `null`, 아니면 사용자에게 보일 한국어 한 줄.
     *
     * 마지막이 **경계 안정성**(R-S)이다. 자유 입력 값은 목록이 검사될 때가 아니라 사람이 치는
     * 순간 처음 나타나므로, 경계에서 합쳐지는 값은 여기서 막는다 — 값을 고쳐 주지 않는다.
     * 계획(`placePlan`/`replacePlan`)이 아니라 값 검사에 둔다: 자리가 아니라 값의 성질이다.
     */
    function validateValue(item, value) {
      var message = typeMessage(item, value);
      if (message) return message;
      var split = String(item.template).split(VALUE_SLOT);
      if (split.length !== 2) return MSG.empty;
      if (!boundaryStable(citationLib, split[0], itemValueText(item, value), split[1])) return MSG.boundary;
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
      // 유효한 빈 목록과 거절된 목록은 다르다: 전자는 `undefined`, 후자는 '<규칙>: <사유>'.
      invalid: invalid === null ? undefined : invalid,
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
    validateCatalog: validateCatalog,
    CatalogError: CatalogError,
    wellFormedUtf16: wellFormedUtf16,
    boundaryStable: boundaryStable,
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

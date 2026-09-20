/* Report citations on the screen (S3-U2b). Pure: no DOM, no fetch, no storage.
 *
 * 이 파일은 서버의 `api/src/report-citation.ts`와 **같은 규칙의 두 번째 구현**이다.
 * 두 구현이 갈라지면 사람은 "같은 문장인데 한쪽은 그대로 있다고 하고 한쪽은 없다고 한다"를
 * 본다. 그래서 규칙은 여기서 다시 쓰되 **같은 벡터 파일**(`tests/report_citation_vectors.json`)이
 * 양쪽의 신탁이고, 어긋나면 시험이 깨진다.
 *
 * 저장하는 것은 동결 사본이 아니라 포인터 + 서버 증언이다. 화면은 증언을 만들지 않는다 —
 * `cid`·사람·시각·링크 상태·머리 판은 전부 서버가 쓰고, 화면은 그것을 **보여주기만** 한다.
 */
window.KinReportCitation = (function () {
  'use strict';

  /** 저장 형식의 판. 서버의 `REPORT_CITATION_SCHEMA`와 같아야 한다. */
  const SCHEMA = 2;
  const FIELDS = Object.freeze(['findings', 'conclusion', 'recommendation']);
  const FIELD_LABEL = Object.freeze({ findings: 'Findings', conclusion: 'Conclusion', recommendation: 'Recommendation' });
  /** 서버의 `REPORT_CITATION_LIMITS.insertedText`와 같은 바이트 한도. */
  const INSERTED_TEXT_BYTES = 4096;
  /** 읽을 수 없는 건에 서버가 다는 단 하나의 중립 상태. 거절인지 부재인지 말하지 않는다. */
  const SOURCE_UNAVAILABLE = 'source-unavailable';

  /**
   * 비교할 때만 쓰는 정규화. **저장된 바이트는 정규화하지 않는다** — 의무기록의 글자를
   * 바꾸는 일이기 때문이다. CRLF와 홀로 있는 CR까지 LF로 모으고 NFC로 맞춘다.
   * 같은 등식이 `k`(본문 출현 수)와 `n`(같은 글 인용 수) 양쪽에 쓰인다.
   */
  function normalizeForCompare(text) {
    return toLf(text).normalize('NFC');
  }
  /**
   * 줄 끝만 모은다. R5의 조립은 "CRLF와 홀로 있는 CR만 LF로 바꾸고 **나머지 글자는 전부
   * 보존**"이므로 NFC까지 걸면 사용자가 쓴 글자를 조합 형태까지 바꿔 넣게 된다.
   */
  function toLf(text) {
    return String(text === null || text === undefined ? '' : text).replace(/\r\n?/g, '\n');
  }

  /**
   * 줄 블록 = 한 줄 이상의 **연속된 완전한 줄**.
   *
   * 블록 끝의 LF는 빈 줄이 아니라 마지막 줄의 **종결자**다. 그러지 않으면 사용자가 삽입된
   * 문장 바로 아래에 이어 치는 순간 `present`가 `absent`로 뒤집힌다 — 아무것도 지우지
   * 않았는데 "넣은 문장이 사라졌습니다"라고 말하게 된다.
   */
  function blockLines(block) {
    const lines = normalizeForCompare(block).split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  /** 공백만인 블록은 아무것도 세지 않고 삽입도 하지 않는다. 아무 빈 줄이나 조건을 만족시킨다. */
  function blockIsBlank(block) {
    return normalizeForCompare(block).trim() === '';
  }

  /**
   * 한 칸 안에서 그 줄 블록이 **겹치지 않게** 몇 번 나오는지. 부분 문자열 일치는 쓰지 않는다 —
   * 더 긴 토큰 안의 조각이나 부정 접두사가 붙은 줄을 "그대로 있다"고 말하면 안 되기 때문이다.
   */
  function lineBlockOccurrences(body, block) {
    if (blockIsBlank(block)) return 0;
    const want = blockLines(block);
    if (!want.length) return 0;
    const lines = normalizeForCompare(body).split('\n');
    let count = 0;
    for (let i = 0; i + want.length <= lines.length;) {
      let hit = true;
      for (let j = 0; j < want.length; j++) if (lines[i + j] !== want[j]) { hit = false; break; }
      if (hit) { count += 1; i += want.length; } else i += 1;
    }
    return count;
  }

  /** `n`과 `k`는 같은 등식을 써야 한다. 저장된 바이트는 건드리지 않는 **비교용 키**일 뿐이다. */
  function comparisonKey(text) {
    return blockLines(text).join('\n');
  }

  /**
   * 어휘는 셋이고 전부 중립이다. `present`는 **주변 문장에 대해 아무것도 말하지 않는다.**
   * `n`은 인용 집합의 성질이고 `k`는 본문의 출현 수다 — 편집 중에는 `k`만 변한다.
   */
  function presenceState(occurrences, sameTextCount) {
    if (occurrences <= 0) return 'absent';
    return occurrences >= sameTextCount ? 'present' : 'ambiguous';
  }

  const STATE_TEXT = Object.freeze({
    present: '넣은 문자열이 이 칸에 그대로 있습니다',
    absent: '넣은 문자열이 이 칸에 더는 없습니다',
    ambiguous: '같은 문장이 여러 건 인용되어 있어 개별 대응을 확인할 수 없습니다',
  });
  /** 축약된 건은 중립 상태만 보이고 본문 대조를 주장하지 않는다. */
  const UNAVAILABLE_TEXT = '이 인용의 소견을 지금 확인할 수 없습니다 — 판독문과 증언은 그대로 있습니다';
  const PRESENT_CAVEAT = '‘그대로 있습니다’는 그 문장에 대한 것이며, 주변 문장에 대해서는 아무것도 말하지 않습니다.';

  /** 서버가 축약해 보낸 건인가. 축약된 건에는 `insertedText`가 없다. */
  function isReduced(entry) {
    return !entry || entry.state === SOURCE_UNAVAILABLE || typeof entry.insertedText !== 'string';
  }

  /**
   * 한 건의 본문 존재 상태. **표시 시점에 계산하고 저장하지 않는다.**
   * `sameTextCount`는 서버가 그 행 **전체**(축약된 건 포함)에서 센 값이다 — 화면이 자기가
   * 받은 건수로 세면 축약된 건이 빠져 `ambiguous`여야 할 것이 `present`로 보인다.
   */
  function presenceOf(entry, body) {
    if (isReduced(entry)) return null;
    const n = Number.isSafeInteger(entry.sameTextCount) && entry.sameTextCount > 0 ? entry.sameTextCount : 1;
    return presenceState(lineBlockOccurrences(body, entry.insertedText), n);
  }

  /**
   * R5의 **단 하나의 결정적 서식**: 고른 소견 판의 제목·본문·특성을 그 순서로.
   *
   * 줄 끝만 LF로 모으고 나머지 글자는 전부 보존한다. 길이가 0인 칸만 빼고, 특성이 있으면
   * 정확히 `특성: `를 앞에 붙이며, 포함된 블록은 LF 하나로 잇는다. 문장 끝맺음·수치 해석·
   * 진단·출처 설명·작성자·시각·소견 식별자를 **더하지 않는다** — 판독문에 들어가는 글은
   * 사람이 쓴 소견 그대로여야 하고, 기계가 덧붙인 한 문장이 임상 주장이 된다.
   * 공백만 남으면 `null`이다. 꾸며낸 대체 문장은 없다.
   */
  function assembleBlock(source) {
    const blocks = [];
    for (const [value, prefix] of [[source && source.title, ''], [source && source.text, ''],
                                   [source && source.characteristics, '특성: ']]) {
      if (value === null || value === undefined) continue;
      const normalized = toLf(value);
      if (!normalized.length) continue;
      blocks.push(prefix + normalized);
    }
    const joined = blocks.join('\n');
    return blockIsBlank(joined) ? null : joined;
  }

  /**
   * 기존 판독문을 보존하고 그 아래에 붙인다. 칸이 비어 있지 않으면 LF 하나를 먼저 넣는다.
   * **구분자는 `insertedText` 바깥**이다 — 증언이 가리키는 바이트는 미리보기가 보인 그 블록뿐이다.
   */
  function appendBlock(current, block) {
    const text = current === null || current === undefined ? '' : String(current);
    return text ? text + '\n' + block : String(block);
  }

  /** UTF-8 바이트. 한도는 서버가 재는 것과 같은 자여야 한다. */
  function utf8Bytes(text) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(String(text)).length;
    return unescape(encodeURIComponent(String(text))).length;
  }

  /**
   * 삽입 전에 **글을 바꾸기도 전에** 거절해야 하는 것들. 잘라내지 않는다 —
   * 사람이 소견을 고쳐 다시 미리보기를 여는 것이 출구다.
   */
  function refuseBlock(block) {
    if (block === null || block === undefined || blockIsBlank(block))
      return '인용할 내용이 없습니다 — 소견에 제목·본문·특성 중 하나는 있어야 합니다';
    if (utf8Bytes(block) > INSERTED_TEXT_BYTES)
      return `삽입할 내용이 ${INSERTED_TEXT_BYTES}바이트를 넘습니다 — 소견을 줄인 뒤 다시 시도하세요`;
    return null;
  }

  const cidOf = entry => String((entry && entry.cid) || '');
  const asArray = value => (Array.isArray(value) ? value : []);

  /**
   * **`appState[uid].draft` 바깥의 uid별 인용 상태** (D8).
   *
   * 초안 객체는 저장할 때마다 새로 만들어지고 서버 투영이 통째로 갈아끼우므로, 초안 안에
   * 인용을 두면 그 집합이 조용히 사라진다. 그리고 사라진 것과 **아직 모르는 것**은 다르다 —
   * 모르면 `citationIds` 키를 **아예 보내지 않는다.** `[]`를 보내면 "내 초안의 인용을 전부
   * 지워라"라는 뜻이고, 화면이 확인한 적도 없는 증언을 지우게 된다.
   */
  function createState() {
    const rows = new Map();

    const state = {
      /** 이 검사의 인용을 전용 읽기로 **확인한 적이 있는가.** 없으면 어떤 키도 만들지 않는다. */
      known(uid) { return rows.has(uid); },
      get(uid) { return rows.get(uid) || null; },

      /** 전용 읽기의 답. 이것만이 "확인됨"을 만든다. */
      confirm(uid, answer) {
        if (!uid || !answer || typeof answer !== 'object') return false;
        const previous = rows.get(uid);
        const head = asArray(answer.head), draft = asArray(answer.draft);
        // 머리 건의 제거 표시는 사람이 고른 것이다. 다시 읽었다고 지우지 않되,
        // 더는 머리에 없는 `cid`는 의미가 없으므로 함께 사라진다.
        const alive = new Set(head.map(cidOf));
        const remove = new Set([...((previous && previous.remove) || [])].filter(cid => alive.has(cid)));
        rows.set(uid, { version: Number.isSafeInteger(answer.version) ? answer.version : 0, head, draft, remove });
        return true;
      },

      /**
       * 삽입 200은 **이미 확인된 상태를 넓히기만** 한다 (B2). 확인 전이었다면 아무것도
       * 만들지 않는다 — 한 건짜리 목록을 지어내면 그 다음 자동 저장의 유지 목록이
       * 화면이 본 적 없는 나머지 건을 전부 지운다.
       */
      extend(uid, entry) {
        const row = rows.get(uid);
        if (!row || !entry || !cidOf(entry)) return false;
        if (row.draft.some(item => cidOf(item) === cidOf(entry))) return false;
        row.draft = [...row.draft, entry];
        // 같은 글을 가진 건이 늘면 `n`도 함께 는다. 서버가 다음 읽기에서 다시 세지만,
        // 그때까지 화면이 `present`라고 말하면 실제로는 `ambiguous`인 것을 감춘다.
        recount(row.draft);
        return true;
      },

      /** 비운 초안은 서버에서 행이 지워진다 — 그 행의 인용도 함께 없어진 것이 사실이다. */
      emptied(uid) {
        const row = rows.get(uid);
        if (!row) return false;
        row.draft = [];
        return true;
      },

      /** 내 초안 건에 대한 **유지 목록**. 모르면 `undefined`(키 부재 = 변경 없음). */
      keepIds(uid) {
        const row = rows.get(uid);
        if (!row) return undefined;
        // 존재 상태가 `absent`·`ambiguous`거나 소견을 읽을 수 없다고 해서 빼지 않는다.
        // 조용한 삭제는 증언을 지우는 일이고, 명시적 제거만이 출구다.
        return row.draft.map(cidOf).filter(Boolean);
      },

      /** 머리 판 건에 대한 **명시적 제거 의사**. 고른 것이 없으면 키를 만들지 않는다. */
      removeIds(uid) {
        const row = rows.get(uid);
        if (!row || !row.remove.size) return undefined;
        return [...row.remove];
      },

      marked(uid, cid) {
        const row = rows.get(uid);
        return !!row && row.remove.has(String(cid));
      },
      mark(uid, cid, on) {
        const row = rows.get(uid);
        if (!row) return false;
        const key = String(cid);
        if (!row.head.some(entry => cidOf(entry) === key)) return false;
        if (on) row.remove.add(key); else row.remove.delete(key);
        return true;
      },

      /**
       * 같은 칸에 같은 `(소견, 판, 출처)`를 이미 인용했는가. 거절이 아니라 **한 번 경고**의
       * 근거다(§6). 다른 칸의 중복은 경고하지 않는다.
       */
      duplicate(uid, field, request) {
        const row = rows.get(uid);
        if (!row || !request) return false;
        return row.draft.some(entry => !isReduced(entry) && entry.field === field &&
          entry.findingId === request.findingId && entry.findingRevision === request.findingRevision &&
          entry.sourceIndex === request.sourceIndex);
      },

      /** 확정·초안 버리기처럼 두 행이 함께 움직인 뒤에는 다시 읽기 전까지 **모르는 상태**다. */
      forget(uid) { return rows.delete(uid); },
      clear() { rows.clear(); },
    };
    return state;
  }

  /** 삽입으로 늘어난 건을 반영해 `sameTextCount`를 그 행 안에서 다시 센다. */
  function recount(entries) {
    const tally = new Map();
    const keys = entries.map(entry => {
      if (isReduced(entry)) return null;
      const key = String(entry.field || '') + ' ' + comparisonKey(entry.insertedText);
      tally.set(key, (tally.get(key) || 0) + 1);
      return key;
    });
    entries.forEach((entry, i) => {
      if (keys[i] === null) return;
      entry.sameTextCount = tally.get(keys[i]);
    });
  }

  return Object.freeze({
    SCHEMA, FIELDS, FIELD_LABEL, INSERTED_TEXT_BYTES, SOURCE_UNAVAILABLE,
    STATE_TEXT, UNAVAILABLE_TEXT, PRESENT_CAVEAT,
    normalizeForCompare, toLf, blockLines, blockIsBlank, lineBlockOccurrences, comparisonKey,
    presenceState, presenceOf, isReduced, assembleBlock, appendBlock, utf8Bytes, refuseBlock,
    createState,
  });
})();

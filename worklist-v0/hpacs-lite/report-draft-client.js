/* 판독문 초안의 명령 프로토콜 (S7-U5, U5S-REQ-15·17). DOM을 쓰지 않는다 — 화면에 쓰는 일은 부른 쪽이 commit으로 한다.
 *
 * 초안을 바꾸는 모든 길(자동 저장·검사 이동·탭 닫기·재기준·인용 삽입·구조화 적용·로그아웃 준비의 보존·Recover Draft·
 * 초안 버리기·확정)이 이 한 경로로 간다. 요청마다 작성자(expectedOwner)와 그 글이 딛고 선 초안 revision(expectedRevision),
 * 그리고 **전체 원문**(세 칸·기준 판·유지할 인용과 구조화 목록 전부)을 싣는다. 서버는 저장된 revision이 그것과 같을 때만
 * 바꾸고 revision을 올린다. 그래서 순서가 뒤바뀐 요청·끊긴 뒤 늦게 닿은 요청·다른 탭의 쓰기는 서로를 조용히 덮지 못한다.
 *
 * 결과는 넷뿐이고 서로 바꿔 부르지 않는다.
 *   saved     200이고, 답의 봉투(uid·작성자·revision·전체 원문)가 보낸 것과 같다. 이것만 저장 확인이다.
 *   conflict  서버의 revision이 달랐다(409 REPORT_DRAFT_CONFLICT). 보낸 원문은 그대로 남기고 자동 쓰기를 멈춘다. 최신 상태를
 *             읽어 사람이 정한 뒤에만 다시 보낸다 — 새 revision을 얻어 그대로 다시 보내지 않는다.
 *   unknown   답을 받지 못했다(연결 끊김·시간 초과·앞단 502/504), 또는 200인데 봉투를 읽을 수 없거나 보낸 것과 다르다.
 *             저장됐을 수도 아닐 수도 있다. 전체 읽기(GET draft)가 작성자·검사·원문 전부의 일치를 보여 줄 때만 저장으로 본다.
 *   refused   서버가 이유를 대고 거절했다(권한·점유·형식). 아무것도 바뀌지 않았다.
 * 그 밖에 unsent(요청이 떠나지 않았다 — 문맥이 무효였다), owner(작성자가 지금 세션의 계정이 아니다), auth(인증 실패 —
 * 전송 계층이 그 요청의 세션으로 이미 알렸다)가 있다.
 *
 * 한 검사의 명령은 한 번에 하나만 나간다(다음 명령은 앞 명령이 올린 revision을 실어야 한다). 결과를 모르는 명령이 있었으면
 * 다음 명령은 먼저 전체 읽기로 서버 상태를 확인한다.
 */
(function (root) {
  'use strict';

  const FIELDS = ['findings', 'conclusion', 'recommendation'];
  // "<epoch>:<n>". 뜻은 서버의 것이고 여기서는 같은가와 같은 epoch 안의 앞뒤만 본다.
  const REVISION = /^([^:\s]+):(\d+)$/;

  const isRevision = value => typeof value === 'string' && REVISION.test(value);
  const idList = value => Array.isArray(value) && value.every(id => typeof id === 'string' && id.length > 0);
  const sameSet = (a, b) => a.length === b.length && a.every(id => b.includes(id)) && b.every(id => a.includes(id));

  function sameOwner(a, b) {
    return !!a && !!b && typeof a.sub === 'string' && a.sub === b.sub
      && (a.institution ?? null) === (b.institution ?? null) && a.author === b.author;
  }

  /** 원문 하나의 모양. 초안이 없는 상태는 null이다. */
  function validSnapshot(s) {
    return !!s && typeof s === 'object' && FIELDS.every(k => typeof s[k] === 'string')
      && Number.isSafeInteger(s.baseVersion) && s.baseVersion >= 0 && idList(s.citations) && idList(s.structured);
  }

  /** 두 원문이 **전부** 같은가: 세 칸의 글자, 기준 판, 인용과 구조화 목록. 둘 다 "초안 없음"이어도 같다. */
  function sameSnapshot(a, b) {
    if (a === null || b === null) return a === null && b === null;
    return validSnapshot(a) && validSnapshot(b) && FIELDS.every(k => a[k] === b[k]) && a.baseVersion === b.baseVersion
      && sameSet(a.citations, b.citations) && sameSet(a.structured, b.structured);
  }

  const emptyText = s => FIELDS.every(k => !s[k]);

  /** 답의 봉투 또는 전체 읽기의 본문: { uid, owner, revision, present, snapshot }. 모양이 다르면 null. */
  function envelopeOf(body) {
    if (!body || typeof body !== 'object' || typeof body.uid !== 'string' || !isRevision(body.revision)) return null;
    const owner = body.owner;
    if (!owner || typeof owner !== 'object' || typeof owner.sub !== 'string' || typeof owner.author !== 'string') return null;
    const updatedAt = typeof body.updatedAt === 'string' ? body.updatedAt : null;
    if (body.present === true && validSnapshot(body.snapshot))
      return { uid: body.uid, owner, revision: body.revision, present: true, snapshot: body.snapshot, updatedAt };
    if (body.present === false && (body.snapshot === null || body.snapshot === undefined))
      return { uid: body.uid, owner, revision: body.revision, present: false, snapshot: null, updatedAt: null };
    return null;
  }

  /** got이 expected와 같거나 같은 epoch에서 그 뒤인가. epoch이 다르면 그 사이 초안이 강제로 치워졌다 — 이어지지 않는다. */
  function notBefore(expected, got) {
    const a = REVISION.exec(expected || ''), b = REVISION.exec(got || '');
    return !!a && !!b && a[1] === b[1] && Number(b[2]) >= Number(a[2]);
  }

  function create(options = {}) {
    const { transport, base } = options;
    if (!transport || typeof transport.request !== 'function') throw new TypeError('KinReportDraftClient.create: a transport is required');
    if (typeof base !== 'string') throw new TypeError('KinReportDraftClient.create: the API base is required');
    const lines = new Map();

    function line(uid) {
      let found = lines.get(uid);
      if (!found) {
        found = { revision: null, lists: null, tail: Promise.resolve(), open: 0, uncertain: null, conflict: null };
        lines.set(uid, found);
      }
      return found;
    }

    const path = (uid, rest) => `${base}/studies/${encodeURIComponent(uid)}/${rest}`;

    /** 전송의 실패·거절을 결과로 옮긴다. 저장 확인은 여기서 나오지 않는다. */
    function failed(error) {
      return error && error.sent === false ? { outcome: 'unsent', error } : { outcome: 'unknown', error };
    }

    function refusal(answer) {
      if (answer.auth) return { outcome: 'auth', answer };
      if (answer.status === 409 && answer.code === 'REPORT_DRAFT_CONFLICT') return { outcome: 'conflict', answer };
      if (answer.status === 409 && answer.code === 'REPORT_DRAFT_OWNER_CHANGED') return { outcome: 'owner', answer };
      // 앞단 프록시가 대신 답한 것: 서버가 그 요청을 받았는지, 끝냈는지 알 수 없다.
      if (answer.status === 502 || answer.status === 504) return { outcome: 'unknown', answer };
      return { outcome: 'refused', answer, code: answer.code, message: answer.body && typeof answer.body.message === 'string'
        ? answer.body.message : `HTTP ${answer.status}` };
    }

    /** 전체 읽기(GET draft): 작성자의 지금 초안과 revision. 충돌·결과 모름 뒤에 서버 상태를 아는 유일한 길이다. */
    async function fetchDraft(uid, { context, session } = {}) {
      let answer;
      try { answer = await transport.request(path(uid, 'draft'), { context, session, abortWhenStale: false }); }
      catch (error) { return failed(error); }
      if (!answer.ok) return refusal(answer);
      const read = answer.incomplete ? null : envelopeOf(answer.body);
      return read && read.uid === uid ? { outcome: 'read', read } : { outcome: 'unknown', answer };
    }

    /**
     * 쓰기 하나를 보내고 그 답을 판정한다. 전제(작성자·revision)와 전체 원문은 받은 그대로 싣는다 — 여기서 고치거나 채우지
     * 않는다. `operation`은 같은 쓰기에 실리는 인용 삽입({ insert }) 또는 구조화 적용({ structure })이다.
     */
    async function put(uid, { owner, expectedRevision, snapshot, operation, context, session, keepalive }) {
      const body = {
        expectedOwner: { institution: owner.institution ?? null, sub: owner.sub, author: owner.author },
        expectedRevision,
        findings: snapshot.findings, conclusion: snapshot.conclusion, recommendation: snapshot.recommendation,
        baseVersion: snapshot.baseVersion, citationIds: [...snapshot.citations], structureIds: [...snapshot.structured],
        ...(operation || {}),
      };
      let answer;
      try {
        answer = await transport.request(path(uid, 'report'), { method: 'PUT', json: body, context, session,
          ...(keepalive ? { keepalive: true, deadlineMs: 0 } : {}) });
      } catch (error) { return failed(error); }
      if (!answer.ok) return refusal(answer);
      const envelope = answer.incomplete ? null : envelopeOf(answer.body);
      if (!envelope || envelope.uid !== uid || !sameOwner(envelope.owner, owner)) return { outcome: 'unknown', answer };
      // 서버가 기록했다고 답한 원문이 보낸 것과 전부 같아야 한다. 삽입·구조화는 서버가 지은 새 id가 목록에 더해진다.
      const inserted = operation && operation.insert ? answer.body.inserted : null;
      const applied = operation && operation.structure ? answer.body.applied : null;
      if (operation && operation.insert && !(inserted && typeof inserted.cid === 'string')) return { outcome: 'unknown', answer };
      if (operation && operation.structure && !(applied && typeof applied.sid === 'string')) return { outcome: 'unknown', answer };
      const replaced = operation && operation.structure ? operation.structure.replacesSid : undefined;
      const expected = emptyText(snapshot) ? null : {
        ...snapshot,
        citations: inserted ? [...snapshot.citations, inserted.cid] : snapshot.citations,
        structured: applied ? [...snapshot.structured.filter(sid => sid !== replaced), applied.sid] : snapshot.structured,
      };
      if (!sameSnapshot(envelope.snapshot, expected)) return { outcome: 'unknown', answer };
      return { outcome: 'saved', envelope, answer };
    }

    /** 초안을 버리거나(DELETE draft) 확정한다(POST commit). 둘 다 초안의 경계를 넘기므로 같은 전제를 싣는다. */
    async function end(uid, { method, rest, owner, expectedRevision, body, context }) {
      let answer;
      try {
        answer = await transport.request(path(uid, rest), { method, context, json: {
          ...(body || {}),
          expectedOwner: { institution: owner.institution ?? null, sub: owner.sub, author: owner.author },
          expectedRevision,
        } });
      } catch (error) { return failed(error); }
      if (!answer.ok) return refusal(answer);
      const envelope = answer.incomplete ? null : envelopeOf(answer.body);
      if (!envelope || envelope.uid !== uid || !sameOwner(envelope.owner, owner) || envelope.present
        || !answer.body.state || typeof answer.body.state !== 'object') return { outcome: 'unknown', answer };
      return { outcome: 'saved', envelope, state: answer.body.state, answer };
    }

    /** 한 검사의 명령을 차례로 세운다. 앞 명령의 결과(올라간 revision)를 본 뒤에 다음 명령이 전제를 정한다. */
    function queue(uid, run) {
      const own = line(uid);
      own.open += 1;
      const turn = own.tail.then(run, run).finally(() => { own.open -= 1; });
      own.tail = turn.then(() => {}, () => {});
      return turn;
    }

    /**
     * 결과를 모르는 앞선 쓰기가 있었으면 전체 읽기로 서버 상태를 확인한다. 그 쓰기가 기록됐으면 기준을 거기로 옮기고,
     * 기록되지 않았으면 그대로 간다(그 쓰기가 나중에 닿아도 revision이 달라 거절된다). 다른 내용이 기록돼 있으면 충돌이다.
     */
    async function settleUncertain(uid, own, owner, opts) {
      if (!own.uncertain) return null;
      const got = await fetchDraft(uid, opts);
      if (got.outcome !== 'read') return got;
      const read = got.read;
      if (!sameOwner(read.owner, owner)) return { outcome: 'owner' };
      if (read.revision === own.revision) {
        own.uncertain = null;
        own.lists = read.present ? { citations: [...read.snapshot.citations], structured: [...read.snapshot.structured] }
          : { citations: [], structured: [] };
        return null;
      }
      if (own.uncertain.snapshot !== undefined && sameSnapshot(read.snapshot, own.uncertain.snapshot)
        && notBefore(own.revision, read.revision)) {
        own.uncertain = null;
        own.revision = read.revision;
        own.lists = read.present ? { citations: [...read.snapshot.citations], structured: [...read.snapshot.structured] }
          : { citations: [], structured: [] };
        return null;
      }
      own.uncertain = null;
      own.conflict = { latest: read };
      return { outcome: 'conflict', latest: read };
    }

    /** 유지 목록의 기준(지금 revision에서 서버가 가진 인용·구조화 id 전부). 모르면 전체 읽기로 알아 온다. */
    async function settleLists(uid, own, owner, opts) {
      if (own.lists) return null;
      const got = await fetchDraft(uid, opts);
      if (got.outcome !== 'read') return got;
      const read = got.read;
      if (!sameOwner(read.owner, owner)) return { outcome: 'owner' };
      if (read.revision !== own.revision) {
        own.conflict = { latest: read };
        return { outcome: 'conflict', latest: read };
      }
      own.lists = read.present ? { citations: [...read.snapshot.citations], structured: [...read.snapshot.structured] }
        : { citations: [], structured: [] };
      return null;
    }

    function adopt(own, envelope) {
      own.revision = envelope.revision;
      own.lists = envelope.present ? { citations: [...envelope.snapshot.citations], structured: [...envelope.snapshot.structured] }
        : { citations: [], structured: [] };
      own.uncertain = null;
    }

    return Object.freeze({
      /**
       * 화면이 서버 상태로 편집기를 그렸다: 그 상태의 초안 revision이 이제 이 글의 기준이다. 나가 있는 명령이 있거나 결과를
       * 모르는 명령·충돌이 남아 있으면 바꾸지 않는다 — 그때의 기준은 그 명령들이 정한다.
       */
      observe(uid, revision) {
        const own = line(uid);
        if (own.open || own.uncertain || own.conflict) return false;
        if (!isRevision(revision)) {
          own.revision = null;
          own.lists = null;
          return false;
        }
        if (own.revision !== revision) own.lists = null;
        own.revision = revision;
        return true;
      },

      revision(uid) { return lines.has(uid) ? lines.get(uid).revision : null; },
      lists(uid) { const own = lines.get(uid); return own && own.lists ? { citations: [...own.lists.citations], structured: [...own.lists.structured] } : null; },
      busy(uid) { return lines.has(uid) && lines.get(uid).open > 0; },
      /** 지금 세워진 명령이 모두 끝날 때. 거절되지 않는다. */
      settled(uid) { return lines.has(uid) ? lines.get(uid).tail : Promise.resolve(); },
      uncertain(uid) { return lines.has(uid) && !!lines.get(uid).uncertain; },
      conflict(uid) { return lines.has(uid) ? lines.get(uid).conflict : null; },

      /** 편집기를 열 때 한 번: 유지 목록의 기준을 미리 알아 둔다(탭이 닫히는 순간에는 읽으러 갈 수 없다). */
      prime(uid, { context }) {
        return queue(uid, async () => {
          const own = line(uid);
          if (own.lists || !own.revision || own.conflict || own.uncertain) return { outcome: 'unsent' };
          const got = await fetchDraft(uid, { context });
          if (got.outcome === 'read' && got.read.revision === own.revision && !own.lists)
            own.lists = got.read.present ? { citations: [...got.read.snapshot.citations], structured: [...got.read.snapshot.structured] }
              : { citations: [], structured: [] };
          return got;
        });
      },

      read(uid, opts) { return fetchDraft(uid, opts || {}); },

      /**
       * 보존 쓰기(로그아웃 준비·Recover Draft)가 실을 기준을 정한다: 결과를 모르는 앞선 쓰기와 유지 목록을 전체 읽기로
       * 확인한 뒤의 revision과 목록. 서버에 다른 내용이 먼저 기록돼 있으면 conflict이고 기준은 바뀌지 않는다.
       */
      base(uid, { owner, context, session } = {}) {
        return queue(uid, async () => {
          const own = line(uid);
          if (own.conflict) return { outcome: 'conflict', latest: own.conflict.latest || null };
          if (!own.revision) return { outcome: 'refused', code: 'KIN_DRAFT_BASE_UNKNOWN', message: '이 검사의 초안 기준을 알 수 없습니다.' };
          const blocked = await settleUncertain(uid, own, owner, { context, session }) || await settleLists(uid, own, owner, { context, session });
          if (blocked) return blocked;
          return { outcome: 'ready', revision: own.revision,
            lists: { citations: [...own.lists.citations], structured: [...own.lists.structured] } };
        });
      },

      /**
       * 일반 쓰기(자동 저장·검사 이동·재기준·삽입·구조화). `texts`는 세 칸과 기준 판이다. 유지 목록은 기준 revision에서
       * 서버가 가진 인용·구조화 id 전부다 — 초안의 증언은 쓰기로 조용히 지우지 않는다(지우는 길은 초안을 비우거나 버리는
       * 것뿐이다). 그 목록은 앞선 쓰기의 답이나 전체 읽기에서만 온다.
       */
      write(uid, texts, { owner, context, operation } = {}) {
        return queue(uid, async () => {
          const own = line(uid);
          if (own.conflict) return { outcome: 'conflict', latest: own.conflict.latest || null };
          if (!own.revision) return { outcome: 'refused', code: 'KIN_DRAFT_BASE_UNKNOWN', message: '이 검사의 초안 기준을 알 수 없어 저장하지 않았습니다.' };
          const blocked = await settleUncertain(uid, own, owner, { context }) || await settleLists(uid, own, owner, { context });
          if (blocked) return blocked;
          const snapshot = {
            findings: texts.findings, conclusion: texts.conclusion, recommendation: texts.recommendation,
            baseVersion: texts.baseVersion,
            citations: [...own.lists.citations], structured: [...own.lists.structured],
          };
          const result = await put(uid, { owner, expectedRevision: own.revision, snapshot, operation, context });
          if (result.outcome === 'saved') adopt(own, result.envelope);
          else if (result.outcome === 'unknown') own.uncertain = { snapshot: operation ? undefined : emptyText(snapshot) ? null : snapshot };
          else if (result.outcome === 'conflict') own.conflict = { attempt: snapshot, latest: null };
          else if (result.outcome === 'refused' && result.answer && result.answer.status === 503) own.uncertain = { snapshot: undefined };
          return { ...result, snapshot };
        });
      },

      /**
       * 탭이 닫히는 중의 쓰기: 답을 볼 수 없다. 기준과 유지 목록을 이미 알 때만 보내고(읽으러 갈 시간이 없다), 결과는
       * 모르는 것으로 남긴다. 보냈는지를 돌려준다.
       */
      writeOnUnload(uid, texts, { owner, context } = {}) {
        const own = line(uid);
        if (!own.revision || !own.lists || own.conflict || own.uncertain || own.open) return false;
        const snapshot = {
          findings: texts.findings, conclusion: texts.conclusion, recommendation: texts.recommendation,
          baseVersion: texts.baseVersion,
          citations: [...own.lists.citations], structured: [...own.lists.structured],
        };
        own.uncertain = { snapshot: emptyText(snapshot) ? null : snapshot };
        put(uid, { owner, expectedRevision: own.revision, snapshot, context, keepalive: true }).then(() => {}, () => {});
        return true;
      },

      /**
       * 잡아 둔 원문 하나를 그대로 보존한다(로그아웃 준비의 저장, Recover Draft). 전제와 원문은 잡을 때 얼린 것이고 여기서
       * 바꾸지 않는다. 저장이 확인되면 이 문서의 기준도 거기로 옮긴다.
       */
      preserve(capture, { context, session } = {}) {
        const uid = capture.uid;
        return queue(uid, async () => {
          if (!validSnapshot(capture.snapshot) || !isRevision(capture.expectedRevision))
            return { outcome: 'refused', code: 'KIN_DRAFT_CAPTURE_INCOMPLETE', message: '잡아 둔 초안의 기준을 알 수 없습니다.' };
          const result = await put(uid, { owner: capture.owner, expectedRevision: capture.expectedRevision,
            snapshot: capture.snapshot, context, session });
          const own = line(uid);
          if (result.outcome === 'saved') { adopt(own, result.envelope); own.conflict = null; }
          else if (result.outcome === 'unknown') own.uncertain = { snapshot: emptyText(capture.snapshot) ? null : capture.snapshot };
          // 충돌한 원문은 그대로 남기고, 이 검사의 자동 쓰기도 사람이 정할 때까지 멈춘다.
          else if (result.outcome === 'conflict') own.conflict = { attempt: capture.snapshot, latest: null };
          return result;
        });
      },

      /**
       * 전체 읽기 하나가 잡아 둔 원문의 저장을 증명하는가: 같은 작성자·같은 검사이고, 원문이 **전부** 같고, revision이 잡을
       * 때의 것과 같은 epoch에서 그것 이후다. 이것이 참일 때만 잡아 둔 원문을 버려도 된다.
       */
      proves(read, capture) {
        return !!read && read.uid === capture.uid && sameOwner(read.owner, capture.owner)
          && notBefore(capture.expectedRevision, read.revision)
          && sameSnapshot(read.snapshot, emptyText(capture.snapshot) ? null : capture.snapshot);
      },

      discard(uid, { owner, context } = {}) {
        return queue(uid, async () => {
          const own = line(uid);
          if (!own.revision) return { outcome: 'refused', code: 'KIN_DRAFT_BASE_UNKNOWN', message: '이 검사의 초안 기준을 알 수 없습니다.' };
          const blocked = await settleUncertain(uid, own, owner, { context });
          // 버리기는 사람이 명시로 고른 일이다. 충돌로 멈춘 자동 쓰기와 달리, 지금 서버에 있는 초안을 본 뒤라면 버릴 수 있다.
          if (blocked && blocked.outcome !== 'conflict') return blocked;
          const expectedRevision = own.conflict && own.conflict.latest ? own.conflict.latest.revision : own.revision;
          const result = await end(uid, { method: 'DELETE', rest: 'draft', owner, expectedRevision, context });
          if (result.outcome === 'saved') { adopt(own, result.envelope); own.conflict = null; }
          else if (result.outcome === 'unknown') own.uncertain = { snapshot: null };
          return result;
        });
      },

      commit(uid, body, { owner, context } = {}) {
        return queue(uid, async () => {
          const own = line(uid);
          if (own.conflict) return { outcome: 'conflict', latest: own.conflict.latest || null };
          if (!own.revision) return { outcome: 'refused', code: 'KIN_DRAFT_BASE_UNKNOWN', message: '이 검사의 초안 기준을 알 수 없어 저장하지 않았습니다.' };
          const blocked = await settleUncertain(uid, own, owner, { context });
          if (blocked) return blocked;
          const result = await end(uid, { method: 'POST', rest: 'report/commit', owner, expectedRevision: own.revision, body, context });
          if (result.outcome === 'saved') adopt(own, result.envelope);
          else if (result.outcome === 'unknown') own.uncertain = { snapshot: undefined };
          else if (result.outcome === 'conflict') own.conflict = { attempt: null, latest: null };
          return result;
        });
      },

      /**
       * 충돌 뒤 최신 상태를 읽는다. 읽은 것은 충돌 기록에 붙을 뿐 기준을 바꾸지 않는다 — 기준을 바꾸는 것은 사람이 고른
       * 뒤의 resolve다.
       */
      latest(uid, { context, session } = {}) {
        return queue(uid, async () => {
          const got = await fetchDraft(uid, { context, session });
          const own = line(uid);
          if (got.outcome === 'read' && own.conflict) own.conflict = { ...own.conflict, latest: got.read };
          return got;
        });
      },

      /**
       * 사람이 충돌을 정했다: 읽어 온 최신 상태를 새 기준으로 삼는다. 그 뒤의 쓰기(화면의 글로 덮기, 또는 서버의 초안을
       * 불러온 뒤의 편집)는 이 기준에서 다시 시작한다.
       */
      resolve(uid) {
        const own = line(uid);
        if (!own.conflict || !own.conflict.latest || own.open) return false;
        const latest = own.conflict.latest;
        own.conflict = null;
        own.uncertain = null;
        adopt(own, latest);
        return true;
      },
    });
  }

  const api = Object.freeze({ create, sameSnapshot, validSnapshot, isRevision, FIELDS });
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KinReportDraftClient = api;
})(typeof window === 'object' ? window : null);

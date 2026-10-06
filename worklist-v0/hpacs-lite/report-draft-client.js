/* 판독문 초안의 명령 프로토콜 (S7-U5, U5S-REQ-15·17). DOM을 쓰지 않는다 — 화면에 쓰는 일은 부른 쪽이 commit으로 한다.
 *
 * 초안을 바꾸는 모든 길(자동 저장·검사 이동·탭 닫기·재기준·인용 삽입·구조화 적용·로그아웃 준비의 보존·Recover Draft·
 * 초안 버리기·확정)이 이 한 경로로 간다. 요청마다 작성자(expectedOwner)와 그 글이 딛고 선 초안 revision(expectedRevision),
 * 그리고 **전체 원문**(세 칸·기준 판·유지할 인용과 구조화 목록 전부)을 싣는다. 서버는 저장된 revision이 그것과 같을 때만
 * 바꾸고 revision을 올린다. 그래서 순서가 뒤바뀐 요청·끊긴 뒤 늦게 닿은 요청·다른 탭의 쓰기는 서로를 조용히 덮지 못한다.
 *
 * 한 검사의 명령은 한 번에 하나만 나가고, 뒤의 명령은 앞의 명령이 확인한 revision을 싣는다. 줄 서서 기다리는 자동 저장은
 * 더 새 저장이 뒤에 서면 그것에 합쳐진다(merged) — 같은 문서의 저장끼리는 충돌하지 않는다.
 *
 * 결과는 넷뿐이고 서로 바꿔 부르지 않는다.
 *   saved     서버가 이 원문을 가졌음을 확인했다: 200의 봉투(uid·작성자·revision·전체 원문)가 보낸 것과 전부 같거나,
 *             그 뒤의 전체 읽기가 같은 작성자·같은 epoch에서 그 원문 전부를 보였다. 이것만 저장 확인이다.
 *   conflict  서버에 이 문서가 본 적 없는 다른 초안이 있다(실제 차이·남이 지운 초안·epoch 변경). 보낸 원문은 그대로 남기고
 *             자동 쓰기를 멈춘다. 사람이 한 번 고른 뒤에만 다시 보낸다.
 *   unknown   답을 받지 못했고(연결 끊김·시간 초과·앞단 502/504·읽을 수 없는 봉투) 전체 읽기로도 저장을 확인하지 못했다.
 *             저장됐을 수도 아닐 수도 있다. 쓰기를 스스로 다시 보내지 않는다 — 다음 명령이 서버 상태부터 읽는다.
 *   refused   서버가 이유를 대고 거절했다(권한·점유·형식). 아무것도 바뀌지 않았다.
 * 그 밖에 unsent(요청이 떠나지 않았다 — 문맥이 무효였다), owner(작성자가 지금 세션의 계정이 아니다), auth(서버가 그 세션의
 * 종료를 알렸다 — 전송 계층이 이미 넘겼다), merged(더 새 저장에 합쳐져 보내지 않았다), withdrawn(차례가 왔을 때 부른 쪽에
 * 보낼 글이 없었다 — 아래)이 있다.
 *
 * 줄 서서 기다린 쓰기가 무엇을 보낼지는 **차례가 왔을 때** 정한다. 줄 설 때의 글을 얼려 두면, 그 사이 앞선 확정이 그 글을
 * 판독문으로 받아들였거나 사람이 그 초안을 버렸어도 뒤늦게 그 글이 새 revision 위에 초안으로 다시 선다(revision 대조는
 * 순서만 지키고 뜻은 모른다). 그래서 일반 쓰기는 글 대신 "지금 보낼 글"을 답하는 함수를 받을 수 있다: 앞선 명령이 모두
 * 끝나고 기준을 확인한 뒤에 한 번 묻고, 없다고 하면(null) 아무것도 보내지 않는다(withdrawn). 무엇이 아직 확인되지 않은
 * 글인가는 부른 쪽이 기록한 사실로 답한다 — 여기서 글을 견주어 짐작하지 않는다.
 *
 * 사람에게 묻기 전에 프로그램이 먼저 확인한다. 충돌(409)이나 결과 모름 뒤에는 서버의 지금 초안을 한 번 읽는다:
 *   · 거기에 보낸 원문이 전부 있으면 저장이다(답만 잃었다).
 *   · 거기 있는 것이 이 문서가 보냈거나 화면에 보였던 원문이면(늦게 닿은 내 저장, 낡은 관측) 본 적 없는 것을 덮지 않는다 —
 *     충돌한 쓰기는 그 revision과 목록 위에서 한 번 다시 보낸다. 결과를 모르는 쓰기는 다시 보내지 않고 기준만 옮긴다.
 *   · 그 밖(다른 글, 남이 지운 초안, epoch 변경)만 충돌로 남긴다.
 */
(function (root) {
  'use strict';

  const FIELDS = ['findings', 'conclusion', 'recommendation'];
  // "<epoch>:<n>". 뜻은 서버의 것이고 여기서는 같은가와 같은 epoch 안의 앞뒤만 본다.
  const REVISION = /^([^:\s]+):(\d+)$/;
  // 이 문서가 보냈거나 보인 원문을 검사마다 이만큼 기억한다(충돌이 내 글과의 것인지 가리는 데 쓴다).
  const MINE_KEPT = 8;
  // 시간 초과로 끊긴 쓰기는 서버가 아직 처리 중일 수 있다. 확인 읽기에 없으면 이만큼 뒤에 한 번 더 읽는다(읽기는 두 번까지).
  const CONFIRM_WAIT_MS = 3000;

  const isRevision = value => typeof value === 'string' && REVISION.test(value);
  const idList = value => Array.isArray(value) && value.every(id => typeof id === 'string' && id.length > 0);
  const sameSet = (a, b) => a.length === b.length && a.every(id => b.includes(id)) && b.every(id => a.includes(id));
  const epochOf = revision => { const found = REVISION.exec(revision || ''); return found ? found[1] : null; };

  function sameOwner(a, b) {
    return !!a && !!b && typeof a.sub === 'string' && a.sub === b.sub
      && (a.institution ?? null) === (b.institution ?? null) && a.author === b.author;
  }

  /** 세 칸과 기준 판의 모양(목록 없이). */
  function validTexts(t) {
    return !!t && typeof t === 'object' && FIELDS.every(k => typeof t[k] === 'string')
      && Number.isSafeInteger(t.baseVersion) && t.baseVersion >= 0;
  }

  /** 원문 하나의 모양. 초안이 없는 상태는 null이다. */
  function validSnapshot(s) {
    return validTexts(s) && idList(s.citations) && idList(s.structured);
  }

  const sameTexts = (a, b) => FIELDS.every(k => a[k] === b[k]) && a.baseVersion === b.baseVersion;

  /** 두 원문이 **전부** 같은가: 세 칸의 글자, 기준 판, 인용과 구조화 목록. 둘 다 "초안 없음"이어도 같다. */
  function sameSnapshot(a, b) {
    if (a === null || b === null) return a === null && b === null;
    return validSnapshot(a) && validSnapshot(b) && sameTexts(a, b)
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
    /**
     * 이 문서의 글을 초안으로 싣는 명령(write·preserve·writeOnUnload)이 시작될 때 부른 쪽에 동기로 알린다(`onWrite(uid)`).
     * 그 글은 답이 확인할 때까지 서버가 가졌는지 모르는 글이다 — 명령의 답을 받는 화면 쪽 이어짐이 버려져도(로그아웃 준비,
     * 닫히는 탭) 그 사실은 남아야 한다. 버리기와 확정은 알리지 않는다: 이 문서의 글을 초안으로 보내는 명령이 아니고,
     * 거절되면 아무것도 달라지지 않는다.
     */
    const sending = uid => { if (typeof options.onWrite === 'function') options.onWrite(uid); };

    /**
     * 한 검사의 줄. revision은 이 문서의 다음 명령이 실을 기준이고, known은 그 revision에서 서버가 가진 전체 원문이다
     * (undefined: 아직 읽지 않았다, null: 초안 없음). mine은 이 문서가 보냈거나 화면에 보였던 원문들이다.
     */
    function line(uid) {
      let found = lines.get(uid);
      if (!found) {
        found = { revision: null, known: undefined, tail: Promise.resolve(), open: 0, changing: 0, uncertain: null,
          conflict: null, mine: [], newest: null };
        lines.set(uid, found);
      }
      return found;
    }

    const path = (uid, rest) => `${base}/studies/${encodeURIComponent(uid)}/${rest}`;

    const listsOf = own => own.known === undefined ? null
      : own.known ? { citations: [...own.known.citations], structured: [...own.known.structured] }
      : { citations: [], structured: [] };

    function remember(own, entry) {
      if (!entry) return;
      own.mine.push(entry);
      if (own.mine.length > MINE_KEPT) own.mine.shift();
    }

    /** 서버에 있는 원문이 이 문서가 보냈거나 보였던 것인가. 목록까지 기억한 것은 목록도 같아야 한다. */
    function isMine(own, snapshot) {
      if (!snapshot) return false;
      return [own.known, ...own.mine].some(entry => !!entry && sameTexts(entry, snapshot)
        && (!idList(entry.citations) || (sameSet(entry.citations, snapshot.citations) && sameSet(entry.structured, snapshot.structured))));
    }

    /**
     * 읽어 온 서버 상태가 이 문서의 기준에서 이어지는가 — 이어지면 그 위에 써도 본 적 없는 것을 덮지 않는다. 같은 revision
     * 이거나, 같은 epoch에서 뒤이고 거기 있는 것이 내 원문이다. 초안이 없어진 것은 내가 방금 비우거나 버리거나 확정한 결과를
     * 모를 때만 이어진 것으로 본다(남이 지운 초안을 스스로 되살리지 않는다).
     */
    function follows(own, read) {
      if (read.revision === own.revision) return true;
      if (!notBefore(own.revision, read.revision)) return false;
      if (!read.present) return !!own.uncertain && own.uncertain.snapshot === null;
      return isMine(own, read.snapshot);
    }

    /** 서버가 확인해 준 상태(쓰기의 봉투 또는 전체 읽기)를 이 문서의 기준으로 삼는다. */
    function adopt(own, view) {
      if (epochOf(view.revision) !== epochOf(own.revision)) own.mine = [];
      own.revision = view.revision;
      own.known = view.present ? view.snapshot : null;
      own.uncertain = null;
    }

    function conflictOf(own, attempt, read) {
      own.conflict = { attempt, latest: read || null };
      if (read) own.uncertain = null;
      return { outcome: 'conflict', latest: read || null };
    }

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
      try { answer = await transport.request(path(uid, 'draft'), { context, session, kind: 'draft', abortWhenStale: false }); }
      catch (error) { return failed(error); }
      if (!answer.ok) return refusal(answer);
      const read = answer.incomplete ? null : envelopeOf(answer.body);
      return read && read.uid === uid ? { outcome: 'read', read } : { outcome: 'unknown', answer };
    }

    /** 전체 읽기 하나를 같은 작성자의 것일 때만 돌려준다. */
    async function look(uid, owner, opts) {
      const got = await fetchDraft(uid, opts);
      if (got.outcome === 'read' && !sameOwner(got.read.owner, owner)) return { outcome: 'owner' };
      return got;
    }

    /**
     * 충돌·결과 모름 뒤의 확인 읽기. 사람에게 알리기 전에 프로그램이 서버의 지금 초안을 본다. 쓰기는 다시 보내지 않는다 —
     * 읽기만 한다. 시간 초과로 끊긴 쓰기가 처음 읽기에 아직 없으면(서버가 처리 중일 수 있다) 잠깐 뒤 한 번 더 읽고, 거기서
     * 끝낸다.
     */
    async function confirm(uid, own, owner, sent, opts) {
      let got = await look(uid, owner, opts);
      const pending = () => got.outcome === 'read' && got.read.revision === own.revision
        && !(sent.expected !== undefined && sameSnapshot(got.read.snapshot, sent.expected));
      if (sent.outcome === 'unknown' && sent.error && sent.error.transport === 'timeout' && pending()) {
        await new Promise(resolve => setTimeout(resolve, CONFIRM_WAIT_MS));
        const again = await look(uid, owner, opts);
        if (again.outcome === 'read' || again.outcome === 'owner') got = again;
      }
      return got;
    }

    /**
     * 쓰기 하나를 보내고 그 답을 판정한다. 전제(작성자·revision)와 전체 원문은 받은 그대로 싣는다 — 여기서 고치거나 채우지
     * 않는다. `operation`은 같은 쓰기에 실리는 인용 삽입({ insert }) 또는 구조화 적용({ structure })이다. `expected`는 이
     * 쓰기가 기록됐다면 서버가 가질 원문이다(삽입·구조화는 서버가 지을 id를 몰라 undefined).
     */
    async function put(uid, { owner, expectedRevision, snapshot, operation, context, session, keepalive }) {
      const expected = operation ? undefined : emptyText(snapshot) ? null : snapshot;
      const body = {
        expectedOwner: { institution: owner.institution ?? null, sub: owner.sub, author: owner.author },
        expectedRevision,
        findings: snapshot.findings, conclusion: snapshot.conclusion, recommendation: snapshot.recommendation,
        baseVersion: snapshot.baseVersion, citationIds: [...snapshot.citations], structureIds: [...snapshot.structured],
        ...(operation || {}),
      };
      let answer;
      try {
        answer = await transport.request(path(uid, 'report'), { method: 'PUT', json: body, context, session, kind: 'draft',
          ...(keepalive ? { keepalive: true, deadlineMs: 0 } : {}) });
      } catch (error) { return { ...failed(error), expected }; }
      if (!answer.ok) return { ...refusal(answer), expected };
      const envelope = answer.incomplete ? null : envelopeOf(answer.body);
      if (!envelope || envelope.uid !== uid || !sameOwner(envelope.owner, owner)) return { outcome: 'unknown', answer, expected };
      // 서버가 기록했다고 답한 원문이 보낸 것과 전부 같아야 한다. 삽입·구조화는 서버가 지은 새 id가 목록에 더해진다.
      const inserted = operation && operation.insert ? answer.body.inserted : null;
      const applied = operation && operation.structure ? answer.body.applied : null;
      if (operation && operation.insert && !(inserted && typeof inserted.cid === 'string')) return { outcome: 'unknown', answer, expected };
      if (operation && operation.structure && !(applied && typeof applied.sid === 'string')) return { outcome: 'unknown', answer, expected };
      const replaced = operation && operation.structure ? operation.structure.replacesSid : undefined;
      const stored = emptyText(snapshot) ? null : {
        ...snapshot,
        citations: inserted ? [...snapshot.citations, inserted.cid] : snapshot.citations,
        structured: applied ? [...snapshot.structured.filter(sid => sid !== replaced), applied.sid] : snapshot.structured,
      };
      if (!sameSnapshot(envelope.snapshot, stored)) return { outcome: 'unknown', answer, expected };
      return { outcome: 'saved', envelope, answer, expected };
    }

    /** 초안을 버리거나(DELETE draft) 확정한다(POST commit). 둘 다 초안의 경계를 넘기므로 같은 전제를 싣는다. */
    async function end(uid, { method, rest, owner, expectedRevision, body, context }) {
      let answer;
      try {
        answer = await transport.request(path(uid, rest), { method, context, kind: 'draft', json: {
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

    /**
     * 한 검사의 명령을 차례로 세운다. 앞 명령의 결과(올라간 revision)를 본 뒤에 다음 명령이 전제를 정한다. `changing`은
     * 초안을 바꾸는 명령(쓰기·보존·버리기·확정)이다 — busy()는 이것만 센다(읽기만 하는 명령은 저장 중이 아니다).
     */
    function queue(uid, run, changing = true) {
      const own = line(uid);
      own.open += 1;
      if (changing) own.changing += 1;
      const turn = own.tail.then(run, run).finally(() => { own.open -= 1; if (changing) own.changing -= 1; });
      own.tail = turn.then(() => {}, () => {});
      return turn;
    }

    /**
     * 명령을 보내기 전에 기준을 확인한다. 결과를 모르는 앞선 명령이 있었거나 그 revision의 원문(유지 목록)을 아직 모르면
     * 전체 읽기 하나로 서버 상태를 본다. 이어지면 기준을 거기로 옮기고, 이어지지 않으면 충돌이다.
     */
    async function settle(uid, own, owner, opts) {
      if (!own.uncertain && own.known !== undefined) return null;
      const got = await look(uid, owner, opts);
      if (got.outcome !== 'read') return got;
      if (!follows(own, got.read)) return conflictOf(own, null, got.read);
      adopt(own, got.read);
      return null;
    }

    /**
     * 일반 쓰기 하나를 끝까지 판정한다. 충돌·결과 모름이면 사람에게 알리기 전에 서버의 지금 초안을 한 번 읽는다(위 설명).
     * 충돌한 쓰기를 다시 보내는 것은 한 번뿐이고, 읽어 온 상태가 이 문서의 기준에서 이어질 때만이다.
     */
    async function deliver(uid, own, texts, { owner, context, operation }) {
      for (let round = 0; ; round += 1) {
        const lists = listsOf(own);
        const snapshot = { findings: texts.findings, conclusion: texts.conclusion, recommendation: texts.recommendation,
          baseVersion: texts.baseVersion, citations: lists.citations, structured: lists.structured };
        // 서버가 이 revision에서 이미 이 원문 전부를 갖고 있다(답을 잃었던 저장을 방금의 읽기가 찾았다): 다시 쓸 것이 없다.
        if (!operation && sameSnapshot(own.known, emptyText(snapshot) ? null : snapshot))
          return { outcome: 'saved', confirmedByRead: true, snapshot,
            envelope: { uid, owner, revision: own.revision, present: !!own.known, snapshot: own.known, updatedAt: null } };
        // 삽입·구조화는 서버가 지을 id를 모르므로 글자만 기억한다.
        remember(own, operation ? { ...texts } : emptyText(snapshot) ? null : snapshot);
        const sent = await put(uid, { owner, expectedRevision: own.revision, snapshot, operation, context });
        if (sent.outcome === 'saved') {
          adopt(own, sent.envelope);
          return { ...sent, snapshot };
        }
        if (sent.outcome !== 'unknown' && sent.outcome !== 'conflict') {
          // 한도 안에 끝내지 못했다는 거절(503)은 저장하지 않았다는 답이지만, 다음 명령은 서버 상태부터 읽는다.
          if (sent.outcome === 'refused' && sent.answer && sent.answer.status === 503) own.uncertain = { snapshot: undefined };
          return { ...sent, snapshot };
        }
        if (sent.outcome === 'unknown') own.uncertain = { snapshot: sent.expected };
        const got = await confirm(uid, own, owner, sent, { context });
        if (got.outcome === 'owner') return { ...got, snapshot };
        if (got.outcome !== 'read') {
          // 읽기도 실패했다: 충돌은 최신 상태를 모르는 충돌로, 결과 모름은 그대로 남는다.
          if (sent.outcome === 'conflict') own.conflict = { attempt: snapshot, latest: null };
          return { ...sent, snapshot, ...(sent.outcome === 'conflict' ? { latest: null } : {}) };
        }
        const read = got.read;
        if (sent.expected !== undefined && sameSnapshot(read.snapshot, sent.expected) && notBefore(own.revision, read.revision)) {
          // 보낸 원문이 서버에 전부 있다 — 답만 잃었거나, 같은 글이 이미 기록돼 있었다.
          adopt(own, read);
          return { outcome: 'saved', envelope: read, confirmedByRead: true, answer: sent.answer, snapshot };
        }
        if (!follows(own, read)) return { ...conflictOf(own, snapshot, read), snapshot, answer: sent.answer };
        const moved = read.revision !== own.revision;
        if (sent.outcome === 'unknown') {
          // 아직 기록되지 않았다. 다시 보내지 않는다 — 기준이 옮겨졌으면(그 사이 내 다른 저장이 닿았다) 이 쓰기는 이제
          // 닿아도 거절되고, 그대로면 늦게 닿을 수 있으므로 결과를 모르는 채로 둔다.
          if (moved) adopt(own, read); else own.known = read.present ? read.snapshot : null;
          return { ...sent, snapshot };
        }
        adopt(own, read);
        if (round > 0) return { ...conflictOf(own, snapshot, read), snapshot, answer: sent.answer };
      }
    }

    /** 버리기·확정 하나를 끝까지 판정한다. 충돌이면 한 번 읽어, 이어지는 상태일 때만 그 revision으로 한 번 다시 보낸다. */
    async function finish(uid, own, { method, rest, body, owner, context }) {
      for (let round = 0; ; round += 1) {
        const sent = await end(uid, { method, rest, owner, expectedRevision: own.revision, body, context });
        if (sent.outcome === 'saved') {
          adopt(own, sent.envelope);
          return sent;
        }
        // 버리기도 확정도 끝나면 초안이 없다. 결과를 모르면 다음 명령이 서버 상태부터 읽는다.
        if (sent.outcome === 'unknown') {
          own.uncertain = { snapshot: null };
          /**
           * 답을 잃은 버리기는 쓰기와 같이 전체 읽기로 먼저 확인한다(다시 보내지 않는다). 버리기가 바꾸는 것은 초안 행
           * 하나뿐이므로, 그 행이 이 명령이 실은 revision 뒤에서 없어져 있으면 버려진 것이다 — 그때 "버렸는지 모른다"로
           * 남기면 뒤에 줄 선 쓰기가 사람이 버린 글을 되살린다. 확정은 여기서 확인하지 않는다: 확정이 바꾸는 것은 판독문
           * 이고 초안 행이 없어진 것만으로는(다른 창의 버리기일 수 있다) 확정됐다고 할 수 없다 — 판독 상태를 읽는 것은
           * 부른 쪽의 일이다.
           */
          if (method !== 'DELETE') return sent;
          const got = await confirm(uid, own, owner, { ...sent, expected: null }, { context });
          if (got.outcome === 'read' && !got.read.present && got.read.revision !== own.revision && follows(own, got.read)) {
            adopt(own, got.read);
            return { outcome: 'saved', envelope: got.read, confirmedByRead: true, answer: sent.answer };
          }
          return sent;
        }
        if (sent.outcome !== 'conflict') return sent;
        const got = await look(uid, owner, { context });
        if (got.outcome === 'owner') return got;
        if (got.outcome !== 'read') {
          own.conflict = { attempt: null, latest: null };
          return { ...sent, latest: null };
        }
        if (round > 0 || !follows(own, got.read)) return conflictOf(own, null, got.read);
        adopt(own, got.read);
      }
    }

    /**
     * 읽기 하나의 답(revision)을 이 문서가 그 사이 넘어섰는가. `issued`는 그 읽기가 나갈 때의 기준이다. 같은 epoch이면
     * 번호로 견준다: 지금 기준보다 앞선 답은 낡았다(더 뒤의 답 — 다른 창의 저장 — 은 낡지 않았다). epoch이 다르면 앞뒤를
     * 견줄 수 없으므로 읽는 사이 이 문서의 기준이 바뀌었을 때만 낡은 것으로 본다 — 그 답은 그 사이 확인한 상태보다 먼저
     * 읽힌 것일 수 있다. 버린 답은 다음 읽기가 다시 알려 준다.
     */
    function overtaken(own, issued, revision) {
      if (!own.revision || revision === own.revision) return false;
      if (epochOf(revision) === epochOf(own.revision)) return notBefore(revision, own.revision);
      return own.revision !== issued;
    }

    /** 전체 읽기 하나가 잡아 둔 원문의 저장을 증명하는가(아래 proves). */
    function provesCapture(read, capture) {
      return !!read && read.uid === capture.uid && sameOwner(read.owner, capture.owner)
        && notBefore(capture.expectedRevision, read.revision)
        && sameSnapshot(read.snapshot, emptyText(capture.snapshot) ? null : capture.snapshot);
    }

    return Object.freeze({
      /**
       * 화면이 서버 상태로 편집기를 그렸다: 그 상태의 초안 revision이 이제 이 글의 기준이고, 화면에 보인 초안(`seen`: 세 칸과
       * 기준 판, 없으면 null)은 이 문서가 본 원문이다. 나가 있는 명령이 있거나 결과를 모르는 명령·충돌이 남아 있으면 바꾸지
       * 않는다 — 그때의 기준은 그 명령들이 정한다. 같은 epoch의 더 낮은 revision은 낡은 관측(늦게 온 목록)이라 따르지 않는다.
       */
      observe(uid, revision, seen) {
        const own = line(uid);
        if (own.open || own.uncertain || own.conflict) return false;
        if (!isRevision(revision)) {
          own.revision = null;
          own.known = undefined;
          return false;
        }
        if (own.revision && own.revision !== revision && notBefore(revision, own.revision)) return false;
        if (epochOf(revision) !== epochOf(own.revision)) own.mine = [];
        if (own.revision !== revision) own.known = undefined;
        own.revision = revision;
        if (validTexts(seen)) remember(own, { findings: seen.findings, conclusion: seen.conclusion,
          recommendation: seen.recommendation, baseVersion: seen.baseVersion });
        return true;
      },

      revision(uid) { return lines.has(uid) ? lines.get(uid).revision : null; },
      lists(uid) { return lines.has(uid) ? listsOf(lines.get(uid)) : null; },
      /** All studies touched by this document, including commands whose page continuation was retired. */
      studies() { return [...lines.keys()]; },
      /**
       * Explicit server replacement, after pending commands have settled. Observations cannot clear conflicts. 지금
       * 기준보다 앞선 revision(같은 epoch의 더 낮은 번호)으로는 바꾸지 않는다 — 늦게 온 읽기가 그 뒤에 확인된 저장의
       * 기준을 되돌리면 다음 쓰기가 그 저장을 모르는 채 나간다.
       */
      replace(uid, revision, seen) {
        const own = line(uid);
        if (own.open || !isRevision(revision)) return false;
        if (own.revision && own.revision !== revision && notBefore(revision, own.revision)) return false;
        own.conflict = null;
        own.uncertain = null;
        own.mine = [];
        const known = own.revision === revision ? own.known : undefined;
        own.revision = null;
        const accepted = this.observe(uid, revision, seen);
        own.known = known;
        return accepted;
      },
      /** Keep the person's latest edit even when a conflict forbids sending it. */
      keep(uid, texts) {
        const own = lines.get(uid);
        if (own?.conflict) own.conflict = { ...own.conflict,
          attempt: { ...(own.conflict.attempt || listsOf(own) || {}), ...texts } };
      },
      /** 이 검사의 초안을 바꾸는 명령이 나가 있거나 줄 서 있는가. */
      busy(uid) { return lines.has(uid) && lines.get(uid).changing > 0; },
      /** 지금 세워진 명령이 모두 끝날 때. 거절되지 않는다. */
      settled(uid) {
        return uid === undefined ? Promise.all([...lines.values()].map(own => own.tail))
          : lines.has(uid) ? lines.get(uid).tail : Promise.resolve();
      },
      uncertain(uid) { return lines.has(uid) && !!lines.get(uid).uncertain; },
      conflict(uid) { return lines.has(uid) ? lines.get(uid).conflict : null; },

      /** 편집기를 열 때 한 번: 유지 목록의 기준을 미리 알아 둔다(탭이 닫히는 순간에는 읽으러 갈 수 없다). */
      prime(uid, { owner, context } = {}) {
        return queue(uid, async () => {
          const own = line(uid);
          if (own.known !== undefined || !own.revision || own.conflict || own.uncertain) return { outcome: 'unsent' };
          const got = await look(uid, owner, { context });
          if (got.outcome === 'read' && own.known === undefined && follows(own, got.read)) adopt(own, got.read);
          return got;
        }, false);
      },

      /**
       * 부른 쪽이 화면에 반영할 전체 읽기 하나. 나갈 때의 기준을 들고 나가, 답이 왔을 때 이 문서가 그 사이 더 새 상태를
       * 확인했으면(그 사이의 저장·확인 읽기) 그 답은 `stale`이다(read는 그대로 실린다) — 부른 쪽은 그것을 화면에도 기준에도
       * 쓰지 않는다. 기준은 여기서 바꾸지 않는다.
       */
      async read(uid, opts) {
        const own = line(uid);
        const issued = own.revision;
        const got = await fetchDraft(uid, opts || {});
        if (got.outcome !== 'read' || !overtaken(own, issued, got.read.revision)) return got;
        return { outcome: 'stale', read: got.read, revision: own.revision };
      },

      /**
       * 보존 쓰기(로그아웃 준비·Recover Draft)가 실을 기준을 정한다: 결과를 모르는 앞선 쓰기와 유지 목록을 전체 읽기로
       * 확인한 뒤의 revision과 목록. 서버에 이 문서가 본 적 없는 내용이 먼저 기록돼 있으면 conflict이고 기준은 바뀌지 않는다.
       */
      base(uid, { owner, context, session } = {}) {
        return queue(uid, async () => {
          const own = line(uid);
          if (own.conflict) return { outcome: 'conflict', latest: own.conflict.latest || null };
          if (!own.revision) return { outcome: 'refused', code: 'KIN_DRAFT_BASE_UNKNOWN', message: '이 검사의 초안 기준을 알 수 없습니다.' };
          const blocked = await settle(uid, own, owner, { context, session });
          if (blocked) return blocked;
          // stored는 그 revision에서 서버가 가진 전체 원문이다(없으면 null) — 잡아 둔 원문이 이미 거기 있으면 보낼 것이 없다.
          return { outcome: 'ready', revision: own.revision, lists: listsOf(own), stored: own.known };
        }, false);
      },

      /**
       * 일반 쓰기(자동 저장·검사 이동·재기준·삽입·구조화). `texts`는 세 칸과 기준 판이다. 유지 목록은 기준 revision에서
       * 서버가 가진 인용·구조화 id 전부다 — 초안의 증언은 쓰기로 조용히 지우지 않는다(지우는 길은 초안을 비우거나 버리는
       * 것뿐이다). 그 목록은 앞선 쓰기의 답이나 전체 읽기에서만 온다. 줄 서 있는 사이 더 새 일반 쓰기가 뒤에 서면 이 쓰기는
       * 보내지 않는다(merged) — 그 쓰기가 더 새 글을 가져간다.
       *
       * `texts`가 함수이면 차례가 왔을 때(앞선 명령이 모두 끝나고 기준을 확인한 뒤, 보내기 직전에) 한 번 불러 그때의 글을
       * 받는다(약속을 돌려줘도 된다). null이면 보낼 글이 없다는 답이다 — 아무것도 보내지 않고 withdrawn으로 끝난다.
       */
      write(uid, texts, { owner, context, operation } = {}) {
        const own = line(uid);
        const ticket = operation ? null : (own.newest = {});
        sending(uid);
        return queue(uid, async () => {
          if (ticket && own.newest !== ticket) return { outcome: 'merged' };
          if (own.conflict) return { outcome: 'conflict', latest: own.conflict.latest || null };
          if (!own.revision) return { outcome: 'refused', code: 'KIN_DRAFT_BASE_UNKNOWN', message: '이 검사의 초안 기준을 알 수 없어 저장하지 않았습니다.' };
          const blocked = await settle(uid, own, owner, { context });
          if (blocked) return blocked;
          const now = typeof texts === 'function' ? await texts() : texts;
          if (!now) return { outcome: 'withdrawn' };
          return deliver(uid, own, now, { owner, context, operation });
        });
      },

      /**
       * 탭이 닫히는 중의 쓰기: 답을 볼 수 없다. 기준과 유지 목록을 이미 알 때만 보내고(읽으러 갈 시간이 없다), 결과는
       * 모르는 것으로 남긴다. 보냈는지를 돌려준다.
       */
      writeOnUnload(uid, texts, { owner, context } = {}) {
        const own = line(uid);
        if (!own.revision || own.known === undefined || own.conflict || own.uncertain || own.open) return false;
        sending(uid);
        const lists = listsOf(own);
        const snapshot = { findings: texts.findings, conclusion: texts.conclusion, recommendation: texts.recommendation,
          baseVersion: texts.baseVersion, citations: lists.citations, structured: lists.structured };
        const expected = emptyText(snapshot) ? null : snapshot;
        remember(own, expected);
        own.uncertain = { snapshot: expected };
        put(uid, { owner, expectedRevision: own.revision, snapshot, context, keepalive: true }).then(() => {}, () => {});
        return true;
      },

      /**
       * 잡아 둔 원문 하나를 그대로 보존한다(로그아웃 준비의 저장, Recover Draft). 전제와 원문은 잡을 때 얼린 것이고 여기서
       * 바꾸지 않는다. 저장은 답의 봉투가, 또는 그 뒤의 전체 읽기가 그 원문 전부를 보일 때만이다. 충돌했는데 서버에 있는 것이
       * 이 문서의 원문이면 기준만 옮기고 `rebased`로 돌려준다 — 부른 쪽이 새 기준으로 다시 잡아(새 준비) 한 번 더 보낸다.
       */
      preserve(capture, { context, session } = {}) {
        const uid = capture.uid;
        sending(uid);
        return queue(uid, async () => {
          if (!validSnapshot(capture.snapshot) || !isRevision(capture.expectedRevision))
            return { outcome: 'refused', code: 'KIN_DRAFT_CAPTURE_INCOMPLETE', message: '잡아 둔 초안의 기준을 알 수 없습니다.' };
          const own = line(uid);
          const expected = emptyText(capture.snapshot) ? null : capture.snapshot;
          remember(own, expected);
          const sent = await put(uid, { owner: capture.owner, expectedRevision: capture.expectedRevision,
            snapshot: capture.snapshot, context, session });
          if (sent.outcome === 'saved') {
            adopt(own, sent.envelope);
            own.conflict = null;
            return sent;
          }
          if (sent.outcome !== 'unknown' && sent.outcome !== 'conflict') return sent;
          if (sent.outcome === 'unknown') own.uncertain = { snapshot: expected };
          const got = await confirm(uid, own, capture.owner, sent, { context, session });
          if (got.outcome === 'owner') return got;
          if (got.outcome !== 'read') {
            if (sent.outcome === 'conflict') own.conflict = { attempt: capture.snapshot, latest: null };
            return { ...sent, ...(sent.outcome === 'conflict' ? { latest: null } : {}) };
          }
          const read = got.read;
          if (provesCapture(read, capture)) {
            adopt(own, read);
            own.conflict = null;
            return { outcome: 'saved', envelope: read, confirmedByRead: true, answer: sent.answer };
          }
          if (!follows(own, read)) return { ...conflictOf(own, capture.snapshot, read), answer: sent.answer };
          if (sent.outcome === 'unknown') {
            if (read.revision !== own.revision) adopt(own, read); else own.known = read.present ? read.snapshot : null;
            return sent;
          }
          adopt(own, read);
          own.conflict = null;
          return { outcome: 'rebased', revision: own.revision };
        });
      },

      /**
       * 전체 읽기 하나가 잡아 둔 원문의 저장을 증명하는가: 같은 작성자·같은 검사이고, 원문이 **전부** 같고, revision이 잡을
       * 때의 것과 같은 epoch에서 그것 이후다. 이것이 참일 때만 잡아 둔 원문을 버려도 된다.
       */
      proves(read, capture) { return provesCapture(read, capture); },

      discard(uid, { owner, context } = {}) {
        return queue(uid, async () => {
          const own = line(uid);
          if (own.conflict) return { outcome: 'conflict', latest: own.conflict.latest || null };
          if (!own.revision) return { outcome: 'refused', code: 'KIN_DRAFT_BASE_UNKNOWN', message: '이 검사의 초안 기준을 알 수 없습니다.' };
          const blocked = await settle(uid, own, owner, { context });
          if (blocked) return blocked;
          return finish(uid, own, { method: 'DELETE', rest: 'draft', owner, context });
        });
      },

      commit(uid, body, { owner, context } = {}) {
        return queue(uid, async () => {
          const own = line(uid);
          if (own.conflict) return { outcome: 'conflict', latest: own.conflict.latest || null };
          if (!own.revision) return { outcome: 'refused', code: 'KIN_DRAFT_BASE_UNKNOWN', message: '이 검사의 초안 기준을 알 수 없어 저장하지 않았습니다.' };
          const blocked = await settle(uid, own, owner, { context });
          if (blocked) return blocked;
          return finish(uid, own, { method: 'POST', rest: 'report/commit', body, owner, context });
        });
      },

      /**
       * 충돌의 최신 상태를 (다시) 읽는다 — 충돌 때의 자동 읽기가 실패했을 때 쓴다. 읽어 온 상태가 이 문서의 기준에서
       * 이어지면 충돌은 풀리고 기준이 거기로 옮겨진다. 그렇지 않으면 충돌 기록에 붙을 뿐 기준을 바꾸지 않는다 — 기준을
       * 바꾸는 것은 사람이 고른 뒤의 resolve다.
       */
      latest(uid, { owner, context, session } = {}) {
        return queue(uid, async () => {
          const got = owner ? await look(uid, owner, { context, session }) : await fetchDraft(uid, { context, session });
          const own = line(uid);
          if (got.outcome !== 'read' || !own.conflict) return got;
          if (follows(own, got.read)) {
            adopt(own, got.read);
            own.conflict = null;
            return { ...got, resolved: true };
          }
          own.conflict = { ...own.conflict, latest: got.read };
          return got;
        }, false);
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
        adopt(own, latest);
        return true;
      },
    });
  }

  const api = Object.freeze({ create, sameSnapshot, validSnapshot, isRevision, FIELDS });
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KinReportDraftClient = api;
})(typeof window === 'object' ? window : null);

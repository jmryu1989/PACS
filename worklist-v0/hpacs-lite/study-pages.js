(function(root) {
  'use strict';
  function create({ request, identity, changed, timeoutMs = 60000 }) {
    let sequence = 0, controller, pending = null, busy = false, notice = '', boundOwner, paused = false;
    const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
    const state = message => { if (message !== undefined) notice = message; changed({ busy, resumable: !!pending, received: pending?.rows.length || 0, total: pending?.total, message:notice }); };
    function cancel() { paused = true; sequence++; controller?.abort(); busy = false; state('불러오기를 멈췄습니다. 이어받거나 새로고침할 수 있습니다.'); }
    function clear() { cancel(); pending = null; paused = false; state(''); }
    async function read({ resume = false, epoch, valid = () => true } = {}) {
      paused = false; controller?.abort(); const mine = ++sequence, owner = identity();
      if (!Array.isArray(owner) || owner.length !== 2 || owner.some(x => typeof x !== 'string' || !x) || (boundOwner && !same(boundOwner,owner))) {
        pending = null; busy = false; throw Object.assign(new Error('계정 상태가 바뀌었습니다.'), {ownerChanged:true});
      }
      boundOwner = [...owner];
      if (!resume || !pending || !same(pending.owner,owner) || pending.epoch !== epoch) pending = { owner, epoch, rows:[], next:null, total:null };
      const draft = pending; busy = true;
      const active = () => mine === sequence && same(identity(),owner) && valid();
      async function get(path) {
        controller = new AbortController(); const ownController = controller;
        const timer = setTimeout(() => ownController.abort(), timeoutMs);
        try { return await request(path, ownController.signal); }
        finally { clearTimeout(timer); }
      }
      try {
        while (draft.total === null || draft.next !== null) {
          state('검사 목록을 나누어 불러오는 중…');
          const data = await get('/studies?limit=100' + (draft.next ? '&after=' + encodeURIComponent(draft.next) : ''));
          if (!active()) throw Object.assign(new Error('계정 또는 판독 작업이 바뀌어 목록 응답을 적용하지 않았습니다.'), { stale:true });
          const page = data?.pagination, rows = data?.studies;
          if (page && !same(page.owner,owner)) throw Object.assign(new Error('목록 계정이 바뀌었습니다.'),{ownerChanged:true});
          if (!page || !same(page.owner,owner) || !Array.isArray(rows) || rows.length > 100 || page.limit !== 100
            || page.offset !== draft.rows.length || !Number.isSafeInteger(page.total) || page.total < 0
            || (draft.total !== null && page.total !== draft.total)
            || !(page.next === null || typeof page.next === 'string' && page.next.length > 0 && page.next.length <= 4096)
            || (page.next !== null && (rows.length !== 100 || page.next === draft.next))
            || draft.rows.length + rows.length > page.total
            || (page.next === null && draft.rows.length + rows.length !== page.total)) throw Object.assign(new Error('목록 페이지 형식을 확인할 수 없습니다. 새로고침하세요.'),{stale:true});
          let previous = draft.rows.at(-1)?.uid;
          for (const row of rows) {
            if (!row || typeof row.uid !== 'string' || !row.uid || (previous !== undefined && row.uid <= previous)
              || !row.state || typeof row.state !== 'object') throw Object.assign(new Error('목록 페이지 순서 또는 검사 정보가 잘못되었습니다.'),{stale:true});
            previous = row.uid;
          }
          draft.rows.push(...rows); draft.total = page.total; draft.next = page.next;
          state('검사 목록을 나누어 불러오는 중…');
        }
        const me = await get('/me');
        if (me?.kind !== 'member' || !same([me.institution,me.sub],owner)) throw Object.assign(new Error('계정이 바뀌어 목록 응답을 적용하지 않았습니다.'),{ownerChanged:true});
        if (!active()) throw Object.assign(new Error('판독 작업이 바뀌어 목록 응답을 적용하지 않았습니다.'),{stale:true});
        const result = { studies:draft.rows, owner:[...owner] }; pending = null; notice = ''; return result;
      } catch (error) {
        if (mine !== sequence) { error.stale = true; throw error; }
        if (error.status === 401 || error.status === 403) error.ownerChanged = true;
        if (error.code === 'STUDY_LIST_CHANGED') {
          try { const me = await get('/me'); if (me?.kind !== 'member' || !same([me.institution,me.sub],owner)) error.ownerChanged = true; }
          catch (identityError) { if ([401,403].includes(identityError.status)) error.ownerChanged = true; }
        }
        if (mine !== sequence) { error.stale = true; throw error; }
        if (!same(identity(),owner)) error.ownerChanged = true;
        if (error.stale || error.ownerChanged || error.code === 'STUDY_LIST_CHANGED' || !valid()) pending = null;
        state(error.code === 'STUDY_LIST_CHANGED' ? '검사 목록이 바뀌었습니다. 새로고침하세요. 현재 화면은 유지했습니다.' : error.message || '응답을 확인하지 못했습니다. 이어받을 수 있습니다.');
        throw error;
      } finally {
        if (mine === sequence) { busy = false; controller = null; state(); }
      }
    }
    return { read, cancel, clear, get paused() { return paused; }, get busy() { return busy; }, get resumable() { return !!pending; } };
  }
  if (typeof module === 'object' && module.exports) module.exports = { create };
  else root.KinStudyPages = { create };
})(globalThis);

(function(root) {
  'use strict';

  const related = root?.KinRelatedParts ||
    (typeof module === 'object' && module.exports ? require('./related-parts.js') : null);
  const uidPattern = /^[0-9]+(?:\.[0-9]+)+$/;
  const responseLimit = 2 * 1024 * 1024;

  function create({owner, changed, fetcher, requestTimeoutMs = 15000, budgetMs = 60000}) {
    if (typeof owner !== 'function' || typeof changed !== 'function' || !related?.parse)
      throw new TypeError('owner, changed, and KinRelatedParts.parse are required.');
    const request = fetcher || ((...args) => fetch(...args));
    let generation = 0, boundOwner = null, scopeKey = '', studies = [];
    let busy = false, ended = false, note = '';
    const results = new Map(), controllers = new Set(), cancelRejectors = new Set();

    function isOwner(value) { return typeof value === 'string' && value.length > 0; }
    function notify() { try { changed(); } catch (_) {} }
    function stopRequests() {
      generation++;
      busy = false;
      for (const controller of controllers) controller.abort();
      controllers.clear();
      for (const reject of cancelRejectors) reject(Object.assign(new Error('load cancelled'), {cancelled: true}));
      cancelRejectors.clear();
    }
    function allowed() {
      return !ended && isOwner(boundOwner) && owner() === boundOwner;
    }
    function normalize(source) {
      if (!Array.isArray(source)) return [];
      const byUid = new Map();
      for (const item of source) {
        if (!item || typeof item !== 'object' || typeof item.uid !== 'string') continue;
        const uid = item.uid;
        if (!byUid.has(uid)) byUid.set(uid, {uid, series: item.series, count: item.count});
      }
      return [...byUid.values()].sort((a, b) => a.uid.localeCompare(b.uid));
    }
    function keyFor(items) {
      return JSON.stringify(items.map(item => [item.uid, item.series, item.count]));
    }
    function clear(nextStudies, nextKey, nextOwner) {
      stopRequests();
      studies = nextStudies;
      scopeKey = nextKey;
      boundOwner = nextOwner;
      results.clear();
      note = '';
    }
    function sync(source) {
      if (ended) return snapshot();
      const nextStudies = normalize(source), nextKey = keyFor(nextStudies), nextOwner = owner();
      if (nextKey !== scopeKey || nextOwner !== boundOwner) {
        clear(nextStudies, nextKey, nextOwner);
        notify();
      }
      return snapshot();
    }
    function cancel() {
      if (ended) return;
      stopRequests();
      note = '부위 조회를 중단했습니다. 다시 조회하면 남은 검사를 이어서 확인합니다.';
      notify();
    }
    function end() {
      if (ended) return;
      ended = true;
      clear([], '', null);
      note = '';
      notify();
    }
    function get(uid) {
      if (!allowed()) return undefined;
      const value = results.get(uid);
      return value?.verified ? value.parts.slice() : undefined;
    }
    function snapshot() {
      const current = allowed();
      let verified = 0, failed = 0;
      if (current) for (const item of studies) {
        const value = results.get(item.uid);
        if (value?.verified) verified++;
        else if (value?.error) failed++;
      }
      const total = current ? studies.length : 0;
      return {busy: busy && current, total, verified, failed,
        remaining: total - verified - failed, note, allowed: current};
    }

    async function read(uid, signal) {
      const response = await request('/dicom-web/studies/' + encodeURIComponent(uid) +
        '/series?includefield=0020000D,0020000E,00180015&limit=501', {
        signal, credentials: 'same-origin', cache: 'no-store',
        headers: {Accept: 'application/dicom+json'}
      });
      if (!response || typeof response.ok !== 'boolean') throw new Error('시리즈 응답 형식을 확인하지 못했습니다.');
      if (!response.ok) {
        try { await response.body?.cancel(); } catch (_) {}
        const error = new Error('조회 실패 (HTTP ' + response.status + ').');
        error.status = response.status;
        throw error;
      }
      if (!response.body?.getReader) throw new Error('시리즈 응답 본문을 확인하지 못했습니다.');
      const reader = response.body.getReader(), chunks = [];
      let size = 0;
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) throw new Error('시리즈 응답 바이트를 확인하지 못했습니다.');
        size += value.byteLength;
        if (size > responseLimit) {
          try { await reader.cancel(); } catch (_) {}
          throw new Error('응답이 2 MiB 상한을 초과했습니다.');
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    }

    async function load({refresh = false} = {}) {
      if (ended) return snapshot();
      stopRequests();
      const waveOwner = boundOwner, mine = generation;
      if (!isOwner(waveOwner) || owner() !== waveOwner) {
        results.clear();
        note = '로그인 계정을 확인한 뒤 다시 조회하세요.';
        notify();
        return snapshot();
      }
      if (refresh) results.clear();
      const queue = studies.filter(item => refresh || !results.get(item.uid)?.verified);
      note = '';
      if (!queue.length) { notify(); return snapshot(); }
      busy = true;
      notify();
      let budgetExpired = false;
      const budgetRejectors = new Set();
      const active = () => !ended && mine === generation && boundOwner === waveOwner && owner() === waveOwner;
      const budgetTimer = setTimeout(() => {
        if (!active()) return;
        budgetExpired = true;
        for (const controller of controllers) controller.abort();
        for (const reject of budgetRejectors) reject(Object.assign(new Error('load budget expired'), {budgetExpired: true}));
        budgetRejectors.clear();
      }, Math.max(0, budgetMs));

      async function worker() {
        while (active() && !budgetExpired && queue.length) {
          const item = queue.shift();
          if (!uidPattern.test(item.uid) || item.uid.length > 64) {
            results.set(item.uid, {error: '검사 UID가 올바르지 않습니다.'});
            notify();
            continue;
          }
          const controller = new AbortController();
          controllers.add(controller);
          let requestExpired = false;
          let rejectRequest, rejectBudget, rejectCancellation;
          const requestDeadline = new Promise((_, reject) => { rejectRequest = reject; });
          const budgetDeadline = new Promise((_, reject) => { rejectBudget = reject; budgetRejectors.add(reject); });
          const cancellation = new Promise((_, reject) => { rejectCancellation = reject; cancelRejectors.add(reject); });
          const requestTimer = setTimeout(() => {
            requestExpired = true;
            controller.abort();
            rejectRequest(Object.assign(new Error('request timed out'), {requestExpired: true}));
          }, Math.max(0, requestTimeoutMs));
          try {
            const rows = await Promise.race([read(item.uid, controller.signal), requestDeadline, budgetDeadline, cancellation]);
            const parts = related.parse(rows, item.uid).filter(Boolean);
            if (Number.isInteger(item.series) && item.series > 0 && rows.length !== item.series)
              throw new Error('시리즈 수가 목록과 일치하지 않습니다. 목록을 새로 고친 뒤 다시 조회하세요.');
            if (active() && !budgetExpired) results.set(item.uid, {verified: true, parts});
          } catch (error) {
            if (!active()) break;
            if (error?.status === 401 || error?.status === 403) {
              stopRequests();
              results.clear();
              note = '인증 또는 접근 권한 오류로 부위 정보를 모두 지웠습니다. 계정과 목록을 다시 확인한 뒤 재조회하세요.';
              notify();
              break;
            }
            if (budgetExpired || (error?.name === 'AbortError' && !requestExpired)) break;
            results.set(item.uid, {error: requestExpired ? '시리즈 조회 시간이 초과되었습니다. 다시 조회하세요.' :
              (error?.message || '시리즈 부위 정보를 확인하지 못했습니다.')});
            notify();
          } finally {
            clearTimeout(requestTimer);
            budgetRejectors.delete(rejectBudget);
            cancelRejectors.delete(rejectCancellation);
            controllers.delete(controller);
          }
        }
      }

      await Promise.all([worker(), worker(), worker()]);
      clearTimeout(budgetTimer);
      if (active()) {
        busy = false;
        if (budgetExpired) note = '전체 조회 시간이 초과되었습니다. 다시 조회하면 남은 검사를 이어서 확인합니다.';
        notify();
      }
      return snapshot();
    }

    return {sync, load, cancel, end, get, snapshot};
  }

  const api = {create};
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KinWorklistBodyParts = api;
})(typeof window === 'object' ? window : null);

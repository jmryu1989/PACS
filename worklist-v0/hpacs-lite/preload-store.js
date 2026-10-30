/* D1890: pure queue and ciphertext-reference model. The worker owns encryption, disk I/O and server time. */
(function (root) {
  'use strict';
  const GB = 1024 ** 3, TTL = 72 * 60 * 60 * 1000;
  const STATUS = Object.freeze({ queued: 'Queued', downloading: 'Downloading', ready: 'Ready', failed: 'Failed', evicted: 'Evicted' });

  const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
  function budgetFor(diskGb) {
    const bytes = positive(diskGb) ? Math.floor(diskGb * GB) : null;
    return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
  }

  /** The study a frame path names, or null for anything but a WADO-RS frame path without a query. */
  function studyOfPath(path) {
    const m = /^\/dicom-web\/studies\/([0-9.]{1,64})\/series\/[0-9.]{1,64}\/instances\/[0-9.]{1,64}\/frames\/[0-9]+$/.exec(String(path));
    return m ? m[1] : null;
  }

  function create(budget, now = Date.now) {
    const studies = new Map();
    let used = 0, seq = 0, clock = 0, copies = 0;
    const released = [];

    const view = study => Object.freeze({ uid: study.uid, label: study.label, status: study.status, reason: study.reason,
      waiting: study.waiting, done: study.frames.size, total: study.total, bytes: study.bytes, open: study.opens > 0, expiresAt: study.expiresAt });

    function release(study) {
      const ids = [...study.frames.values()].map(f => f.entryId);
      used -= study.bytes;
      study.frames.clear(); study.bytes = 0; study.revision = null; study.total = 0; study.estimate = null; study.copy = null;
      return ids;
    }
    function end(study, status, reason) {
      const ids = release(study);
      study.status = status; study.reason = reason || null; study.waiting = false;
      return ids;
    }

    /** Studies that may go to make room, the longest closed first: opened at least once and open in no viewer now. */
    function evictable(except) {
      return [...studies.values()].filter(s => s.uid !== except && s.bytes > 0 && s.opens === 0 && s.closedAt !== null)
        .sort((a, b) => a.closedAt - b.closedAt);
    }

    return {
      budget: () => budget,
      evictable,
      takeReleased: () => released.splice(0),
      get: uid => studies.get(uid),
      entries: () => [...studies.values()],
      manifest(uid) {
        const s = studies.get(uid);
        return { uid: s.uid, label: s.label, status: s.status === STATUS.downloading ? STATUS.queued : s.status,
          reason: s.reason, revision: s.revision, copy: s.copy, seq: s.seq, total: s.total,
          queuedAt: s.queuedAt, fetchedAt: s.fetchedAt, bytes: s.bytes,
          frames: Object.fromEntries([...s.frames].map(([path, f]) => [path, f.entryId])) };
      },
      restore(value, records) {
        const previous = studies.get(value.uid);
        if (previous) used -= previous.bytes;
        const frames = new Map(Object.entries(value.frames).map(([path, entryId]) => [path, { entryId, bytes: records.get(entryId)?.bytes || 0 }]));
        const s = { ...value, frames, bytes: [...frames.values()].reduce((n, f) => n + f.bytes, 0),
          status: value.status === STATUS.downloading ? STATUS.queued : value.status,
          expiresAt: (value.fetchedAt ?? value.queuedAt) + TTL, waiting: false, opens: 0, closedAt: null, estimate: null };
        studies.set(s.uid, s); used += s.bytes; seq = Math.max(seq, s.seq); copies = Math.max(copies, s.copy || 0);
      },
      suspend() { for (const s of studies.values()) if (s.status === STATUS.downloading) s.status = STATUS.queued; },
      fetched(uid, at) { const s = studies.get(uid); if (s && s.fetchedAt === null) { s.fetchedAt = at; s.expiresAt = at + TTL; } },
      expire(at = now()) {
        const ids = [];
        for (const s of studies.values()) if (s.expiresAt <= at && ![STATUS.evicted, STATUS.failed].includes(s.status)) {
          ids.push(...end(s, STATUS.evicted, s.fetchedAt === null
            ? '72시간 안에 받지 못해 대기열에서 지웠습니다.'
            : '받은 지 72시간이 지나 자동으로 지웠습니다. 다시 받으려면 Retry를 누르세요.'));
        }
        return ids;
      },
      /** Site disk cap (null: preload off). */
      setBudget(bytes) { budget = Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null; },
      used: () => used,
      /** Queue studies (in the reader's order). A study already queued, loading or held stays as it is. */
      add(list) {
        const added = [];
        for (const { uid, label } of list) {
          const known = studies.get(uid);
          if (known && ![STATUS.failed, STATUS.evicted].includes(known.status)) continue;
          if (known) { known.status = STATUS.queued; known.reason = null; known.seq = ++seq; known.queuedAt = now(); known.fetchedAt = null; known.expiresAt = now() + TTL; known.label = label ?? known.label; added.push(uid); continue; }
          studies.set(uid, { uid, label: label ?? null, status: STATUS.queued, reason: null, waiting: false, seq: ++seq,
            queuedAt: now(), fetchedAt: null, expiresAt: now() + TTL, frames: new Map(), bytes: 0, total: 0, revision: null, estimate: null, copy: null, opens: 0, closedAt: null });
          added.push(uid);
        }
        return added;
      },
      /** Retry puts the study at the head of the queue (design §4.1). */
      retry(uid) {
        const study = studies.get(uid);
        if (!study || ![STATUS.failed, STATUS.evicted].includes(study.status)) return false;
        const first = Math.min(0, ...[...studies.values()].map(s => s.seq));
        study.status = STATUS.queued; study.reason = null; study.waiting = false; study.seq = first - 1; study.queuedAt = now(); study.fetchedAt = null; study.expiresAt = now() + TTL;
        return true;
      },
      /** The next study to fetch: the earliest queued one that is not waiting for space. */
      next() {
        return [...studies.values()].filter(s => s.status === STATUS.queued && !s.waiting).sort((a, b) => a.seq - b.seq)[0] || null;
      },
      /** Fetching begins or goes on; false when the study was cleared, removed or failed meanwhile. */
      start(uid, total) {
        const study = studies.get(uid);
        if (!study || ![STATUS.queued, STATUS.downloading].includes(study.status)) return false;
        if (study.copy === null) study.copy = ++copies;
        study.status = STATUS.downloading; study.reason = null; study.waiting = false;
        if (Number.isInteger(total) && total > 0) study.total = total;
        return true;
      },
      /**
       * Keep one frame of a study being fetched. `changed`: the archive's revision differs from the study's earlier
       * frames (the study changed while it was fetched - nothing of it is kept). `full`: no room even after eviction (the
       * study waits for space, its frames kept). `oversize`: the study could not fit even alone in the store - its frames
       * so far already exceed the budget, or, where it would otherwise wait, its frames so far projected over its frame
       * count do - so waiting for others to go would never let it in. `gone`: the study is no longer being fetched
       * (cleared, retried, evicted).
       */
      put(uid, path, frame, revision) {
        const study = studies.get(uid);
        if (!study || study.status !== STATUS.downloading) return 'gone';
        if (typeof revision !== 'string' || !revision) return 'changed';
        if (study.revision !== null && study.revision !== revision) return 'changed';
        if (study.frames.has(path)) return 'stored';
        const size = frame.bytes;
        if (budget !== null && study.bytes + size > budget) return 'oversize';
        if (budget === null || used + size > budget) {
          for (const victim of evictable(uid)) {
            if (budget !== null && used + size <= budget) break;
            released.push(...end(victim, STATUS.evicted, '저장 공간을 비우려고 이미 본 검사를 지웠습니다. 다시 받으려면 Retry를 누르세요.'));
          }
          if (budget === null || used + size > budget) {
            // Before parking: from the frames read so far, would the whole study fit even if every other study went?
            const read = study.frames.size + 1;
            if (budget !== null && study.total > read && (study.bytes + size) / read * study.total > budget) return 'oversize';
            study.status = STATUS.queued; study.waiting = true; study.reason = '저장 공간이 비기를 기다립니다.';
            return 'full';
          }
        }
        study.revision = revision;
        if (study.copy === null) study.copy = ++copies;
        study.frames.set(path, frame);
        study.bytes += size; used += size;
        return 'stored';
      },
      /** The size the whole study will take, from its first frames; false when even an empty store could not hold it. */
      estimate(uid, bytes) {
        const study = studies.get(uid);
        if (!study) return false;
        study.estimate = bytes;
        return budget !== null && bytes <= budget;
      },
      ready(uid) {
        const study = studies.get(uid);
        if (!study || study.status !== STATUS.downloading) return false;
        study.status = STATUS.ready; study.reason = null;
        return true;
      },
      fail(uid, reason) { const study = studies.get(uid); return study ? end(study, STATUS.failed, reason) : []; },
      evict(uid, reason) { const study = studies.get(uid); return study ? end(study, STATUS.evicted, reason) : []; },
      remove(uid) { const study = studies.get(uid); if (!study) return []; const ids = release(study); studies.delete(uid); return ids; },
      /** Clear All releases references; the list keeps the entries as Evicted. Session changes discard the model only. */
      clear(reason) { return [...studies.values()].flatMap(study => end(study, STATUS.evicted, reason)); },
      /** Space may have come free: studies that waited for it are queued again. */
      wake() { let woke = false; for (const s of studies.values()) if (s.waiting) { s.waiting = false; woke = true; } return woke; },
      /** The held study a viewer may check: its revision and copy, or null when nothing of it is held. */
      held(uid) {
        const study = studies.get(uid);
        return study && study.expiresAt > now() && study.frames.size && [STATUS.downloading, STATUS.ready, STATUS.queued].includes(study.status)
          ? { revision: study.revision, status: study.status, copy: study.copy } : null;
      },
      frame(path) {
        const uid = studyOfPath(path), study = uid && studies.get(uid);
        return study && study.expiresAt > now() && [STATUS.downloading, STATUS.ready, STATUS.queued].includes(study.status) ? study.frames.get(path) || null : null;
      },
      /** A viewer shows the study: it cannot be evicted until every viewer that opened it has closed it. */
      open(uid) { const study = studies.get(uid); if (study) { study.opens++; study.closedAt = null; } },
      close(uid) {
        const study = studies.get(uid);
        if (!study || study.opens === 0) return false;
        if (--study.opens === 0) study.closedAt = ++clock;
        return study.opens === 0;
      },
      snapshot() {
        return Object.freeze({ budget, used, studies: [...studies.values()].sort((a, b) => a.seq - b.seq).map(view) });
      },
    };
  }

  const api = Object.freeze({ create, budgetFor, studyOfPath, STATUS, TTL });
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KinPreloadStore = api;
})(typeof self === 'object' ? self : typeof window === 'object' ? window : null);

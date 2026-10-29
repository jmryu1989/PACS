/* D1880 memory-only preload (Minhoon P0 item 1): the store the preload SharedWorker keeps. Pure state - no fetch, no
 * timers, no storage API - so the worker (importScripts) and node tests share one model.
 *
 * Nothing here is ever written to disk: the bytes are ArrayBuffers in the worker's memory and end with it (D1880: no
 * Cache Storage, IndexedDB or OPFS). A study's frames are kept as the reader sent them for preload - the gzip stream of
 * the multipart frame answer, or the relayed answer unchanged - with the archive revision they were read under, which the
 * viewer checks live before it shows one (viewer-preload.js).
 *
 * Budget: the memory the browser reports (`navigator.deviceMemory`, GB; Chrome rounds it down and reports at most 8)
 * times the share of it the site sets for the preload (`KIN_PRELOAD_MEMORY_SHARE`, answered with /api/me). There is no
 * built-in share and no ceiling of our own: neither has a measured source yet (the design's 0.15 and 4 GB were starting
 * values awaiting its measurement M1 - reading PCs, comparison reading with a full store), so the first site sets the
 * share from its own reading PCs and the preload stays off until it does. A browser that reports no memory gets no
 * preload either.
 *
 * Eviction never touches the study a viewer has open, nor a study the reader has not looked at yet: those are the next
 * reads, and dropping an earlier one to fetch a later one would serve the queue backwards. Only studies opened and then
 * closed go, the longest closed first; when nothing can go, the study being fetched waits for memory (Queued) and the
 * queue resumes when a viewer closes a study or the reader clears one. A study that could not fit even if it were alone
 * in the store does not wait: it fails with its reason, its bytes go, and the queue goes on.
 *
 * Each fetch of a study is one copy with its own identity: a viewer checked one copy live, and it is answered from that
 * copy only - one fetched again after Clear All or Retry needs a check of its own (viewer-preload.js).
 */
(function (root) {
  'use strict';
  const GB = 1024 ** 3;
  const STATUS = Object.freeze({ queued: 'Queued', downloading: 'Downloading', ready: 'Ready', failed: 'Failed', evicted: 'Evicted' });

  const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
  /** Bytes the store may hold, or null when the browser reports no memory or the site set no share (preload off). */
  function budgetFor(deviceMemory, share) {
    if (!positive(deviceMemory) || !positive(share) || share > 1) return null;
    return Math.floor(share * deviceMemory * GB);
  }

  /** The study a frame path names, or null for anything but a WADO-RS frame path without a query. */
  function studyOfPath(path) {
    const m = /^\/dicom-web\/studies\/([0-9.]{1,64})\/series\/[0-9.]{1,64}\/instances\/[0-9.]{1,64}\/frames\/[0-9]+$/.exec(String(path));
    return m ? m[1] : null;
  }

  function create(budget) {
    const studies = new Map();
    let used = 0, seq = 0, clock = 0, copies = 0;

    const view = study => Object.freeze({ uid: study.uid, label: study.label, status: study.status, reason: study.reason,
      waiting: study.waiting, done: study.frames.size, total: study.total, bytes: study.bytes, open: study.opens > 0 });

    function release(study) {
      used -= study.bytes;
      study.frames.clear(); study.bytes = 0; study.revision = null; study.total = 0; study.estimate = null; study.copy = null;
    }
    function end(study, status, reason) {
      release(study);
      study.status = status; study.reason = reason || null; study.waiting = false;
    }

    /** Studies that may go to make room, the longest closed first: opened at least once and open in no viewer now. */
    function evictable(except) {
      return [...studies.values()].filter(s => s.uid !== except && s.bytes > 0 && s.opens === 0 && s.closedAt !== null)
        .sort((a, b) => a.closedAt - b.closedAt);
    }

    return {
      budget: () => budget,
      /** The budget once the browser's memory and the site's share are known (null: preload off). */
      setBudget(bytes) { budget = Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null; },
      used: () => used,
      /** Queue studies (in the reader's order). A study already queued, loading or held stays as it is. */
      add(list) {
        const added = [];
        for (const { uid, label } of list) {
          const known = studies.get(uid);
          if (known && ![STATUS.failed, STATUS.evicted].includes(known.status)) continue;
          if (known) { known.status = STATUS.queued; known.reason = null; known.seq = ++seq; known.label = label ?? known.label; added.push(uid); continue; }
          studies.set(uid, { uid, label: label ?? null, status: STATUS.queued, reason: null, waiting: false, seq: ++seq,
            frames: new Map(), bytes: 0, total: 0, revision: null, estimate: null, copy: null, opens: 0, closedAt: null });
          added.push(uid);
        }
        return added;
      },
      /** Retry puts the study at the head of the queue (design §4.1). */
      retry(uid) {
        const study = studies.get(uid);
        if (!study || ![STATUS.failed, STATUS.evicted].includes(study.status)) return false;
        const first = Math.min(0, ...[...studies.values()].map(s => s.seq));
        study.status = STATUS.queued; study.reason = null; study.waiting = false; study.seq = first - 1;
        return true;
      },
      /** The next study to fetch: the earliest queued one that is not waiting for memory. */
      next() {
        return [...studies.values()].filter(s => s.status === STATUS.queued && !s.waiting).sort((a, b) => a.seq - b.seq)[0] || null;
      },
      /** Fetching begins or goes on; false when the study was cleared, removed or failed meanwhile. */
      start(uid, total) {
        const study = studies.get(uid);
        if (!study || ![STATUS.queued, STATUS.downloading].includes(study.status)) return false;
        study.status = STATUS.downloading; study.reason = null; study.waiting = false;
        if (Number.isInteger(total) && total > 0) study.total = total;
        return true;
      },
      /**
       * Keep one frame of a study being fetched. `changed`: the archive's revision differs from the study's earlier
       * frames (the study changed while it was fetched - nothing of it is kept). `full`: no room even after eviction (the
       * study waits for memory, its frames kept). `oversize`: the study could not fit even alone in the store - its frames
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
        const size = frame.data.byteLength;
        if (budget !== null && study.bytes + size > budget) return 'oversize';
        if (budget === null || used + size > budget) {
          for (const victim of evictable(uid)) {
            if (used + size <= budget) break;
            end(victim, STATUS.evicted, '메모리를 비우려고 이미 본 검사를 내렸습니다. 다시 받으려면 Retry를 누르세요.');
          }
          if (budget === null || used + size > budget) {
            // Before parking: from the frames read so far, would the whole study fit even if every other study went?
            const read = study.frames.size + 1;
            if (budget !== null && study.total > read && (study.bytes + size) / read * study.total > budget) return 'oversize';
            study.status = STATUS.queued; study.waiting = true; study.reason = '메모리가 비기를 기다립니다.';
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
      fail(uid, reason) { const study = studies.get(uid); if (study) end(study, STATUS.failed, reason); },
      evict(uid, reason) { const study = studies.get(uid); if (study) end(study, STATUS.evicted, reason); },
      remove(uid) { const study = studies.get(uid); if (!study) return; release(study); studies.delete(uid); },
      /** Everything goes (another session, the session ended, Clear All); the list keeps the entries as Evicted. */
      clear(reason) { for (const study of studies.values()) if (study.status !== STATUS.failed || study.bytes) end(study, STATUS.evicted, reason); },
      /** Memory may have come free: studies that waited for it are queued again. */
      wake() { let woke = false; for (const s of studies.values()) if (s.waiting) { s.waiting = false; woke = true; } return woke; },
      /** The held study a viewer may check: its revision and copy, or null when nothing of it is held. */
      held(uid) {
        const study = studies.get(uid);
        return study && study.frames.size && [STATUS.downloading, STATUS.ready, STATUS.queued].includes(study.status)
          ? { revision: study.revision, status: study.status, copy: study.copy } : null;
      },
      frame(path) {
        const uid = studyOfPath(path), study = uid && studies.get(uid);
        return study && [STATUS.downloading, STATUS.ready, STATUS.queued].includes(study.status) ? study.frames.get(path) || null : null;
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

  const api = Object.freeze({ create, budgetFor, studyOfPath, STATUS });
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KinPreloadStore = api;
})(typeof self === 'object' ? self : typeof window === 'object' ? window : null);

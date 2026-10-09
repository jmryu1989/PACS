/* Stored XA playback model (REQ-XA-01..06): which object may play in time, with which source timing, in which order,
   and how much decoded memory a bounded window may hold. Pure and synchronous: the viewer module owns timers, loads
   and the DOM. The model reads DICOM JSON (PS3.18 F.2, as DICOMweb metadata and standard libraries give it) and never
   touches pixel data, so it cannot re-subtract, rebuild a mask or shift pixels: stored pixels play as stored. */
(function (root) {
  'use strict';
  const SOP = Object.freeze({ xa: '1.2.840.10008.5.1.4.1.1.12.1', enhancedXa: '1.2.840.10008.5.1.4.1.1.12.1.1' });
  const TAG = Object.freeze({
    sopClass: '00080016', sop: '00080018', study: '0020000D', series: '0020000E', frames: '00280008', pointer: '00280009',
    frameTime: '00181063', frameTimeVector: '00181065', rows: '00280010', columns: '00280011', samples: '00280002',
    bitsAllocated: '00280100', bitsStored: '00280101', highBit: '00280102', pixelRepresentation: '00280103',
    viewingMode: '00281090', maskSubtraction: '00286100', perFrame: '52009230', frameContent: '00209111',
    referenceTime: '00189151', acquisitionTime: '00189074', dimensionIndex: '00209222', dimensionPointer: '00209165',
  });
  // Enhanced XA dimensions that order frames in time (Frame Content macro attributes used as a Dimension Index Pointer).
  const TEMPORAL = new Set([TAG.acquisitionTime, TAG.referenceTime, '00209128']);
  // Initial explicit budget: the sum over every active XA viewport of decoded retained + in-flight reservations. It is
  // this module's accounting, not a process-wide memory limit (the shared image cache and codecs hold memory of their own).
  const LIMITS = Object.freeze({ bytes: 128 * 1024 * 1024, decodes: 4, prepared: 500, ahead: 8 });
  const MODES = Object.freeze(['forward', 'reverse', 'yoyo']);
  const SOURCE_RATES = Object.freeze([0.5, 1, 2]);
  const MANUAL_FPS = Object.freeze([5, 10, 15, 30]);

  const uid = v => typeof v === 'string' && v.length <= 64 && /^\d+(?:\.\d+)+$/.test(v);
  const element = (json, tag) => json && typeof json === 'object' ? json[tag] : undefined;
  const values = (json, tag) => { const e = element(json, tag); return e && Array.isArray(e.Value) ? e.Value : undefined; };
  const one = (json, tag) => values(json, tag)?.[0];
  // DS/IS arrive as JSON numbers; some archives send the original decimal string instead.
  const number = v => typeof v === 'number' ? v
    : typeof v === 'string' && /^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\s*$/.test(v) ? Number(v) : NaN;
  const integer = v => { const n = number(v); return Number.isSafeInteger(n) ? n : NaN; };
  const hex = v => typeof v === 'string' && /^[0-9A-Fa-f]{8}$/.test(v) ? v.toUpperCase() : null;
  const refuse = (reason, extra) => Object.freeze({ ok: false, reason, ...extra });
  const unverified = reason => Object.freeze({ source: 'unverified', verified: false, reason, offsets: null });

  /* Cine Module C.7.6.5 with the X-Ray Image Module C.8.7.1 pointer rule: the Frame Increment Pointer names Frame Time
     or Frame Time Vector. Relative times are kept from frame 1, so Frame Delay (a shared offset from Content Time) does
     not change any interval. Anything missing or contradictory is Unverified, never a guessed normal speed. */
  function cineTiming(json, frames) {
    const pointers = values(json, TAG.pointer);
    if (!Array.isArray(pointers) || pointers.length !== 1) return unverified('pointer');
    const pointer = hex(pointers[0]);
    if (pointer === TAG.frameTime) {
      const step = number(one(json, TAG.frameTime));
      if (!Number.isFinite(step) || step <= 0) return unverified('frame-time');
      const offsets = Array.from({ length: frames }, (_, i) => i * step);
      if (!Number.isFinite(offsets[frames - 1])) return unverified('frame-time');
      return Object.freeze({ source: 'frame-time', verified: true, reason: null, offsets: Object.freeze(offsets) });
    }
    if (pointer === TAG.frameTimeVector) {
      const vector = values(json, TAG.frameTimeVector);
      if (!Array.isArray(vector) || vector.length !== frames) return unverified('vector-length');
      const steps = vector.map(number);
      // The first frame always has an increment of 0; a later increment must be a real, positive time.
      if (steps[0] !== 0) return unverified('vector-first');
      if (steps.slice(1).some(n => !Number.isFinite(n) || n <= 0)) return unverified('vector-value');
      const offsets = [0];
      for (let i = 1; i < frames; i++) offsets.push(offsets[i - 1] + steps[i]);
      if (!Number.isFinite(offsets[frames - 1])) return unverified('vector-value');
      return Object.freeze({ source: 'frame-time-vector', verified: true, reason: null, offsets: Object.freeze(offsets) });
    }
    return unverified('pointer-target');
  }

  // DT "YYYYMMDDHHMMSS[.F{1,6}][&ZZXX]" to milliseconds (fraction kept). Shorter DT values cannot order frames.
  function dateTime(v) {
    const m = typeof v === 'string' && v.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{1,6}))?(?:([+-])(\d{2})(\d{2}))?$/);
    if (!m) return null;
    const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
    const at = Date.UTC(y, mo - 1, d, h, mi, s);
    const check = new Date(at);
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null;
    const zone = m[8] ? (m[8] === '-' ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10])) * 60000 : 0;
    return { ms: at + (m[7] ? Number('0.' + m[7]) * 1000 : 0) - zone, zoned: !!m[8] };
  }

  /* Enhanced XA (A.47-1) carries no Cine Module: top-level Frame Time / Frame Time Vector are not its timing. Its
     timing is the per-frame Frame Content: Frame Reference DateTime for every frame, else Frame Acquisition DateTime
     for every frame (never a mix), strictly increasing in stored order. */
  function contentTiming(json, frames) {
    const items = values(json, TAG.perFrame);
    if (!Array.isArray(items) || items.length !== frames) return unverified('per-frame');
    for (const tag of [TAG.referenceTime, TAG.acquisitionTime]) {
      const raw = items.map(item => one(one(item, TAG.frameContent), tag));
      if (raw.some(v => v === undefined)) continue;
      const times = raw.map(dateTime);
      if (times.some(t => !t) || new Set(times.map(t => t.zoned)).size !== 1) return unverified('content-time');
      const offsets = times.map(t => t.ms - times[0].ms);
      for (let i = 1; i < frames; i++) if (!(offsets[i] > offsets[i - 1]) || !Number.isFinite(offsets[i])) return unverified('content-order');
      return Object.freeze({ source: 'frame-content', verified: true, reason: null, offsets: Object.freeze(offsets) });
    }
    return unverified('content-time');
  }

  // An Enhanced object with more than one dimension (e.g. stack x time) is never flattened into one time run.
  function enhancedDimension(json, timing) {
    const dimensions = values(json, TAG.dimensionIndex);
    if (Array.isArray(dimensions)) return dimensions.length === 1 && TEMPORAL.has(hex(one(dimensions[0], TAG.dimensionPointer))) ? 'time' : 'frames';
    return timing.verified ? 'time' : 'frames';
  }

  /* Conservative per-frame reservation: the decoder output reserved at 4 bytes per sample (the pinned renderer may
     scale stored values to Float32) plus one RGBA8 staging copy for the texture, both with 4-byte row alignment.
     Missing, inconsistent or overflowing pixel attributes never become a successful reservation. */
  function frameBytes(json) {
    const rows = integer(one(json, TAG.rows)), columns = integer(one(json, TAG.columns)), samples = integer(one(json, TAG.samples));
    const allocated = integer(one(json, TAG.bitsAllocated)), stored = integer(one(json, TAG.bitsStored));
    const high = integer(one(json, TAG.highBit)), representation = integer(one(json, TAG.pixelRepresentation));
    if (![rows, columns].every(n => n >= 1 && n <= 65535)) return refuse('pixel-size');
    if (![1, 3].includes(samples) || ![8, 16, 32].includes(allocated) || !(stored >= 1 && stored <= allocated) ||
        high !== stored - 1 || ![0, 1].includes(representation)) return refuse('pixel-layout');
    const align = n => Math.ceil(n / 4) * 4;
    const bytes = rows * align(columns * samples * 4) + rows * align(columns * 4);
    if (!Number.isSafeInteger(bytes) || bytes <= 0) return refuse('pixel-size');
    return Object.freeze({ ok: true, bytes, rows, columns, samples, bitsAllocated: allocated });
  }

  function describe(json) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) return refuse('metadata');
    const sopClass = one(json, TAG.sopClass);
    const kind = sopClass === SOP.xa ? 'xa' : sopClass === SOP.enhancedXa ? 'enhanced-xa' : 'other';
    const study = one(json, TAG.study), series = one(json, TAG.series), sop = one(json, TAG.sop);
    if (![sopClass, study, series, sop].every(uid)) return refuse('identity', { kind });
    const raw = one(json, TAG.frames);
    const frames = raw === undefined ? 1 : integer(raw);
    if (!Number.isSafeInteger(frames) || frames < 1) return refuse('frames', { kind });
    const timing = frames < 2 ? Object.freeze({ source: 'still', verified: false, reason: 'still', offsets: null })
      : kind === 'enhanced-xa' ? contentTiming(json, frames) : cineTiming(json, frames);
    // A classic XA multi-frame is a time run by its IOD (its pointer may only name Frame Time or Frame Time Vector),
    // even when the values are missing; an Enhanced XA must show its time dimension.
    const playback = frames < 2 ? 'still' : kind === 'xa' ? 'time' : kind === 'enhanced-xa' ? enhancedDimension(json, timing) : 'other';
    const reservation = frameBytes(json);
    const subtractionRecommended = String(one(json, TAG.viewingMode) || '').trim().toUpperCase() === 'SUB' ||
      (values(json, TAG.maskSubtraction) || []).length > 0;
    return Object.freeze({ ok: true, kind, sopClass, study, series, sop, frames, timing, playback,
      frameBytes: reservation.ok ? reservation.bytes : null, reservation, subtractionRecommended });
  }

  /* One display set -> one playback owner. XA never goes to the generic fixed-rate cine: a still is a still, a damaged
     XA plays nowhere, several XA objects in one set are not flattened into a run. Everything else keeps its path. */
  function route(list) {
    const items = Array.isArray(list) ? list : [list];
    if (!items.length) return Object.freeze({ path: 'refused', reason: 'empty' });
    const xa = items.filter(d => d && (d.kind === 'xa' || d.kind === 'enhanced-xa'));
    if (!xa.length) return Object.freeze({ path: 'generic', reason: null });
    if (items.length !== 1) return Object.freeze({ path: 'still', reason: 'several-objects' });
    const d = items[0];
    if (!d.ok) return Object.freeze({ path: 'refused', reason: d.reason });
    if (d.playback === 'still') return Object.freeze({ path: 'still', reason: 'one-frame' });
    if (d.playback === 'frames') return Object.freeze({ path: 'xa-frames', reason: 'no-time-dimension' });
    if (!d.reservation.ok) return Object.freeze({ path: 'refused', reason: d.reservation.reason });
    // Playing means holding the frame on screen and the next one; a frame that cannot pair within the budget cannot play.
    if (d.frameBytes * 2 > LIMITS.bytes) return Object.freeze({ path: 'refused', reason: 'frame-too-large' });
    return Object.freeze({ path: 'xa', reason: null });
  }

  // Source frame identity (1-based DICOM frame number) is kept apart from the 0-based viewport index.
  function frame(d, index) {
    if (!d?.ok || !Number.isSafeInteger(index) || index < 0 || index >= d.frames) throw RangeError('frame index outside the object');
    return Object.freeze({ index, number: index + 1, key: d.sop + '#' + (index + 1) });
  }

  function step({ index, first, last, mode, direction, loop }) {
    if (![index, first, last].every(Number.isSafeInteger) || first < 0 || first >= last || index < first || index > last ||
        !MODES.includes(mode)) throw RangeError('invalid play state');
    if (mode === 'yoyo') {
      let nextDirection = direction === -1 ? -1 : 1;
      if (index === last && nextDirection === 1) nextDirection = -1;
      else if (index === first && nextDirection === -1) {
        if (!loop) return { stop: true, direction: nextDirection };
        nextDirection = 1;
      }
      return { stop: false, direction: nextDirection, next: index + nextDirection };
    }
    const nextDirection = mode === 'reverse' ? -1 : 1, next = index + nextDirection;
    if (next >= first && next <= last) return { stop: false, direction: nextDirection, next };
    return loop ? { stop: false, direction: nextDirection, next: nextDirection === 1 ? first : last } : { stop: true, direction: nextDirection };
  }

  function speedOptions(timing) {
    const source = timing?.verified ? SOURCE_RATES.map(rate => Object.freeze({ kind: 'source', rate })) : [];
    return Object.freeze([...source, ...MANUAL_FPS.map(fps => Object.freeze({ kind: 'manual', fps }))]);
  }
  const defaultSpeed = timing => timing?.verified ? Object.freeze({ kind: 'source', rate: 1 }) : Object.freeze({ kind: 'manual', fps: 10 });

  /* Wait before showing `to` after `from`. Source timing uses the real difference of the two adjacent stored frames
     (reverse plays the same difference backwards); a wrap from a range end uses that end frame's own interval. */
  function interval(timing, speed, from, to, range) {
    if (speed?.kind === 'manual') {
      if (!MANUAL_FPS.includes(speed.fps)) throw RangeError('unsupported manual speed');
      return 1000 / speed.fps;
    }
    if (speed?.kind !== 'source' || !SOURCE_RATES.includes(speed.rate) || !timing?.verified) throw RangeError('source timing is not verified');
    const offsets = timing.offsets;
    if (![from, to].every(n => Number.isSafeInteger(n) && n >= 0 && n < offsets.length) || !range || from < range.first || from > range.last) throw RangeError('frame outside the timeline');
    const neighbour = Math.abs(to - from) === 1 ? to : from === range.last ? from - 1 : from + 1;
    return Math.abs(offsets[from] - offsets[neighbour]) / speed.rate;
  }

  // The frames a window should hold, current first, in play order; it never repeats a frame or leaves the range.
  function windowPlan({ index, first, last, mode, direction, loop, ahead }) {
    const plan = [index];
    let at = index, heading = direction;
    for (let n = 0; n < ahead; n++) {
      const s = step({ index: at, first, last, mode, direction: heading, loop });
      if (s.stop || plan.includes(s.next)) break;
      plan.push(s.next); at = s.next; heading = s.direction;
    }
    return plan;
  }

  // Look-ahead within a fair share of the budget; the frame on screen and the next one are the playing minimum.
  function aheadFor({ frameBytes: size, owners, limits = LIMITS }) {
    if (!Number.isSafeInteger(size) || size <= 0) return 0;
    const share = Math.floor(limits.bytes / Math.max(1, owners));
    return Math.max(1, Math.min(limits.ahead, Math.floor(share / size) - 1));
  }

  /* One budget for every XA viewport of the document. A reservation is taken before the fetch starts and is keyed by
     the source frame, so two viewports of the same frame share one reservation and one decode. A viewport only ever
     releases its own hold; a frame another viewport holds or pins stays. A failed load ends the reservation for all. */
  function createBudget(limits = LIMITS) {
    const entries = new Map();
    let bytes = 0, loading = 0, peakBytes = 0, peakLoading = 0, peakPrepared = 0;
    const no = reason => ({ ok: false, reason });
    function reserve(owner, key, size) {
      if (!owner || typeof key !== 'string' || !key || !Number.isSafeInteger(size) || size <= 0) return no('invalid');
      const held = entries.get(key);
      if (held) {
        if (held.size !== size) return no('invalid');
        held.owners.add(owner);
        return { ok: true, shared: true, state: held.state };
      }
      if (size > limits.bytes) return no('too-large');
      if (bytes + size > limits.bytes) return no('bytes');
      if (entries.size >= limits.prepared) return no('prepared');
      if (loading >= limits.decodes) return no('decodes');
      entries.set(key, { size, owners: new Set([owner]), pins: new Set(), state: 'loading' });
      bytes += size; loading++;
      peakBytes = Math.max(peakBytes, bytes); peakLoading = Math.max(peakLoading, loading); peakPrepared = Math.max(peakPrepared, entries.size);
      return { ok: true, shared: false, state: 'loading' };
    }
    function ready(key) {
      const held = entries.get(key);
      if (held?.state !== 'loading') return false;
      held.state = 'ready'; loading--;
      return true;
    }
    function drop(key) {
      const held = entries.get(key);
      if (!held) return false;
      entries.delete(key); bytes -= held.size;
      if (held.state === 'loading') loading--;
      return true;
    }
    function release(owner, key) {
      const held = entries.get(key);
      if (!held || !held.owners.has(owner)) return false;
      held.owners.delete(owner); held.pins.delete(owner);
      if (held.owners.size) return false;
      return drop(key);
    }
    function pin(owner, key) { const held = entries.get(key); if (!held?.owners.has(owner)) return false; held.pins.add(owner); return true; }
    function unpin(owner, key) { const held = entries.get(key); return !!held && held.pins.delete(owner); }
    const holds = (owner, key) => !!entries.get(key)?.owners.has(owner);
    const pinned = key => (entries.get(key)?.pins.size || 0) > 0;
    const state = key => entries.get(key)?.state || null;
    const snapshot = () => ({ bytes, loading, prepared: entries.size, peakBytes, peakLoading, peakPrepared, limit: limits.bytes });
    return Object.freeze({ reserve, ready, drop, release, pin, unpin, holds, pinned, state, snapshot, limits });
  }

  /* An opening is the account, the institution, the object and the opening sequence. Another account or no session
     ends playback; the same object opened again (A -> B -> A) is a new opening, so the old one's answers are stale. */
  function sameOpening(opened, now) {
    if (!now || typeof now !== 'object') return 'ended';
    if (now.account !== opened.account || now.institution !== opened.institution) return 'ended';
    if (now.study !== opened.study || now.series !== opened.series || now.sop !== opened.sop || now.sequence !== opened.sequence) return 'stale';
    return 'current';
  }

  /* What a failed frame means for the reader: refused access hides the image, a transfer cut/codec/timeout keeps the
     last shown frame with a retry, a cancellation the viewer made itself is no failure at all. None is success. */
  function failureKind(error, { cancelled = false, timedOut = false } = {}) {
    if (cancelled) return 'cancelled';
    if (timedOut) return 'timeout';
    const status = Number(error?.status);
    if (status === 401 || status === 403) return 'denied';
    if (error?.name === 'AbortError') return 'interrupted';
    return 'failed';
  }

  // Shown means rendered on screen in this opening; a requested or decoded frame is not shown.
  function createCoverage(first, last) {
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 0 || last < first) throw RangeError('invalid coverage range');
    const shown = new Set();
    return Object.freeze({
      mark(index) { if (Number.isSafeInteger(index) && index >= first && index <= last) shown.add(index); },
      snapshot: () => ({ shown: shown.size, total: last - first + 1, all: shown.size === last - first + 1 }),
    });
  }

  const api = Object.freeze({ SOP, LIMITS, MODES, describe, route, frame, step, speedOptions, defaultSpeed, interval,
    windowPlan, aheadFor, createBudget, sameOpening, failureKind, createCoverage });
  if (typeof module === 'object' && module.exports) module.exports = api; else root.KinXaPlaybackModel = api;
})(globalThis);

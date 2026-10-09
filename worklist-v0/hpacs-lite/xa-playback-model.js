/* Stored XA playback model (REQ-XA-01..06): which object may play in time, with which source timing, in which order,
   and how much decoded memory a bounded window may hold. Pure and synchronous: the viewer module owns timers, loads
   and the DOM. The model reads DICOM JSON (PS3.18 F.2, as DICOMweb metadata and standard libraries give it) and never
   touches pixel data, so it cannot re-subtract, rebuild a mask or shift pixels: stored pixels play as stored. */
(function (root) {
  'use strict';
  const SOP = Object.freeze({ xa: '1.2.840.10008.5.1.4.1.1.12.1', enhancedXa: '1.2.840.10008.5.1.4.1.1.12.1.1' });
  const TAG = Object.freeze({
    sopClass: '00080016', sop: '00080018', study: '0020000D', series: '0020000E', frames: '00280008', pointer: '00280009',
    frameTime: '00181063', frameTimeVector: '00181065', frameDelay: '00181066', rows: '00280010', columns: '00280011', samples: '00280002',
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
  const unverified = reason => Object.freeze({ source: 'unverified', verified: false, reason, offsets: null, basis: null });
  // `offsets` are the playback timeline from frame 1; `basis` keeps the source's own time reference as data.
  const verifiedTimeline = (source, offsets, basis) => Object.freeze({ source, verified: true, reason: null,
    offsets: Object.freeze(offsets), basis: Object.freeze({ ...basis, relative: Object.freeze(basis.relative) }) });

  /* Cine Module C.7.6.5 with the X-Ray Image Module C.8.7.1 pointer rule: the Frame Increment Pointer names Frame Time
     or Frame Time Vector. Playback intervals come from `offsets` (frame 1 = 0); the source basis keeps Frame Delay and
     the C.7.6.5 relative time of every frame from Content Time (Frame Delay + Frame Time x (n-1), or Frame Delay + the
     summed vector). Anything missing or contradictory is Unverified, never a guessed normal speed. */
  function cineTiming(json, frames) {
    const pointers = values(json, TAG.pointer);
    if (!Array.isArray(pointers) || pointers.length !== 1) return unverified('pointer');
    const rawDelay = one(json, TAG.frameDelay);
    const frameDelay = rawDelay === undefined ? 0 : number(rawDelay);
    if (!Number.isFinite(frameDelay)) return unverified('frame-delay');
    const pointer = hex(pointers[0]);
    let source, offsets;
    if (pointer === TAG.frameTime) {
      const step = number(one(json, TAG.frameTime));
      if (!Number.isFinite(step) || step <= 0) return unverified('frame-time');
      offsets = Array.from({ length: frames }, (_, i) => i * step);
      if (!Number.isFinite(offsets[frames - 1])) return unverified('frame-time');
      source = 'frame-time';
    } else if (pointer === TAG.frameTimeVector) {
      const vector = values(json, TAG.frameTimeVector);
      if (!Array.isArray(vector) || vector.length !== frames) return unverified('vector-length');
      const steps = vector.map(number);
      // The first frame always has an increment of 0; a later increment must be a real, positive time.
      if (steps[0] !== 0) return unverified('vector-first');
      if (steps.slice(1).some(n => !Number.isFinite(n) || n <= 0)) return unverified('vector-value');
      offsets = [0];
      for (let i = 1; i < frames; i++) offsets.push(offsets[i - 1] + steps[i]);
      if (!Number.isFinite(offsets[frames - 1])) return unverified('vector-value');
      source = 'frame-time-vector';
    } else return unverified('pointer-target');
    const relative = offsets.map(o => frameDelay + o);
    if (!relative.every(Number.isFinite)) return unverified('frame-delay');
    return verifiedTimeline(source, offsets, { reference: 'content-time', frameDelay, frameDelayPresent: rawDelay !== undefined, origin: null, relative });
  }

  /* DT per PS3.5 6.2: "YYYY[MM[DD[HH[MM[SS[.F{1,6}]]]]]][&ZZXX]", at most 26 characters. Only trailing ASCII SPACE
     (U+0020) is padding; a leading or inner space, TAB, CR, LF, NBSP, NUL or BOM makes the value invalid and is never
     repaired. Month 01-12, a real day, hour 00-23, minute 00-59, second 00-60 (60 only as a leap second, which closes
     23:59 UTC on 30 June or 31 December); the offset has 4 digits, minutes 00-59, lies within -1200 to +1400 and is
     never -0000. A legal DT coarser than the second cannot time frames and is reported as such, not filled in. */
  function parseDT(text) {
    const m = text.match(/^(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:\.(\d{1,6}))?(?:([+-])(\d{2})(\d{2}))?$/);
    if (!m) return null;
    for (let i = 3; i <= 6; i++) if (m[i] !== undefined && m[i - 1] === undefined) return null;
    if (m[7] !== undefined && m[6] === undefined) return null;
    const [y, mo = 1, d = 1, h = 0, mi = 0, s = 0] = m.slice(1, 7).map(n => n === undefined ? undefined : Number(n));
    if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 60) return null;
    const day = new Date(0);
    day.setUTCFullYear(y, mo - 1, d); day.setUTCHours(h, mi, Math.min(s, 59), 0);
    if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return null;
    let zone = 0;
    if (m[8]) {
      const minutes = Number(m[10]);
      if (minutes > 59) return null;
      zone = (m[8] === '-' ? -1 : 1) * (Number(m[9]) * 60 + minutes);
      if (zone < -720 || zone > 840 || (m[8] === '-' && zone === 0)) return null;
    }
    const utc = day.getTime() - zone * 60000;
    if (s === 60) {
      if (m[6] === undefined) return null;
      const at = new Date(utc);
      const end = (at.getUTCMonth() === 5 && at.getUTCDate() === 30) || (at.getUTCMonth() === 11 && at.getUTCDate() === 31);
      if (!end || at.getUTCHours() !== 23 || at.getUTCMinutes() !== 59) return null;
    }
    if (m[6] === undefined) return { coarse: true };
    // Whole UTC seconds and the fraction apart, so a difference keeps its microseconds.
    return { seconds: (utc / 1000) + (s === 60 ? 1 : 0), fraction: m[7] ? Number('0.' + m[7]) * 1000 : 0, zoned: !!m[8], leap: s === 60 };
  }
  function dateTime(v) {
    if (typeof v !== 'string') return null;
    let end = v.length;
    while (end > 0 && v.charCodeAt(end - 1) === 0x20) end--;
    const text = v.slice(0, end);
    if (!text || v.length > 26 || !/^[0-9.+-]+$/.test(text)) return null;
    return parseDT(text);
  }
  const between = (a, b) => (a.seconds - b.seconds) * 1000 + (a.fraction - b.fraction);

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
      if (times.some(t => !t)) return unverified('content-time');
      // Legal, but too coarse to time frames: an invalid DT and an unsupported precision are different reasons.
      if (times.some(t => t.coarse)) return unverified('content-precision');
      if (new Set(times.map(t => t.zoned)).size !== 1) return unverified('content-time');
      // A leap second is a legal DT, but intervals across it are unknowable without a leap-second table.
      if (times.some(t => t.leap)) return unverified('leap-second');
      const offsets = times.map(t => between(t, times[0]));
      for (let i = 1; i < frames; i++) if (!(offsets[i] > offsets[i - 1]) || !Number.isFinite(offsets[i])) return unverified('content-order');
      return verifiedTimeline('frame-content', offsets, { reference: 'frame-content', attribute: tag, frameDelay: null,
        frameDelayPresent: false, origin: raw[0], relative: offsets.slice() });
    }
    return unverified('content-time');
  }

  // An Enhanced object with more than one dimension (e.g. stack x time) is never flattened into one time run.
  function enhancedDimension(json, timing) {
    const dimensions = values(json, TAG.dimensionIndex);
    if (Array.isArray(dimensions)) return dimensions.length === 1 && TEMPORAL.has(hex(one(dimensions[0], TAG.dimensionPointer))) ? 'time' : 'frames';
    return timing.verified ? 'time' : 'frames';
  }

  /* Conservative per-frame reservation, in two parts: the decoded payload at 4 bytes per sample (the pinned renderer may
     scale stored values to Float32), shared by every viewport of the same opening, and one RGBA8 render surface, which
     every viewport drawing the frame pays for itself; both with 4-byte row alignment. Missing, inconsistent or
     overflowing pixel attributes never become a successful reservation. */
  function frameBytes(json) {
    const rows = integer(one(json, TAG.rows)), columns = integer(one(json, TAG.columns)), samples = integer(one(json, TAG.samples));
    const allocated = integer(one(json, TAG.bitsAllocated)), stored = integer(one(json, TAG.bitsStored));
    const high = integer(one(json, TAG.highBit)), representation = integer(one(json, TAG.pixelRepresentation));
    if (![rows, columns].every(n => n >= 1 && n <= 65535)) return refuse('pixel-size');
    if (![1, 3].includes(samples) || ![8, 16, 32].includes(allocated) || !(stored >= 1 && stored <= allocated) ||
        high !== stored - 1 || ![0, 1].includes(representation)) return refuse('pixel-layout');
    const align = n => Math.ceil(n / 4) * 4;
    const payload = rows * align(columns * samples * 4), surface = rows * align(columns * 4), bytes = payload + surface;
    if (![payload, surface, bytes].every(n => Number.isSafeInteger(n) && n > 0)) return refuse('pixel-size');
    return Object.freeze({ ok: true, bytes, payload, surface, rows, columns, samples, bitsAllocated: allocated });
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
    const timing = frames < 2 ? Object.freeze({ source: 'still', verified: false, reason: 'still', offsets: null, basis: null })
      : kind === 'enhanced-xa' ? contentTiming(json, frames) : cineTiming(json, frames);
    // A classic XA multi-frame is a time run by its IOD (its pointer may only name Frame Time or Frame Time Vector),
    // even when the values are missing; an Enhanced XA must show its time dimension.
    const playback = frames < 2 ? 'still' : kind === 'xa' ? 'time' : kind === 'enhanced-xa' ? enhancedDimension(json, timing) : 'other';
    const reservation = frameBytes(json);
    const subtractionRecommended = String(one(json, TAG.viewingMode) || '').trim().toUpperCase() === 'SUB' ||
      (values(json, TAG.maskSubtraction) || []).length > 0;
    return Object.freeze({ ok: true, kind, sopClass, study, series, sop, frames, timing, playback,
      frameBytes: reservation.ok ? reservation.bytes : null, payloadBytes: reservation.ok ? reservation.payload : null,
      surfaceBytes: reservation.ok ? reservation.surface : null, reservation, subtractionRecommended });
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

  /* The one ownership ledger of a document's XA viewports (consult D732 section 2). A resource R is one incarnation of
     one source frame for one opening scope, with a token that is never reused; consumers hold leases on it, draws and
     front surfaces pin it. Everything is addressed by token: a frame key alone never names a resource, so an old
     callback can only ever end its own incarnation.
       bytes    = payload of every resource not yet given back (admitted, loading, decoded, draining)
                  + the surface of every draw and front that the renderer has not yet let go
       loading  = decode permits: admitted resources and supplies whose promise has not settled
       prepared = resources not yet given back; retiring = cancelled loads still running + drains not yet acknowledged
     Cancelling ends nobody's wait for the memory: a cancelled load keeps its bytes and permit until it settles, a release
     keeps its bytes until it is acknowledged (a failed release keeps them for good). Under pressure only a decoded
     resource with no lease, no draw and no front may be reclaimed; a drawing frame, a shown frame or another viewport's
     frame never is. Sharing is only within the same complete opening scope, never with a retiring or draining one. */
  function createLedger(limits = LIMITS) {
    const resources = new Map(), byScope = new Map(), surfaces = new Map();
    let bytes = 0, permits = 0, peakBytes = 0, peakLoading = 0, peakPrepared = 0;
    const no = reason => ({ ok: false, reason });
    const exact = t => (t && resources.get(t)) || null;
    const peak = () => { peakBytes = Math.max(peakBytes, bytes); peakLoading = Math.max(peakLoading, permits); peakPrepared = Math.max(peakPrepared, resources.size); };
    function gone(held) {
      resources.delete(held.token);
      if (byScope.get(held.id) === held) byScope.delete(held.id);
      bytes -= held.payload;
      if (held.permit) { held.permit = false; permits--; }
      held.state = 'gone';
    }
    function admit({ lease, scope, key, payload }) {
      if (!lease || typeof scope !== 'string' || !scope || typeof key !== 'string' || !key || !Number.isSafeInteger(payload) || payload <= 0) return no('invalid');
      const id = JSON.stringify([scope, key]);
      const held = byScope.get(id);
      if (held) {
        if (held.retiring || held.state === 'draining') return no('busy');
        if (held.payload !== payload) return no('invalid');
        held.leases.add(lease);
        return { ok: true, resource: held.token, joined: true, state: held.state };
      }
      if (payload > limits.bytes) return no('too-large');
      if (bytes + payload > limits.bytes) return no('bytes');
      if (resources.size >= limits.prepared) return no('prepared');
      if (permits >= limits.decodes) return no('decodes');
      const token = Object.freeze({ scope, key });
      const created = { token, id, payload, state: 'admitted', retiring: false, permit: true, releaseFailed: false,
        leases: new Set([lease]), draws: new Set(), displays: new Set() };
      resources.set(token, created); byScope.set(id, created);
      bytes += payload; permits++; peak();
      return { ok: true, resource: token, joined: false, state: 'admitted' };
    }
    // The source call really happened.
    function start(t) { const held = exact(t); if (held?.state !== 'admitted') return false; held.state = 'loading'; return true; }
    // Admitted but never called (the gate refused at the call): the provisional reservation simply comes back.
    function abandon(t) { const held = exact(t); if (held?.state !== 'admitted') return false; gone(held); return true; }
    // The supply promise settled: the decoder has stopped. decoded | release (nobody wants the image, or the image is
    // refused as not the requested frame: its bytes stay until the source takes it back) | failed (no image at all).
    function settle(t, image, refused = false) {
      const held = exact(t);
      if (!held || held.state !== 'loading') return null;
      held.permit = false; permits--;
      if (!image) { gone(held); return 'failed'; }
      if (held.retiring || refused || !held.leases.size) { held.state = 'draining'; return 'release'; }
      held.state = 'decoded';
      return 'decoded';
    }
    // kept | unstarted | retire (still loading: the abort is asked for, the memory stays) | unheld (decoded, reclaimable)
    function leave(lease, t) {
      const held = exact(t);
      if (!held || !held.leases.delete(lease)) return null;
      if (held.leases.size || held.draws.size || held.displays.size) return 'kept';
      if (held.state === 'admitted') return 'unstarted';
      if (held.state === 'loading') {
        held.retiring = true;
        return 'retire';
      }
      return held.state === 'decoded' ? 'unheld' : 'kept';
    }
    const reclaimable = h => !!h && h.state === 'decoded' && !h.leases.size && !h.draws.size && !h.displays.size;
    function reclaim(t) { const held = exact(t); if (!reclaimable(held)) return false; held.state = 'draining'; return true; }
    // The source acknowledged giving the image back; a failed release keeps its bytes counted.
    function released(t, ok = true) {
      const held = exact(t);
      if (!held || held.state !== 'draining') return false;
      if (!ok) { held.releaseFailed = true; return false; }
      gone(held);
      return true;
    }
    // A draw pins its decoded resource and reserves its own surface before the renderer allocates it.
    function beginDraw({ resource: t, lease, owner, surface }) {
      const held = exact(t);
      if (!held || held.state !== 'decoded' || !held.leases.has(lease) || !owner || !Number.isSafeInteger(surface) || surface <= 0) return no('invalid');
      const cost = surface;
      if (bytes + cost > limits.bytes) return no('bytes');
      const draw = Object.freeze({ key: held.token.key });
      surfaces.set(draw, { token: draw, resource: held, owner, cost, kind: 'draw', failed: false });
      held.draws.add(draw); bytes += cost; peak();
      return { ok: true, draw };
    }
    // The verified draw becomes the owner's front; the previous front is detached and returned for its surface release.
    function publish(draw, owner) {
      const s = surfaces.get(draw);
      if (!s || s.kind !== 'draw' || s.owner !== owner) return { ok: false, previous: null };
      const previous = [...surfaces.values()].find(x => x.kind === 'front' && x.owner === owner) || null;
      s.kind = 'front'; s.resource.draws.delete(draw); s.resource.displays.add(draw);
      if (previous) { previous.kind = 'detached'; previous.resource.displays.delete(previous.token); }
      return { ok: true, previous: previous ? previous.token : null };
    }
    // The owner's front leaves the screen without a successor (closed under its cover).
    function detach(draw) { const s = surfaces.get(draw); if (!s || s.kind !== 'front') return false; s.kind = 'detached'; s.resource.displays.delete(draw); return true; }
    const front = owner => [...surfaces.values()].find(x => x.kind === 'front' && x.owner === owner)?.token || null;
    // A draw that ended unpublished, or a detached front, whose surface the renderer has really let go.
    function drop(draw, ok = true) {
      const s = surfaces.get(draw);
      if (!s || s.kind === 'front') return false;
      if (!ok) { s.failed = true; return false; }
      surfaces.delete(draw); bytes -= s.cost;
      s.resource.draws.delete(draw); s.resource.displays.delete(draw);
      return true;
    }
    const holds = (lease, t) => !!exact(t)?.leases.has(lease);
    const state = t => exact(t)?.state || null;
    const retiring = t => !!exact(t)?.retiring;
    const reclaimables = () => [...resources.values()].filter(reclaimable).map(h => h.token);
    const snapshot = () => ({ bytes, loading: permits, prepared: resources.size,
      retiring: [...resources.values()].filter(h => (h.retiring && h.state === 'loading') || h.state === 'draining').length,
      surfaces: surfaces.size, peakBytes, peakLoading, peakPrepared, limit: limits.bytes, decodes: limits.decodes });
    return Object.freeze({ admit, start, abandon, settle, leave, reclaim, released, beginDraw, publish, detach, front, drop,
      holds, state, retiring, reclaimables, snapshot, limits });
  }

  // The sharing scope of a frame: the complete opening (and session when the host gives one) plus the source revision.
  const scopeKey = (opening, revision = '') => JSON.stringify([opening?.account, opening?.institution, opening?.session ?? null,
    opening?.study, opening?.series, opening?.sop, opening?.sequence, revision]);

  /* An opening is the account, the institution, the object (Study/Series/SOP) and the opening sequence; when the host
     also gives a login session, that too. Each must be present: a missing field never matches by being equally missing.
     Another account, another session or no session ends playback; the same object opened again (A -> B -> A) is a new
     opening, so the old one's answers are stale. */
  const complete = o => !!o && typeof o === 'object' && typeof o.account === 'string' && o.account !== '' &&
    typeof o.institution === 'string' && o.institution !== '' && [o.study, o.series, o.sop].every(uid) &&
    (Number.isSafeInteger(o.sequence) || (typeof o.sequence === 'string' && o.sequence !== ''));
  function sameOpening(opened, now) {
    if (!complete(opened) || !complete(now)) return 'ended';
    if (now.account !== opened.account || now.institution !== opened.institution) return 'ended';
    if (opened.session !== undefined && now.session !== opened.session) return 'ended';
    if (now.study !== opened.study || now.series !== opened.series || now.sop !== opened.sop || now.sequence !== opened.sequence) return 'stale';
    return 'current';
  }

  // The opening the host made must be the object the source will supply, before anything is fetched or drawn.
  function openingMatches(key, d) {
    if (!complete(key)) return Object.freeze({ ok: false, reason: 'opening' });
    if (!d?.ok) return Object.freeze({ ok: false, reason: d?.reason || 'metadata' });
    if (key.study !== d.study || key.series !== d.series || key.sop !== d.sop) return Object.freeze({ ok: false, reason: 'manifest' });
    return Object.freeze({ ok: true, reason: null });
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
    windowPlan, aheadFor, createLedger, scopeKey, sameOpening, openingMatches, failureKind, createCoverage });
  if (typeof module === 'object' && module.exports) module.exports = api; else root.KinXaPlaybackModel = api;
})(globalThis);

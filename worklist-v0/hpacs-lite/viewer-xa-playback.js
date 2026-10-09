/* Stored XA playback in one viewport: the frames the equipment stored, in stored order and source time. The viewport
   gets exactly the image the source decoded; nothing here re-subtracts, rebuilds a mask or shifts pixels.

   Ownership (consult D732): one ledger per document (KinXaPlaybackModel.createLedger) holds every byte reservation,
   decode permit, consumer lease, draw and front surface; one owner per physical viewport; one gate before every effect.
   A late callback may end its own resources; it can never take back the screen.

   mount({host, source, viewport, identity, events, clock}):
     source    {metadata: DICOM JSON of the one instance, revision?,
                load(index, {signal, mayDecode}) -> {image, sop, frame}   (settles only when its decoder has stopped;
                                                                            mayDecode() is asked right before decoding),
                release(index, image) -> ack}
     viewport  the physical viewport, the same object for every opening shown in it:
                prepare(image, {sop, frame, index, opening}, {draw, surface, signal}) -> {draw, surface, sop, frame, opening}
                  renders into a private surface behind the opaque handle `surface` issued to this draw, and echoes it
                publish({draw, surface, sop, frame, index, opening})   synchronous swap of the visible front to that
                  surface; no later pixel writes, no callbacks
                release(surface handle) -> ack, clear(), cover(on), current() -> index
     identity  {key: {account, institution, study, series, sop, sequence[, session]}, current(), subscribe?(onChange)}
     events    {emit(event)}: requested / provided / displayed / failed / cancelled / stopped stay separate facts
     clock     {now, setTimeout, clearTimeout}; the document's own timers when omitted. */
(function (root) {
  'use strict';
  const LOAD_TIMEOUT_MS = 20000;
  // One ledger, the live resources, the owner of every physical viewport and one memory queue per document.
  // handles: the surface handle issued to each draw token (the only surface that draw may publish or give back).
  const broker = { model: null, ledger: null, resources: new Map(), viewports: new Map(), controllers: new Set(), queue: [], pumping: false,
    handles: new Map() };

  const PHASE = { ready: 'Ready', loading: 'Loading', playing: 'Playing', buffering: 'Buffering', paused: 'Paused',
    failed: 'Failed', denied: 'Access Denied', ended: 'Stopped', stale: 'Stopped', unavailable: 'Unavailable',
    still: 'Still Image', frames: 'Frames Only' };
  const REASON = {
    metadata: '영상 정보를 읽지 못해 재생할 수 없습니다.',
    identity: '원본 식별 정보를 확인하지 못해 재생할 수 없습니다.',
    frames: '프레임 수를 확인하지 못해 재생할 수 없습니다.',
    empty: '재생할 영상이 없습니다.',
    'pixel-size': '영상 크기 정보를 확인하지 못해 재생 준비량을 계산할 수 없습니다.',
    'pixel-layout': '화소 형식 정보가 맞지 않아 재생 준비량을 계산할 수 없습니다.',
    'frame-too-large': '프레임이 커서 재생 준비 한도(128 MiB) 안에서 이어 재생할 수 없습니다. 스크롤로 프레임을 볼 수 있습니다.',
    'several-objects': '여러 XA 객체를 한 재생으로 이어 붙이지 않습니다. 객체마다 따로 여세요.',
    'one-frame': '한 프레임 영상이라 시간 재생이 없습니다.',
    'no-time-dimension': '여러 차원으로 저장된 영상이라 시간 재생으로 이어 붙이지 않습니다. First Frame·Last Frame과 스크롤로 프레임을 보세요.',
    generic: '저장된 XA 재생 대상이 아닙니다.',
    opening: '열린 검사·계정 정보를 확인하지 못해 이 영상을 표시하지 않습니다.',
    manifest: '열린 검사와 영상의 Study·Series·SOP가 일치하지 않아 이 영상을 표시하지 않습니다.',
  };

  function schedulePump() {
    if (broker.pumping) return;
    broker.pumping = true;
    queueMicrotask(() => {
      broker.pumping = false;
      reclaimOrphans();
      const list = [...broker.queue, ...[...broker.controllers].filter(c => !broker.queue.includes(c))];
      for (const c of list) c.pump();
    });
  }
  const dequeue = c => { const i = broker.queue.indexOf(c); if (i >= 0) broker.queue.splice(i, 1); };

  // ---- resources: one incarnation per token, given back only through the source that supplied it ----
  // A supply is wanted while one of its consumers' own gates still calls that consumer current.
  function wanted(res) { for (const slot of [...res.consumers]) if (slot.owner.wants(slot)) return true; return false; }
  function releaseImage(res, image) {
    let ack;
    try { ack = res.source.release?.(res.index, image); } catch (_) { broker.ledger.released(res.token, false); return; }
    Promise.resolve(ack).then(() => {
      if (broker.ledger.released(res.token, true) || !broker.ledger.state(res.token)) broker.resources.delete(res.token);
      schedulePump();
    }, () => broker.ledger.released(res.token, false));
  }
  // Decoded frames nobody holds any more and whose opening no live viewport still has.
  function reclaimOrphans() {
    for (const t of broker.ledger?.reclaimables() || []) {
      if ([...broker.controllers].some(c => c.scope === t.scope && c.alive())) continue;
      const res = broker.resources.get(t);
      if (res && broker.ledger.reclaim(t)) { res.state = 'draining'; releaseImage(res, res.image); }
    }
  }
  // The one place a load starts: decided right here, in the call's own turn, with nothing in between.
  function callLoad(res) {
    if (broker.resources.get(res.token) !== res || res.state !== 'admitted') return;
    if (!wanted(res)) { broker.ledger.abandon(res.token); endResource(res, { kind: 'cancelled', status: null }); return; }
    broker.ledger.start(res.token);
    res.state = 'loading';
    let supply;
    try {
      supply = Promise.resolve(res.source.load(res.index, { signal: res.abort.signal,
        mayDecode: () => res.state === 'loading' && !broker.ledger.retiring(res.token) && wanted(res) }));
    } catch (error) { supply = Promise.reject(error); }
    supply.then(result => supplied(res, result, null), error => supplied(res, null, error || Error('load failed')));
    for (const slot of [...res.consumers]) slot.owner.loaded(slot);
  }
  function endResource(res, failure) {
    res.state = 'gone';
    broker.resources.delete(res.token);
    for (const slot of [...res.consumers]) slot.owner.supplyFailed(slot, failure);
    res.consumers.clear();
    schedulePump();
  }
  // The supply promise settled, so its decoder has stopped: only now do its permit (and, unwanted, its bytes) come back.
  function supplied(res, result, error) {
    if (res.settled) return;
    res.settled = true;
    const image = !error && result && result.image !== undefined && result.image !== null ? result.image : null;
    const foreign = image !== null && (result.sop !== res.expect.sop || result.frame !== res.expect.frame);
    const verdict = broker.ledger.settle(res.token, image !== null, foreign);
    if (verdict === 'decoded') {
      res.state = 'decoded'; res.image = image;
      for (const slot of [...res.consumers]) slot.owner.supplied(slot, res);
      schedulePump();
      return;
    }
    if (image !== null) { res.state = 'draining'; releaseImage(res, image); }
    if (verdict === 'release' && !foreign) { schedulePump(); return; }
    endResource(res, foreign ? { kind: 'failed', status: null }
      : { kind: broker.model.failureKind(error || Error('empty frame')), status: Number(error?.status) || null });
  }

  function mount({ host, source, viewport, identity, events, clock } = {}) {
    const Model = root.KinXaPlaybackModel;
    if (!Model) throw Error('XA 재생 모델을 불러오지 못했습니다.');
    if (!host?.ownerDocument || !source || typeof source.load !== 'function' || typeof viewport?.prepare !== 'function' ||
        typeof viewport.publish !== 'function' || !identity?.key || typeof identity.current !== 'function') throw TypeError('XA playback needs host, source, viewport and identity');
    const doc = host.ownerDocument, win = doc.defaultView || root;
    const time = clock || { now: () => win.performance.now(), setTimeout: (fn, ms) => win.setTimeout(fn, ms), clearTimeout: id => win.clearTimeout(id) };
    broker.model = Model;
    const ledger = broker.ledger || (broker.ledger = Model.createLedger(Model.LIMITS));
    const opened = Object.freeze({ ...identity.key });
    const meta = Model.describe(source.metadata);
    const path = Model.route(meta);
    // The opening must be complete and name exactly the object this source supplies, before anything is fetched.
    const binding = Model.openingMatches(opened, meta);
    const scope = Model.scopeKey(opened, source.revision ?? '');
    const total = meta.ok ? meta.frames : 0;
    const navigable = path.path === 'xa' || path.path === 'xa-frames';
    let physical = broker.viewports.get(viewport);
    if (!physical) { physical = { owner: null, controller: null, covered: false }; broker.viewports.set(viewport, physical); }
    const V = Object.freeze({});  // this mount's ownership of the physical viewport; never reused

    // G: presentation generation (every user intent); P: playback generation (timers and look-ahead).
    let seq = 0, G = 0, P = 0, playing = false, shown = null, shownSlot = null, target = null, drawing = null;
    let direction = 1, mode = 'forward', loop = true;
    let range = total ? { first: 0, last: total - 1 } : null;
    let coverage = range ? Model.createCoverage(range.first, range.last) : null;
    let speed = meta.ok ? Model.defaultSpeed(meta.timing) : null;
    let failure = null, message = '', lastDue = 0, pendingDue = null, pendingWait = 0, late = 0, sleeper = null;
    let ended = false, disposed = false, memoryWait = false;
    const slots = new Set(), skip = new Set(), told = new WeakSet(), listeners = [];
    let phase = !meta.ok ? 'unavailable' : path.path === 'xa' ? 'ready' : path.path === 'xa-frames' ? 'frames' : path.path === 'still' ? 'still' : 'unavailable';
    if (phase !== 'ready') message = REASON[path.path === 'generic' ? 'generic' : path.reason || meta.reason] || REASON.metadata;
    else if (!meta.timing.verified) message = '원본 촬영 시간 정보를 확인할 수 없어 수동 속도로 재생합니다.';

    const keyOf = index => Model.frame(meta, index).key;
    const emit = event => {
      const frame = Number.isSafeInteger(event.index) && event.index >= 0 ? event.index + 1 : null;
      try { events?.emit?.({ ...event, sop: meta.sop || null, frame, sequence: opened.sequence, at: time.now() }); } catch (_) {}
    };
    const MEMORY_WAIT = '다른 XA 화면이 재생 준비 메모리를 쓰고 있어 기다립니다. 그 화면을 멈추거나 닫으면 이어집니다.';
    const self = {
      scope, alive: () => !ended && !disposed,
      wants: slot => gate('supply', { slot }) === 'current',
      loaded: slot => emit({ type: 'requested', index: slot.index, shared: false }),
      supplied: (slot, res) => supplied(slot, res),
      supplyFailed: (slot, f) => supplyFailed(slot, f),
      lose: () => lose('stale'),
      pump: () => pump(),
      playing: () => playing,
    };

    // ---- the panel: English names, Korean explanations, external text only through textContent ----
    const panel = doc.createElement('div');
    panel.setAttribute('role', 'group'); panel.setAttribute('aria-label', 'XA Playback');
    panel.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;font:13px sans-serif';
    const button = text => { const b = doc.createElement('button'); b.type = 'button'; b.textContent = text; return b; };
    const select = (name, options) => {
      const s = doc.createElement('select'); s.setAttribute('aria-label', name);
      for (const [value, text] of options) { const o = doc.createElement('option'); o.value = value; o.textContent = text; s.append(o); }
      return s;
    };
    const play = button('Play'), pause = button('Pause'), first = button('First Frame'), last = button('Last Frame');
    const apply = button('Apply Range'), retry = button('Retry');
    const directionSelect = select('Playback Direction', [['forward', 'Forward'], ['reverse', 'Reverse'], ['yoyo', 'Yoyo']]);
    const speedName = s => s.kind === 'source' ? (s.rate === 1 ? 'Source Timing' : 'Source Timing ' + s.rate + 'x') : s.fps + ' fps';
    const speedValue = s => s.kind + ':' + (s.kind === 'source' ? s.rate : s.fps);
    const speeds = meta.ok ? Model.speedOptions(meta.timing) : [];
    const speedSelect = select('Playback Speed', speeds.map(s => [speedValue(s), speedName(s)]));
    const loopBox = doc.createElement('input'); loopBox.type = 'checkbox'; loopBox.checked = true;
    const loopLabel = doc.createElement('label'); loopLabel.append(loopBox, ' Loop');
    const rangeInput = name => { const i = doc.createElement('input'); i.type = 'number'; i.min = '1'; i.max = String(total || 1); i.setAttribute('aria-label', name); i.style.width = '64px'; return i; };
    const rangeStart = rangeInput('Range Start'), rangeEnd = rangeInput('Range End');
    const status = doc.createElement('p'); status.setAttribute('role', 'status');
    const note = doc.createElement('p'); note.setAttribute('aria-live', 'polite');
    const help = doc.createElement('p');
    help.textContent = '장비가 저장한 프레임 순서와 시간 정보로 재생합니다. Frame 번호는 원본 프레임 번호입니다.' +
      (meta.subtractionRecommended ? ' 장비가 감산 표시를 권장한 영상이지만, 이 뷰어는 감산·마스크·픽셀 이동을 다시 계산하지 않고 저장된 화소를 그대로 표시합니다.' : '');
    for (const p of [status, note, help]) p.style.margin = '0';
    panel.append(play, pause, first, last, directionSelect, loopLabel, speedSelect, rangeStart, ' to ', rangeEnd, apply, retry, status, note, help);
    host.append(panel);

    function paint() {
      if (disposed) return;
      const parts = [PHASE[phase]];
      if (path.path === 'xa' && speed && !ended) parts.push(speed.kind === 'source' ? speedName(speed) : 'Manual ' + speed.fps + ' fps' + (meta.timing.verified ? '' : ' · Timing Unverified'));
      if (total) parts.push('Frame ' + (shown === null ? '-' : shown + 1) + ' / ' + total);
      if (navigable && coverage) { const c = coverage.snapshot(); parts.push(c.all ? 'All Shown' : 'Shown ' + c.shown + ' / ' + c.total); }
      if (late > 0 && playing) parts.push(speed.kind === 'source' ? 'Slower Than Source' : 'Slower Than Set Speed');
      status.textContent = parts.join(' · ');
      note.textContent = memoryWait && !ended ? MEMORY_WAIT : message;
      const open = !ended && navigable;
      const playable = open && path.path === 'xa';
      play.disabled = !playable || playing || !!failure;
      pause.disabled = !playing;
      first.disabled = last.disabled = !open;
      directionSelect.disabled = loopBox.disabled = speedSelect.disabled = rangeStart.disabled = rangeEnd.disabled = apply.disabled = !playable;
      retry.hidden = retry.disabled = !(failure && !ended);
      if (speed) speedSelect.value = speedValue(speed);
      directionSelect.value = mode; loopBox.checked = loop;
    }

    // ---- the gate: the one check before every effect (consult section 3) ----
    function opening() { let now = null; try { now = identity.current(); } catch (_) {} return Model.sameOpening(opened, now); }
    // current | drain (stale, but the ticket's own resources may still be ended) | reject
    function gate(kind, t = {}) {
      const tokens = !!(t.slot || t.draw);
      if (disposed || ended) return tokens ? 'drain' : 'reject';
      const now = opening();
      if (now !== 'current' || physical.owner !== V) { lose(now); return tokens ? 'drain' : 'reject'; }
      if (t.P !== undefined && t.P !== P) return tokens ? 'drain' : 'reject';
      if (t.slot) {
        if (!slots.has(t.slot) || t.slot.phase === 'released') return 'reject';
        if (t.slot.G !== G) return 'drain';
      }
      if (t.draw) {
        if (t.draw.ended) return 'reject';
        if (t.draw.void) return 'drain';
        if (t.draw.G !== G) return 'drain';
      }
      return 'current';
    }
    function coverPhysical(on) {
      if (physical.owner !== V) return false;
      try { viewport.cover?.(on); physical.covered = on; return true; } catch (_) { return false; }
    }
    // Hide what the physical viewport shows: the cover, or when the cover cannot be set, clearing the front so no
    // earlier pixels remain. false = nothing could hide it.
    function hide() {
      if (coverPhysical(true)) return true;
      if (physical.owner !== V || typeof viewport.clear !== 'function') return false;
      try { viewport.clear(); } catch (_) { return false; }
      const front = ledger.front(physical);
      if (front) { ledger.detach(front); releaseSurface(front); }
      return true;
    }
    // After the claim could not cover, nothing new is loaded until the previous image is really gone.
    function barrier() { return failure?.kind !== 'cover' || physical.covered || hide(); }
    function lose(state) {
      if (ended || disposed) return;
      if (state === 'ended') finish('ended', '로그인 상태가 바뀌어 재생을 멈추고 영상을 가렸습니다.');
      else finish('stale', '이 화면에 다른 영상 열기가 있어 이전 재생을 멈추고 가렸습니다.');
    }
    // This opening is over for this mount: every intent ends; only what it still owns is hidden.
    function finish(next, text) {
      if (ended || disposed) return;
      ended = true; G = ++seq; P = ++seq; playing = false; failure = null; memoryWait = false; cancelSleep(); dequeue(self);
      for (const slot of [...slots]) {
        if (slot.phase === 'drawing') abortDraw(slot.J);
        else if (slot.phase !== 'shown') releaseSlot(slot);
      }
      if (physical.owner === V) hide();
      phase = next; message = text;
      emit({ type: 'stopped', index: shown ?? -1, reason: next });
      paint(); schedulePump();
    }

    // ---- slots: this mount's interest in one frame for one intent ----
    function slotFor(index, kind) {
      for (const s of slots) if (s.index === index && s.G === G && s.phase !== 'shown' && s.phase !== 'released') { if (kind === 'target') s.kind = kind; return s; }
      const slot = { owner: self, index, key: keyOf(index), G, kind, phase: 'requested', lease: Object.freeze({}), res: null, J: null, timer: null };
      slots.add(slot);
      return slot;
    }
    function clearTimer(slot) { if (slot.timer !== null) { time.clearTimeout(slot.timer); slot.timer = null; } }
    // A slot that has not started drawing lets go of its lease; a load nobody wants any more is asked to abort, and its
    // memory stays counted until the source's own promise settles.
    function releaseSlot(slot) {
      if (slot.phase === 'released') return;
      clearTimer(slot);
      const res = slot.res && broker.resources.get(slot.res);
      slot.phase = 'released'; slots.delete(slot);
      if (target === slot) target = null;
      if (!slot.res) return;
      res?.consumers.delete(slot);
      const left = ledger.leave(slot.lease, slot.res);
      if (left === 'retire' && res) {
        res.abort.abort();
        emit({ type: 'cancelled', index: slot.index });
      }
      schedulePump();
    }
    // Under pressure only decoded frames nobody holds are given back (never a draw, a front or another viewport's frame);
    // a needed frame may also end this viewport's own look-ahead when nothing else can go. The memory counts as free
    // only once the source has acknowledged the release, so the caller waits and the pump retries.
    function reclaimUnheld() {
      let freed = false;
      for (const t of ledger.reclaimables()) {
        const res = broker.resources.get(t);
        if (res && ledger.reclaim(t)) { freed = true; res.state = 'draining'; releaseImage(res, res.image); }
      }
      return freed;
    }
    function relieve(keep, needed) {
      if (reclaimUnheld() || !needed) return;
      for (const s of [...slots]) if (s !== keep && s !== target && s.kind === 'ahead' && s.phase !== 'drawing' && s.phase !== 'shown') releaseSlot(s);
      reclaimUnheld();
    }
    function wait(reason) {
      if (reason !== 'busy' && !broker.queue.includes(self)) broker.queue.push(self);
      memoryWait = reason === 'bytes' || reason === 'queued' || reason === 'prepared';
      paint();
    }
    function admitSlot(slot, needed) {
      if (slot.res) return true;
      if (gate('admit', { slot }) !== 'current') return false;
      // Someone already waits for memory: look-ahead stands back, a needed frame queues behind them.
      if (broker.queue.length && broker.queue[0] !== self) { if (needed) wait('queued'); return false; }
      const ask = () => ledger.admit({ lease: slot.lease, scope, key: slot.key, payload: meta.payloadBytes });
      let r = ask();
      if (!r.ok && (r.reason === 'bytes' || r.reason === 'prepared')) { relieve(slot, needed); r = ask(); }
      if (!r.ok) {
        if (r.reason === 'too-large' || r.reason === 'invalid') { if (needed) fail(slot.index, { kind: 'refused' }); return false; }
        if (needed) wait(r.reason);
        return false;
      }
      if (needed) { dequeue(self); memoryWait = false; }
      slot.res = r.resource;
      let res = broker.resources.get(r.resource);
      if (!r.joined || !res) {
        res = { token: r.resource, index: slot.index, expect: { sop: meta.sop, frame: slot.index + 1 }, source, time, state: 'admitted',
          image: null, abort: new AbortController(), consumers: new Set(), settled: false };
        broker.resources.set(r.resource, res);
        queueMicrotask(() => callLoad(res));
      } else emit({ type: 'requested', index: slot.index, shared: true });
      res.consumers.add(slot);
      if (res.state === 'decoded') { const s = slot; queueMicrotask(() => supplied(s, res)); }
      else slot.phase = res.state === 'loading' ? 'loading' : 'requested';
      return true;
    }
    function plan() {
      const anchor = target ? target.index : shown;
      if (anchor === null || !range) return [];
      if (!playing || path.path !== 'xa' || anchor < range.first || anchor > range.last) return [anchor];
      const owners = [...broker.controllers].filter(c => c.playing()).length;
      const ahead = Model.aheadFor({ frameBytes: meta.frameBytes, owners });
      return Model.windowPlan({ index: anchor, first: range.first, last: range.last, mode, direction, loop, ahead });
    }
    function fill() {
      if (ended || disposed || !navigable) return;
      if (gate('admit', { P }) !== 'current') return;
      const want = plan();
      for (const slot of [...slots]) if (slot.kind === 'ahead' && slot.phase !== 'drawing' && slot.phase !== 'shown' && !want.includes(slot.index)) releaseSlot(slot);
      for (const index of want) {
        if ((target && target.index === index) || index === shown || skip.has(index)) continue;
        const slot = slotFor(index, 'ahead');
        if (slot.res) continue;
        if (!admitSlot(slot, false)) { releaseSlot(slot); break; }
      }
    }
    function pump() {
      if (ended || disposed) return;
      if (target && target.phase === 'requested' && !target.res) admitSlot(target, true);
      if (target && target.phase === 'decoded') startDraw(target);
      fill();
    }

    // ---- supply results for this mount's slots ----
    function supplied(slot, res) {
      if (slot.phase === 'released' || slot.phase === 'drawing' || slot.phase === 'shown' || slot.phase === 'decoded') return;
      if (gate('supply', { slot }) !== 'current') { releaseSlot(slot); return; }
      slot.phase = 'decoded';
      clearTimer(slot);
      if (!told.has(slot)) { told.add(slot); emit({ type: 'provided', index: slot.index }); }
      if (slot === target) queueMicrotask(() => startDraw(slot));
    }
    function supplyFailed(slot, f) {
      if (slot.phase === 'released') return;
      const wasTarget = target === slot, verdict = gate('supply', { slot });
      clearTimer(slot); slot.phase = 'released'; slots.delete(slot);
      if (wasTarget) target = null;
      if (verdict !== 'current' || f.kind === 'cancelled') return;
      // Refused access concerns the opening, not one frame: a 401/403 on any of its requests, look-ahead included,
      // covers and stops exactly like the frame being shown.
      if (f.kind === 'denied') return fail(slot.index, f);
      if (!wasTarget) { skip.add(slot.index); emit({ type: 'failed', index: slot.index, kind: f.kind, needed: false }); return; }
      return fail(slot.index, f);
    }

    // ---- drawing: prepare privately, verify, publish synchronously ----
    // Each draw is issued one surface handle of its own at the gate. Only that exact handle, for this draw, this
    // object, frame and opening, may be published; a draw that ends unpublished gives back that handle and nothing else.
    const receiptOk = (r, J) => !!r && r.draw === J.draw && r.surface === J.surface && r.sop === meta.sop &&
      r.frame === J.slot.index + 1 && r.opening === opened.sequence;
    function startDraw(slot) {
      if (slot.phase !== 'decoded' || slot !== target) return;
      if (gate('draw', { slot }) !== 'current') { releaseSlot(slot); return; }
      const res = broker.resources.get(slot.res);
      const ask = () => ledger.beginDraw({ resource: slot.res, lease: slot.lease, owner: physical, surface: meta.surfaceBytes });
      let d = ask();
      if (!d.ok && d.reason === 'bytes') { relieve(slot, true); d = ask(); }
      if (!d.ok || !res) { wait('bytes'); return; }
      const J = { draw: d.draw, surface: Object.freeze({}), slot, res, G, void: false, ended: false, abort: new AbortController(), timer: null };
      broker.handles.set(J.draw, J.surface);
      slot.phase = 'drawing'; slot.J = J; drawing = J;
      J.timer = time.setTimeout(() => expire(J), LOAD_TIMEOUT_MS);
      let pending;
      const frameId = { sop: meta.sop, frame: slot.index + 1, index: slot.index, opening: opened.sequence };
      try { pending = Promise.resolve(viewport.prepare(res.image, frameId, { draw: J.draw, surface: J.surface, signal: J.abort.signal })); }
      catch (error) { pending = Promise.reject(error); }
      pending.then(receipt => drawn(J, receipt, null), error => drawn(J, null, error || Error('render failed')));
    }
    function abortDraw(J) {
      try { J.abort.abort(); } catch (_) {}  // asked to stop; its surface and its frame stay pinned until it really ends
    }
    // Gives back the surface issued to this draw token, through the renderer, counted until the renderer confirms.
    function releaseSurface(token) {
      const handle = broker.handles.get(token);
      let ack;
      try { ack = viewport.release?.(handle); } catch (_) { ledger.drop(token, false); return; }
      Promise.resolve(ack).then(() => { ledger.drop(token, true); broker.handles.delete(token); schedulePump(); }, () => ledger.drop(token, false));
    }
    function endDraw(J) {
      J.ended = true;
      if (drawing === J) drawing = null;
      time.clearTimeout(J.timer);
      releaseSurface(J.draw);
      const slot = J.slot;
      if (slot.phase === 'drawing') { slot.phase = 'decoded'; releaseSlot(slot); }
    }
    function drawn(J, receipt, error) {
      if (J.ended) return;
      time.clearTimeout(J.timer);
      const verdict = gate('publish', { draw: J });
      if (verdict === 'current' && !error && receiptOk(receipt, J)) { publish(J); return; }
      if (verdict === 'current') fail(J.slot.index, { kind: 'render' });
      endDraw(J);
    }
    // One synchronous transaction: the verified surface goes to the front, then the facts that follow from it.
    function publish(J) {
      const slot = J.slot, index = slot.index;
      const frameId = { sop: meta.sop, frame: index + 1, index, opening: opened.sequence };
      try { viewport.publish({ draw: J.draw, surface: J.surface, ...frameId }); } catch (_) { fail(index, { kind: 'render' }); endDraw(J); return; }
      J.ended = true; time.clearTimeout(J.timer);
      if (drawing === J) drawing = null;
      const { previous } = ledger.publish(J.draw, physical);
      if (previous) releaseSurface(previous);
      if (shownSlot && shownSlot !== slot) { shownSlot.phase = 'released'; slots.delete(shownSlot); }
      slot.phase = 'shown'; shownSlot = slot; shown = index;
      if (target === slot) target = null;
      ledger.leave(slot.lease, slot.res);  // the front pins the frame now; the interest is over
      broker.resources.get(slot.res)?.consumers.delete(slot);
      if (physical.covered && !coverPhysical(false)) { failure = { index, kind: 'cover', resume: false }; phase = 'failed'; paint(); return; }
      failure = null;
      const now = time.now();
      if (pendingDue === null) lastDue = now;
      else if (now - pendingDue > Math.max(15, pendingWait / 2)) { late = 10; lastDue = now; }
      else { if (late > 0) late--; lastDue = pendingDue; }
      pendingDue = null;
      coverage.mark(index);
      paint();
      emit({ type: 'displayed', index });
      afterShown();
      schedulePump();
    }
    // A render that does not confirm in time loses its right to the screen for good; only Retry makes a new one.
    function expire(J) {
      if (J.ended || J.void) return;
      J.void = true;
      abortDraw(J);
      if (J.G === G && !ended && !disposed) fail(J.slot.index, { kind: 'render', timedOut: true });
    }

    // ---- intents ----
    function newIntent() {
      G = ++seq; P = ++seq;
      cancelSleep(); dequeue(self); memoryWait = false; skip.clear(); pendingDue = null;
      for (const slot of [...slots]) {
        if (slot.phase === 'drawing') abortDraw(slot.J);
        else if (slot.phase !== 'shown') releaseSlot(slot);
      }
      target = null; drawing = null;
    }
    function withdraw(pick) {
      for (const slot of [...slots]) {
        if (slot.phase === 'shown' || !pick(slot)) continue;
        if (slot.phase === 'drawing') { slot.J.void = true; abortDraw(slot.J); }
        else releaseSlot(slot);
      }
    }
    function bring(index) {
      if (gate('bring') !== 'current') return;
      const slot = slotFor(index, 'target');
      target = slot;
      if (slot.phase === 'decoded') queueMicrotask(() => startDraw(slot));
      else if (slot.phase === 'requested' && !slot.res) admitSlot(slot, true);
      if (slot.phase !== 'decoded' && slot.phase !== 'drawing' && slot.timer === null && !ended) {
        slot.timer = time.setTimeout(() => {
          slot.timer = null;
          if (target !== slot || slot.phase === 'decoded' || slot.phase === 'drawing' || slot.phase === 'released') return;
          if (gate('supply', { slot }) !== 'current') return;
          releaseSlot(slot);
          fail(index, { kind: 'timeout' });
        }, LOAD_TIMEOUT_MS);
      }
      if (slot.phase !== 'decoded' && slot.phase !== 'drawing' && !failure && phase !== 'unavailable') phase = playing ? 'buffering' : 'loading';
      fill(); paint();
    }
    function fail(index, error) {
      const kind = error?.kind || 'failed';
      if (kind === 'cancelled' || ended || disposed) return false;
      // A timed-out render is recovered by one verified frame; playback does not restart by itself (R07).
      const resume = playing && !error?.timedOut;
      P = ++seq; playing = false; cancelSleep(); dequeue(self); memoryWait = false;
      // Refused access ends every pending load and publish of this opening, a draw already under way included.
      if (kind === 'denied') { G = ++seq; withdraw(() => true); }
      else withdraw(slot => slot.kind === 'ahead' || slot.phase !== 'drawing');
      const at = shown === null ? '-' : shown + 1, frameNumber = index + 1;
      if (kind === 'refused') { phase = 'unavailable'; failure = null; message = REASON['frame-too-large']; paint(); return false; }
      failure = { index, kind, resume };
      phase = kind === 'denied' ? 'denied' : 'failed';
      if (kind === 'denied') {
        message = '프레임 ' + frameNumber + '을 볼 권한을 확인하지 못해 영상을 가렸습니다. Retry로 다시 확인하세요.';
        hide();
      } else message = (kind === 'timeout' ? '프레임 ' + frameNumber + ' 준비 시간이 초과되었습니다. ' : '프레임 ' + frameNumber + '을 불러오거나 표시하지 못했습니다. ') +
        '마지막으로 표시한 프레임 ' + at + '에서 멈췄습니다. Retry로 같은 위치부터 다시 시도하세요.';
      emit({ type: 'failed', index, kind, needed: true });
      paint();
      return false;
    }
    function sleep(ms, fn) {
      cancelSleep();
      const id = time.setTimeout(() => { if (sleeper?.id === id) sleeper = null; fn(); }, Math.max(0, ms));
      sleeper = { id };
    }
    function cancelSleep() { if (!sleeper) return; time.clearTimeout(sleeper.id); sleeper = null; }
    // A published frame: while playing, the next one is due one source interval after this one was due.
    function afterShown() {
      if (!playing) { if (!failure && !ended) phase = path.path === 'xa' ? 'paused' : 'frames'; paint(); return; }
      const s = Model.step({ index: shown, first: range.first, last: range.last, mode, direction, loop });
      if (s.stop) { stop('재생 범위 끝까지 재생했습니다.'); return; }
      const ticket = { P }, wait = Model.interval(meta.timing, speed, shown, s.next, range), due = lastDue + wait;
      phase = 'playing'; paint();
      sleep(due - time.now(), () => {
        if (gate('pump', ticket) !== 'current') return;
        direction = s.direction; pendingDue = due; pendingWait = wait;
        bring(s.next);
      });
    }
    function stop(text) {
      P = ++seq; playing = false; cancelSleep(); dequeue(self); memoryWait = false;
      // Pause stops what has not started drawing; a draw already under way may still publish once.
      withdraw(slot => slot.phase !== 'drawing');
      if (!failure) phase = path.path === 'xa' ? 'paused' : 'frames';
      message = text; paint();
    }
    function start() {
      if (path.path !== 'xa' || ended || disposed || playing || failure || doc.hidden) return;
      newIntent();
      playing = true; message = ''; late = 0;
      let at = shown;
      if (!Number.isSafeInteger(at) || at < range.first || at > range.last) at = null;
      if (mode !== 'yoyo') direction = mode === 'reverse' ? -1 : 1;
      if (at !== null && Model.step({ index: at, first: range.first, last: range.last, mode, direction, loop }).stop) at = null;
      if (at === null) { at = mode === 'reverse' ? range.last : range.first; direction = mode === 'reverse' ? -1 : 1; }
      if (at === shown) { lastDue = time.now(); afterShown(); schedulePump(); return; }  // the look-ahead starts with Play
      bring(at);
    }
    function seek(index) {
      if (!navigable || ended || disposed || !Number.isSafeInteger(index) || index < 0 || index >= total) return;
      if (!barrier()) { paint(); return; }
      failure = null; message = '';
      newIntent(); playing = false;
      // Seeking to the frame already on screen ends older draws but invents no new display.
      if (index === shown && shownSlot) { phase = path.path === 'xa' ? 'paused' : 'frames'; paint(); return; }
      phase = 'loading';
      bring(index);
    }
    function again() {
      if (!failure || ended || disposed) return;
      if (!barrier()) { paint(); return; }
      const { index, resume } = failure;
      failure = null; message = '';
      newIntent();
      playing = resume;
      bring(index);
    }
    function setRange() {
      if (ended || disposed) return false;
      const parse = v => /^\d+$/.test(v) ? Number(v) : NaN, a = parse(rangeStart.value), b = parse(rangeEnd.value);
      if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 1 || a >= b || b > total) {
        message = '재생 범위는 1~' + total + ' 안에서 시작이 끝보다 작아야 합니다.'; paint(); return false;
      }
      failure = null;
      newIntent(); playing = false;
      range = { first: a - 1, last: b - 1 }; coverage = Model.createCoverage(range.first, range.last);
      direction = mode === 'reverse' ? -1 : 1;
      phase = 'paused'; message = '범위를 적용했습니다. Play로 시작하세요.'; paint();
      return true;
    }

    const listen = (target, type, fn) => { target.addEventListener(type, fn); listeners.push(() => target.removeEventListener(type, fn)); };
    listen(play, 'click', () => start());
    listen(pause, 'click', () => { if (playing) stop(''); });
    listen(first, 'click', () => seek(range.first));
    listen(last, 'click', () => seek(range.last));
    listen(retry, 'click', () => again());
    listen(apply, 'click', setRange);
    const changed = () => {
      if (ended || disposed) return;
      mode = directionSelect.value; loop = loopBox.checked; direction = mode === 'reverse' ? -1 : 1;
      failure = null; newIntent(); playing = false;
      if (phase !== 'ready') phase = 'paused';
      message = '설정을 바꿨습니다. Play로 다시 시작하세요.'; paint();
    };
    listen(directionSelect, 'change', changed); listen(loopBox, 'change', changed);
    listen(speedSelect, 'change', () => {
      const picked = speeds.find(s => speedValue(s) === speedSelect.value);
      if (!picked) return;
      speed = picked; late = 0; if (playing) lastDue = time.now();
      paint();
    });
    // A hidden document pauses: returning never replays the missed frames in a burst.
    listen(doc, 'visibilitychange', () => { if (doc.hidden && playing) stop('창이 보이지 않아 재생을 멈췄습니다. Play로 다시 시작하세요.'); });
    let unsubscribe = null;
    try { unsubscribe = identity.subscribe?.(() => { if (opening() !== 'current') gate('notice'); }) || null; } catch (_) {}

    if (range) { rangeStart.value = '1'; rangeEnd.value = String(total); }
    // Claim the physical viewport: the previous owner loses its right to publish now, and a new opening starts covered.
    const previousOwner = physical.controller;
    physical.owner = V; physical.controller = self;
    // The claim needs the cover; when the cover fails the previous front is cleared instead, and the opening waits in
    // a failed state for Retry rather than loading over whatever might still be on screen.
    const hidden = hide();
    broker.controllers.add(self);
    previousOwner?.lose();
    if (meta.ok && !binding.ok) {
      // Nothing of a source that is not this opening's object is fetched or drawn.
      phase = 'unavailable'; message = REASON[binding.reason] || REASON.opening; ended = true;
    } else if (gate('mount') === 'current' && navigable) {
      let at = null;
      try { at = viewport.current?.(); } catch (_) {}
      if (!Number.isSafeInteger(at) || at < 0 || at >= total) at = 0;
      if (physical.covered) { newIntent(); bring(at); }
      else {
        failure = { index: at, kind: 'cover', resume: false }; phase = 'failed';
        message = hidden ? '화면 가림을 설정하지 못해 이전 영상을 지우고 멈췄습니다. Retry로 다시 시도하세요.'
          : '이전 영상을 가리지 못해 이 영상을 표시하지 않았습니다. Retry로 다시 시도하세요.';
      }
    }
    paint();

    return Object.freeze({
      play: start, pause: () => { if (playing) stop(''); }, first: () => seek(range.first), last: () => seek(range.last),
      seek: frameNumber => seek(Number(frameNumber) - 1), retry: again,
      state: () => ({ phase, playing, route: path.path, frame: shown === null ? null : shown + 1, index: shown, total,
        range: range ? { first: range.first + 1, last: range.last + 1 } : null, mode, loop,
        speed: speed ? { ...speed } : null, timing: meta.ok ? { source: meta.timing.source, verified: meta.timing.verified } : null,
        coverage: coverage ? coverage.snapshot() : null, slower: late > 0 && playing, owner: physical.owner === V, covered: !!physical.covered,
        failure: failure ? { frame: failure.index + 1, kind: failure.kind } : null, subtractionRecommended: !!meta.subtractionRecommended }),
      dispose() {
        if (disposed) return;
        const owning = physical.owner === V;
        G = ++seq; P = ++seq; playing = false; cancelSleep(); dequeue(self);
        for (const slot of [...slots]) {
          if (slot.phase === 'drawing') abortDraw(slot.J);
          else if (slot.phase !== 'shown') releaseSlot(slot);
        }
        if (owning) {
          // The last owner closes under its cover and gives its front back.
          coverPhysical(true);
          const front = ledger.front(physical);
          if (front && typeof viewport.clear === 'function') {
            // A front the renderer could not clear stays counted: it is still memory in use, not a release.
            let cleared = true;
            try { viewport.clear(); } catch (_) { cleared = false; }
            if (cleared) { ledger.detach(front); releaseSurface(front); }
          }
          physical.owner = null; physical.controller = null;
        }
        disposed = true; broker.controllers.delete(self);
        try { unsubscribe?.(); } catch (_) {}
        for (const off of listeners.splice(0)) off();
        panel.remove(); schedulePump();
      },
    });
  }

  const api = Object.freeze({ mount, budget: () => broker.ledger ? broker.ledger.snapshot() : null });
  if (typeof module === 'object' && module.exports) module.exports = api; else root.KinViewerXaPlayback = api;
})(globalThis);

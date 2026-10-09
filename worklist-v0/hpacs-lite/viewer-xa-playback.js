/* Stored XA playback in one viewport: the frames the equipment stored, in stored order and source time, through a
   bounded and cancellable window shared by every XA viewport of this document (KinXaPlaybackModel). The viewport gets
   exactly the image the source decoded; nothing here re-subtracts, rebuilds a mask or shifts pixels.
   mount({host, source, viewport, identity, events, clock}):
     source    {metadata: DICOM JSON of the one instance, load(index, {signal}) -> image, release(index, image)}
     viewport  {show(index, image) -> {index} once that frame is rendered, current() -> index, cover(on)}
     identity  {key: {account, institution, study, series, sop, sequence}, current() -> the same shape or null}
     events    {emit(event)}: requested / provided / displayed / failed / cancelled stay separate facts
     clock     {now, setTimeout, clearTimeout}; the document's own timers when omitted. */
(function (root) {
  'use strict';
  const LOAD_TIMEOUT_MS = 20000;
  // One budget, one frame registry and one memory queue per document: the limit is the sum over all XA viewports.
  const shared = { budget: null, frames: new Map(), controllers: new Set(), queue: [], pumping: false };

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
  };

  function schedulePump() {
    if (shared.pumping) return;
    shared.pumping = true;
    queueMicrotask(() => {
      shared.pumping = false;
      const list = [...shared.controllers];
      for (const c of list) c.wake();
      for (const c of list) c.fill();
    });
  }
  const dequeue = c => { const i = shared.queue.indexOf(c); if (i >= 0) shared.queue.splice(i, 1); };

  function mount({ host, source, viewport, identity, events, clock } = {}) {
    const Model = root.KinXaPlaybackModel;
    if (!Model) throw Error('XA 재생 모델을 불러오지 못했습니다.');
    if (!host?.ownerDocument || !source || typeof source.load !== 'function' || typeof viewport?.show !== 'function' ||
        !identity?.key || typeof identity.current !== 'function') throw TypeError('XA playback needs host, source, viewport and identity');
    const doc = host.ownerDocument, win = doc.defaultView || root;
    const time = clock || { now: () => win.performance.now(), setTimeout: (fn, ms) => win.setTimeout(fn, ms), clearTimeout: id => win.clearTimeout(id) };
    const opened = Object.freeze({ ...identity.key });
    const meta = Model.describe(source.metadata);
    const path = Model.route(meta);
    const budget = shared.budget || (shared.budget = Model.createBudget(Model.LIMITS));
    const total = meta.ok ? meta.frames : 0;
    const navigable = path.path === 'xa' || path.path === 'xa-frames';

    let gen = 0, playing = false, shown = null, target = null, direction = 1, mode = 'forward', loop = true;
    let range = total ? { first: 0, last: total - 1 } : null;
    let coverage = range ? Model.createCoverage(range.first, range.last) : null;
    let speed = meta.ok ? Model.defaultSpeed(meta.timing) : null;
    let failure = null, message = '', lastDue = 0, late = 0, sleeper = null, waiter = null;
    let ended = false, disposed = false, covered = false, memoryWait = false;
    const own = new Set(), skip = new Set(), told = new Set(), listeners = [];
    let phase = !meta.ok ? 'unavailable' : path.path === 'xa' ? 'ready' : path.path === 'xa-frames' ? 'frames' : path.path === 'still' ? 'still' : 'unavailable';
    if (phase !== 'ready') message = REASON[path.path === 'generic' ? 'generic' : path.reason || meta.reason] || REASON.metadata;
    else if (!meta.timing.verified) message = '원본 촬영 시간 정보를 확인할 수 없어 수동 속도로 재생합니다.';

    const keyOf = index => Model.frame(meta, index).key;
    const live = g => !ended && !disposed && g === gen;
    const emit = event => {
      const frame = Number.isSafeInteger(event.index) && event.index >= 0 ? event.index + 1 : null;
      try { events?.emit?.({ ...event, sop: meta.sop || null, frame, sequence: opened.sequence, at: time.now() }); } catch (_) {}
    };
    const MEMORY_WAIT = '다른 XA 화면이 재생 준비 메모리를 쓰고 있어 기다립니다. 그 화면을 멈추거나 닫으면 이어집니다.';
    const self = {
      playing: () => playing,
      wake() { const resolve = waiter; waiter = null; resolve?.(); },
      fill: () => fill(),
      forget(key) { for (const i of own) if (keyOf(i) === key) { own.delete(i); if (i !== target) skip.add(i); } },
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
      if (path.path === 'xa' && speed) parts.push(speed.kind === 'source' ? speedName(speed) : 'Manual ' + speed.fps + ' fps' + (meta.timing.verified ? '' : ' · Timing Unverified'));
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

    // ---- opening checks: before every write to the viewport ----
    function opening() { let now = null; try { now = identity.current(); } catch (_) {} return Model.sameOpening(opened, now); }
    function checkOpening() {
      const state = opening();
      if (state === 'current') return true;
      if (state === 'ended') finish('ended', '로그인 상태가 바뀌어 재생을 멈추고 영상을 가렸습니다.', true);
      else finish('stale', '이 화면에 다른 영상이 열려 이전 재생을 멈췄습니다.', false);
      return false;
    }
    function finish(next, text, hide) {
      if (ended || disposed) return;
      ended = true; gen++; playing = false; target = null; failure = null; cancelSleep(); self.wake(); dequeue(self);
      for (const i of [...own]) letGo(i);
      phase = next; message = text;
      // A changed or ended session hides the pixels; a viewport now showing another object is left to its new owner.
      if (hide) { try { viewport.cover?.(true); covered = true; } catch (_) {} }
      emit({ type: 'stopped', index: shown ?? -1, reason: next });
      paint();
    }

    // ---- supply: reserve before fetching, share by source frame, cancel what the window no longer holds ----
    function request(index, needed) {
      const key = keyOf(index);
      if (own.has(index)) return { entry: shared.frames.get(key) };
      const joining = budget.state(key) !== null;
      if (!joining && shared.queue.length && (shared.queue[0] !== self || !needed)) return { refused: 'queued' };
      const r = budget.reserve(self, key, meta.frameBytes);
      if (!r.ok) return { refused: r.reason };
      own.add(index); told.delete(index);
      emit({ type: 'requested', index, shared: r.shared });
      return { entry: shared.frames.get(key) || startLoad(index, key) };
    }
    function startLoad(index, key) {
      const controller = new AbortController();
      const entry = { key, index, source, state: 'loading', image: null, error: null, controller, timedOut: false, timer: null, halt: null };
      shared.frames.set(key, entry);
      const halted = new Promise((_, reject) => { entry.halt = reject; });
      const timeout = new Promise((_, reject) => {
        entry.timer = time.setTimeout(() => { entry.timedOut = true; controller.abort(); reject(Object.assign(Error('frame timeout'), { name: 'TimeoutError' })); }, LOAD_TIMEOUT_MS);
      });
      const load = Promise.resolve().then(() => source.load(index, { signal: controller.signal }));
      entry.promise = (async () => {
        let image;
        try {
          image = await Promise.race([load, timeout, halted]);
          if (image === undefined || image === null) throw Error('empty frame');
        } catch (error) {
          time.clearTimeout(entry.timer);
          // A source that answers after its load was cancelled or timed out still gets its image back.
          load.then(late => { if (late !== undefined && late !== null) release(entry, late); }, () => {});
          const cancelled = shared.frames.get(key) !== entry;
          entry.error = { kind: Model.failureKind(error, { cancelled, timedOut: entry.timedOut }), status: Number(error?.status) || null };
          if (!cancelled) {
            shared.frames.delete(key); budget.drop(key); entry.state = 'failed';
            for (const c of shared.controllers) c.forget(key);
            schedulePump();
          }
          throw entry.error;
        }
        time.clearTimeout(entry.timer);
        // Answered in the same turn it was let go: nobody holds it any more, so the image goes straight back.
        if (shared.frames.get(key) !== entry) { release(entry, image); entry.error = { kind: 'cancelled', status: null }; throw entry.error; }
        entry.state = 'ready'; entry.image = image; budget.ready(key);
        schedulePump();
        return entry;
      })();
      entry.promise.catch(() => {});
      return entry;
    }
    function release(entry, image) { try { entry.source.release?.(entry.index, image); } catch (_) {} }
    function letGo(index) {
      if (!own.delete(index)) return;
      const key = keyOf(index);
      if (!budget.release(self, key)) return;
      const entry = shared.frames.get(key);
      shared.frames.delete(key);
      if (entry?.state === 'loading') {
        time.clearTimeout(entry.timer); entry.controller.abort(); entry.halt({ kind: 'cancelled' });
        emit({ type: 'cancelled', index });
      } else if (entry?.state === 'ready') release(entry, entry.image);
      schedulePump();
    }
    function watch(index, entry) {
      entry.promise.then(() => {
        if (own.has(index) && !told.has(index)) { told.add(index); emit({ type: 'provided', index }); }
      }, error => {
        // A look-ahead failure is asked again when the frame is due; only that answer can stop playback.
        if (error?.kind !== 'cancelled' && index !== target) emit({ type: 'failed', index, kind: error?.kind || 'failed', needed: false });
      });
    }
    function plan() {
      const anchor = target ?? shown;
      if (anchor === null || !range) return [];
      if (!playing || path.path !== 'xa' || anchor < range.first || anchor > range.last) return [anchor];
      const owners = [...shared.controllers].filter(c => c.playing()).length;
      const ahead = Model.aheadFor({ frameBytes: meta.frameBytes, owners });
      return Model.windowPlan({ index: anchor, first: range.first, last: range.last, mode, direction, loop, ahead });
    }
    function fill() {
      if (ended || disposed || !navigable) return;
      const want = plan();
      for (const i of [...own]) if (!want.includes(i) && i !== shown && i !== target) letGo(i);
      for (const i of want) {
        if (own.has(i)) continue;
        const needed = i === target;
        if (!needed && skip.has(i)) continue;
        const r = request(i, needed);
        if (r.refused) break;
        watch(i, r.entry);
      }
    }
    async function need(g, index) {
      for (;;) {
        if (!live(g)) throw { kind: 'cancelled' };
        let entry = own.has(index) ? shared.frames.get(keyOf(index)) : null;
        if (!entry) {
          own.delete(index);
          let r = request(index, true);
          if (r.refused === 'bytes' || r.refused === 'prepared' || r.refused === 'queued') {
            // Never wait on this viewport's own look-ahead: give it back first, in the same turn, then ask again.
            for (const i of [...own]) if (i !== shown && i !== index) letGo(i);
            r = request(index, true);
          }
          if (r.refused) {
            if (r.refused === 'too-large' || r.refused === 'invalid') throw { kind: 'refused' };
            if (!shared.queue.includes(self)) shared.queue.push(self);
            memoryWait = r.refused === 'bytes' || r.refused === 'queued' || r.refused === 'prepared';
            paint();
            await new Promise(resolve => { waiter = resolve; });
            continue;
          }
          dequeue(self); memoryWait = false; watch(index, r.entry); entry = r.entry;
        }
        skip.delete(index);
        return await entry.promise;
      }
    }
    // A renderer that never confirms is a failed frame, not an endless Playing.
    function rendered(promise) {
      return new Promise((resolve, reject) => {
        const id = time.setTimeout(() => reject(Error('render timeout')), LOAD_TIMEOUT_MS);
        Promise.resolve(promise).then(value => { time.clearTimeout(id); resolve(value); }, error => { time.clearTimeout(id); reject(error); });
      });
    }

    // ---- display: one frame at a time, the label follows only a confirmed render ----
    async function bring(g, index) {
      target = index;
      fill();
      if (shared.frames.get(keyOf(index))?.state !== 'ready' || !own.has(index)) { phase = playing ? 'buffering' : 'loading'; paint(); }
      let entry;
      try { entry = await need(g, index); } catch (error) { return live(g) ? fail(index, error) : false; }
      if (!live(g) || !checkOpening()) return false;
      if (covered) { try { viewport.cover?.(false); } catch (_) {} covered = false; }
      let result;
      try { result = await rendered(viewport.show(index, entry.image)); } catch (_) { return live(g) ? fail(index, { kind: 'render' }) : false; }
      if (ended || disposed || !checkOpening()) return false;
      if (!result || result.index !== index) return live(g) ? fail(index, { kind: 'render' }) : false;
      // The screen now shows this frame even when playback was paused meanwhile, so the label follows it.
      shown = index;
      if (target === index) target = null;
      coverage.mark(index);
      emit({ type: 'displayed', index });
      if (!live(g)) { fill(); paint(); return false; }
      failure = null; fill(); paint();
      return true;
    }
    function fail(index, error) {
      const kind = error?.kind || 'failed';
      if (kind === 'cancelled') return false;
      const resume = playing;
      gen++; playing = false; target = null; cancelSleep(); dequeue(self);
      const at = shown === null ? '-' : shown + 1, frameNumber = index + 1;
      if (kind === 'refused') { phase = 'unavailable'; failure = null; message = REASON['frame-too-large']; fill(); paint(); return false; }
      failure = { index, kind, resume };
      phase = kind === 'denied' ? 'denied' : 'failed';
      if (kind === 'denied') {
        message = '프레임 ' + frameNumber + '을 볼 권한을 확인하지 못해 영상을 가렸습니다. Retry로 다시 확인하세요.';
        if (!checkOpening()) return false;
        try { viewport.cover?.(true); covered = true; } catch (_) {}
      } else message = (kind === 'timeout' ? '프레임 ' + frameNumber + ' 준비 시간이 초과되었습니다. ' : '프레임 ' + frameNumber + '을 불러오거나 표시하지 못했습니다. ') +
        '마지막으로 표시한 프레임 ' + at + '에서 멈췄습니다. Retry로 같은 위치부터 다시 시도하세요.';
      emit({ type: 'failed', index, kind, needed: true });
      fill(); paint();
      return false;
    }

    function sleep(g, ms) {
      return new Promise(resolve => {
        const id = time.setTimeout(() => { if (sleeper?.id === id) sleeper = null; resolve(live(g)); }, Math.max(0, ms));
        sleeper = { id, resolve };
      });
    }
    function cancelSleep() { if (!sleeper) return; const { id, resolve } = sleeper; sleeper = null; time.clearTimeout(id); resolve(false); }
    function halt(next, text) {
      gen++; playing = false; target = null; memoryWait = false; cancelSleep(); self.wake(); dequeue(self);
      if (next) phase = next;
      message = text;
      fill(); paint();
    }

    async function run(g) {
      while (live(g) && playing) {
        const s = Model.step({ index: shown, first: range.first, last: range.last, mode, direction, loop });
        if (s.stop) { halt('paused', '재생 범위 끝까지 재생했습니다.'); return; }
        const wait = Model.interval(meta.timing, speed, shown, s.next, range);
        const due = lastDue + wait;
        phase = 'playing'; paint();
        if (!(await sleep(g, due - time.now())) || !checkOpening()) return;
        direction = s.direction;
        if (!(await bring(g, s.next))) return;
        // A late frame restarts the clock from now: no catch-up burst, and the status says playback is slower.
        const now = time.now();
        if (now - due > Math.max(15, wait / 2)) { late = 10; lastDue = now; } else { if (late > 0) late--; lastDue = due; }
      }
    }
    async function start() {
      if (path.path !== 'xa' || ended || disposed || playing || failure || doc.hidden) return;
      const g = ++gen; cancelSleep();
      playing = true; message = ''; late = 0;
      let at = shown;
      if (at === null) { try { at = viewport.current?.(); } catch (_) { at = null; } }
      if (!Number.isSafeInteger(at) || at < range.first || at > range.last) at = null;
      if (mode !== 'yoyo') direction = mode === 'reverse' ? -1 : 1;
      if (at !== null && Model.step({ index: at, first: range.first, last: range.last, mode, direction, loop }).stop) at = null;
      if (at === null) { at = mode === 'reverse' ? range.last : range.first; direction = mode === 'reverse' ? -1 : 1; }
      if (!(await bring(g, at))) return;
      lastDue = time.now();
      await run(g);
    }
    async function jump(end) {
      if (!navigable || ended || disposed) return;
      failure = null;
      halt('loading', '');
      const g = gen;
      await bring(g, end ? range.last : range.first);
      if (live(g) && !failure) { phase = path.path === 'xa' ? 'paused' : 'frames'; paint(); }
    }
    async function again() {
      if (!failure || ended || disposed) return;
      const { index, resume } = failure;
      failure = null; skip.delete(index); message = '';
      const g = ++gen; cancelSleep();
      playing = resume;
      if (!(await bring(g, index))) return;
      if (playing) { lastDue = time.now(); await run(g); } else { phase = path.path === 'xa' ? 'paused' : 'frames'; paint(); }
    }
    function setRange() {
      const parse = v => /^\d+$/.test(v) ? Number(v) : NaN, a = parse(rangeStart.value), b = parse(rangeEnd.value);
      if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 1 || a >= b || b > total) {
        message = '재생 범위는 1~' + total + ' 안에서 시작이 끝보다 작아야 합니다.'; paint(); return false;
      }
      failure = null;
      halt('paused', '범위를 적용했습니다. Play로 시작하세요.');
      range = { first: a - 1, last: b - 1 }; coverage = Model.createCoverage(range.first, range.last);
      direction = mode === 'reverse' ? -1 : 1; paint();
      return true;
    }

    const listen = (target, type, fn) => { target.addEventListener(type, fn); listeners.push(() => target.removeEventListener(type, fn)); };
    listen(play, 'click', () => { void start(); });
    listen(pause, 'click', () => { if (playing) halt('paused', ''); });
    listen(first, 'click', () => { void jump(false); });
    listen(last, 'click', () => { void jump(true); });
    listen(retry, 'click', () => { void again(); });
    listen(apply, 'click', setRange);
    const changed = () => {
      mode = directionSelect.value; loop = loopBox.checked; direction = mode === 'reverse' ? -1 : 1;
      failure = null;
      halt(phase === 'ready' ? 'ready' : 'paused', '설정을 바꿨습니다. Play로 다시 시작하세요.');
    };
    listen(directionSelect, 'change', changed); listen(loopBox, 'change', changed);
    listen(speedSelect, 'change', () => {
      const picked = speeds.find(s => speedValue(s) === speedSelect.value);
      if (!picked) return;
      speed = picked; late = 0; if (playing) lastDue = time.now();
      paint();
    });
    // A hidden document pauses: returning never replays the missed frames in a burst.
    listen(doc, 'visibilitychange', () => { if (doc.hidden && playing) halt('paused', '창이 보이지 않아 재생을 멈췄습니다. Play로 다시 시작하세요.'); });

    if (range) { rangeStart.value = '1'; rangeEnd.value = String(total); }
    shared.controllers.add(self);
    paint();

    return Object.freeze({
      play: start, pause: () => { if (playing) halt('paused', ''); }, first: () => jump(false), last: () => jump(true), retry: again,
      state: () => ({ phase, playing, route: path.path, frame: shown === null ? null : shown + 1, index: shown, total,
        range: range ? { first: range.first + 1, last: range.last + 1 } : null, mode, loop,
        speed: speed ? { ...speed } : null, timing: meta.ok ? { source: meta.timing.source, verified: meta.timing.verified } : null,
        coverage: coverage ? coverage.snapshot() : null, slower: late > 0 && playing,
        failure: failure ? { frame: failure.index + 1, kind: failure.kind } : null, subtractionRecommended: !!meta.subtractionRecommended }),
      dispose() {
        if (disposed) return;
        gen++; playing = false; target = null; cancelSleep(); self.wake(); dequeue(self);
        for (const i of [...own]) letGo(i);
        disposed = true; shared.controllers.delete(self);
        for (const off of listeners.splice(0)) off();
        panel.remove(); schedulePump();
      },
    });
  }

  const api = Object.freeze({ mount, budget: () => shared.budget ? shared.budget.snapshot() : null });
  if (typeof module === 'object' && module.exports) module.exports = api; else root.KinViewerXaPlayback = api;
})(globalThis);

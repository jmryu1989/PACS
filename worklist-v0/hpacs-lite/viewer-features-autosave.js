// Viewer feature module: Auto Save View. With the account setting "Save view changes automatically and apply on reopen"
// on, the view of this study is saved to the reader's account a moment after it last changed (each cell's zoom and pan,
// window, rotation and flip, the image it shows by SOP and frame, its Display Set Presets rule, and the layout), when a
// patient tab is switched and when the window is closed. When the study is opened again in a new viewer, the saved view
// is put back over the viewer's own first layout and a badge says what was put back. A Job chosen to open wins. One
// saved view per reader and study, kept apart from the Jobs; Display ▾ › Auto Save View… shows it and discards it.
// Pure rules: viewer-auto-view-model.js. Marks are not part of it (they are saved on their own).
(() => {
  // Studies this document has shown before: a patient tab brought back keeps the view the tab held (viewer-patient-tabs.js),
  // so only the first opening of a study in a document puts the saved view back.
  const opened = new Set();
  const DEBOUNCE = 2000, QUIET = 600, START_MS = 30000, SETTINGS_MS = 15000, BADGE_MS = 8000, RULES_MS = 10000;
  const UID = /^[0-9]+(?:\.[0-9]+)+$/;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  window.KinViewerFeatures?.module('autosave', async ({ services, session, store, ui }) => {
    await ui.load(['viewer-auto-view-model.js']);
    const model = window.KinAutoViewModel;
    const grid = services.viewportGridService, cells = services.cornerstoneViewportService, sets = services.displaySetService;
    const native = window.cornerstone, events = native?.Enums?.Events || {};
    const search = location.search, query = new URLSearchParams(search);
    const studies = (query.get('StudyInstanceUIDs') || '').split(',').filter(Boolean);
    const valid = studies.length >= 1 && studies.length <= 8 && studies.every(uid => uid.length <= 64 && UID.test(uid)) && new Set(studies).size === studies.length;
    const study = valid ? studies[0] : null, path = study ? '/api/studies/' + study + '/viewer-auto-view' : null;
    const firstOpening = valid && !opened.has(studies.join(','));
    if (valid) opened.add(studies.join(','));
    // A Job (or a finding's saved location) chosen to open this viewer wins over the saved view.
    const jobChosen = ['kinJob', 'kinFinding'].some(name => query.has(name));
    const abort = new AbortController(), { signal } = abort;
    const convert = (lower, upper) => native?.utilities?.windowLevel?.toWindowLevel?.(lower, upper);
    // phase: starting (the viewer's first layout and images), restoring (the saved view going back), ready (saving).
    let ended = false, on = false, phase = 'starting', timer = null, chain = Promise.resolve(), epoch = 0;
    let last;  // undefined: not read yet; null: nothing saved; else { snapshot, savedAt }
    let painter = null, badge = null, badgeTimer = null;
    // held: a Hanging Protocol still being laid out with its cell rules (nothing is saved meanwhile; hpRun counts the
    // protocols applied); discarding: Discard Saved View on its way (the view it discards is not sent again).
    let held = false, hpRun = 0, discarding = false;
    // restoreRun: turning the check off ends the putting back of the saved view that was going on (restoreAt).
    let restoreRun = 0, restoreAt = -1;
    // The server's Discard generation is pinned at capture, even for queued/closing saves. A rejected old capture is
    // never relabelled with a newer generation; only a subsequent capture may use it.
    const viewerId = crypto.randomUUID();
    let order = 0, lastAt = 0;
    let generation = null, reading = null;
    function observeGeneration(value) {
      if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value)) return false;
      if (generation !== null && BigInt(value) < BigInt(generation)) return false;
      generation = value; return true;
    }
    const stamp = () => (lastAt = Math.max(Date.now(), lastAt + 1));
    // issued: the view of the latest save sent or queued (or the view taken as the starting point); waiting: queued
    // saves not answered yet; outside: saves sent outside the queue not answered yet.
    let issued = { text: null, seq: 0 }, waiting = 0;
    const outside = new Set();
    const pending = new Map();  // capture sequence -> Discard generation, including saves still waiting in the queue

    const element = (tag, text, parent, className) => {
      const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; parent?.append(node); return node;
    };
    const style = element('style', `
.kin-auto-view-badge{position:absolute;left:50%;bottom:28px;transform:translateX(-50%);pointer-events:auto;background:#0b182bdd;border:1px solid #6de6ff;border-radius:4px;padding:3px 8px;font:12px/1.4 sans-serif;color:#fff;cursor:pointer;white-space:nowrap}
.kin-auto-view-note{color:var(--kin-ux-secondary);margin:0 0 6px;max-width:40em}
.kin-auto-view-row{display:flex;flex-wrap:wrap;align-items:center;gap:.4em;margin:6px 0}
`, document.head);

    // ── Cells ──
    const ordered = () => { try { return [...grid.getState().viewports.values()].sort((a, b) => a.y - b.y || a.x - b.x); } catch (_) { return []; } };
    const stackOf = id => { try { const v = cells.getCornerstoneViewport(id); return v?.type === 'stack' && v.element?.isConnected !== false ? v : null; } catch (_) { return null; } };
    const instance = id => { try { return native.metaData.get('instance', id) || null; } catch (_) { return null; } };
    const setOf = id => { try { return grid.getState().viewports.get(id)?.displaySetInstanceUIDs?.[0] || ''; } catch (_) { return ''; } };
    const paneOf = v => v.element?.closest?.('[data-cy=viewport-pane]') || v.element?.parentElement;
    const switching = () => ['kin-patient-switching', 'kin-viewer-empty'].some(name => document.body.classList.contains(name));
    const live = () => !ended && location.search === search && !session?.ended?.();
    // Putting the saved view back stops where it is when the check is turned off (even if it is turned on again).
    const restoring = () => live() && on && restoreAt === restoreRun;
    const writer = () => session?.writer?.() !== false && !session?.ended?.();
    const list = value => Array.from(value || [], Number);

    // The view as it stands, or null when it is not one this feature keeps (a merged or non-grid layout, an MPR or
    // other non-stack cell, an image of another study, a cell still loading).
    function capture() {
      const state = grid.getState(), views = ordered(), layout = state.layout || {};
      const rows = layout.numRows, cols = layout.numCols;
      if ((layout.layoutType && layout.layoutType !== 'grid') || !(rows >= 1 && rows <= 4 && cols >= 1 && cols <= 4) || views.length !== rows * cols) return null;
      const uniform = views.every((g, i) => g.x === undefined || (Math.abs(g.x - (i % cols) / cols) <= 1e-6 && Math.abs(g.y - Math.floor(i / cols) / rows) <= 1e-6 &&
        Math.abs(g.width - 1 / cols) <= 1e-6 && Math.abs(g.height - 1 / rows) <= 1e-6));
      if (!uniform) return null;
      const saved = [];
      for (const g of views) {
        const ids = g.displaySetInstanceUIDs || [];
        if (!ids.length) { saved.push(null); continue; }
        const v = stackOf(g.viewportId), image = v?.getCurrentImageId?.(), meta = image && instance(image);
        if (ids.length !== 1 || !v || !meta || !studies.includes(meta.StudyInstanceUID)) return null;
        const camera = v.getCamera() || {}, properties = v.getProperties() || {}, range = properties.voiRange;
        if (!range) return null;
        let display = null;
        try { display = window.KinViewerCellRules?.rule?.(g.viewportId) ?? null; } catch (_) { display = null; }
        const rotation = Number.isFinite(camera.rotation) ? camera.rotation : Number(v.getViewPresentation?.()?.rotation ?? 0);
        saved.push({ study: meta.StudyInstanceUID, series: meta.SeriesInstanceUID, sop: meta.SOPInstanceUID, frame: model.frameOf(image),
          index: v.getCurrentImageIdIndex?.() ?? 0, zoom: Number(v.getZoom?.() ?? 1),
          camera: { focalPoint: list(camera.focalPoint), position: list(camera.position), viewUp: list(camera.viewUp), viewPlaneNormal: list(camera.viewPlaneNormal),
            parallelScale: camera.parallelScale, rotation, flipHorizontal: !!camera.flipHorizontal, flipVertical: !!camera.flipVertical },
          properties: { voiRange: { lower: range.lower, upper: range.upper }, VOILUTFunction: properties.VOILUTFunction || 'LINEAR', invert: !!properties.invert,
            interpolationType: properties.interpolationType ?? 1 }, display });
      }
      const active = views.findIndex(g => g.viewportId === state.activeViewportId);
      return model.validate({ version: 1, studies: [...studies], rows, cols, active: active >= 0 ? active : 0, cells: saved }, study);
    }
    const captured = () => { try { return capture(); } catch (error) { console.error(error); return null; } };

    // The session owner is [institution, subject], shared by this reader's windows but not by another account.
    const account = () => { const owner = session?.owner?.(); return owner ? JSON.stringify(owner) : null; };
    let channel = null;
    try {
      channel = new BroadcastChannel('kin-auto-view');
      channel.onmessage = ({ data }) => {
        const owner = account();
        if (!live() || !owner || data?.owner !== owner || data.study !== study ||
            data.generation === generation || !observeGeneration(data.generation)) return;
        // Treat the view present at Discard as already issued. Old captures retain their old generation, and neither
        // a pending timer nor closing the window may revive this view. Only the reader's next change is saved.
        const now = captured(); issued = { text: now ? JSON.stringify(now) : null, seq: ++order };
        last = null; painter?.();
      };
    } catch (_) { channel = null; }

    // ── Requests (each save waits for the one before it; Discard waits for them all and so comes last) ──
    async function request(url, options = {}) {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options,
        headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
      const value = await response.json().catch(() => null);
      return { ok: response.ok, status: response.status, value };
    }
    function read() {
      if (!reading) reading = readView().finally(() => { reading = null; });
      return reading;
    }
    async function readView() {
      if (!path) return null;
      let answer;
      try { answer = await request(path, { signal }); } catch (_) { return last ?? null; }
      if (ended) return null;
      if (!answer.ok || !observeGeneration(answer.value?.generation)) return last ?? null;
      const view = answer.value?.view, snapshot = view ? model.validate(view.snapshot, study) : null;
      last = snapshot ? { snapshot, savedAt: view.savedAt } : null;
      painter?.();
      return last;
    }
    // mode: 'queue' (after the save before it), 'now' (at once, outside the queue: a patient switch, the viewer ending)
    // or 'close' (at once with keepalive: the window closing). None is cancelled when this viewer ends.
    async function send(snapshot, text, at, seq, when, capturedGeneration, mode) {
      let reached = false;
      try {
        const answer = await request(path, { method: 'POST', body: JSON.stringify({ snapshot, writer: viewerId, seq, at: when, generation: capturedGeneration }), ...(mode === 'close' ? { keepalive: true } : {}) });
        reached = answer.ok;
        const current = answer.ok && observeGeneration(answer.value?.generation);
        if (current && at === epoch && answer.value?.saved !== false && capturedGeneration === generation) { last = { snapshot, savedAt: answer.value?.savedAt || new Date().toISOString() }; painter?.(); }
      } catch (_) { reached = false; }
      // A save that did not reach the server leaves its view unsent: the next chance (a change, the switch, the window
      // closing) sends it again.
      if (!reached && issued.seq === seq) issued = { text: null, seq };
    }
    // Saves the view when it differs from the last one sent. Going away ('now', 'close') while another save is still
    // waiting or on its way, the view on the screen is sent anyway, last in order.
    function save(mode = 'queue') {
      if (!on || phase !== 'ready' || held || discarding || !path || !writer()) return chain;
      if (window.KinViewerCellRules?.busy?.()) { if (mode === 'queue') changed(); return chain; }
      if (generation === null) { read().then(() => { if (live() && on && generation !== null) changed(); }); return chain; }
      const snapshot = captured(), text = snapshot && JSON.stringify(snapshot);
      // An old-generation request cannot overwrite this generation. It must not force the unchanged, discarded view
      // to be captured again merely because the window closes before that old request answers.
      const canOverwrite = [...pending.values()].includes(generation);
      if (!snapshot || (text === issued.text && !(mode !== 'queue' && canOverwrite))) return chain;
      const at = epoch, seq = ++order, when = stamp(), capturedGeneration = generation;
      issued = { text, seq };
      pending.set(seq, capturedGeneration);
      if (mode !== 'queue') {
        const going = send(snapshot, text, at, seq, when, capturedGeneration, mode).finally(() => pending.delete(seq));
        outside.add(going); going.finally(() => outside.delete(going));
        return chain;
      }
      waiting++;
      chain = chain.then(async () => {
        if (at === epoch && !ended && on && !held && !window.KinViewerCellRules?.busy?.()) await send(snapshot, text, at, seq, when, capturedGeneration, 'queue');
        else {
          if (issued.seq === seq) issued = { text: null, seq };
          if (at === epoch && !ended && on && !held) changed();
        }
      }).catch(() => {}).finally(() => { waiting--; pending.delete(seq); });
      return chain;
    }
    function changed() {
      if (ended || !on || phase !== 'ready') return;
      if (generation === null && !timer) read();
      clearTimeout(timer);
      timer = setTimeout(() => { timer = null; if (!ended && !switching()) save(); }, DEBOUNCE);
    }
    // Discard Saved View: it waits for every save sent before it (queued or not), and the server refuses any save of
    // this reader taken before it (from this viewer or an earlier one) that arrives after it.
    async function discard() {
      epoch++; clearTimeout(timer); timer = null; discarding = true;
      // The view on the screen as Discard is pressed is the one discarded: it is not sent again afterwards either.
      const seq = ++order, when = stamp(), shownNow = captured();
      issued = { text: shownNow ? JSON.stringify(shownNow) : null, seq };
      const before = [chain, ...outside];
      let ok = false;
      chain = (async () => {
        await Promise.all(before.map(going => Promise.resolve(going).catch(() => {})));
        try {
          const answer = await request(path + '/discard', { method: 'POST', body: JSON.stringify({ writer: viewerId, seq, at: when }), signal });
          ok = answer.ok;
          if (ok && observeGeneration(answer.value?.generation)) {
            const owner = account();
            if (owner) try { channel?.postMessage({ owner, study, generation }); } catch (_) {}
          }
        } catch (_) { ok = false; }
        if (ok) { last = null; const now = captured(); issued = { text: now ? JSON.stringify(now) : null, seq }; }
      })();
      try { await chain; } finally { discarding = false; }
      return ok;
    }

    // ── Putting the saved view back ──
    const wantedSet = cell => {
      if (!cell) return null;
      let found = [];
      try { found = sets.getActiveDisplaySets().filter(d => d.StudyInstanceUID === cell.study && d.SeriesInstanceUID === cell.series &&
        (!Array.isArray(d.images) || d.images.some(image => image?.SOPInstanceUID === cell.sop))); } catch (_) { found = []; }
      return found.length === 1 ? found[0].displaySetInstanceUID : null;
    };
    async function moveTo(v, index) {
      const display = paneOf(v)?.dataset?.kinDisplay === 'on';
      let done;
      const settled = new Promise(resolve => { done = resolve; });
      const heard = event => { if (event.detail?.viewportId === v.id) done(); };
      v.element.addEventListener('kin-display-image-settled', heard);
      try {
        clearTimeout(v.debouncedTimeout);
        if ('targetImageIdIndex' in v) v.targetImageIdIndex = index;
        if (typeof v.setImageIdIndex === 'function') await v.setImageIdIndex(index);
        else await native?.utilities?.jumpToSlice?.(v.element, { imageIndex: index });
        await Promise.race([display ? settled : new Promise(resolve => requestAnimationFrame(() => resolve())), wait(2000)]);
      } finally { v.element.removeEventListener('kin-display-image-settled', heard); }
    }
    // The Display Set Presets rules, once that module has started (it may start after this one).
    async function cellRules() {
      for (const until = Date.now() + RULES_MS; Date.now() < until && restoring();) {
        if (typeof window.KinViewerCellRules?.apply === 'function') return window.KinViewerCellRules;
        await wait(100);
      }
      return typeof window.KinViewerCellRules?.apply === 'function' ? window.KinViewerCellRules : null;
    }
    // One cell: its rule (sort first), then its image by SOP and frame in the sorted stack, then its window and camera.
    // Resolves what was put back ({ zoom, window, image, index: the image's place now, rule: true / false, or null when
    // the cell kept no rule }), or null when the cell was not this one any more.
    async function restoreCell(viewportId, cell) {
      const v = stackOf(viewportId), set = setOf(viewportId);
      if (!v) return null;
      const still = () => restoring() && stackOf(viewportId) === v && setOf(viewportId) === set;
      const result = { zoom: false, window: false, image: false, index: null, rule: null };
      if (cell.display) {
        const rules = await cellRules();
        if (!still()) return null;
        result.rule = false;
        if (rules) {
          // The cell's own condition goes into the rule's work: turned off meanwhile, the rule's later steps are not done.
          try { result.rule = await rules.apply(viewportId, cell.display, still) === true; } catch (error) { console.error(error); }
          if (!still()) return null;
        }
      }
      const index = model.findImage(v.getImageIds?.(), instance, cell.sop, cell.frame);
      if (index >= 0) {
        if ((v.getCurrentImageIdIndex?.() ?? -1) !== index) await moveTo(v, index);
        if (!still()) return null;
        result.image = v.getCurrentImageIdIndex?.() === index;
        if (result.image) result.index = index;
      }
      v.setProperties({ invert: false, VOILUTFunction: 'LINEAR' });
      v.setProperties(structuredClone(cell.properties));
      result.window = true;
      // A camera belongs to its image: without that image the cell keeps the viewer's own.
      if (result.image) {
        v.setCamera({ flipHorizontal: cell.camera.flipHorizontal, flipVertical: cell.camera.flipVertical });
        const camera = structuredClone(cell.camera); delete camera.flipHorizontal; delete camera.flipVertical;
        v.setCamera(camera);
        result.zoom = true;
      }
      v.render?.();
      return result;
    }
    async function shown(ids) {
      for (let i = 0; i < 100; i++) {
        if (!restoring()) return false;
        if (ids.every(({ id, set }) => !set || (setOf(id) === set && stackOf(id)?.getCurrentImageId?.()))) return true;
        await wait(100);
      }
      return false;
    }
    async function restore(view) {
      const views = ordered(), state = grid.getState(), wanted = view.cells.map(wantedSet);
      const sameLayout = state.layout?.numRows === view.rows && state.layout?.numCols === view.cols && views.length === view.cells.length;
      let targets = views.map(g => g.viewportId);
      // A cell saved empty is part of the layout too.
      const matches = sameLayout && view.cells.every((cell, i) => cell ? setOf(targets[i]) === wanted[i] : !setOf(targets[i]));
      if (!matches && view.cells.every((cell, i) => !cell || wanted[i])) {
        // The saved layout and series, when every saved series is in this viewer.
        const ids = view.cells.map(() => 'kin-auto-view-' + crypto.randomUUID());
        await grid.setLayout({ numRows: view.rows, numCols: view.cols, activeViewportId: ids[view.active], isHangingProtocolLayout: false,
          findOrCreateViewport: index => ({ displaySetInstanceUIDs: wanted[index] ? [wanted[index]] : [], displaySetOptions: [{}],
            viewportOptions: { viewportId: ids[index], viewportType: 'stack', toolGroupId: 'default', allowUnmatchedView: true } }) });
        targets = ids;
        if (!await shown(ids.map((id, i) => ({ id, set: wanted[i] })))) return null;
      } else if (!sameLayout) targets = [];
      const results = [];
      for (let i = 0; i < view.cells.length; i++) {
        const cell = view.cells[i], id = targets[i];
        // A cell whose series is not the saved one now (or is not in this viewer) is left as it is.
        if (!cell || !id || !wanted[i] || setOf(id) !== wanted[i]) { results.push(null); continue; }
        let result = null;
        try { result = await restoreCell(id, cell); } catch (error) { console.error(error); }
        if (!restoring()) return null;
        results.push(result);
      }
      if (!restoring()) return null;
      const activeId = targets[view.active];
      if (activeId && results[view.active]) try { grid.setActiveViewportId?.(activeId); } catch (_) {}
      const text = model.restoredText(view, results, convert);
      const at = results.findIndex((result, i) => i === view.active && result) >= 0 ? view.active : results.findIndex(Boolean);
      if (text && at >= 0) showBadge(targets[at], text);
      return text;
    }
    function showBadge(viewportId, text) {
      clearTimeout(badgeTimer); badge?.remove(); badge = null;
      const layer = ui.cellLayer(viewportId);
      if (!layer) { ui.toast(text); return; }
      const node = element('button', text, layer, 'kin-auto-view-badge');
      node.type = 'button'; node.title = 'Auto Save View'; node.dataset.autoViewBadge = '';
      node.onclick = () => open();
      badge = layer;
      badgeTimer = setTimeout(() => { layer.remove(); if (badge === layer) badge = null; }, BADGE_MS);
    }

    // ── Start: the viewer's first layout and images, then the saved view, then saving ──
    const gridText = () => {
      try {
        const state = grid.getState();
        return JSON.stringify([state.layout?.numRows, state.layout?.numCols, ordered().map(g => [g.viewportId, g.displaySetInstanceUIDs, stackOf(g.viewportId)?.getCurrentImageId?.() || null])]);
      } catch (_) { return ''; }
    };
    async function firstView() {
      let before = null, since = 0;
      for (const until = Date.now() + START_MS; Date.now() < until;) {
        if (!live()) return false;
        const shownHere = !switching() && ordered().some(g => { const v = stackOf(g.viewportId), image = v?.getCurrentImageId?.(), meta = image && instance(image); return meta && studies.includes(meta.StudyInstanceUID); });
        const now = gridText();
        if (shownHere && now === before) { if (Date.now() - since >= QUIET) return true; }
        else { before = now; since = Date.now(); }
        await wait(100);
      }
      return false;
    }
    let known;
    const settingsRead = new Promise(resolve => { known = resolve; });
    store.subscribe('autoSaveView', value => {
      const was = on;
      on = value === true;  // anything else (absent, malformed) is off
      known();
      // Off ends the putting back that is going on and the saves waiting in the queue.
      if (!on) { clearTimeout(timer); timer = null; if (was) { restoreRun++; epoch++; } }
      else if (!was && phase === 'ready') { if (generation === null) read(); changed(); }
      painter?.();
    });
    (async () => {
      await Promise.race([settingsRead, wait(SETTINGS_MS)]);
      if (!live() || !study) return;
      const started = await firstView();
      if (!live()) return;
      if (started && on) {
        phase = 'restoring'; restoreAt = restoreRun;
        // Every enabled opening needs the Discard generation for closing saves. Only a fresh non-Job opening restores.
        try { const saved = await read(); if (saved && firstOpening && !jobChosen && restoring()) await restore(saved.snapshot); }
        catch (error) { console.error(error); }
        if (!live()) return;
      }
      phase = 'ready';
      // The view on the screen now is the starting point: it is saved once it changes.
      const now = captured(); issued = { text: now ? JSON.stringify(now) : null, seq: 0 };
    })().catch(error => console.error(error));

    // ── What changes the view ──
    const listen = name => { if (name) document.addEventListener(name, changed, { capture: true, signal }); };
    [events.CAMERA_MODIFIED, events.VOI_MODIFIED, events.STACK_NEW_IMAGE].forEach(listen);
    const subscriptions = [];
    for (const name of new Set([grid?.EVENTS?.GRID_STATE_CHANGED, grid?.EVENTS?.LAYOUT_CHANGED, grid?.EVENTS?.ACTIVE_VIEWPORT_ID_CHANGED].filter(Boolean)))
      try { const subscription = grid.subscribe(name, () => changed()); if (subscription) subscriptions.push(subscription); } catch (error) { console.error(error); }
    // A Hanging Protocol applied: its cell rules are put on the cells next. Nothing is saved (after a quiet moment, on a
    // patient switch or as the window closes) until Display Set Presets and any replacement pass finish, and then the
    // grid has stood still for the quiet time. There is no time
    // limit: a pass still going is not taken for one that has ended. A later protocol takes the place of an earlier one.
    async function steady(run) {
      let before = null, since = 0;
      while (live() && run === hpRun) {
        if (window.KinViewerCellRules?.busy?.()) { before = null; since = 0; await wait(100); continue; }
        // Even a replacement that finishes between checks (overlay/camera only) starts a fresh quiet interval.
        const now = JSON.stringify([gridText(), window.KinViewerCellRules?.revision?.()]);
        if (now === before) { if (Date.now() - since >= QUIET) return true; }
        else { before = now; since = Date.now(); }
        await wait(100);
      }
      return false;
    }
    addEventListener('kin-hanging-protocol-applied', () => {
      const run = ++hpRun;
      held = true; clearTimeout(timer); timer = null;
      (async () => {
        await wait(0);  // Display Set Presets hears the same event and starts its pass of the protocol's rules
        const rules = window.KinViewerCellRules;
        const outcome = typeof rules?.settled === 'function' ? await rules.settled() : 'none';
        if (run !== hpRun || outcome === 'ended' || !await steady(run) || run !== hpRun) return;
        held = false; changed();
      })().catch(error => console.error(error));
    }, { signal });
    // The window closing, and a patient tab switching (the view is read before the next patient's images come).
    addEventListener('pagehide', () => { if (timer) { clearTimeout(timer); timer = null; } save('close'); }, { signal });
    const classes = new MutationObserver(() => {
      if (!document.body.classList.contains('kin-patient-switching')) return;
      // Sent at once, outside the queue, and kept going when this viewer ends with the switch.
      clearTimeout(timer); timer = null; save('now');
    });
    classes.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    // ── The window: Display ▾ › Auto Save View…, and Viewer Settings › Tools & Display ──
    function open() {
      const handle = ui.panel({ id: 'auto-save-view', title: 'Auto Save View' });
      if (!handle) return;
      const body = handle.body; body.replaceChildren();
      element('p', 'Saves the view of this study as you change it — zoom and pan, window, rotation and flip, the image each cell shows, each cell\'s '
        + 'display set rule and the layout — and applies it when the study is opened again. Marks are saved on their own. Opening a Job shows the Job instead.', body, 'kin-auto-view-note');
      const label = element('label', '', body, 'kin-auto-view-row');
      const input = element('input', '', label); input.type = 'checkbox';
      element('span', 'Save view changes automatically and apply on reopen', label);
      input.setAttribute('aria-label', 'Save view changes automatically and apply on reopen');
      const savedLine = element('p', '', body); savedLine.dataset.autoViewSaved = '';
      const row = element('div', '', body, 'kin-auto-view-row');
      const discardButton = element('button', 'Discard Saved View', row); discardButton.type = 'button';
      const line = element('p', '', body, 'kin-auto-view-note'); line.setAttribute('role', 'status');
      let busy = false;
      function paint() {
        if (!input.isConnected) return;
        if (!busy) input.checked = on;
        input.disabled = busy || !writer();
        savedLine.textContent = last === undefined ? 'Reading the saved view of this study…'
          : last ? 'Last saved ' + new Date(last.savedAt).toLocaleString() + ' · ' + model.summary(last.snapshot, convert) : model.summary(null);
        discardButton.disabled = busy || !last || !writer();
      }
      input.onchange = async () => {
        const want = input.checked;
        busy = true; paint(); line.textContent = 'Saving the setting…';
        let ok = false;
        try { ok = await store.set('autoSaveView', want); } catch (_) { ok = false; }
        busy = false;
        if (handle.element.isConnected) {
          line.textContent = !ok ? 'The setting was not saved.' : want ? 'On: view changes are saved and applied when this study is opened again.' : 'Off: views are neither saved nor applied. A saved view stays until it is discarded.';
          paint();
        }
      };
      discardButton.onclick = async () => {
        busy = true; paint(); line.textContent = 'Discarding…';
        const ok = await discard();
        busy = false;
        if (handle.element.isConnected) { line.textContent = ok ? 'The saved view of this study was discarded.' : 'The saved view was not discarded. Try again.'; paint(); }
      };
      painter = paint;
      handle.onClose(() => { if (painter === paint) painter = null; });
      paint();
      if (last === undefined) read();
      handle.focus();
    }
    ui.menuItem('Display', { id: 'autoSaveView', label: 'Auto Save View…', order: 900, run: () => open(), enabled: () => !!study });
    ui.setting({ id: 'autoSaveViewCheck', kind: 'check', label: 'Save view changes automatically and apply on reopen', order: 65, key: 'autoSaveView', default: false });
    ui.setting({ id: 'autoSaveView', kind: 'button', label: 'Auto Save View…', order: 65, run: () => open() });

    return () => {
      // A save that was waiting (for the quiet moment or in the queue) goes now, while the cells are still this study's.
      if (timer || waiting) { clearTimeout(timer); timer = null; save('now'); }
      ended = true; abort.abort(); classes.disconnect(); channel?.close(); painter = null;
      for (const subscription of subscriptions) try { subscription.unsubscribe?.(); } catch (_) {}
      clearTimeout(badgeTimer); badge?.remove(); style.remove();
    };
  });
})();

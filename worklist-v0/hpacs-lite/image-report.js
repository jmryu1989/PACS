/*
 * Image Report (worklist add-on): draw on a breast or thyroid diagram or on a saved image of the study, and attach the
 * drawing to the report.
 *
 * Entry: `Image Report` at the right end of the Report Editor title row, next to Pop Out. It opens the Image Report
 * window for the study selected then; that study is fixed for the window ("name · ID").
 *   Background  Breast diagram · Thyroid diagram · Saved image (this study) - one of the study's key images (with more
 *               than one, the Image list chooses); without a key image that choice is off and says so.
 *   Tool        Pen · Line · Ellipse · Text. Text places the words of the Text field where the drawing is pressed; nothing
 *               opens on the drawing, and Enter in the field only ends typing (a placed label never changes).
 *   Color       Black · Red · Blue · Green · Yellow. Undo takes back the last mark; Clear takes all marks off this
 *               background. Each background keeps its own marks (each saved image frame too).
 *   Attach to Report  saves the drawing of the shown background into my report draft (the server keeps it; the same
 *               background again replaces the drawing attached for it). Attached drawings are listed under the window
 *               and under Conclusion in the editor, each with Remove. A drawing is part of the report version made by
 *               Save, Prelim, Defer, Approve, an amendment or an Addendum, and is shown with that version (preview,
 *               print, History, Clinician Home).
 * When the report does not take edits now (approved and not amendable by me, held by someone else, preliminary, …) the
 * window only shows what is attached. Marks not yet attached stay for this study while this sign-in lasts (in memory, per
 * institution, user and study); they are dropped when the report is committed or my draft is discarded, and at log out.
 *
 * The pure part (`KinImageReportModel`) is what the tests load without a page.
 */
(function (root) {
  'use strict';

  // ════════ pure model ════════
  const BACKGROUNDS = Object.freeze([['breast', 'Breast diagram'], ['thyroid', 'Thyroid diagram'], ['image', 'Saved image (this study)']]);
  const TOOLS = Object.freeze([['pen', 'Pen'], ['line', 'Line'], ['ellipse', 'Ellipse'], ['text', 'Text']]);
  const COLORS = Object.freeze([['#000000', 'Black'], ['#e0242b', 'Red'], ['#1565c0', 'Blue'], ['#2e7d32', 'Green'], ['#f9a825', 'Yellow']]);
  // The server's limits (api/src/image-report.ts DRAWING_LIMITS).
  const LIMITS = Object.freeze({ strokes: 500, points: 2000, text: 80, perReport: 3, pngBytes: 1200000 });
  const unit = value => Math.round(Math.min(1, Math.max(0, Number(value) || 0)) * 1e5) / 1e5;

  /** The marks of one drawing are kept apart per background, and per key image frame on a saved image. */
  function keyOf(background, image) {
    if (background === 'image') return image && image.sopUid && Number.isSafeInteger(image.frame) ? `image:${image.sopUid}:${image.frame}` : null;
    return BACKGROUNDS.some(([value]) => value === background) ? background : null;
  }
  /** The key of an attached drawing (its server entry: background and pinned source). */
  const attachedKey = d => d && keyOf(d.background, d.source || null);

  /** One stroke as the server takes it, or null: coordinates 0..1 of the drawing area, text only for Text. */
  function strokeOf(s) {
    if (!s || !TOOLS.some(([t]) => t === s.tool) || !COLORS.some(([c]) => c === s.color) || !Array.isArray(s.points)) return null;
    const want = s.tool === 'pen' ? [1, LIMITS.points] : s.tool === 'text' ? [1, 1] : [2, 2];
    if (s.points.length < want[0] || s.points.length > want[1]) return null;
    const points = [];
    for (const p of s.points) {
      if (!Array.isArray(p) || p.length !== 2 || !p.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)) return null;
      points.push([unit(p[0]), unit(p[1])]);
    }
    const stroke = { tool: s.tool, color: s.color, points };
    if (s.tool === 'text') {
      if (typeof s.text !== 'string' || !s.text.trim() || [...s.text].length > LIMITS.text || /[\u0000-\u001f\u007f]/.test(s.text)) return null;
      stroke.text = s.text;
    }
    return stroke;
  }
  /** The strokes of an attach request, or null when one is not valid or there are none or too many. */
  function wireStrokes(strokes) {
    if (!Array.isArray(strokes) || !strokes.length || strokes.length > LIMITS.strokes) return null;
    const out = strokes.map(strokeOf);
    return out.every(Boolean) ? out : null;
  }

  /** The marks being drawn, per key. A new mark beyond the limit is refused; Undo and Clear act on one key only. */
  function createMarks(initial) {
    const sets = new Map(initial ? Object.entries(initial).map(([k, list]) => [k, list.map(s => ({ ...s, points: s.points.map(p => [...p]) }))]) : []);
    const list = key => (key ? sets.get(key) || [] : []);
    return {
      list,
      push(key, stroke) {
        if (!key || !strokeOf(stroke)) return false;
        const marks = sets.get(key) || [];
        if (marks.length >= LIMITS.strokes) return false;
        marks.push(stroke); sets.set(key, marks); return true;
      },
      /** A pen stroke grows while it is drawn; its last point moves for Line and Ellipse. */
      extend(key, stroke, point) {
        if (!list(key).includes(stroke)) return false;
        if (stroke.tool === 'pen') { if (stroke.points.length < LIMITS.points) stroke.points.push(point); }
        else stroke.points[1] = point;
        return true;
      },
      undo(key) { const marks = list(key); if (!marks.length) return false; marks.pop(); return true; },
      clear(key) { const had = list(key).length > 0; if (key) sets.delete(key); return had; },
      snapshot() { return Object.fromEntries([...sets].filter(([, marks]) => marks.length).map(([k, marks]) => [k, marks.map(s => ({ ...s, points: s.points.map(p => [...p]) }))])); },
    };
  }

  /**
   * Marks not yet attached, kept for this sign-in only (memory, never browser storage). One entry per institution, user
   * and study, with the report version and the start of my draft's work when it was written (null: no draft): a later open
   * that sees another version (a commit) or another draft work (mine discarded, cleared or committed, then written again)
   * does not bring them back. A draft started after the marks were drawn keeps them.
   */
  function createMemory() {
    const kept = new Map();
    const scopeOf = (owner, uid) => JSON.stringify([owner?.institution ?? null, owner?.sub ?? null, uid]);
    return {
      put(owner, uid, value) { kept.set(scopeOf(owner, uid), value); },
      take(owner, uid, now) {
        const scope = scopeOf(owner, uid), value = kept.get(scope);
        if (!value) return null;
        if (value.version !== now.version || (value.draftSince !== null && value.draftSince !== now.draftSince)) { kept.delete(scope); return null; }
        // Marks drawn before any draft belong to the draft that started since: its end ends them too.
        if (value.draftSince === null && now.draftSince !== null) value.draftSince = now.draftSince;
        return value;
      },
      drop(owner, uid) { kept.delete(scopeOf(owner, uid)); },
      clear() { kept.clear(); },
      size() { return kept.size; },
    };
  }

  /** Where an image of size w×h sits, kept whole and centred, in the drawing area W×H. */
  function fit(w, h, W, H) {
    const s = Math.min(W / w, H / h), dw = Math.round(w * s), dh = Math.round(h * s);
    return { x: Math.floor((W - dw) / 2), y: Math.floor((H - dh) / 2), w: dw, h: dh };
  }

  const model = Object.freeze({ BACKGROUNDS, TOOLS, COLORS, LIMITS, keyOf, attachedKey, strokeOf, wireStrokes, createMarks, createMemory, fit, unit });
  if (typeof module === 'object' && module.exports) module.exports = model;
  if (!root || !root.document) return;
  root.KinImageReportModel = model;

  // ════════ the window ════════
  const W = 640, H = 440;
  const memory = createMemory();

  function install(ctx) {
    const $ = selector => document.querySelector(selector);
    const node = (tag, props = {}, ...children) => {
      const el = Object.assign(document.createElement(tag), props);
      for (const child of children) if (child != null) el.append(child);
      return el;
    };
    const radio = (name, [value, label], checked) => {
      const input = node('input', { type: 'radio', name, value, checked });
      return { input, label: node('label', {}, input, ' ' + label) };
    };

    const style = node('style', { textContent: `
      #image-report { width: min(1000px, 96vw); max-height: 94vh; overflow: auto; color: #d7dce4; background: #1b2029; border: 1px solid #3a4356; border-radius: 6px; padding: 14px 16px; }
      #image-report::backdrop { background: rgba(0, 0, 0, .45); }
      #image-report h2 { font-size: 15px; margin: 0 0 4px; }
      #image-report .ir-study { font-size: 12px; color: #aab2c0; margin: 0 0 10px; }
      #image-report .ir-cols { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
      #image-report .ir-tools { flex: 0 1 260px; display: grid; gap: 8px; font-size: 12px; }
      #image-report fieldset { border: 1px solid #3a4356; padding: 6px 8px; display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; }
      #image-report fieldset:disabled { opacity: .5; }
      #image-report input[type=text], #image-report select { background: #11151c; color: #d7dce4; border: 1px solid #3a4356; }
      #image-report canvas.ir-draw { width: ${W}px; max-width: 100%; height: auto; background: #fff; border: 1px solid #3a4356; cursor: crosshair; touch-action: none; }
      #image-report .ir-note { color: #aab2c0; margin: 0; }
      #image-report .ir-status { min-height: 1.2em; margin: 0; }
      #image-report .ir-status.err { color: #ff8a80; } #image-report .ir-status.ok { color: #8bd49c; }
      #image-report button, #report-image-attached button { background: #232936; border: 1px solid #3a4356; color: #d7dce4; padding: 3px 10px; border-radius: 3px; cursor: pointer; font-size: 12px; }
      #image-report button.primary { background: #2d5a8a; border-color: #4b7fb5; }
      #image-report button:disabled { opacity: .4; cursor: default; }
      #image-report .ir-actions { display: flex; gap: 6px; justify-content: flex-end; margin-top: 10px; }
      .ir-attached { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-start; font-size: 12px; }
      .ir-attached figure { margin: 0; display: grid; gap: 2px; justify-items: center; }
      .ir-attached img { width: 120px; height: 83px; object-fit: contain; background: #fff; border: 1px solid #3a4356; }
      #report-image-attached { margin-top: 4px; }
      #report-image-attached[hidden] { display: none; }` });
    const dialog = node('dialog', { id: 'image-report' });
    dialog.setAttribute('aria-labelledby', 'image-report-title');
    const title = node('h2', { id: 'image-report-title', textContent: 'Image Report' });
    const head = node('p', { className: 'ir-study' });
    const bgRadios = BACKGROUNDS.map(entry => radio('image-report-bg', entry, entry[0] === 'breast'));
    const imageSelect = node('select', { id: 'image-report-image' });
    imageSelect.setAttribute('aria-label', 'Image');
    const imageNote = node('p', { className: 'ir-note', textContent: '' });
    const toolRadios = TOOLS.map(entry => radio('image-report-tool', entry, entry[0] === 'pen'));
    const text = node('input', { type: 'text', id: 'image-report-text', maxLength: LIMITS.text, size: 16 });
    text.setAttribute('aria-label', 'Text');
    const colorRadios = COLORS.map(entry => radio('image-report-color', entry, entry[0] === '#e0242b'));
    const undo = node('button', { type: 'button', id: 'image-report-undo', textContent: 'Undo' });
    const clear = node('button', { type: 'button', id: 'image-report-clear', textContent: 'Clear' });
    const canvas = node('canvas', { width: W, height: H, className: 'ir-draw', id: 'image-report-canvas' });
    canvas.setAttribute('role', 'img');
    const attachedHead = node('strong', { textContent: 'Attached to this report: 0' });
    const attached = node('div', { className: 'ir-attached', id: 'image-report-attached' });
    const status = node('p', { className: 'ir-status', id: 'image-report-status' });
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const readOnly = node('p', { className: 'ir-note', id: 'image-report-readonly' });
    const attach = node('button', { type: 'button', id: 'image-report-attach', className: 'primary', textContent: 'Attach to Report' });
    const close = node('button', { type: 'button', id: 'image-report-close', textContent: 'Close' });
    const bgSet = node('fieldset', {}, node('legend', { textContent: 'Background' }), ...bgRadios.map(r => r.label), imageSelect, imageNote);
    const toolSet = node('fieldset', {}, node('legend', { textContent: 'Tool' }), ...toolRadios.map(r => r.label), text);
    const colorSet = node('fieldset', {}, node('legend', { textContent: 'Color' }), ...colorRadios.map(r => r.label));
    dialog.append(title, head, node('div', { className: 'ir-cols' },
      node('div', { className: 'ir-tools' }, bgSet, toolSet, colorSet, node('div', {}, undo, ' ', clear),
        node('p', { className: 'ir-note', textContent: 'Draw by hand on a diagram or on a saved image of this study. Attach to Report saves the drawing with the report draft; Save, Prelim or Approve keeps it in the report.' }),
        readOnly, node('div', {}, attachedHead, attached), status),
      node('div', {}, canvas)),
    node('div', { className: 'ir-actions' }, attach, close));
    document.head.append(style);
    document.body.append(dialog);

    // The entry in the editor title row (main.html) and the attached drawings under Conclusion.
    const button = $('#report-image-report');
    const strip = node('div', { id: 'report-image-attached', hidden: true });
    strip.setAttribute('aria-label', 'Attached drawings');
    const stripList = node('div', { className: 'ir-attached' });
    strip.append(node('small', { textContent: 'Image Report' }), stripList);
    const conclusion = $('#conclusion');
    conclusion?.after(strip);

    // ── state ──
    let session = null;   // { uid, seq, at, owner, marks, background, images, image, list, editable } of the open window
    let seq = 0;
    let stripSeq = 0;
    let stripUid = null;
    let stripMark = null;  // the selected study's draft revision and version when the strip was read
    const markOf = uid => { const s = uid ? ctx.study(uid) : null; return s ? JSON.stringify([s.state?.draftRevision ?? null, s.state?.version ?? null, s.state?.rs ?? null]) : null; };
    let drawing = null;   // the stroke being drawn
    const pictures = new Map();   // drawing id → object URL (a drawing's content never changes)
    const frames = new Map();     // key image id:revision → { image, w, h } loaded this sign-in
    const owner = () => { const s = ctx.session(); return s ? { institution: s.institution ?? null, sub: s.sub ?? null } : null; };
    const can = () => ctx.has('radiologist') && !ctx.session()?.demo;
    const value = list => list.find(r => r.input.checked)?.input.value;
    const background = () => value(bgRadios);
    const tool = () => value(toolRadios);
    const color = () => value(colorRadios);
    const image = () => session?.images.find(i => i.id === imageSelect.value) || null;
    const key = () => keyOf(background(), background() === 'image' ? image() : null);
    const say = (message, kind = '') => { status.textContent = message; status.className = 'ir-status' + (kind ? ' ' + kind : ''); };
    const reason = (error, fallback) => (error && (error.body?.message || error.message)) || fallback;

    function sync() {
      if (!button) return;
      button.hidden = !can();
      button.disabled = !can() || !ctx.allowed() || !ctx.selectedUid();
    }

    // ── drawing ──
    function paintStroke(c, s) {
      const pts = s.points.map(([x, y]) => [x * W, y * H]);
      c.strokeStyle = s.color; c.fillStyle = s.color; c.lineWidth = 3; c.lineCap = 'round'; c.lineJoin = 'round';
      if (s.tool === 'pen') {
        c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
        if (pts.length === 1) c.lineTo(pts[0][0] + 0.1, pts[0][1]);
        c.stroke();
      } else if (s.tool === 'line') {
        c.beginPath(); c.moveTo(...pts[0]); c.lineTo(...pts[1]); c.stroke();
      } else if (s.tool === 'ellipse') {
        const [[x0, y0], [x1, y1]] = pts;
        c.beginPath(); c.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2); c.stroke();
      } else if (s.tool === 'text') {
        c.font = 'bold 16px sans-serif'; c.textBaseline = 'middle'; c.textAlign = 'left';
        c.fillText(s.text, pts[0][0], pts[0][1]);
      }
    }
    function paint() {
      const c = canvas.getContext('2d');
      const bg = background();
      if (bg === 'image') {
        c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
        const picked = image(), loaded = picked && frames.get(picked.id + ':' + picked.revision);
        if (loaded) { const at = fit(loaded.w, loaded.h, W, H); c.drawImage(loaded.image, at.x, at.y, at.w, at.h); }
      } else root.KinImageReportDiagrams.draw(c, bg, W, H);
      for (const s of session ? session.marks.list(key()) : []) paintStroke(c, s);
      canvas.setAttribute('aria-label', (BACKGROUNDS.find(([v]) => v === bg) || [, ''])[1] + ' · ' + (session ? session.marks.list(key()).length : 0) + ' marks');
    }
    function remember() {
      if (!session) return;
      memory.put(session.owner, session.uid, { version: session.list.version, draftSince: session.list.draft?.since ?? null,
        background: background(), image: imageSelect.value, marks: session.marks.snapshot() });
    }
    const point = event => {
      const box = canvas.getBoundingClientRect();
      return [unit((event.clientX - box.left) / box.width), unit((event.clientY - box.top) / box.height)];
    };
    canvas.addEventListener('pointerdown', event => {
      if (!session || !session.editable || event.button !== 0) return;
      const k = key();
      if (!k) { say(background() === 'image' ? '이 검사에 저장된 영상이 없습니다' : '배경을 고르세요', 'err'); return; }
      const at = point(event);
      if (tool() === 'text') {
        const words = text.value.trim();
        if (!words) { say('먼저 Text 칸에 넣을 글을 쓰세요', 'err'); text.focus(); return; }
        if (!session.marks.push(k, { tool: 'text', color: color(), points: [at], text: words.slice(0, LIMITS.text) })) { say('표시는 한 그림에 ' + LIMITS.strokes + '개까지입니다', 'err'); return; }
        say(''); paint(); remember(); return;
      }
      const stroke = { tool: tool(), color: color(), points: tool() === 'pen' ? [at] : [at, at] };
      if (!session.marks.push(k, stroke)) { say('표시는 한 그림에 ' + LIMITS.strokes + '개까지입니다', 'err'); return; }
      drawing = { key: k, stroke };
      try { canvas.setPointerCapture(event.pointerId); } catch (_) {}
      paint();
    });
    canvas.addEventListener('pointermove', event => {
      if (!drawing || !session) return;
      session.marks.extend(drawing.key, drawing.stroke, point(event));
      paint();
    });
    const finish = () => { if (!drawing) return; drawing = null; say(''); remember(); };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', finish);
    // Enter only ends typing in the field: a label already placed keeps its words.
    text.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); text.blur(); } });
    undo.addEventListener('click', () => { if (session?.editable && session.marks.undo(key())) { paint(); remember(); } });
    clear.addEventListener('click', () => { if (session?.editable && session.marks.clear(key())) { paint(); remember(); } });
    for (const r of [...bgRadios, ...toolRadios, ...colorRadios]) r.input.addEventListener('change', () => { onBackground(); });
    imageSelect.addEventListener('change', () => onBackground());

    // ── saved images ──
    async function keyImages(uid, at) {
      const items = []; let cursor = null;
      do {
        const page = await ctx.api('GET', '/studies/' + encodeURIComponent(uid) + '/viewer-items?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), undefined, undefined, at);
        if (!page || !Array.isArray(page.items) || (cursor && page.nextCursor === cursor)) throw new Error('저장한 영상 목록을 읽지 못했습니다');
        items.push(...page.items); cursor = page.nextCursor || null;
      } while (cursor);
      return items.filter(item => item && !item.hidden && item.item && item.item.kind === 'key'
        && typeof item.item.sopUid === 'string' && typeof item.item.seriesUid === 'string' && Number.isSafeInteger(item.item.frame))
        .map((item, index) => ({ id: item.id, revision: item.revision, seriesUid: item.item.seriesUid, sopUid: item.item.sopUid,
          frame: item.item.frame, label: (item.item.title || 'Key image ' + (index + 1)) + ' · frame ' + item.item.frame }));
    }
    async function loadFrame(uid, picked, mine) {
      const cacheKey = picked.id + ':' + picked.revision;
      if (frames.has(cacheKey)) return;
      const at = session.at;
      const located = await ctx.api('POST', '/dicom/lookup', { studyUid: uid, sopUid: picked.sopUid }, undefined, at);
      if (!located || !/^[a-f0-9]{8}(?:-[a-f0-9]{8}){4}$/.test(located.id)) throw new Error('저장한 영상을 찾지 못했습니다');
      const response = await root.KinSessionTransport.page().request('/instances/' + located.id + '/frames/' + (picked.frame - 1) + '/preview',
        { context: at, read: 'response', cache: 'no-store', headers: { Accept: 'image/png' } });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/png')) throw new Error('저장한 영상을 불러오지 못했습니다');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const picture = new Image(); picture.src = url;
      try { await picture.decode(); } finally { URL.revokeObjectURL(url); }
      if (!current(mine)) return;
      frames.set(cacheKey, { image: picture, w: picture.naturalWidth, h: picture.naturalHeight });
    }
    function onBackground() {
      if (!session) return;
      const bg = background();
      imageSelect.hidden = bg !== 'image' || session.images.length < 2;
      paint(); remember();
      const picked = image();
      if (bg === 'image' && picked && !frames.has(picked.id + ':' + picked.revision)) {
        const mine = session.seq;
        say('저장한 영상을 불러오는 중입니다…');
        loadFrame(session.uid, picked, mine).then(() => { if (current(mine)) { say(''); paint(); } },
          error => { if (current(mine)) say(reason(error, '저장한 영상을 불러오지 못했습니다'), 'err'); });
      }
    }

    // ── attached drawings ──
    async function picture(uid, id, at) {
      if (pictures.has(id)) return pictures.get(id);
      const got = await ctx.api('GET', '/studies/' + encodeURIComponent(uid) + '/report/drawings/' + encodeURIComponent(id), undefined, undefined, at);
      if (!got || typeof got.png !== 'string') throw new Error('그림을 읽지 못했습니다');
      const bytes = Uint8Array.from(atob(got.png), ch => ch.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
      pictures.set(id, url);
      return url;
    }
    const nameOf = d => d.background === 'image' ? 'Saved image' + (d.source?.frame ? ' · frame ' + d.source.frame : '')
      : (BACKGROUNDS.find(([v]) => v === d.background) || [, d.background])[1];
    /** One list of attached drawings (window or editor strip): a thumbnail each, and Remove where the report takes edits. */
    function renderAttached(target, uid, list, { editable, at, onRemove }) {
      target.replaceChildren(...list.map(d => {
        const img = node('img', { alt: nameOf(d) });
        picture(uid, d.id, at).then(url => { img.src = url; }, () => { img.alt = nameOf(d) + ' (could not be read)'; });
        const remove = node('button', { type: 'button', textContent: 'Remove', hidden: !editable });
        remove.dataset.drawing = d.id;
        remove.addEventListener('click', () => onRemove(d));
        return node('figure', {}, img, node('figcaption', { textContent: nameOf(d) }), remove);
      }));
    }
    /** What the report would hold now: my draft's list when I have a draft, otherwise the head version's. */
    const shownList = list => (list.draft ? list.draft.drawings : list.head) || [];
    /** The page learns whether my draft's drawings differ from the head version's (an amendment of an approved report). */
    function tellChanged(uid, list) {
      const ids = l => (l || []).map(d => d.id).sort().join(',');
      ctx.report.drawingsChanged(uid, !!list.draft && ids(list.draft.drawings) !== ids(list.head));
    }

    /**
     * The page learns what is shown as that report's drawings (`null`: no list that was read is shown). A commit names
     * this list as the one its version must hold, and the server refuses a version that would hold another: only a list
     * drawn here is told, never one that is merely known.
     */
    function tellShown(uid, list) {
      ctx.report.drawingsShown?.(uid, list ? { revision: list.draftRevision, effective: shownList(list).map(d => d.id),
        head: list.head.map(d => d.id) } : null);
    }

    async function readList(uid, at) {
      const list = await ctx.api('GET', '/studies/' + encodeURIComponent(uid) + '/report/drawings', undefined, undefined, at);
      if (!list || !Array.isArray(list.head)) throw new Error('붙인 그림 목록을 읽지 못했습니다');
      return list;
    }
    function current(mine) { return !!session && session.seq === mine && dialog.open && ctx.admits(session.at); }

    function renderWindow() {
      if (!session) return;
      const list = shownList(session.list);
      attachedHead.textContent = 'Attached to this report: ' + list.length;
      renderAttached(attached, session.uid, list, { editable: session.editable, at: session.at, onRemove: d => void change({ removeDrawing: d.id }) });
      for (const set of [bgSet, toolSet, colorSet]) set.disabled = !session.editable;
      undo.disabled = clear.disabled = attach.disabled = !session.editable;
      bgSet.disabled = false;   // a read-only window still shows each background's attached drawing beside the list
      readOnly.textContent = session.editable ? '' : 'View only — ' + session.why;
    }

    async function open(uid) {
      if (!can()) return;
      if (!ctx.allowed()) { ctx.toast('서버에 연결된 계정에서만 Image Report를 쓸 수 있습니다.', 'err'); return; }
      if (!uid) { ctx.toast('검사를 먼저 고르세요.', 'err'); return; }
      const mine = ++seq, at = ctx.work('study');
      const s = ctx.study(uid) || {};
      head.textContent = [s.name, s.id].filter(v => v != null && String(v).trim() !== '').join(' · ');
      head.dataset.uid = uid;
      say('');
      session = { uid, seq: mine, at, owner: owner(), marks: createMarks(), images: [], list: { version: 0, head: [], draft: null }, editable: false, why: '' };
      imageSelect.replaceChildren(); imageNote.textContent = '';
      if (!dialog.open) dialog.showModal();
      paint();
      try {
        const [list, images] = await Promise.all([readList(uid, at), keyImages(uid, at).catch(() => null)]);
        if (!current(mine)) return;
        session.list = list;
        tellChanged(uid, list);
        session.images = images || [];
        imageSelect.replaceChildren(...session.images.map(i => node('option', { value: i.id, textContent: i.label })));
        bgRadios[2].input.disabled = !session.images.length;
        imageNote.textContent = images === null ? '저장한 영상 목록을 읽지 못했습니다' : session.images.length ? '' : '이 검사에 저장된 영상이 없습니다';
        const why = ctx.report.editBlock(uid);
        session.editable = !why; session.why = why || '';
        const kept = memory.take(session.owner, uid, { version: list.version, draftSince: list.draft?.since ?? null });
        if (kept) {
          session.marks = createMarks(kept.marks);
          if (kept.image && session.images.some(i => i.id === kept.image)) imageSelect.value = kept.image;
          const bg = bgRadios.find(r => r.input.value === kept.background && !r.input.disabled);
          if (bg) bg.input.checked = true;
        }
        if (background() === 'image' && !session.images.length) bgRadios[0].input.checked = true;
        renderWindow();
        tellShown(uid, list);
        onBackground();
      } catch (error) {
        if (current(mine)) say(reason(error, 'Image Report를 열지 못했습니다'), 'err');
      }
    }

    /** Attach (`{ drawing }`) or Remove (`{ removeDrawing }`) through the report's draft write, then read the list again. */
    async function change(operation) {
      if (!session || !session.editable) return;
      const mine = session.seq, uid = session.uid;
      attach.disabled = true;
      say(operation.removeDrawing ? '그림을 빼는 중입니다…' : '판독문에 붙이는 중입니다…');
      let result;
      try { result = await ctx.report.drawing(uid, operation); }
      catch (error) { result = { status: 'refused', reason: reason(error, '처리하지 못했습니다') }; }
      if (!current(mine)) { void refreshStrip(); return; }
      if (result.status !== 'applied') { attach.disabled = !session.editable; say(result.reason || '처리하지 못했습니다', 'err'); return; }
      // The draft changed; what is shown changes only with a list read again. When that read fails the list below is the
      // one from before, and it stays what the page tells as shown: a commit then names it and the server refuses it.
      let reread = true;
      try { session.list = await readList(uid, session.at); tellChanged(uid, session.list); } catch (_) { reread = false; }
      if (!current(mine)) return;
      remember();
      renderWindow();
      if (reread) tellShown(uid, session.list);
      const n = shownList(session.list).length;
      if (!reread) say('판독 초안에는 반영됐지만 붙인 그림 목록을 다시 읽지 못했습니다 — 아래 목록은 이전 것입니다. 창을 닫았다 다시 열어 확인하세요.', 'err');
      else say(operation.removeDrawing ? 'Removed from the report draft.' : `Attached to the report draft (${n} of ${LIMITS.perReport}). Save, Prelim or Approve keeps it in the report.`, 'ok');
      void refreshStrip();
    }
    attach.addEventListener('click', () => {
      if (!session || !session.editable) return;
      const k = key(), bg = background(), picked = bg === 'image' ? image() : null;
      if (!k) { say(bg === 'image' ? '이 검사에 저장된 영상이 없습니다' : '배경을 고르세요', 'err'); return; }
      const strokes = wireStrokes(session.marks.list(k));
      if (!strokes) { say('붙일 그림이 없습니다 — 먼저 그리세요', 'err'); return; }
      if (bg === 'image' && !frames.has(picked.id + ':' + picked.revision)) { say('저장한 영상을 아직 불러오지 못했습니다', 'err'); return; }
      paint();
      const png = canvas.toDataURL('image/png').split(',')[1];
      if (Math.floor(png.length * 3 / 4) > LIMITS.pngBytes) { say('그림 파일이 너무 커서 붙이지 못했습니다 — 표시를 줄이거나 다른 배경을 쓰세요', 'err'); return; }
      const replaces = shownList(session.list).find(d => attachedKey(d) === k)?.id;
      void change({ drawing: { background: bg, ...(picked ? { source: { keyImageId: picked.id, keyImageRevision: picked.revision, frame: picked.frame } } : {}),
        strokes, png, ...(replaces ? { replaces } : {}) } });
    });
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { drawing = null; session = null; void refreshStrip(); button?.focus(); });

    // ── the editor strip ──
    async function refreshStrip() {
      const uid = ctx.selectedUid(), mine = ++stripSeq;
      // Another study: the last one's drawings go at once, before its own are read.
      if (uid !== stripUid) { strip.hidden = true; stripList.replaceChildren(); }
      stripUid = uid;
      stripMark = markOf(uid);
      if (!uid || !can() || !ctx.allowed()) { strip.hidden = true; stripList.replaceChildren(); return; }
      const at = ctx.work('study');
      let list;
      // A list that could not be read is shown as none - and told as not shown, which is not "no drawings".
      try { list = await readList(uid, at); } catch (_) { if (mine === stripSeq) { strip.hidden = true; tellShown(uid, null); } return; }
      if (mine !== stripSeq || !ctx.admits(at) || ctx.selectedUid() !== uid) return;
      tellChanged(uid, list);
      tellShown(uid, list);
      const shown = shownList(list);
      strip.hidden = !shown.length;
      const why = ctx.report.editBlock(uid);
      renderAttached(stripList, uid, shown, { editable: !why, at, onRemove: async d => {
        const result = await ctx.report.drawing(uid, { removeDrawing: d.id });
        if (result.status !== 'applied') ctx.toast(result.reason || '그림을 빼지 못했습니다', 'err');
        void refreshStrip();
      } });
    }

    const openFromButton = event => { event.preventDefault(); void open(ctx.selectedUid()); };
    button?.addEventListener('click', openFromButton);
    sync();
    // After the list is drawn: read the strip again when the study changed or its draft or version moved (a discard, Clear,
    // commit or reset, here or in another window), not on every redraw.
    const offRender = ctx.onRender(() => { sync(); if (ctx.selectedUid() !== stripUid || markOf(stripUid) !== stripMark) void refreshStrip(); });
    const offSelect = ctx.onSelect(() => { sync(); void refreshStrip(); });
    // The editor drew this study's report again (a discard, Clear, commit or reset changed what the draft holds): read again.
    const offReport = ctx.onReport ? ctx.onReport(uid => { if (uid === ctx.selectedUid()) void refreshStrip(); }) : () => {};
    // The person ended that study's draft (Discard Draft, Clear): the marks not yet attached go with it.
    const offDraftEnd = ctx.onDraftEnd ? ctx.onDraftEnd(uid => { memory.drop(owner(), uid); if (session?.uid === uid) { session.marks = createMarks(); paint(); } }) : () => {};
    const end = () => {
      memory.clear();
      for (const url of pictures.values()) URL.revokeObjectURL(url);
      pictures.clear(); frames.clear();
      session = null;
    };
    const offEnd = ctx.onEnd(() => { if (dialog.open) dialog.close(); end(); });

    return () => {
      offRender(); offSelect(); offReport(); offDraftEnd(); offEnd();
      button?.removeEventListener('click', openFromButton);
      if (dialog.open) dialog.close();
      end();
      dialog.remove(); strip.remove(); style.remove();
    };
  }

  (root.KinWorklistAddOns ||= []).push(Object.assign(install, { addOnName: 'Image Report' }));
})(typeof window === 'object' ? window : null);

/*
 * Film / DICOM Print (worklist add-on): print one film of a series of the selected study to a DICOM film printer, or
 * send the same film as one print layout image to a DICOM device. Entry points: `Film / DICOM Print` in the report's
 * More menu (Print and History, after Print) and `Film Print` on the Technician button bar (after Attach Document).
 * Both open the Print Images window for the study selected when it was opened; that study is fixed for the window.
 *
 * The window: Series, Format, Film size, Orientation, Copies, Destination (Film printer / DICOM device (send print
 * layout)) with the registered printers or devices, the film layout preview and the result line. The preview shows the
 * film exactly as it will be printed: the server decides the cells (POST /api/film-print/layout) and each cell's image
 * is the same Orthanc rendering the printer gets (the image header's window, the cell's size), drawn grey as printed. A
 * print names the cells it showed; if the series changed since, the server refuses it and the preview is drawn again. More images than cells
 * make more films: "Film 1 of n" with ◀ ▶; one Print prints the film shown.
 *
 * The result line shows only what the printer or device answered (GET /api/film-print/jobs/:id): Sending, Sent,
 * Printed / No answer - result unknown / Stored on the device / Failed. Changing the destination or closing the window
 * stops showing the job it was showing. A print whose answer was lost is asked again with the same request id, so the
 * server does not print it twice. Format, film size, orientation, destination and the chosen printer or device are
 * kept for the next window in this browser.
 */
(function () {
  'use strict';
  const LAST = 'kin.filmPrint.last';
  const FORMATS = [['1x1', '1 × 1'], ['1x2', '1 × 2'], ['2x2', '2 × 2'], ['3x4', '3 × 4'], ['4x5', '4 × 5']];
  const SIZES = [['14INX17IN', '14 × 17 in'], ['11INX14IN', '11 × 14 in'], ['10INX12IN', '10 × 12 in'], ['8INX10IN', '8 × 10 in']];
  const ORIENTATIONS = [['PORTRAIT', 'Portrait'], ['LANDSCAPE', 'Landscape']];
  const OPEN = new Set(['sending', 'sent']);
  const POLL_MS = 700;

  function install(ctx) {
    const $ = selector => document.querySelector(selector);
    const node = (tag, props = {}, ...children) => {
      const el = Object.assign(document.createElement(tag), props);
      for (const child of children) if (child != null) el.append(child);
      return el;
    };
    const option = ([value, label]) => node('option', { value, textContent: label });

    // ── nodes ──
    const style = node('style', { textContent: `
      #film-print { width: min(900px, 96vw); max-height: 94vh; overflow: auto; color: #d7dce4; background: #1b2029; border: 1px solid #3a4356; border-radius: 6px; padding: 14px 16px; }
      #film-print::backdrop { background: rgba(0, 0, 0, .45); }
      #film-print h2 { font-size: 15px; margin: 0 0 4px; }
      #film-print .fp-study { font-size: 12px; color: #aab2c0; margin: 0 0 10px; }
      #film-print .fp-cols { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
      #film-print .fp-form { flex: 1 1 320px; display: grid; gap: 8px; font-size: 12px; }
      #film-print fieldset { border: 1px solid #3a4356; padding: 6px 8px; display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; }
      #film-print select, #film-print input[type=number] { background: #11151c; color: #d7dce4; border: 1px solid #3a4356; }
      #film-print .fp-preview { flex: 0 0 auto; display: grid; gap: 4px; justify-items: center; font-size: 12px; }
      #film-print .fp-film { display: grid; gap: 3px; background: #000; border: 1px solid #3a4356; padding: 4px; box-sizing: border-box; }
      #film-print .fp-cell { background: #0b0d11; display: flex; align-items: center; justify-content: center; overflow: hidden; min-width: 0; min-height: 0; }
      #film-print .fp-cell canvas { max-width: 100%; max-height: 100%; }
      #film-print .fp-nav { display: flex; gap: 6px; align-items: center; }
      #film-print .fp-note { color: #aab2c0; margin: 0; }
      #film-print .fp-steps { margin: 4px 0 0; padding-left: 18px; min-height: 1.2em; }
      #film-print .fp-steps .ok { color: #8bd49c; } #film-print .fp-steps .warn { color: #ffcf70; } #film-print .fp-steps .err { color: #ff8a80; }
      #film-print button { background: #232936; border: 1px solid #3a4356; color: #d7dce4; padding: 3px 10px; border-radius: 3px; cursor: pointer; font-size: 12px; }
      #film-print button.primary { background: #2d5a8a; border-color: #4b7fb5; }
      #film-print button:disabled { opacity: .4; cursor: default; }
      #film-print .fp-actions { display: flex; gap: 6px; justify-content: flex-end; margin-top: 10px; }` });
    const dialog = node('dialog', { id: 'film-print' });
    dialog.setAttribute('aria-labelledby', 'film-print-title');
    const title = node('h2', { id: 'film-print-title', textContent: 'Print Images' });
    const head = node('p', { className: 'fp-study' });
    const series = node('select', { id: 'film-print-series' });
    const format = node('select', { id: 'film-print-format' }, ...FORMATS.map(option));
    const size = node('select', { id: 'film-print-size' }, ...SIZES.map(option));
    const orientation = node('select', { id: 'film-print-orientation' }, ...ORIENTATIONS.map(option));
    const copies = node('input', { id: 'film-print-copies', type: 'number', min: 1, max: 5, step: 1, value: 1 });
    copies.style.width = '50px';
    const toPrinter = node('input', { id: 'film-print-to-printer', type: 'radio', name: 'film-print-destination', value: 'printer', checked: true });
    const toDevice = node('input', { id: 'film-print-to-device', type: 'radio', name: 'film-print-destination', value: 'device' });
    const target = node('select', { id: 'film-print-target' });
    target.setAttribute('aria-label', 'Printer or device');
    const film = node('div', { className: 'fp-film', id: 'film-print-film' });
    film.setAttribute('role', 'img');
    const prev = node('button', { type: 'button', textContent: '◀', title: 'Previous film' });
    const next = node('button', { type: 'button', textContent: '▶', title: 'Next film' });
    const filmOf = node('span', { id: 'film-print-film-of' });
    const steps = node('ol', { className: 'fp-steps', id: 'film-print-status' });
    steps.setAttribute('role', 'status');
    steps.setAttribute('aria-live', 'polite');
    const go = node('button', { type: 'button', id: 'film-print-go', className: 'primary', textContent: 'Print' });
    const close = node('button', { type: 'button', id: 'film-print-close', textContent: 'Close' });
    const label = (text, control) => node('label', {}, text + ' ', control);
    dialog.append(title, head, node('div', { className: 'fp-cols' },
      node('div', { className: 'fp-form' },
        node('p', { className: 'fp-note', textContent: 'Print to a film printer (DICOM Print), or send the print layout to a DICOM device. This is separate from browser printing to paper or PDF.' }),
        node('fieldset', {}, node('legend', { textContent: 'Images' }), label('Series', series)),
        node('fieldset', {}, node('legend', { textContent: 'Layout' }), label('Format', format), label('Film size', size),
          label('Orientation', orientation), label('Copies', copies)),
        node('fieldset', {}, node('legend', { textContent: 'Destination' }), node('label', {}, toPrinter, ' Film printer'),
          node('label', {}, toDevice, ' DICOM device (send print layout)'), node('div', {}, target)),
        node('div', {}, node('strong', { textContent: 'Result' }), steps),
        node('p', { className: 'fp-note', textContent: 'Sent and Printed are shown separately. If the printer does not answer, the result is unknown: check the printer before printing again.' })),
      node('div', { className: 'fp-preview' }, film, node('div', { className: 'fp-nav' }, prev, filmOf, next),
        node('p', { className: 'fp-note', textContent: 'Window: from the image header (may differ from the viewer).' }))),
    node('div', { className: 'fp-actions' }, go, close));
    document.head.append(style);
    document.body.append(dialog);

    // ── state ──
    let session = null;   // { uid, seq, destinations, layout, film } of the open window
    let seq = 0;          // every window, layout read and print gets a new number; late answers compare against it
    let watching = null;  // { seq, id, kind, name, timer } of the job the result line shows
    const can = () => ['radiologist', 'technician', 'admin'].some(role => ctx.has(role)) && !ctx.session()?.demo;
    const doc = () => ctx.work('document');
    const kind = () => toDevice.checked ? 'device' : 'printer';

    function remembered() { try { return JSON.parse(localStorage.getItem(LAST) || '{}') || {}; } catch (_) { return {}; } }
    function remember() {
      try {
        const last = remembered();
        last.format = format.value; last.filmSize = size.value; last.orientation = orientation.value; last.kind = kind();
        if (target.value) last[kind()] = target.value;
        localStorage.setItem(LAST, JSON.stringify(last));
      } catch (_) { /* storage off: the next window starts with the defaults */ }
    }

    const radiologyButton = $('#b-film-print'), techButton = $('#t-film-print');
    function sync() {
      if (techButton) techButton.hidden = !can();
      if (radiologyButton) radiologyButton.disabled = !can();
    }
    const openFromMenu = event => { event.preventDefault(); const more = $('#report-more'); if (more) more.open = false; open(ctx.selectedUid()); };
    const openFromBar = event => { event.preventDefault(); open(ctx.selectedUid()); };
    radiologyButton?.addEventListener('click', openFromMenu);
    techButton?.addEventListener('click', openFromBar);
    sync();
    const offRender = ctx.onRender(sync);

    // ── the window ──
    async function open(uid) {
      if (!can()) return;
      if (!ctx.allowed()) { ctx.toast('서버에 연결된 계정에서만 필름 인쇄를 할 수 있습니다.', 'err'); return; }
      if (!uid) { ctx.toast('인쇄할 검사를 먼저 고르세요.', 'err'); return; }
      stopWatching();
      const mine = ++seq;
      session = { uid, seq: mine, destinations: { printers: [], devices: [] }, layout: null, film: 1 };
      const s = ctx.study(uid) || {};
      head.textContent = [s.name, s.id, s.date, s.modality, s.desc].filter(v => v != null && String(v).trim() !== '').join(' · ');
      head.dataset.uid = uid;
      const last = remembered();
      format.value = FORMATS.some(([v]) => v === last.format) ? last.format : '2x2';
      size.value = SIZES.some(([v]) => v === last.filmSize) ? last.filmSize : '14INX17IN';
      orientation.value = ORIENTATIONS.some(([v]) => v === last.orientation) ? last.orientation : 'PORTRAIT';
      copies.value = 1;
      (last.kind === 'device' ? toDevice : toPrinter).checked = true;
      series.replaceChildren();
      target.replaceChildren();
      steps.replaceChildren();
      paintFilm();
      label_();
      if (!dialog.open) dialog.showModal();
      try {
        const destinations = await ctx.api('GET', '/film-print/destinations', undefined, undefined, doc());
        if (!current(mine)) return;
        session.destinations = { printers: Array.isArray(destinations?.printers) ? destinations.printers : [],
          devices: Array.isArray(destinations?.devices) ? destinations.devices : [] };
        paintTargets(last);
      } catch (error) {
        if (current(mine)) say([['err', 'Failed — ' + reason(error, '프린터 목록을 불러오지 못했습니다')]]);
      }
      await loadLayout(1, true);
    }

    function current(mine) { return !!session && session.seq === mine && dialog.open; }

    function paintTargets(last = remembered()) {
      const list = kind() === 'device' ? session.destinations.devices : session.destinations.printers;
      target.replaceChildren(...list.map(p => node('option', { value: p.id, textContent: `${p.name} · AE ${p.aet}` })));
      if (!list.length) target.append(node('option', { value: '', textContent: kind() === 'device' ? 'No DICOM device is registered' : 'No film printer is registered' }));
      const keep = last[kind()];
      if (list.some(p => p.id === keep)) target.value = keep;
      const before = size.value;
      fitSizes();
      if (size.value !== before && session.layout) void loadLayout(1);
      label_();
    }

    /** A printer registered for some film sizes only offers those. */
    function fitSizes() {
      const printer = kind() === 'printer' ? session?.destinations.printers.find(p => p.id === target.value) : null;
      const allowed = printer && Array.isArray(printer.filmSizes) ? new Set(printer.filmSizes) : null;
      for (const o of size.options) o.disabled = !!allowed && !allowed.has(o.value);
      if (size.selectedOptions[0]?.disabled) size.value = [...size.options].find(o => !o.disabled)?.value ?? size.value;
    }

    function label_() {
      go.textContent = kind() === 'device' ? 'Send' : 'Print';
      const ready = !!session?.layout && !!target.value && !(watching && OPEN.has(watching.state));
      go.disabled = !ready;
    }

    async function loadLayout(filmNumber, firstSeries = false) {
      if (!session) return;
      const mine = ++seq;
      session.seq = mine;
      session.layout = null;
      label_();
      try {
        const body = { studyUid: session.uid, format: format.value, filmSize: size.value, orientation: orientation.value, film: filmNumber,
          ...(firstSeries || !series.value ? {} : { seriesUid: series.value }) };
        const layout = await ctx.api('POST', '/film-print/layout', body, undefined, doc());
        if (!current(mine)) return;
        session.layout = layout;
        session.film = layout.film;
        if (firstSeries || series.options.length !== layout.series.length) {
          series.replaceChildren(...layout.series.map(s => node('option', { value: s.uid,
            textContent: [s.number != null ? `#${s.number}` : '', s.modality, s.description, `${s.images} image${s.images === 1 ? '' : 's'}`].filter(Boolean).join(' · ') })));
        }
        series.value = layout.seriesUid;
        paintFilm();
        label_();
      } catch (error) {
        if (!current(mine)) return;
        paintFilm();
        say([['err', 'Failed — ' + reason(error, '필름 배치를 만들지 못했습니다')]]);
      }
    }

    /** The film preview: Format's grid, each cell with its image as the printer will get it; empty cells stay empty. */
    function paintFilm() {
      const [columns, rows] = format.value.split('x').map(Number);
      const landscape = orientation.value === 'LANDSCAPE';
      const [w, h] = size.value.match(/\d+/g).map(Number);
      const boxH = 360;
      film.style.width = Math.round(boxH * (landscape ? h / w : w / h)) + 'px';
      film.style.height = boxH + 'px';
      film.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
      film.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
      const layout = session?.layout, cells = new Map((layout?.cells ?? []).map(c => [c.position, c]));
      film.replaceChildren();
      for (let position = 1; position <= columns * rows; position++) {
        const box = node('div', { className: 'fp-cell' });
        box.dataset.position = String(position);
        const cell = cells.get(position);
        if (cell) { box.dataset.sop = cell.sop; box.dataset.frame = String(cell.frame); void picture(box, cell.src, session.seq); }
        film.append(box);
      }
      film.setAttribute('aria-label', `Film layout ${columns} × ${rows}`);
      const films = layout?.films ?? 1, at = layout?.film ?? 1;
      filmOf.textContent = layout ? `Film ${at} of ${films}` : '';
      prev.disabled = !layout || at <= 1;
      next.disabled = !layout || at >= films;
    }

    /**
     * One cell's image: the rendering the printer gets, turned grey with the print's own weights (BT.601, as the server
     * does for the film), so a colour image is previewed as it will be printed.
     */
    async function picture(box, src, mine) {
      try {
        const response = await window.KinSessionTransport.page().request(src, { context: doc(), read: 'response',
          headers: { Accept: 'image/png' }, credentials: 'same-origin', cache: 'no-store' });
        if (!current(mine) || !response.ok) { await response.body?.cancel?.(); return; }
        const bitmap = await createImageBitmap(await response.blob());
        if (!current(mine)) { bitmap.close(); return; }
        const canvas = node('canvas', { width: bitmap.width, height: bitmap.height });
        const g = canvas.getContext('2d', { willReadFrequently: true });
        g.drawImage(bitmap, 0, 0);
        bitmap.close();
        const image = g.getImageData(0, 0, canvas.width, canvas.height), d = image.data;
        for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114 + 500) / 1000 | 0;
        g.putImageData(image, 0, 0);
        box.append(canvas);
      } catch (_) { /* the cell stays dark; the print reads its image again */ }
    }

    // ── the result line ──
    function say(lines) {
      steps.replaceChildren(...lines.map(([cls, text]) => node('li', { className: cls, textContent: text })));
    }

    function stopWatching() {
      if (watching) clearTimeout(watching.timer);
      watching = null;
    }

    function describe(job, where) {
      const device = job.destination?.kind === 'device';
      const name = job.destination?.name || where;
      const lines = [];
      for (const event of job.events ?? []) {
        if (event.state === 'sending') lines.push(['', `Sending — film ${job.film} of ${job.films} to ${name}`]);
        else if (event.state === 'sent') lines.push(['', device ? 'Sent — the print layout went out to the device' : 'Sent — the printer took the film']);
        else if (event.state === 'printed') lines.push(['ok', `Printed — the printer reported ${job.copies > 1 ? job.copies + ' copies' : 'the film'} done`]);
        else if (event.state === 'sent-unreported') lines.push(['warn', 'Sent — this printer does not report completion. Check the film at the printer.']);
        else if (event.state === 'stored') lines.push(['ok', 'Stored on the device (the device confirmed it). The original images are unchanged.']);
        else if (event.state === 'no-answer') lines.push(['warn', device
          ? 'No answer — result unknown. Check the device before sending again.'
          : 'No answer — result unknown. Check the film at the printer before printing again.']);
        else if (event.state === 'failed') lines.push(['err', `Failed — ${job.reason || 'no reason was given'}`]);
      }
      for (const warning of job.warnings ?? []) lines.push(['warn', `${device ? 'Device' : 'Printer'} warning: ${warning}`]);
      return lines;
    }

    async function watch(mine, id, where) {
      if (!watching || watching.seq !== mine || !dialog.open) return;
      try {
        const { job } = await ctx.api('GET', '/film-print/jobs/' + encodeURIComponent(id), undefined, undefined, doc());
        if (!watching || watching.seq !== mine || !dialog.open) return;
        watching.state = job.state;
        say(describe(job, where));
        label_();
        if (OPEN.has(job.state)) watching.timer = setTimeout(() => void watch(mine, id, where), POLL_MS);
      } catch (error) {
        if (!watching || watching.seq !== mine) return;
        watching.timer = setTimeout(() => void watch(mine, id, where), POLL_MS * 3);
      }
    }

    /** A lost answer (no answer, or the server could not answer) is asked again with the same request id. */
    const lost = error => error?.name !== 'AbortError' && !(error?.status >= 400 && error.status < 500) && !error?.auth;

    async function print() {
      if (!session?.layout || !target.value) return;
      remember();
      stopWatching();
      const mine = ++seq;
      const where = target.selectedOptions[0]?.textContent || '';
      watching = { seq: mine, id: null, state: 'sending', timer: null };
      label_();
      const n = Math.min(5, Math.max(1, Math.round(Number(copies.value) || 1)));
      copies.value = n;
      const body = { requestId: crypto.randomUUID(), studyUid: session.uid, seriesUid: session.layout.seriesUid, format: format.value,
        filmSize: size.value, orientation: orientation.value, film: session.layout.film, copies: n, plan: session.layout.plan,
        destination: { kind: kind(), peerId: target.value } };
      say([['', `Sending — film ${body.film} of ${session.layout.films} to ${where}`]]);
      for (let attempt = 1; ; attempt++) {
        try {
          const { job } = await ctx.api('POST', '/film-print/jobs', body, undefined, doc());
          if (!watching || watching.seq !== mine) return;
          watching.id = job.id;
          watching.state = job.state;
          say(describe(job, where));
          label_();
          if (OPEN.has(job.state)) watching.timer = setTimeout(() => void watch(mine, job.id, where), POLL_MS);
          return;
        } catch (error) {
          if (!watching || watching.seq !== mine) return;
          if (lost(error) && attempt < 3) { await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); continue; }
          watching.state = 'ended';
          // The series changed since the preview: nothing was printed; the preview is drawn again from the server.
          if (error?.code === 'FILM_PLAN_CHANGED' && session) void loadLayout(body.film);
          say(lost(error)
            ? [['warn', 'No answer — result unknown. The server did not answer; check the printer before printing again.']]
            : [['err', 'Failed — ' + reason(error, '인쇄를 보내지 못했습니다')]]);
          label_();
          return;
        }
      }
    }

    function reason(error, fallback) {
      return typeof error?.body?.message === 'string' && error.status >= 400 && error.status < 500 ? error.body.message : fallback;
    }

    function end() {
      stopWatching();
      session = null;
      seq++;
    }

    // ── controls ──
    const relayout = () => { remember(); void loadLayout(1); };
    format.addEventListener('change', relayout);
    size.addEventListener('change', relayout);
    orientation.addEventListener('change', relayout);
    series.addEventListener('change', () => void loadLayout(1));
    for (const radio of [toPrinter, toDevice]) radio.addEventListener('change', () => {
      // The job shown belongs to the other destination: it is no longer shown.
      stopWatching();
      steps.replaceChildren();
      paintTargets();
      remember();
    });
    target.addEventListener('change', () => {
      stopWatching();
      steps.replaceChildren();
      const before = size.value;
      fitSizes();
      remember();
      if (size.value !== before) void loadLayout(1); else label_();
    });
    prev.addEventListener('click', () => { if (session?.layout) void loadLayout(session.layout.film - 1); });
    next.addEventListener('click', () => { if (session?.layout) void loadLayout(session.layout.film + 1); });
    go.addEventListener('click', () => void print());
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => end());
    const offEnd = ctx.onEnd(() => { if (dialog.open) dialog.close(); end(); });

    return () => {
      offRender(); offEnd();
      radiologyButton?.removeEventListener('click', openFromMenu);
      techButton?.removeEventListener('click', openFromBar);
      if (dialog.open) dialog.close();
      end();
      dialog.remove();
      style.remove();
    };
  }

  (window.KinWorklistAddOns ||= []).push(Object.assign(install, { addOnName: 'Film / DICOM Print' }));
})();

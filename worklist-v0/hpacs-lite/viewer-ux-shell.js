window.KinViewerUXShell = (() => {
  function mount({ services }) {
    const css = document.createElement('link'); css.rel = 'stylesheet';
    css.href = '/worklist/hpacs-lite/viewer-ux-theme.css'; document.head.append(css);
    document.body.classList.add('kin-viewer-ux');
    const tabs = window.KinViewerPatientTabs;
    let actions = null, reportContext = null;
    const report = document.createElement('section'); report.hidden = true; report.className = 'kin-viewer-prior-report';
    report.dataset.kinUxOwned = ''; report.setAttribute('role', 'region'); report.setAttribute('aria-label', 'Previous Report');
    const closeReport = () => { report.hidden = true; reportContext = null; report.replaceChildren(); };
    const context = viewportId => {
      const patient = tabs.snapshot(), cell = window.KinViewerInfoBar.identity(services, viewportId);
      return patient && cell.instance ? { patientKey: patient.key, sequence: patient.sequence, viewportId,
        studyUid: cell.instance.StudyInstanceUID, seriesUid: cell.instance.SeriesInstanceUID,
        mode: cell.viewport.type } : null;
    };
    const admits = value => {
      const now = value && context(value.viewportId);
      return !!now && ['patientKey', 'sequence', 'viewportId', 'studyUid', 'seriesUid', 'mode'].every(key => now[key] === value[key]);
    };
    const seam = {
      snapshot: tabs.snapshot, subscribe: tabs.subscribe, viewport: context,
      registerStudyActions(value) {
        actions = value; info.refresh();
        return () => { if (actions === value) { actions = null; closeReport(); info.refresh(); } };
      },
      async assign(value, displaySetInstanceUIDs) {
        if (!admits(value) || !tabs.guard()) return false;
        const sets = displaySetInstanceUIDs.map(id => services.displaySetService.getDisplaySetByUID(id));
        if (sets.some(set => !set)) return false;
        const response = await fetch('/api/studies', { credentials: 'same-origin' });
        if (!response.ok) return false;
        const data = await response.json();
        if (!admits(value) || !tabs.guard(true) || sets.some(set =>
          data.studies?.find(study => study.uid === set.StudyInstanceUID)?.sourcePatientKey !== value.patientKey)) return false;
        services.viewportGridService.setDisplaySetsForViewport({ viewportId: value.viewportId, displaySetInstanceUIDs });
        return true;
      },
      comparisonTarget(value) {
        if (!admits(value)) return null;
        const state = services.viewportGridService.getState();
        return { layout: { ...state.layout }, viewportId: [...state.viewports.values()]
          .find(cell => cell.viewportId !== value.viewportId && !cell.displaySetInstanceUIDs?.length)?.viewportId || null };
      },
      reportHost: {
        close: closeReport,
        show(value, body) {
          if (!admits(value)) return false;
          closeReport();
          const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close'; close.onclick = closeReport;
          report.append(close);
          for (const [title, content] of [['Previous Report', body.title], ['Findings', body.findings], ['Impression', body.impression]]) {
            const heading = document.createElement('h3'); heading.textContent = title;
            const paragraph = document.createElement('p'); paragraph.textContent = String(content ?? ''); report.append(heading, paragraph);
          }
          const pane = services.cornerstoneViewportService.getCornerstoneViewport(value.viewportId)?.element?.closest('[data-cy="viewport-pane"]');
          if (!pane) return false;
          pane.append(report); reportContext = value; report.hidden = false; return true;
        },
      },
    };
    window.KinViewerUX = seam;
    const stopPatient = tabs.subscribe(closeReport);
    const info = window.KinViewerInfoBar.mount({ services, studyActions: {
      available: () => typeof actions?.listPriors === 'function',
      open(viewportId, anchor) { const value = context(viewportId); if (value) actions?.listPriors({ ...value, anchor, openImages: actions.openImages, openReport: actions.openReport }); },
    } });
    const series = window.KinViewerSeriesStrip.mount({ services });
    tabs.mount({ services, refreshChrome() { info.refresh(); series.refresh(); } });
    const subscriptions = [];
    let frame, ended = false, fit = null;
    // The shell changes the canvas area from inside the pane (info bar) and
    // above the grid (strip, toolbar, late stylesheet) after the stock grid
    // measured it; the stock observer watches the grid, not the pane's canvas
    // container, so the backing store kept a stale size (stretched pixels,
    // wrong pointer mapping, a saved camera that restores elsewhere).
    // Only a canvas whose backing store no longer matches its box is re-fitted:
    // a stock resize resets and restores every camera, and a redundant one
    // after a grid change let the MPR crosshairs move the linked planes' focal
    // points by rounding (cell merge restore, planes the user never touched).
    const misfit = () => [...document.querySelectorAll('[data-cy="viewport-pane"] canvas.cornerstone-canvas')].some(canvas =>
      canvas.clientWidth > 0 && canvas.clientHeight > 0 && (canvas.width !== Math.floor(canvas.clientWidth * devicePixelRatio) ||
        canvas.height !== Math.floor(canvas.clientHeight * devicePixelRatio)));
    const fitter = new ResizeObserver(() => { if (ended || fit) return; fit = requestAnimationFrame(() => {
      fit = null; if (!ended && misfit()) services.cornerstoneViewportService.resize(true);
    }); });
    function refresh() { frame = null; if (!ended) {
      if (reportContext && !admits(reportContext)) closeReport();
      info.refresh(); series.refresh(); tabs.refresh();
      for (const container of document.querySelectorAll('[data-cy="viewport-pane"] > .relative')) fitter.observe(container);
    } }
    function schedule() { if (!ended && !frame) frame = requestAnimationFrame(refresh); }
    for (const service of [services.viewportGridService, services.displaySetService, services.cornerstoneViewportService]) {
      for (const event of Object.values(service.EVENTS || {})) subscriptions.push(service.subscribe(event, () => {
        // Grid replacement is announced before the new canvas paints. Drop
        // clinical headings synchronously, then adopt only rendered identity.
        if (service === services.viewportGridService && event !== service.EVENTS.ACTIVE_VIEWPORT_ID_CHANGED) info.invalidate();
        schedule();
      }));
    }
    const events = window.cornerstone.Enums.Events;
    const imageEvents = [events.PRE_STACK_NEW_IMAGE, events.STACK_NEW_IMAGE, events.IMAGE_RENDERED, events.ELEMENT_ENABLED, events.ELEMENT_DISABLED].filter(Boolean);
    imageEvents.forEach(event => document.addEventListener(event, schedule, true));
    const observer = new MutationObserver(records => {
      if (ended || !records.some(record => !record.target.closest?.('[data-kin-ux-owned]'))) return;
      // A pane gets its bar in this same microtask, before the stock passive
      // effect enables the element, so the canvas is created at the size it
      // keeps and needs no re-fit. A pane whose element already exists is
      // re-fitted at once: left to the next frame, a Job or tab restore could
      // apply its camera to the unfitted canvas first, and the later fit
      // re-derives that camera from the pan in pixels, reopening the saved
      // screen a bar's height away.
      if (info.adopt() && misfit()) services.cornerstoneViewportService.resize(true);
      schedule();
    });
    observer.observe(document.getElementById('root'), { childList: true, subtree: true });
    schedule();
    return { dispose() {
      ended = true; cancelAnimationFrame(frame); cancelAnimationFrame(fit); fitter.disconnect(); observer.disconnect();
      subscriptions.forEach(subscription => subscription.unsubscribe());
      imageEvents.forEach(event => document.removeEventListener(event, schedule, true));
      stopPatient(); report.remove(); if (window.KinViewerUX === seam) delete window.KinViewerUX;
      tabs.dispose(); info.dispose(); series.dispose(); css.remove(); document.body.classList.remove('kin-viewer-ux');
    } };
  }
  return { mount };
})();

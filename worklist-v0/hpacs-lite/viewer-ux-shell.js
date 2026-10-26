window.KinViewerUXShell = (() => {
  function mount({ services, session }) {
    // The theme stylesheet is loaded once per document by the extension before
    // this mount; the body class scopes its viewer-wide rules to the mounted shell.
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
        const url = new URL('/ohif/viewer', location.origin);
        url.searchParams.set('StudyInstanceUIDs', [...new Set(sets.map(set => set.StudyInstanceUID))].join(','));
        let patient;
        try { patient = await tabs.resolve(url.href); } catch (_) { return false; }
        if (!admits(value) || !tabs.guard(true) || patient.key !== value.patientKey) return false;
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
    tabs.mount({ services, session, refreshChrome() { info.refresh(); series.refresh(); } });
    const subscriptions = [];
    let frame, ended = false;
    // The shell never resizes the rendering engine. The stock viewport observer
    // queues its own resize for every pane whose element changes size and that
    // queued pass re-fits the canvas and restores each camera from its
    // presentation; a shell-driven resize(true) ran that pass synchronously at
    // moments of its own, so whether a rebuilt MPR plane's focal point carried
    // the presentation rounding depended on timing and a cell-merge restore
    // returned planes the user never touched with a camera that differed in
    // the last bit. The shell's rows and the bar take their space before the
    // stock sizes a canvas (theme padding, reserved rows), so nothing of the
    // shell's needs a re-fit of its own.
    function refresh() { frame = null; if (!ended) {
      if (reportContext && !admits(reportContext)) closeReport();
      info.refresh(); series.refresh(); tabs.refresh();
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
      // The strip and the toolbar's reserved row go above the grid in this same
      // microtask, as soon as the grid exists, and a pane gets its bar in the
      // row its padding reserves: neither changes the size of a canvas the
      // stock has already created.
      series.place(); info.adopt();
      schedule();
    });
    observer.observe(document.getElementById('root'), { childList: true, subtree: true });
    schedule();
    return { dispose() {
      ended = true; cancelAnimationFrame(frame); observer.disconnect();
      subscriptions.forEach(subscription => subscription.unsubscribe());
      imageEvents.forEach(event => document.removeEventListener(event, schedule, true));
      stopPatient(); report.remove(); if (window.KinViewerUX === seam) delete window.KinViewerUX;
      tabs.dispose(); info.dispose(); series.dispose(); document.body.classList.remove('kin-viewer-ux');
    } };
  }
  return { mount };
})();

window.KinViewerUXShell = (() => {
  // Minhoon 2026-10-27 item 4: the stock Studies and Measurement panels take image width. They open as the
  // stock mode declares until the reader opens or closes one with its own controls; that choice is then kept
  // for this account in this browser, like the window's place. Only the reader's clicks are recorded: a panel
  // the stock opens by itself is left open for that viewer only.
  function mountSidePanels(session, signal) {
    const sides = ['left', 'right'], applied = new Set();
    const key = () => { const owner = session.owner(); return owner ? 'kin-viewer-side-panels:v1:' + JSON.stringify(owner) : null; };
    const header = side => document.querySelector('[data-cy="side-panel-header-' + side + '"]');
    // The stock panel slides out by a negative margin and stays mounted as a narrow strip.
    const container = side => header(side)?.closest('[style*="margin-' + side + '"]');
    const open = side => { const box = container(side); return box ? box.style[side === 'left' ? 'marginLeft' : 'marginRight'] === '0px' : null; };
    function read() {
      try {
        const value = JSON.parse(localStorage.getItem(key()) || 'null');
        return value && typeof value === 'object' ? value : {};
      } catch (_) { return {}; }
    }
    function apply() {
      if (!key() || applied.size === sides.length) return;
      const saved = read();
      for (const side of sides) {
        const now = open(side);
        if (applied.has(side) || now === null) continue;
        applied.add(side);
        if (typeof saved[side] === 'boolean' && saved[side] !== now) header(side).click();
      }
    }
    document.addEventListener('click', event => {
      const side = sides.find(value => container(value)?.contains(event.target));
      if (!side || !event.isTrusted) return;
      const before = open(side);
      requestAnimationFrame(() => {
        const now = open(side), name = key();
        if (signal.aborted || !name || now === null || now === before) return;
        try { localStorage.setItem(name, JSON.stringify({ ...read(), [side]: now })); } catch (_) {}
      });
    }, { capture: true, signal });
    return { apply };
  }
  // A3 C-R01-027 #18/#19: the pinned OHIF 3.9.1 Studies panel already builds Primary/Recent/All tabs, but shows them
  // only as a dropdown behind its unlabeled settings icon. This row shows the same tabs over the list. Selecting one calls
  // the panel's own onClickTab, so the stock panel still filters its own list, and its dropdown, sort and list/thumbnail
  // controls stay as they are. The props are read from React 18's committed fibers. React keeps two copies of each
  // fiber and a commit makes one of them current. The element keeps the fiber it was created with, a fiber's return may
  // be a copy that is no longer current, and __reactProps$ does not follow a children-only update. So the element's
  // fiber path is followed again from the root's current fiber, whose child lists hold only committed copies. Without
  // those props the row is removed rather than left without an effect.
  function mountStudyTabs() {
    const row = document.createElement('div');
    row.className = 'kin-study-tabs'; row.dataset.kinUxOwned = '';
    row.setAttribute('role', 'tablist'); row.setAttribute('aria-label', 'Study List');
    let chosen = null, timer = 0, signature = '';
    function nativeProps(panel) {
      const key = Object.keys(panel).find(name => name.startsWith('__reactFiber$')), path = [], committed = [];
      for (let fiber = key && panel[key]; fiber; fiber = fiber.return) path.unshift(fiber);
      let node = path[0]?.stateNode?.current;
      for (let index = 1; node && index < path.length; index++) {
        let child = node.child;
        while (child && child !== path[index] && child !== path[index].alternate) child = child.sibling;
        committed.unshift(node = child);
      }
      if (!node) return null;
      for (const fiber of committed.slice(0, 4)) {
        const props = fiber.memoizedProps;
        if (props && typeof props.onClickTab === 'function' && typeof props.activeTabName === 'string' && Array.isArray(props.tabs)
          && props.tabs.every(tab => typeof tab?.name === 'string' && typeof tab.label === 'string' && Array.isArray(tab.studies))) return props;
      }
      return null;
    }
    const current = () => { const panel = document.querySelector('[data-cy="studyBrowser-panel"]'); return panel && { panel, props: nativeProps(panel) }; };
    function apply() {
      const { panel, props } = current() || {};
      if (!props) { row.remove(); return; }
      if (row.nextElementSibling !== panel) panel.before(row);
      const next = JSON.stringify(props.tabs.map(tab => [tab.name, tab.label]));
      if (next !== signature) {
        signature = next;
        row.replaceChildren(...props.tabs.map(tab => {
          const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'tab');
          button.dataset.tab = tab.name; button.textContent = tab.label;
          button.onclick = () => {
            const now = current()?.props;
            if (!now?.tabs.some(value => value.name === tab.name && value.studies.length)) return;
            now.onClickTab(tab.name);
            // The stock panel commits the choice in a later task; until then the row shows what was chosen.
            chosen = tab.name; clearTimeout(timer); timer = setTimeout(() => { chosen = null; apply(); }, 300); apply();
          };
          return button;
        }));
      }
      const active = chosen ?? props.activeTabName;
      for (const button of row.children) {
        const tab = props.tabs.find(value => value.name === button.dataset.tab);
        button.setAttribute('aria-selected', String(tab.name === active));
        button.disabled = !tab.studies.length;
      }
    }
    return { apply, dispose() { clearTimeout(timer); row.remove(); } };
  }
  function mount({ services, session }) {
    // The theme stylesheet is loaded once per document by the extension before
    // this mount; the body class scopes its viewer-wide rules to the mounted shell.
    document.body.classList.add('kin-viewer-ux');
    const tabs = window.KinViewerPatientTabs;
    let actions = null, reportContext = null, reportLifecycle = null;
    const report = document.createElement('section'); report.hidden = true; report.className = 'kin-viewer-prior-report';
    report.dataset.kinUxOwned = ''; report.setAttribute('role', 'region'); report.setAttribute('aria-label', 'Previous Report');
    const closeReport = options => {
      const { restoreFocus = false, notify = true } = options || {};
      const previous = reportLifecycle; reportLifecycle = null;
      report.hidden = true; reportContext = null; report.replaceChildren();
      if (notify) previous?.onClose?.();
      if (restoreFocus && previous?.opener?.isConnected) previous.opener.focus();
    };
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
      async compare(value, displaySetInstanceUIDs, { signal, studies } = {}) {
        if (!admits(value) || !tabs.guard() || signal?.aborted) return false;
        const grid = services.viewportGridService;
        const signature = () => JSON.stringify([...grid.getState().viewports.values()].map(cell =>
          [cell.viewportId, cell.displaySetInstanceUIDs, cell.x, cell.y, cell.width, cell.height]));
        const before = signature(), sets = displaySetInstanceUIDs.map(id => services.displaySetService.getDisplaySetByUID(id));
        if (!sets.length || sets.some(set => !set)) return false;
        // The prior controller already read these rows for this patient/sequence.
        // Direct seam callers still resolve just the affected studies.
        if (!studies) {
          const uids = [...new Set([value.studyUid, ...sets.map(set => set.StudyInstanceUID)])].join(',');
          const endpoint = session.readOnly() ? '/api/clinician/studies' : '/api/studies';
          const response = await fetch(endpoint + '?uids=' + encodeURIComponent(uids), { credentials: 'same-origin', signal });
          if (window.KinSessionTransport.refusal(response)) throw window.KinSessionTransport.responseError(response);
          if (!response.ok) return false;
          studies = (await response.json()).studies;
        }
        if (signal?.aborted || !admits(value) || before !== signature() || !tabs.guard(true) || sets.some(set =>
          studies?.find(study => study.uid === set.StudyInstanceUID)?.sourcePatientKey !== value.patientKey)) return false;
        const preference = window.kinViewerHangingPreference?.(sets[0].Modality) || window.KinViewerHangingSettings.defaults;
        const currentUid = tabs.snapshot().studyUIDs[0], cells = [...grid.getState().viewports.values()];
        if (sets.every(set => set.StudyInstanceUID === value.studyUid)) return true;
        // A prior cell is replaceable. From the current cell, preserve every
        // current image and reuse an assigned comparison or an empty cell.
        const originCell = cells.find(cell => cell.viewportId === value.viewportId);
        const onPriorSide = cell => preference.priorPosition === 'left' ? cell.x < originCell.x : preference.priorPosition === 'top' ? cell.y < originCell.y : preference.priorPosition === 'bottom' ? cell.y > originCell.y : cell.x > originCell.x;
        let target = value.studyUid !== currentUid ? value.viewportId : cells.find(cell => {
          const rendered = context(cell.viewportId);
          return rendered && rendered.studyUid !== currentUid;
        })?.viewportId || cells.find(cell => cell.viewportId !== value.viewportId && !cell.displaySetInstanceUIDs?.length && onPriorSide(cell))?.viewportId;
        if (target) {
          grid.setDisplaySetsForViewport({ viewportId: target, displaySetInstanceUIDs,
            viewportOptions: { viewportType: 'stack', toolGroupId: 'default', allowUnmatchedView: true } });
        } else {
          // With no comparison or vacant cell, the guarded comparison layout
          // keeps the originating current image beside the requested prior.
          if (value.mode !== 'stack') return false;
          target = 'kin-prior-' + crypto.randomUUID();
          const current = cells.find(cell => cell.viewportId === value.viewportId);
          const layout = window.KinViewerHangingSettings.dimensions(preference, true);
          const priorIndex = layout.priorFirst ? 0 : layout.vertical ? layout.columns : 1;
          const currentIndex = layout.priorFirst ? layout.vertical ? layout.columns : 1 : 0;
          grid.setLayout({ numRows: layout.rows, numCols: layout.columns, activeViewportId: value.viewportId, isHangingProtocolLayout: false,
            findOrCreateViewport: index => index === currentIndex ? current : ({ displaySetInstanceUIDs: index === priorIndex ? displaySetInstanceUIDs : [], displaySetOptions: [{}],
              viewportOptions: { viewportId: index === priorIndex ? target : 'kin-prior-' + crypto.randomUUID(), viewportType: 'stack', toolGroupId: 'default', allowUnmatchedView: true } }) });
        }
        return true;
      },
      reportHost: {
        close: closeReport,
        render(value, renderer, lifecycle = {}) {
          if (!admits(value)) return false;
          const pane = services.cornerstoneViewportService.getCornerstoneViewport(value.viewportId)?.element?.closest('[data-cy="viewport-pane"]');
          if (!pane) return false;
          reportContext = value; reportLifecycle = lifecycle; pane.append(report);
          renderer(report, { close: () => closeReport({ restoreFocus: true }), retry: lifecycle.onRetry });
          report.hidden = false; return true;
        },
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
      hidden: () => session.readOnly(),
      available: () => !session.readOnly() && typeof actions?.listPriors === 'function',
      open(viewportId, anchor) { const value = context(viewportId); if (value) actions?.listPriors({ ...value, anchor, openImages: actions.openImages, openReport: actions.openReport }); },
    } });
    const series = window.KinViewerSeriesStrip.mount({ services });
    tabs.mount({ services, session, refreshChrome() { info.refresh(); series.refresh(); } });
    const subscriptions = [], abort = new AbortController(), panels = mountSidePanels(session, abort.signal), studies = mountStudyTabs();
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
      actions?.refresh?.();
      info.refresh(); series.refresh(); tabs.refresh(); panels.apply(); studies.apply();
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
      if (ended || !records.some(record => {
        if (record.target.closest?.('[data-kin-ux-owned]')) return false;
        // Attaching/removing shell chrome targets the stock pane or column,
        // so inspect the changed nodes as well as the mutation's parent.
        return [...record.addedNodes, ...record.removedNodes].some(node => !node.matches?.('[data-kin-ux-owned]'));
      })) return;
      // The strip and the toolbar's reserved row go above the grid in this same
      // microtask, as soon as the grid exists, and a pane gets its bar in the
      // row its padding reserves: neither changes the size of a canvas the
      // stock has already created.
      series.place(); info.adopt(); panels.apply(); studies.apply();
      schedule();
    });
    observer.observe(document.getElementById('root'), { childList: true, subtree: true });
    schedule();
    return { dispose() {
      ended = true; cancelAnimationFrame(frame); observer.disconnect(); abort.abort();
      subscriptions.forEach(subscription => subscription.unsubscribe());
      imageEvents.forEach(event => document.removeEventListener(event, schedule, true));
      stopPatient(); closeReport(); report.remove(); if (window.KinViewerUX === seam) delete window.KinViewerUX;
      tabs.dispose(); info.dispose(); series.dispose(); studies.dispose(); document.body.classList.remove('kin-viewer-ux');
    } };
  }
  return { mount };
})();

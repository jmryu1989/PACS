// The stock mode owns the grid and Cornerstone elements. This extension owns
// only its chrome and removes it when that mode or document ends.
function kinCreateViewerUX() {
  let services, dispose, toolbar, shortcuts, mouse, resize, generation = 0, ready;
  const assets = ['viewer-info-bar.js', 'viewer-series-strip.js', 'viewer-patient-tabs.js', 'viewer-ux-shortcuts.js', 'viewer-hanging-settings.js', 'viewer-ux-toolbar.js', 'viewer-ux-shell.js'];
  // The theme fixes the chrome rows' heights. It is loaded once per document,
  // before the first mount, and stays: a stylesheet attached per mount and
  // dropped on mode exit left a window on re-entry (saved Job, patient tab) in
  // which the stock grid measured unstyled rows, so a camera applied then was
  // re-fitted when the rows took their height.
  function stylesheet() {
    return new Promise((resolve, reject) => {
      const href = '/worklist/hpacs-lite/viewer-ux-theme.css';
      const existing = document.head.querySelector('link[rel="stylesheet"][href="' + href + '"]');
      if (existing?.sheet) { resolve(); return; }
      const link = existing || document.createElement('link');
      link.rel = 'stylesheet'; link.href = href;
      link.addEventListener('load', () => resolve(), { once: true });
      link.addEventListener('error', () => { link.remove(); reject(new Error('뷰어 화면 모듈을 불러오지 못했습니다.')); }, { once: true });
      if (!existing) document.head.append(link);
    });
  }
  function load() {
    return ready ||= assets.reduce((previous, name) => previous.then(() => new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/worklist/hpacs-lite/' + name;
      script.onload = () => { script.remove(); resolve(); };
      script.onerror = () => { script.remove(); reject(new Error('뷰어 화면 모듈을 불러오지 못했습니다.')); };
      document.head.append(script);
    })), stylesheet()).catch(error => { ready = null; throw error; });
  }
  function stop() { generation++; dispose?.(); dispose = null; mouse?.dispose(); mouse = null; resize?.(); resize = null; }
  return {
    id: 'kin.viewer-ux',
    async preRegistration({ servicesManager }) {
      services = servicesManager.services;
      if (window.top !== window) return;
      try { await load(); }
      catch (error) {
        // Optional chrome cannot prevent the native viewer from opening images.
        services.uiNotificationService?.show({ title: 'Viewer', message: error.message, type: 'error' });
        return;
      }
      await window.KinViewerUXToolbar.prepare(kinViewerSession);
      // Own letter keys before the first mode enters, including route teardown.
      shortcuts = window.KinViewerUXShortcuts.mount({
        getBindings: () => toolbar?.bindings() || {}, invoke: id => toolbar?.invoke(id),
        allowed: () => !kinViewerSession.ended(),
      });
      kinViewerOnEnd(() => { shortcuts?.dispose(); window.KinViewerUXToolbar.clear(); });
    },
    onModeEnter() {
      stop();
      if (!kinViewerSession.ended()) {
        mouse = kinStackMouse(services);
        resize = kinStackResize(services.cornerstoneViewportService);
      }
      if (window.top !== window || !shortcuts) return;
      const ticket = generation;
      if (kinViewerSession.ended()) return;
      try {
        const shell = window.KinViewerUXShell.mount({ services, session: kinViewerSession });
        toolbar = window.KinViewerUXToolbar.mount({ services, session: kinViewerSession });
        const channel = kinViewerOnEnd(() => { window.KinViewerPatientTabs.end(); stop(); });
        dispose = () => { channel?.close(); toolbar?.dispose(); toolbar = null; shell.dispose(); };
      } catch (error) {
        if (ticket !== generation) return;
        services.uiNotificationService?.show({ title: 'Viewer', message: error.message, type: 'error' });
      }
    },
    onModeExit: stop,
  };
}

// OHIF's resize restores a stack's current frame through setViewReference ->
// scroll. That rewinds a pending scroll's target while its debounce/load can
// still finish: the next key then selects the frame already shown, and the
// native Loading indicator never receives another STACK_NEW_IMAGE. Resizing
// restores the camera, not the slice; explicit navigation keeps its reference.
// The pinned engine's resize also assigns every canvas size, which clears the
// canvas even when the size is unchanged, and leaves the redraw to the next
// animation frame while each viewport still reports RENDERED. Drawing that
// queued frame before the resize returns keeps a capture or pixel read in a
// later task from seeing a cleared cell beside a newly dropped series.
function kinStackResize(service) {
  const resize = service.performResize, present = service.setPresentations;
  if (typeof resize !== 'function' || typeof present !== 'function') return;
  let resizing = 0;
  const resized = function (...args) {
    resizing++;
    try { return resize.apply(this, args); }
    finally { if (!--resizing) kinDrawQueuedFrame(this.renderingEngine); }
  };
  const presented = function (id, presentations, ...args) {
    if (resizing && this.getCornerstoneViewport(id)?.type === 'stack' && presentations?.positionPresentation) {
      presentations = { ...presentations,
        positionPresentation: { ...presentations.positionPresentation, viewReference: undefined } };
    }
    return present.call(this, id, presentations, ...args);
  };
  service.performResize = resized;
  service.setPresentations = presented;
  return () => {
    if (service.performResize === resized) service.performResize = resize;
    if (service.setPresentations === presented) service.setPresentations = present;
  };
}

// A draw that throws leaves the engine's requested frame to retry it. A draw
// that succeeds forgets that frame's handle, so it is cancelled here: left
// scheduled it would repeat the VTK draw call and, after the engine is
// destroyed, throw. A frame requested during the draw has its own handle.
function kinDrawQueuedFrame(engine) {
  if (!engine || engine.hasBeenDestroyed || !engine._animationFrameSet) return;
  if (typeof engine._renderFlaggedViewports !== 'function') return;
  const queued = engine._animationFrameHandle;
  try { engine._renderFlaggedViewports(); }
  catch (error) { console.warn('Resize redraw deferred to the next frame', error); return; }
  cancelAnimationFrame(queued);
}

// Stack defaults belong to its native tool group. MPR groups keep their own
// bindings; selecting a tool only replaces the primary binding, leaving wheel
// scroll and right-button windowing available while drawing or zooming.
function kinStackMouse(services) {
  const cs = window.cornerstone, tools = window.cornerstoneTools;
  const initialized = new WeakSet(), subscriptions = [];
  const primary = tools.Enums.MouseBindings.Primary;
  const secondary = tools.Enums.MouseBindings.Secondary;
  const wheel = tools.Enums.MouseBindings.Wheel;
  let ended = false, frame;
  function groupFor(viewport) {
    return viewport?.type === 'stack' && tools.ToolGroupManager.getToolGroupForViewport(viewport.id, viewport.renderingEngineId);
  }
  function refresh() {
    frame = null;
    if (ended || kinViewerSession.ended()) return;
    for (const id of services.viewportGridService.getState().viewports.keys()) {
      const viewport = services.cornerstoneViewportService.getCornerstoneViewport(id), group = groupFor(viewport);
      if (!group || initialized.has(group) || !group.hasTool('StackScroll') || !group.hasTool('WindowLevel')) continue;
      if (group.getViewportsInfo().some(info => {
        const view = cs.getRenderingEngine(info.renderingEngineId)?.getViewport(info.viewportId);
        return view && view.type !== 'stack';
      })) continue;
      const bindings = [primary, secondary, wheel].map(mouseButton => ({ mouseButton }));
      for (const [name, options] of Object.entries(group.toolOptions)) {
        if (options.bindings?.some(binding => !binding.modifierKey && bindings.some(b => b.mouseButton === binding.mouseButton)))
          group.setToolPassive(name, { removeAllBindings: bindings });
      }
      group.setToolActive('StackScroll', { bindings: [{ mouseButton: primary }, { mouseButton: wheel }] });
      group.setToolActive('WindowLevel', { bindings: [{ mouseButton: secondary }] });
      initialized.add(group);
      services.toolbarService.refreshToolbarState?.({ viewportId: id });
    }
  }
  function schedule() { if (!ended && !frame) frame = requestAnimationFrame(refresh); }
  for (const service of [services.viewportGridService, services.cornerstoneViewportService]) {
    for (const event of Object.values(service.EVENTS || {})) subscriptions.push(service.subscribe(event, schedule));
  }
  const enabled = cs.Enums.Events.ELEMENT_ENABLED;
  cs.eventTarget.addEventListener(enabled, schedule);
  const controller = {
    deselect(name) {
      const viewport = services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId());
      const group = groupFor(viewport);
      if (!group || name === 'StackScroll' || group.getActivePrimaryMouseButtonTool() !== name) return false;
      group.setToolPassive(name);
      group.setToolActive('StackScroll', { bindings: [{ mouseButton: primary }, { mouseButton: wheel }] });
      services.toolbarService.refreshToolbarState?.({ viewportId: viewport.id });
      return true;
    },
    dispose() {
      ended = true; cancelAnimationFrame(frame);
      subscriptions.forEach(subscription => subscription.unsubscribe());
      cs.eventTarget.removeEventListener(enabled, schedule);
      if (window.kinViewerStackMouse === controller) delete window.kinViewerStackMouse;
    },
  };
  window.kinViewerStackMouse = controller;
  schedule();
  return controller;
}

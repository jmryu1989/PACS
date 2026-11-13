// The stock mode owns the grid and Cornerstone elements. This extension owns
// only its chrome and removes it when that mode or document ends.
function kinCreateViewerUX() {
  let services, commands, dispose, toolbar, shortcuts, mouse, resize, generation = 0, ready;
  const assets = ['viewer-info-bar.js', 'viewer-series-strip.js', 'viewer-patient-tabs.js', 'viewer-ux-shortcuts.js', 'viewer-hanging-settings.js', 'viewer-export.js',
    // Viewer feature modules register through viewer-features.js before the toolbar that shows them mounts.
    'viewer-features.js', 'viewer-features-navigate.js', 'viewer-features-display.js', 'viewer-features-view.js', 'viewer-features-autosave.js', 'viewer-features-input.js', 'viewer-features-chrome.js', 'viewer-features-monitors.js', 'viewer-features-compare.js', 'viewer-features-mg.js', 'viewer-features-measure.js', 'viewer-features-measure-lines.js', 'viewer-features-measure-ortho.js',
    'viewer-ux-toolbar.js', 'viewer-display-layout.js', 'viewer-display-span.js', 'viewer-ux-shell.js'];
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
      // A viewer feature file that fails is reported alone; the chrome and the other features still load.
      script.onerror = () => {
        script.remove();
        if (!name.startsWith('viewer-features')) { reject(new Error('뷰어 화면 모듈을 불러오지 못했습니다.')); return; }
        services?.uiNotificationService?.show({ title: 'Viewer', message: '뷰어 기능 모듈을 불러오지 못했습니다: ' + name, type: 'error' });
        resolve();
      };
      document.head.append(script);
    })), stylesheet()).catch(error => { ready = null; throw error; });
  }
  function stop() { generation++; dispose?.(); dispose = null; mouse?.dispose(); mouse = null; resize?.(); resize = null; }
  return {
    id: 'kin.viewer-ux',
    async preRegistration({ servicesManager, commandsManager }) {
      services = servicesManager.services; commands = commandsManager;
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
        toolbar = window.KinViewerUXToolbar.mount({ services, commands, session: kinViewerSession });
        // A window across two displays, or a second window: the account's Second Display setting.
        const span = window.KinViewerDisplaySpan.mount({ services, enabled: () => toolbar?.secondDisplay?.() });
        const channel = kinViewerOnEnd(() => { window.KinViewerPatientTabs.end(); stop(); });
        dispose = () => { channel?.close(); span.dispose(); toolbar?.dispose(); toolbar = null; shell.dispose(); };
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

// The account's Mouse & Wheel choices (A1 04-3) for the stack groups. The defaults are the bindings the stack had
// before there was a choice: left Stack Scroll, middle Pan, right W/L, both buttons nothing, one image per wheel
// step, no wraparound, nothing on Ctrl+wheel. A stored value is read through kinMouseSettings, so a value that is
// not one of the choices falls back to its default.
function kinMouseModel() {
  return {
    defaults: { middle: 'Pan', right: 'WindowLevel', both: 'None', defaultTool: 'StackScroll', wheelStep: 1, wrap: false, ctrlZoom: 0 },
    choices: {
      left: ['StackScroll', 'WindowLevel', 'Pan', 'Zoom', 'Pointer'],
      middle: ['None', 'Pan', 'Zoom', 'WindowLevel'],
      right: ['WindowLevel', 'Pan', 'Zoom', 'StackScroll'],
      both: ['None', 'StackScroll', 'WindowLevel', 'Pan', 'Zoom'],
      defaultTool: ['StackScroll', 'WindowLevel', 'Pan', 'Zoom', 'Pointer'],
      wheelStep: [1, 2, 3, 5, 10],
      ctrlZoom: [0, 1, 5, 10, 20],
    },
  };
}
function kinMouseSettings(value) {
  const { defaults, choices } = kinMouseModel();
  const stored = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const settings = {};
  for (const [key, fallback] of Object.entries(defaults))
    settings[key] = key === 'wrap' ? (typeof stored.wrap === 'boolean' ? stored.wrap : fallback) : choices[key].includes(stored[key]) ? stored[key] : fallback;
  return settings;
}
// Tool name -> its mouse bindings for one stack group: left is the tool on the primary button (Pointer: none).
// Buttons as the pinned engine numbers them: 1 primary, 2 secondary, 3 both, 4 middle, 524288 wheel.
function kinMouseBindings(value, left) {
  const settings = kinMouseSettings(value), plan = {};
  const add = (tool, mouseButton) => { if (tool && tool !== 'None' && tool !== 'Pointer') (plan[tool] ||= []).push({ mouseButton }); };
  add(left, 1); add(settings.right, 2); add(settings.both, 3); add(settings.middle, 4); add('StackScroll', 524288);
  return plan;
}
// The image a wheel step goes to. Within the stack it moves by the step; a step past an end stops on that end, and
// with wraparound a step from the end goes round to the other end.
function kinWheelTarget(index, count, direction, step, wrap) {
  if (!(count > 0)) return index;
  const last = count - 1, next = index + direction * step;
  if (next >= 0 && next <= last) return next;
  const edge = direction > 0 ? last : 0;
  if (!wrap || index !== edge) return edge;
  return direction > 0 ? 0 : last;
}

// Stack defaults belong to its native tool group. MPR groups keep their own
// bindings; selecting a tool only replaces the primary binding, leaving wheel
// scroll and right-button windowing available while drawing or zooming.
// The account's Mouse & Wheel choices (configure) are put on every stack group when the group appears, and again on
// the groups already there when the choices change (a save, a reload, another window's save).
function kinStackMouse(services) {
  const cs = window.cornerstone, tools = window.cornerstoneTools;
  const applied = new WeakMap(), subscriptions = [], wheels = new Set();
  const buttons = tools.Enums.MouseBindings;
  const primary = buttons.Primary, managed = [buttons.Primary, buttons.Secondary, buttons.Primary_And_Secondary ?? 3, buttons.Auxiliary ?? 4, buttons.Wheel];
  let ended = false, frame, settings = kinMouseSettings(kinStackMouse.last), signature = JSON.stringify(settings), forced;
  function groupFor(viewport) {
    return viewport?.type === 'stack' && tools.ToolGroupManager.getToolGroupForViewport(viewport.id, viewport.renderingEngineId);
  }
  const cursor = group => group.setViewportsCursorByToolName?.('default');
  // Every managed button binding is taken off and the plan put on, the bindings of one tool together.
  function bind(group, left) {
    const plan = kinMouseBindings(settings, left), remove = managed.map(mouseButton => ({ mouseButton }));
    for (const [name, options] of Object.entries(group.toolOptions)) {
      if (options.bindings?.some(binding => !binding.modifierKey && managed.includes(binding.mouseButton)))
        group.setToolPassive(name, { removeAllBindings: remove });
    }
    for (const [name, bindings] of Object.entries(plan)) if (group.hasTool(name)) group.setToolActive(name, { bindings });
    if (!plan[left]) cursor(group);
  }
  function refresh() {
    frame = null;
    if (ended || kinViewerSession.ended()) return;
    const seen = new Set();
    for (const id of services.viewportGridService.getState().viewports.keys()) {
      const viewport = services.cornerstoneViewportService.getCornerstoneViewport(id), group = groupFor(viewport);
      if (!group || !group.hasTool('StackScroll') || !group.hasTool('WindowLevel')) continue;
      if (group.getViewportsInfo().some(info => {
        const view = cs.getRenderingEngine(info.renderingEngineId)?.getViewport(info.viewportId);
        return view && view.type !== 'stack';
      })) continue;
      if (viewport.element?.addEventListener && !wheels.has(viewport.element)) {
        viewport.element.addEventListener('wheel', wheeled, { capture: true, passive: false });
        wheels.add(viewport.element);
      }
      if (seen.has(group)) continue;
      seen.add(group);
      const record = applied.get(group);
      let left, followsDefault = false;
      if (!record) { left = settings.defaultTool; followsDefault = true; }
      else if (forced !== undefined) left = forced;
      else if (record.signature === signature) continue;
      else {
        // A left tool still as this code set it from the default follows the new default; one the reader chose stays.
        const now = group.getActivePrimaryMouseButtonTool() || 'Pointer';
        followsDefault = record.followsDefault && now === record.left;
        left = followsDefault ? settings.defaultTool : now;
      }
      bind(group, left);
      applied.set(group, { signature, left, followsDefault });
      services.toolbarService.refreshToolbarState?.({ viewportId: id });
    }
    forced = undefined;
  }
  function schedule() { if (!ended && !frame) frame = requestAnimationFrame(refresh); }
  // A wheel step on a stack cell. The native scroll (one image, no wraparound) and the native nothing on Ctrl+wheel
  // stay as they were until a choice changes them; then this takes the event before the native handler, so a step
  // runs once. Listening on the cell (capture) keeps the document-level guards of busy states ahead of it.
  function wheeled(event) {
    if (ended || kinViewerSession.ended() || event.altKey || event.metaKey || event.shiftKey) return;
    if (event.ctrlKey ? !settings.ctrlZoom : settings.wheelStep === 1 && !settings.wrap) return;
    if (event.deltaY > -1 && event.deltaY < 1) return;
    const viewport = [...services.viewportGridService.getState().viewports.keys()]
      .map(id => services.cornerstoneViewportService.getCornerstoneViewport(id)).find(view => view?.element === event.currentTarget);
    const group = groupFor(viewport);
    if (!group || !applied.has(group) || tools.state?.isInteractingWithTool) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const direction = event.deltaY < 0 ? -1 : 1;
    if (event.ctrlKey) {
      // Ctrl+wheel up enlarges by the chosen percent around the pointer; down undoes one such step.
      const factor = direction < 0 ? 1 + settings.ctrlZoom / 100 : 1 / (1 + settings.ctrlZoom / 100);
      const camera = viewport.getCamera(), box = viewport.element.getBoundingClientRect();
      const world = viewport.canvasToWorld([event.clientX - box.left, event.clientY - box.top]);
      const shift = [0, 1, 2].map(axis => (world[axis] - camera.focalPoint[axis]) * (1 - 1 / factor));
      viewport.setCamera({ parallelScale: camera.parallelScale / factor,
        focalPoint: camera.focalPoint.map((value, axis) => value + shift[axis]), position: camera.position.map((value, axis) => value + shift[axis]) });
      viewport.render();
      return;
    }
    const index = viewport.getTargetImageIdIndex?.() ?? viewport.getCurrentImageIdIndex();
    const next = kinWheelTarget(index, viewport.getImageIds().length, direction, settings.wheelStep, settings.wrap);
    if (next !== index) tools.utilities.scroll(viewport, { delta: next - index, debounceLoading: true });
  }
  for (const service of [services.viewportGridService, services.cornerstoneViewportService]) {
    for (const event of Object.values(service.EVENTS || {})) subscriptions.push(service.subscribe(event, schedule));
  }
  const enabled = cs.Enums.Events.ELEMENT_ENABLED;
  cs.eventTarget.addEventListener(enabled, schedule);
  const controller = {
    // The account's choices (viewer-features-input.js). options.left puts that tool on the left button of every
    // stack group now (Apply in Mouse & Wheel); otherwise the groups keep the left tool the reader has.
    configure(value, options = {}) {
      if (ended) return;
      settings = kinMouseSettings(value); signature = JSON.stringify(settings); kinStackMouse.last = settings;
      if (kinMouseModel().choices.left.includes(options.left)) forced = options.left;
      cancelAnimationFrame(frame); refresh();
    },
    settings: () => ({ ...settings }),
    // The tool on the left button of the active stack cell ('Pointer' when none), or null for another cell.
    left() {
      const group = groupFor(services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId()));
      return group ? group.getActivePrimaryMouseButtonTool() || 'Pointer' : null;
    },
    // Turning the left tool off gives the left button back to the default tool (Pointer: to none).
    deselect(name) {
      const viewport = services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId());
      const group = groupFor(viewport), fallback = settings.defaultTool;
      if (!group || name === fallback || group.getActivePrimaryMouseButtonTool() !== name) return false;
      group.setToolPassive(name);
      if (fallback !== 'Pointer' && group.hasTool(fallback)) group.setToolActive(fallback, { bindings: [{ mouseButton: primary }] });
      else cursor(group);
      services.toolbarService.refreshToolbarState?.({ viewportId: viewport.id });
      return true;
    },
    // A3 C-R01-029 #52, Pointer: no tool on the primary button of the stack groups, so a click only selects a cell and
    // moves marks already drawn; wheel scroll and right-button windowing keep their bindings. MPR groups keep theirs.
    pointing() {
      const group = groupFor(services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId()));
      return group ? !group.getActivePrimaryMouseButtonTool() : null;
    },
    point() {
      const active = services.viewportGridService.getActiveViewportId();
      if (!groupFor(services.cornerstoneViewportService.getCornerstoneViewport(active))) return false;
      const groups = new Set([...services.viewportGridService.getState().viewports.keys()]
        .map(id => groupFor(services.cornerstoneViewportService.getCornerstoneViewport(id))).filter(Boolean));
      for (const group of groups) {
        const name = group.getActivePrimaryMouseButtonTool();
        if (!name) continue;
        group.setToolPassive(name);
        // setToolPassive keeps the tool's cursor; no cursor is defined under 'default', so the cells get the plain one.
        group.setViewportsCursorByToolName?.('default');
      }
      services.toolbarService.refreshToolbarState?.({ viewportId: active });
      return true;
    },
    dispose() {
      ended = true; cancelAnimationFrame(frame);
      for (const element of wheels) element.removeEventListener('wheel', wheeled, { capture: true });
      wheels.clear();
      subscriptions.forEach(subscription => subscription.unsubscribe());
      cs.eventTarget.removeEventListener(enabled, schedule);
      if (window.kinViewerStackMouse === controller) delete window.kinViewerStackMouse;
    },
  };
  window.kinViewerStackMouse = controller;
  schedule();
  return controller;
}

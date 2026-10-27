window.KinViewerHangingSettings = (() => {
  const modalities = ['CT', 'MR', 'XA', 'Other'];
  const defaults = { layout: 'automatic', priorPosition: 'right', seriesMatch: 'similar' };
  const get = (settings, modality) => ({ ...defaults, ...settings?.hanging?.[modalities.includes(modality) ? modality : 'Other'] });
  const metadata = set => ({ ...set?.images?.[0], ...set });
  const text = value => String(value || '').toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, ' ');
  const seriesOrder = (a, b) => Number(a.SeriesNumber || 0) - Number(b.SeriesNumber || 0) ||
    String(a.SeriesInstanceUID).localeCompare(String(b.SeriesInstanceUID));
  function rank(sets, origin, method = 'similar') {
    const source = metadata(origin);
    const plane = image => {
      const v = image.ImageOrientationPatient;
      if (!Array.isArray(v) || v.length !== 6) return null;
      const n = [v[1]*v[5]-v[2]*v[4], v[2]*v[3]-v[0]*v[5], v[0]*v[4]-v[1]*v[3]];
      return n.map(Math.abs).indexOf(Math.max(...n.map(Math.abs)));
    };
    function score(set) {
      const m = metadata(set), a = new Set(text(source.SeriesDescription).split(' ').filter(Boolean));
      const b = new Set(text(m.SeriesDescription).split(' ').filter(Boolean));
      const overlap = a.size && b.size ? [...a].filter(word => b.has(word)).length / new Set([...a, ...b]).size : 0;
      const thickness = Number(source.SliceThickness), candidate = Number(m.SliceThickness);
      const similar = [overlap, plane(source) !== null && plane(source) === plane(m) ? 1 : 0,
        text(source.ConvolutionKernel) && text(source.ConvolutionKernel) === text(m.ConvolutionKernel) ? 1 : 0,
        thickness > 0 && candidate > 0 ? -Math.abs(thickness - candidate) : -Infinity];
      return [source.Modality === m.Modality ? 1 : 0,
        ...(method === 'number' ? [Number(source.SeriesNumber) === Number(m.SeriesNumber) ? 1 : 0] : []),
        ...(method === 'largest' ? [] : similar), set.numImageFrames || set.images?.length || 0];
    }
    return sets.slice().sort((a, b) => {
      const x = score(a), y = score(b);
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i] ? -1 : 1;
      return seriesOrder(a, b);
    });
  }
  function dimensions(value, comparing) {
    let [rows, columns] = value.layout === 'automatic' ? [1, 1] : value.layout.split('x').map(Number);
    const vertical = ['top', 'bottom'].includes(value.priorPosition);
    if (comparing) { if (vertical) rows = Math.max(2, rows); else columns = Math.max(2, columns); }
    return { rows, columns, priorFirst: ['left', 'top'].includes(value.priorPosition), vertical };
  }
  function mountSizing(services, notify) {
    const native = window.cornerstone, saved = new Map(), observed = new Set();
    let frame = null, ended = false, limited = false;
    const announce = value => { if (limited !== value) { limited = value; notify(value); } };
    const restore = element => {
      const value = saved.get(element); if (!value) return false;
      element.style.maxWidth = value.maxWidth; element.style.marginInline = value.marginInline;
      saved.delete(element); return true;
    };
    const queue = () => { if (!ended && frame === null) frame = requestAnimationFrame(refresh); };
    const observer = new ResizeObserver(queue);
    function refresh() {
      frame = null; if (ended) return;
      const engine = services.cornerstoneViewportService.getRenderingEngine();
      if (!engine || engine.hasBeenDestroyed) return;
      const views = engine.getViewports().filter(view => view.element?.isConnected);
      const elements = new Set(views.map(view => view.element));
      let changed = false;
      for (const element of saved.keys()) if (!elements.has(element)) changed = restore(element) || changed;
      if (views.some(view => view.type !== 'stack')) {
        for (const element of saved.keys()) changed = restore(element) || changed;
        announce(false);
      } else {
        const gl = engine.offscreenMultiRenderWindow?.getOpenGLRenderWindow?.().getContext?.();
        if (!gl || gl.isContextLost()) return;
        const limit = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), gl.getParameter(gl.MAX_VIEWPORT_DIMS)[0]);
        if (!(limit > 0)) return;
        const ratio = window.devicePixelRatio || 1, roots = new Set();
        const widths = views.map(view => {
          const root = view.element.closest('[class~="group/pane"]') || view.element.parentElement;
          if (!observed.has(root)) { observer.observe(root); observed.add(root); }
          roots.add(root); return root.clientWidth;
        });
        for (const root of observed) if (!roots.has(root)) { observer.unobserve(root); observed.delete(root); }
        const total = widths.reduce((sum, width) => sum + width * ratio, 0), fitting = total > limit;
        // The pinned tiled renderer silently crops a shared canvas wider than the GPU limit.
        // Keep the reader's pane arrangement; native resize/camera math handles narrower image areas.
        views.forEach((view, i) => {
          const element = view.element;
          if (!fitting) { changed = restore(element) || changed; return; }
          if (!saved.has(element)) saved.set(element, { maxWidth: element.style.maxWidth, marginInline: element.style.marginInline });
          const width = Math.floor(widths[i] * limit / total) + 'px';
          if (element.style.maxWidth !== width || element.style.marginInline !== 'auto') {
            element.style.maxWidth = width; element.style.marginInline = 'auto'; changed = true;
          }
        });
        announce(fitting);
      }
      if (changed && views.length) engine.resize(true, false);
    }
    const events = [native.Enums.Events.ELEMENT_ENABLED, native.Enums.Events.ELEMENT_DISABLED];
    events.forEach(event => native.eventTarget.addEventListener(event, queue));
    window.addEventListener('resize', queue);
    const subscription = services.viewportGridService.subscribe(services.viewportGridService.EVENTS.GRID_STATE_CHANGED, queue);
    queue();
    return { dispose() {
      ended = true; if (frame !== null) cancelAnimationFrame(frame); observer.disconnect(); subscription.unsubscribe();
      events.forEach(event => native.eventTarget.removeEventListener(event, queue)); window.removeEventListener('resize', queue);
      for (const element of saved.keys()) restore(element); announce(false);
    } };
  }
  function mount(services, getSettings) {
    const hp = services.hangingProtocolService, run = hp.run;
    const opened = new URLSearchParams(location.search).get('StudyInstanceUIDs')?.split(',') || [];
    let last = null, applying = false, ended = false;
    function wrapped(data, requested, options) {
      if (ended) return run.call(this, data, requested, options);
      const current = data.displaySets.filter(d => d.StudyInstanceUID === opened[0] && d.images?.length).sort(seriesOrder);
      const modality = current[0]?.Modality, settings = getSettings(), value = get(settings, modality);
      if (modality === 'MG' || !current.length || requested && !['default', '@ohif/hpCompare'].includes(requested)) return run.call(this, data, requested, options);
      last = { data, requested, options };
      if (!settings?.hanging?.[modalities.includes(modality) ? modality : 'Other']) return run.call(this, data, requested, options);
      const prior = data.displaySets.filter(d => d.StudyInstanceUID === opened[1] && d.images?.length).sort(seriesOrder);
      if (value.layout === 'automatic' && !prior.length) return run.call(this, data, requested, options);
      const { rows, columns, priorFirst, vertical } = dimensions(value, !!prior.length);
      // Match priors to the stable current series, never to the first metadata response.
      const ordered = value.seriesMatch === 'largest' ? rank(current, current[0], 'largest') : current;
      const first = ordered[0], cells = Array(rows * columns).fill(null);
      if (prior.length) {
        const split = vertical ? Math.floor(rows / 2) : Math.floor(columns / 2);
        let currentIndex = 0, priorIndex = 0;
        for (let i = 0; i < cells.length; i++) {
          const second = (vertical ? Math.floor(i / columns) : i % columns) >= split;
          const isPrior = priorFirst ? !second : second;
          cells[i] = isPrior ? rank(prior, ordered[priorIndex++] || first, value.seriesMatch)[0] : ordered[currentIndex++];
        }
      } else ordered.slice(0, cells.length).forEach((set, i) => { cells[i] = set; });
      // Distinct definitions let native OHIF retain a reader's chosen stage without
      // accidentally reusing a cached layout after the account settings change.
      const id = 'kin.personal.' + modality + '.' + [rows, columns, value.priorPosition, value.seriesMatch].join('.');
      const selectors = Object.fromEntries(cells.map((set, i) => [String(i), { seriesMatchingRules: [{
        attribute: 'displaySetInstanceUID', required: true, constraint: { equals: { value: set?.displaySetInstanceUID || '' } },
      }] }]));
      hp.addProtocol(id, { id, name: 'Personal Layout', locked: true, numberOfPriorsReferenced: 1,
        protocolMatchingRules: [], displaySetSelectors: selectors, stages: [{ id: 'personal', name: 'Personal Layout',
          stageActivation: { enabled: { minViewportsMatched: 0 } },
          viewportStructure: { layoutType: 'grid', properties: { rows, columns } },
          viewports: cells.map((_, i) => ({ viewportOptions: { toolGroupId: 'default', viewportType: 'stack', allowUnmatchedView: true }, displaySets: [{ id: String(i) }] })),
        }] });
      return run.call(this, data, id, { ...options, stageIndex: 0 });
    }
    hp.run = wrapped;
    return { apply() {
      if (last && !applying) { applying = true; try { wrapped.call(hp, last.data, last.requested, last.options); } finally { applying = false; } }
    }, dispose() { ended = true; if (hp.run === wrapped) hp.run = run; last = null; } };
  }
  return { modalities, defaults, get, rank, dimensions, mount, mountSizing };
})();

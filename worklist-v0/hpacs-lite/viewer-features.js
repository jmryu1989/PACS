// Viewer feature modules: one place where each viewer feature file registers its menu items, toolbar buttons,
// Viewer Settings entries, shortcuts and windows. The image toolbar (viewer-ux-toolbar.js) attaches this
// registry when it mounts and detaches it when it ends; a feature never edits the toolbar or its dialog itself.
// Every action runs through run(id), which keeps the toolbar's own guards (ended session, empty viewer,
// patient switch, a History or Job workspace being restored).
window.KinViewerFeatures = (() => {
  const MENUS = ['MG', 'Navigate', 'Display', 'Compare', 'Measure'];
  const modules = [];
  const scripts = new Map();
  let host = null;
  const validId = id => typeof id === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id);
  const copy = value => value === undefined ? undefined : structuredClone(value);
  const sorted = list => [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.sequence - b.sequence);

  function module(name, setup) {
    if (typeof name !== 'string' || !name || typeof setup !== 'function' || modules.some(entry => entry.name === name)) return false;
    const entry = { name, setup }; modules.push(entry);
    host?.install(entry);
    return true;
  }

  // Scripts a feature loads for itself (pure calculation files), once per document.
  function script(name) {
    if (!/^[a-z0-9][a-z0-9-]*\.js$/.test(name)) return Promise.reject(new Error(name));
    if (!scripts.has(name)) scripts.set(name, new Promise((resolve, reject) => {
      const node = document.createElement('script');
      node.src = '/worklist/hpacs-lite/' + name;
      node.onload = () => { node.remove(); resolve(); };
      node.onerror = () => { node.remove(); scripts.delete(name); reject(new Error(name)); };
      document.head.append(node);
    }));
    return scripts.get(name);
  }

  // context: { services, commands, session, store, toolbar, status(text), allowed(), tools(), invoke(id, options),
  //            dialog (the Viewer Settings dialog), opened() (true while that dialog is open) }
  function attach(context) {
    const { services, commands, session, store } = context;
    const abort = new AbortController();
    const actions = new Map(), settings = [], subscribers = new Set(), panels = new Map(), layers = new Set();
    let sequence = 0, ended = false, started = false, ready = false, popup = null, renderQueued = false;
    const element = (tag, text, parent, className) => {
      const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; parent?.append(node); return node;
    };
    const button = (text, parent, click, className) => { const node = element('button', text, parent, className); node.type = 'button'; node.onclick = click; return node; };
    const report = text => {
      if (ended) return;
      context.status(text);
      services.uiNotificationService?.show({ title: 'Viewer', message: text, type: 'error' });
    };
    // Each cell has a generation that only grows. It moves on when the cell is given other images (the grid names the
    // cell, or names none for a new layout, or the cell gets new viewport data) and, for every cell, whenever a patient
    // switch or an emptied viewer begins or ends. An action started in a cell stays current only while that cell keeps
    // the generation it started at; when it moves on, the action's signal is aborted, so a late result is not applied
    // to other images, even when the same series comes back.
    const STATES = ['kin-patient-switching', 'kin-viewer-empty'];
    const runs = new Set(), moves = new Map(), subscriptions = [];
    let everyCell = 0;
    const generation = id => everyCell + (moves.get(id) ?? 0);
    const switching = () => STATES.some(name => document.body.classList.contains(name));
    const stateIn = value => typeof value === 'string' && value.split(/\s+/).some(name => STATES.includes(name));
    function moved(ids) {
      if (ids) for (const id of ids) moves.set(id, (moves.get(id) ?? 0) + 1); else everyCell++;
      for (const run of [...runs]) if (generation(run.viewportId) !== run.at) run.abort();
    }
    // A state class was there before a change (the old value) or is there now: a switch began or ended.
    const observed = records => { if (records.length && (records.some(record => stateIn(record.oldValue)) || switching())) moved(null); };
    const classes = new MutationObserver(observed);
    classes.observe(document.body, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    // Changes the observer has not delivered yet count before a generation is read.
    const deliver = () => observed(classes.takeRecords());
    const listen = (service, event, fn) => {
      if (!event || typeof service?.subscribe !== 'function') return;
      try { const subscription = service.subscribe(event, fn); if (subscription) subscriptions.push(subscription); } catch (error) { console.error(error); }
    };
    const grid = services.viewportGridService, cells = services.cornerstoneViewportService;
    listen(grid, grid?.EVENTS?.GRID_STATE_CHANGED, event => moved(Array.isArray(event?.viewports)
      ? [...event.viewports.map(view => view?.viewportId), ...(event.removedViewportIds || [])].filter(Boolean) : null));
    listen(cells, cells?.EVENTS?.VIEWPORT_DATA_CHANGED, event => moved(event?.viewportId ? [event.viewportId] : null));

    // ── The Feature Menus group between More and Viewer Settings ──
    const group = element('div', '', null, 'kin-ux-features'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', 'Feature Menus'); group.hidden = true;
    const row = element('div', '', null, 'kin-ux-features-row');
    // Where the group itself does not fit, arrows page through it as the frequent tools do.
    const pagers = [['Previous Feature Menus', -1, '‹'], ['Next Feature Menus', 1, '›']].map(([name, direction, text]) => {
      const node = button(text, group, () => row.scrollBy({ left: direction * Math.max(row.clientWidth, 1), behavior: 'auto' }), 'kin-ux-features-scroll');
      node.setAttribute('aria-label', name); node.hidden = true; return node;
    });
    pagers[0].after(row);
    function overflow() {
      if (ended || group.hidden) return;
      const shown = !pagers[0].hidden, gap = parseFloat(getComputedStyle(group).columnGap) || 0;
      const room = row.clientWidth + (shown ? pagers.reduce((sum, node) => sum + node.offsetWidth + gap, 0) : 0);
      pagers.forEach(node => { node.hidden = row.scrollWidth <= room + 1; });
    }
    const resized = new ResizeObserver(overflow); resized.observe(group); resized.observe(row);
    context.toolbar.querySelector(':scope > .kin-ux-toolbar-settings')?.before(group);

    // ── The Tools & Display section of Viewer Settings ──
    const section = element('fieldset', '', null, 'kin-ux-feature-settings'); section.hidden = true;
    element('legend', 'Tools & Display', section);
    const checkRows = element('div', '', section), settingButtons = element('div', '', section, 'kin-ux-feature-setting-buttons');
    const checks = new Map();
    context.dialog.querySelector(':scope > p[role=status]')?.before(section);

    function closePopup(focus) {
      if (!popup) return;
      const { node, opener } = popup; popup = null;
      node.remove(); opener.setAttribute('aria-expanded', 'false');
      if (focus && opener.isConnected) opener.focus();
    }
    function openPopup(opener, menu) {
      if (popup?.opener === opener) { closePopup(true); return; }
      closePopup(false);
      const node = element('div', '', document.body, 'kin-ux-feature-popup'); node.setAttribute('role', 'menu'); node.setAttribute('aria-label', menu);
      for (const action of items(menu)) {
        const entry = actions.get(action.id);
        const item = button(action.label, node, () => { closePopup(true); run(action.id); }); item.setAttribute('role', 'menuitem');
        item.dataset.feature = action.id;
        try { item.disabled = entry.enabled ? !entry.enabled() : false; } catch (_) { item.disabled = true; }
      }
      const rect = opener.getBoundingClientRect();
      node.style.left = Math.max(0, Math.min(rect.left, innerWidth - node.offsetWidth)) + 'px';
      node.style.top = rect.bottom + 'px';
      popup = { node, opener, menu }; opener.setAttribute('aria-expanded', 'true');
      node.addEventListener('keydown', event => {
        const enabled = [...node.querySelectorAll('[role=menuitem]:not(:disabled)')];
        const at = enabled.indexOf(document.activeElement);
        const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: enabled.length - 1 }[event.key];
        if (next !== undefined && enabled.length) { event.preventDefault(); enabled[(next + enabled.length) % enabled.length].focus(); }
        else if (event.key === 'Tab') closePopup(false);
      });
      node.querySelector('[role=menuitem]:not(:disabled)')?.focus();
    }
    document.addEventListener('pointerdown', event => {
      if (popup && !popup.node.contains(event.target) && !popup.opener.contains(event.target)) closePopup(false);
    }, { capture: true, signal: abort.signal });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !popup) return;
      event.stopPropagation(); closePopup(true);
    }, { capture: true, signal: abort.signal });

    function render() {
      renderQueued = false;
      if (ended) return;
      const focused = row.contains(document.activeElement) ? document.activeElement.dataset.featureMenu || document.activeElement.dataset.feature : null;
      if (popup) closePopup(false);
      row.replaceChildren();
      for (const menu of MENUS) {
        if (!items(menu).length) continue;
        const node = button(menu + ' ▾', row, event => openPopup(event.currentTarget, menu), 'kin-ux-feature-menu');
        node.dataset.featureMenu = menu; node.setAttribute('aria-haspopup', 'menu'); node.setAttribute('aria-expanded', 'false');
      }
      for (const action of sorted([...actions.values()].filter(action => action.button))) {
        const node = button(action.button.label, row, () => run(action.id), 'kin-ux-feature-button');
        node.dataset.feature = action.id; if (action.button.title) node.title = action.button.title;
      }
      group.hidden = !row.children.length;
      if (focused) row.querySelector('[data-feature-menu="' + CSS.escape(focused) + '"],[data-feature="' + CSS.escape(focused) + '"]')?.focus();
      settingButtons.replaceChildren();
      for (const setting of sorted(settings.filter(setting => setting.kind === 'button'))) {
        const node = button(setting.label, settingButtons, () => { if (!ended && session.writer()) setting.call(); }, 'kin-ux-feature-setting');
        node.dataset.featureSetting = setting.id;
      }
      settingButtons.hidden = !settingButtons.children.length;
      section.hidden = !settings.length;
      overflow();
    }
    const schedule = () => { if (!renderQueued) { renderQueued = true; queueMicrotask(render); } };

    // Checks are drawn from the values the dialog opens with and saved with the dialog's Save.
    function fill(value) {
      checkRows.replaceChildren(); checks.clear();
      const features = value?.features && typeof value.features === 'object' ? value.features : {};
      for (const setting of sorted(settings.filter(setting => setting.kind === 'check'))) {
        const label = element('label', '', checkRows, 'kin-ux-setting-row');
        const input = element('input', '', label); input.type = 'checkbox';
        input.checked = typeof features[setting.key] === 'boolean' ? features[setting.key] : !!setting.default;
        input.setAttribute('aria-label', setting.label); element('span', setting.label, label);
        checks.set(setting, input);
      }
      checkRows.hidden = !checks.size;
    }
    function collect(features) {
      const next = { ...(features || {}) };
      for (const [setting, input] of checks)
        if (input.checked !== !!setting.default || Object.prototype.hasOwnProperty.call(next, setting.key)) next[setting.key] = input.checked;
      return next;
    }

    // ── run(id): the one way a feature action starts ──
    // The action gets the cell it runs for, current() and an AbortSignal. An action that finishes later applies its
    // result only while current() is true: the module and toolbar still live, the session not ended, no patient switch
    // or emptied viewer now, and the cell still at the generation the action started at. Once false it stays false.
    function run(id, options = {}) {
      const action = actions.get(id);
      if (ended || !action || !action.owner.live()) return false;
      try { if (action.enabled && !action.enabled()) return false; } catch (_) { return false; }
      if (!context.allowed()) return false;
      const viewportId = options.viewportId ?? services.viewportGridService?.getActiveViewportId?.();
      deliver();
      const controller = new AbortController();
      let valid = true;
      const entry = { owner: action.owner, viewportId, at: generation(viewportId), abort: () => { valid = false; controller.abort(); } };
      const current = () => {
        if (!valid) return false;
        deliver();
        if (ended || !action.owner.live() || session.ended() || switching() || generation(viewportId) !== entry.at) entry.abort();
        return valid;
      };
      runs.add(entry);
      try {
        const result = action.run({ viewportId, current, signal: controller.signal });
        Promise.resolve(result).catch(error => { if (current()) report(error?.message || action.label + '을(를) 실행하지 못했습니다.'); })
          .finally(() => runs.delete(entry));
        return true;
      } catch (error) { runs.delete(entry); report(error?.message || action.label + '을(를) 실행하지 못했습니다.'); return false; }
    }
    // A menu's items in their order; without a menu, every menu in toolbar order and then the toolbar buttons.
    function items(menu) {
      const list = menu === undefined
        ? [...MENUS.flatMap(name => sorted([...actions.values()].filter(action => action.menu === name))), ...sorted([...actions.values()].filter(action => !action.menu && action.button))]
        : sorted([...actions.values()].filter(action => action.menu === menu));
      return list.map(({ id, menu, label, order }) => ({ id, menu: menu || null, label, order: order ?? 0 }));
    }

    // ── Feature settings in the account (viewerSettings.features) ──
    function notify(keys) {
      if (ended) return;
      for (const subscriber of [...subscribers]) {
        if (keys && !keys.includes(subscriber.key)) continue;
        try { subscriber.fn(copy(store.value()[subscriber.key])); } catch (error) { console.error(error); }
      }
    }

    function install(entry) {
      if (ended || !started) return;
      const owned = { actions: new Set(), settings: new Set(), subscribers: new Set(), panels: new Set(), layers: new Set(), dispose: null, alive: true };
      const live = () => !ended && owned.alive;
      const register = (id, fields) => {
        if (!live()) return null;
        if (!validId(id)) throw new Error('feature id: ' + id);
        let action = actions.get(id);
        if (action && action.owner !== owner) throw new Error('feature id in use: ' + id);
        if (!action) {
          if (typeof fields.run !== 'function') throw new Error('feature run: ' + id);
          action = { id, owner, sequence: ++sequence, run: fields.run }; actions.set(id, action); owned.actions.add(id);
        }
        for (const [key, value] of Object.entries(fields)) if (value !== undefined) action[key] = value;
        schedule();
        return action;
      };
      const owner = { live, name: entry.name };
      const ui = {
        menuItem(menu, { id, label, order, run, enabled }) {
          if (!MENUS.includes(menu)) throw new Error('feature menu: ' + menu);
          register(id, { menu, label: String(label), order, run, enabled });
        },
        toolbarButton({ id, label, title, order, run }) { register(id, { button: { label: String(label), title }, label: String(label), order, run }); },
        shortcut({ id, label, run }) { register(id, { shortcut: true, shortcutLabel: label === undefined ? undefined : String(label), label: actions.get(id)?.label ?? String(label), run }); },
        setting({ id, kind, label, order, key, run, default: fallback }) {
          if (!live()) return;
          if (!validId(id) || !['check', 'button'].includes(kind)) throw new Error('feature setting: ' + id);
          if (kind === 'check' && !/^[a-z][A-Za-z0-9]{0,31}$/.test(key)) throw new Error('feature setting key: ' + key);
          if (kind === 'button' && typeof run !== 'function') throw new Error('feature setting run: ' + id);
          const setting = { id, kind, label: String(label), order, key, default: !!fallback, sequence: ++sequence, module: entry.name,
            call: () => { try { Promise.resolve(run({ modal: true })).catch(error => report(error?.message || String(label))); } catch (error) { report(error?.message || String(label)); } } };
          settings.push(setting); owned.settings.add(setting); schedule();
        },
        // A window for the feature. While Viewer Settings is open it opens as a dialog above it (the settings dialog
        // is modal); elsewhere it is a window beside the images. Either keeps the revision it was opened at.
        panel({ id, title }) {
          if (!live()) return null;
          const key = entry.name + ':' + id, modal = context.opened();
          // The same window again: focused where it is, or opened anew when it must now open the other way (a window
          // left behind the modal Viewer Settings could not be used).
          if (panels.has(key)) {
            const existing = panels.get(key);
            if (existing.modal === modal) { existing.focus(); return existing; }
            existing.close();
          }
          const node = element(modal ? 'dialog' : 'section', '', document.body, 'kin-ux-feature-panel');
          if (!modal) node.setAttribute('role', 'dialog');
          node.setAttribute('aria-label', title); node.dataset.featurePanel = id;
          element('h2', title, node);
          const body = element('div', '', node, 'kin-ux-feature-panel-body');
          const opener = document.activeElement;
          const closers = [];
          let open = true;
          const handle = {
            element: node, body, revision: store.revision(), modal,
            onClose(fn) { closers.push(fn); },
            focus() { (node.querySelector('button, input, select, textarea') || node).focus?.(); },
            close() {
              if (!open) return; open = false;
              panels.delete(key); owned.panels.delete(handle);
              if (modal && node.open) node.close();
              node.remove();
              for (const fn of closers) try { fn(); } catch (error) { console.error(error); }
              if (opener?.isConnected) opener.focus();
            },
          };
          button('Close', node, () => handle.close(), 'kin-ux-feature-panel-close');
          node.addEventListener('keydown', event => {
            event.stopPropagation();
            if (!modal && event.key === 'Escape') { event.preventDefault(); handle.close(); }
          });
          if (modal) { node.addEventListener('cancel', event => { event.preventDefault(); handle.close(); }); node.showModal(); }
          panels.set(key, handle); owned.panels.add(handle);
          handle.focus();
          return handle;
        },
        cellLayer(viewport) {
          if (!live()) return null;
          const target = typeof viewport === 'string' ? services.cornerstoneViewportService?.getCornerstoneViewport(viewport) : viewport;
          const host = target?.element?.closest?.('[data-cy=viewport-pane]') || target?.element?.parentElement;
          if (!host) return null;
          const layer = element('div', '', host, 'kin-ux-cell-layer');
          layers.add(layer); owned.layers.add(layer);
          return layer;
        },
        toast(text, type = 'info') { if (live()) services.uiNotificationService?.show({ title: 'Viewer', message: String(text), type }); },
        // Loads pure calculation files in order. A failure is reported for this module only; after the module or the
        // toolbar has ended the promise never settles, so nothing continues on a viewer that is gone.
        load(names) {
          const list = [].concat(names);
          return new Promise((resolve, reject) => {
            list.reduce((previous, name) => previous.then(() => script(name)), Promise.resolve()).then(
              () => { if (live()) resolve(); },
              error => { if (!live()) return; report(entry.name + ': ' + error.message + '을(를) 불러오지 못했습니다.'); reject(error); });
          });
        },
        // The toolbar's guards (ended session, empty viewer, patient switch, a History or Job workspace being restored), for a
        // feature that must check them before it changes anything itself (e.g. which cell is active).
        allowed: () => live() && context.allowed(),
        tools: () => live() ? context.tools() : [],
        // An existing toolbar tool in a cell (default: the active one); resolves true when it ran.
        invoke: async (id, options = {}) => live() && await context.invoke(id, options) === true,
      };
      const featureStore = {
        get: key => copy(store.value()[key]),
        revision: () => store.revision(),
        writable: () => store.writable(),
        // Resolves true when saved (or applied in this window for a session that does not save). A save in
        // progress, a conflict or a failure resolves false and every subscriber of the key hears the stored value again.
        async set(key, value, options = {}) {
          if (!live() || !/^[a-z][A-Za-z0-9]{0,31}$/.test(key)) return false;
          const saved = await store.set(key, copy(value), options.revision ?? null);
          if (live()) notify([key]);
          return saved;
        },
        subscribe(key, fn) {
          if (!live() || typeof fn !== 'function') return () => {};
          const subscriber = { key, fn }; subscribers.add(subscriber); owned.subscribers.add(subscriber);
          if (ready) { try { fn(copy(store.value()[key])); } catch (error) { console.error(error); } }
          return () => { subscribers.delete(subscriber); owned.subscribers.delete(subscriber); };
        },
      };
      const remove = () => {
        owned.alive = false;
        for (const id of owned.actions) actions.delete(id);
        for (const setting of owned.settings) {
          settings.splice(settings.indexOf(setting), 1);
          // A check already drawn in an open Viewer Settings goes too, so that dialog's Save does not write it.
          checks.get(setting)?.closest('label')?.remove(); checks.delete(setting);
        }
        checkRows.hidden = !checks.size;
        for (const run of [...runs]) if (run.owner === owner) run.abort();
        for (const subscriber of owned.subscribers) subscribers.delete(subscriber);
        for (const panel of [...owned.panels]) panel.close();
        for (const layer of owned.layers) { layer.remove(); layers.delete(layer); }
        schedule();
      };
      const fail = error => {
        console.error(error);
        if (owned.dispose) try { owned.dispose(); } catch (_) {}
        remove();
        report('뷰어 기능 ' + entry.name + '을(를) 설치하지 못했습니다.');
      };
      entry.installed = { remove: () => { if (!owned.alive) return; try { owned.dispose?.(); } catch (error) { console.error(error); } remove(); } };
      const settle = result => {
        const dispose = typeof result === 'function' ? result : typeof result?.dispose === 'function' ? () => result.dispose() : null;
        if (!live()) { try { dispose?.(); } catch (error) { console.error(error); } return; }
        owned.dispose = dispose;
      };
      try {
        const result = entry.setup({ services, commands, session, store: featureStore, ui });
        if (result && typeof result.then === 'function') result.then(settle, error => { if (live()) fail(error); });
        else settle(result);
      } catch (error) { fail(error); }
    }

    // Every registered action with the module that registered it (menu items, toolbar buttons and shortcut-only
    // actions), and the Tools & Display buttons: the lists a feature that reaches all others reads (F.Leader).
    const actionList = () => sorted([...actions.values()]).map(action => ({ id: action.id, menu: action.menu || null, label: action.label,
      order: action.order ?? 0, module: action.owner.name, button: !!action.button, shortcut: !!action.shortcut }));
    const settingList = () => sorted(settings.filter(setting => setting.kind === 'button')).map(({ id, label, module }) => ({ id, label, module }));
    function openSetting(id) {
      const setting = settings.find(setting => setting.kind === 'button' && setting.id === id);
      if (ended || !setting || !session.writer()) return false;
      setting.call(); return true;
    }
    const controller = {
      install,
      items, run, actions: actionList, settings: settingList, openSetting,
      has: id => actions.has(id),
      shortcuts: () => sorted([...actions.values()].filter(action => action.shortcut)).map(action => ({ id: action.id, label: action.shortcutLabel || action.label })),
      fill, collect,
      // The modules install once the toolbar has its tool catalog, so ui.tools() is complete during setup.
      start() {
        if (started || ended) return;
        started = true;
        for (const entry of modules) install(entry);
        render();
      },
      // The account values were read (first read, reload, save, another window's change): every subscriber hears them.
      changed: () => { if (!ended) { ready = true; notify(); } },
      dispose() {
        if (ended) return;
        for (const entry of [...modules].reverse()) entry.installed?.remove();
        ended = true; abort.abort(); resized.disconnect(); classes.disconnect(); closePopup(false);
        for (const subscription of subscriptions) try { subscription.unsubscribe?.(); } catch (error) { console.error(error); }
        for (const run of [...runs]) run.abort();
        for (const panel of [...panels.values()]) panel.close();
        for (const layer of layers) layer.remove();
        group.remove(); section.remove();
        if (host === controller) host = null;
      },
    };
    host = controller;
    render();
    return controller;
  }

  return {
    menus: [...MENUS], module, attach,
    items: menu => host ? host.items(menu) : [],
    run: (id, options) => host ? host.run(id, options) : false,
    actions: () => host ? host.actions() : [],
    settings: () => host ? host.settings() : [],
    openSetting: id => host ? host.openSetting(id) : false,
  };
})();

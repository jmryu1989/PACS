/* Loaded-list folders and personal shortcut editing, with caller-owned search and persistence. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KinWorklistFolderTree = api;
})(typeof window === 'object' ? window : null, function () {
  'use strict';
  const BASE = ['CT', 'MR', 'CR', 'US', 'SC'];
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 400 && !/[\r\n]/.test(value);
  const tokens = value => typeof value === 'string'
    ? [...new Set(value.split(/[,\\]/).map(token => token.trim().toUpperCase()).filter(Boolean))] : [];
  function matchesModality(value, modality) {
    return typeof modality === 'string' && tokens(value).includes(modality.trim().toUpperCase());
  }
  function defaultModalities(rows) {
    return [...BASE, ...[...new Set(rows.flatMap(row => tokens(row.modality)))].filter(token => !BASE.includes(token)).sort()];
  }

  // Searches are adapters: {id, name, matches(row)}. Compile/validate a saved search
  // or compound filter before handing it in; a null match result means its count is unknown.
  // Adapters capture immutable criteria. Updates refresh data, never reapply a selection;
  // select(id) explicitly applies the current adapter, setApplied(id) aligns it silently.
  function mount({ host, rows = [], loadState = 'unknown', searches = [], shortcuts = [], onSelect, onChange }) {
    if (!host?.ownerDocument || typeof onSelect !== 'function' || typeof onChange !== 'function') {
      throw new Error('폴더 표시 영역과 변경 콜백을 확인해 주세요.');
    }
    const doc = host.ownerDocument;
    let state, selected = 'all', applied = { id: 'all', name: 'All Studies', kind: 'all' }, appliedSearch, ended = false;
    const nav = doc.createElement('nav');
    nav.className = 'worklist-folder-tree'; nav.setAttribute('aria-label', 'Folders');
    const controls = new Map(), collapsed = new Set();
    function validate(next) {
      if (!Array.isArray(next.rows) || next.rows.some(row => !object(row))
        || !['complete', 'partial', 'unknown'].includes(next.loadState)
        || !Array.isArray(next.searches) || next.searches.some(search => !object(search)
          || !text(search.id) || !text(search.name) || typeof search.matches !== 'function')
        || new Set(next.searches.map(search => search.id)).size !== next.searches.length
        || !Array.isArray(next.shortcuts) || next.shortcuts.length > 200
        || next.shortcuts.some(item => !object(item) || Object.keys(item).sort().join() !== 'id,name,searchId'
          || !text(item.id) || !text(item.name) || !text(item.searchId))
        || new Set(next.shortcuts.map(item => item.id)).size !== next.shortcuts.length) {
        throw new Error('폴더 목록 또는 바로가기 형식을 확인해 주세요.');
      }
      const shortcuts = next.shortcuts.map(item => ({ ...item, name: item.name.trim() }));
      const names = new Set(['All Studies', ...defaultModalities(next.rows),
        ...(applied.kind === 'modality' ? [applied.modality] : []),
        ...(applied.kind === 'shortcut' && !shortcuts.some(item => 'shortcut:' + item.id === selected)
          ? [applied.name] : [])].map(name => name.toUpperCase()));
      for (const item of shortcuts) {
        const name = item.name.toUpperCase();
        if (names.has(name)) throw new Error('이미 사용 중인 폴더 또는 바로가기 이름입니다. 다른 이름을 입력해 주세요.');
        names.add(name);
      }
      return { rows: [...next.rows], loadState: next.loadState,
        searches: next.searches.map(search => ({ ...search })), shortcuts };
    }
    function availableItems() {
      return [{ id: 'all', name: 'All Studies', kind: 'all' },
        ...state.shortcuts.map(item => ({ ...item, id: 'shortcut:' + item.id, shortcutId: item.id, kind: 'shortcut',
          unavailable: !state.searches.some(search => search.id === item.searchId) })),
        ...defaultModalities(state.rows).map(modality => ({ id: 'modality:' + modality, name: modality, modality, kind: 'modality' }))];
    }
    function items() {
      const result = availableItems();
      const at = result.findIndex(item => item.id === selected);
      if (at < 0) result.push({ ...applied, unavailable: applied.kind === 'shortcut' });
      else if (applied.kind === 'shortcut' && result[at].searchId !== applied.searchId) {
        result[at] = { ...applied, unavailable: true };
      }
      return result;
    }
    function matches(item, row) {
      if (item.kind === 'all') return true;
      if (item.kind === 'modality') return matchesModality(row.modality, item.modality);
      if (item.unavailable) return null;
      // A refreshed adapter must not silently replace the doctor's applied criteria.
      const search = item.id === selected ? appliedSearch : state.searches.find(search => search.id === item.searchId);
      if (!search) return null;
      try { const result = search.matches(row); return typeof result === 'boolean' ? result : null; }
      catch (_) { return null; }
    }
    function count(item) {
      if (state.loadState === 'unknown' || item.unavailable) return '—';
      const results = state.rows.map(row => matches(item, row));
      if (results.includes(null)) return '—';
      const n = results.filter(Boolean).length;
      return state.loadState === 'partial' ? n + ' · Partial' : String(n);
    }
    function snapshot() {
      return { selectedId: selected, loadState: state.loadState, shortcuts: state.shortcuts.map(item => ({ ...item })),
        items: items().map(item => ({ ...item, count: count(item), selected: item.id === selected })) };
    }
    function active() { if (ended) throw new Error('종료된 폴더 목록입니다.'); }
    // Selection policy extension point: only replace is supported until composition is agreed.
    function choose(id, reason) {
      active();
      const item = availableItems().find(item => item.id === id) || items().find(item => item.id === id);
      if (!item || item.unavailable) throw new Error('사용할 수 없는 폴더입니다.');
      selected = id; applied = { ...item };
      appliedSearch = state.searches.find(search => search.id === item.searchId);
      render();
      if (reason) onSelect({ ...item }, { mode: 'replace', reason });
    }
    function select(id) { choose(id, 'programmatic'); }
    function setApplied(id) { choose(id, null); }
    function update(patch) {
      active();
      if (!object(patch) || Object.keys(patch).some(key => !['rows', 'loadState', 'searches', 'shortcuts'].includes(key))) {
        throw new Error('폴더 갱신 형식을 확인해 주세요.');
      }
      state = validate({ ...state, ...patch });
      const current = state.shortcuts.find(item => 'shortcut:' + item.id === selected);
      if (current && current.searchId === applied.searchId) applied.name = current.name;
      render();
    }
    function change(next) { update({ shortcuts: next }); onChange(state.shortcuts.map(item => ({ ...item }))); }
    function add(item) {
      active();
      const next = validate({ ...state, shortcuts: [...state.shortcuts, item] });
      if (!state.searches.some(search => search.id === item.searchId)) throw new Error('기존 검색을 선택해 주세요.');
      change(next.shortcuts);
    }
    function index(id) {
      active(); const found = state.shortcuts.findIndex(item => item.id === id);
      if (found < 0) throw new Error('바로가기를 찾을 수 없습니다.');
      return found;
    }
    function rename(id, name) {
      const at = index(id), next = state.shortcuts.map(item => ({ ...item }));
      next[at].name = name; change(next);
    }
    function remove(id) { const at = index(id); change(state.shortcuts.filter((_, i) => i !== at)); }
    function reorder(id, to) {
      const at = index(id);
      if (!Number.isInteger(to) || to < 0 || to >= state.shortcuts.length) throw new Error('바로가기 순서를 확인해 주세요.');
      const next = [...state.shortcuts], [item] = next.splice(at, 1); next.splice(to, 0, item); change(next);
    }
    function element(tag, label) {
      const node = doc.createElement(tag); if (label !== undefined) node.textContent = label; return node;
    }
    function remember(node, key) { controls.set(key, node); return node; }
    function button(label, action, key) {
      const node = remember(element('button', label), key); node.type = 'button'; node.onclick = action; return node;
    }
    const status = element('p'); status.setAttribute('role', 'status'); status.setAttribute('lang', 'ko');
    function attempt(action) {
      status.textContent = '';
      try { action(); } catch (error) { status.textContent = error.message; }
    }
    function render() {
      const focused = [...controls].find(([, node]) => node === doc.activeElement)?.[0];
      // Background count updates must not discard an in-progress shortcut name.
      const drafts = new Map([...controls].filter(([, node]) => ['INPUT', 'SELECT'].includes(node.tagName)).map(([key, node]) => [key, node.value]));
      const expanded = new Set([...controls].filter(([, node]) => node.tagName === 'DETAILS' && node.open).map(([key]) => key));
      controls.clear();
      const list = element('ul');
      function itemRow(item, parent) {
        const li = element('li'), label = item.name + ' (' + count(item) + ')' + (item.unavailable ? ' · Unavailable' : '');
        const control = button(label, () => attempt(() => choose(item.id, 'user')), item.id);
        if (item.id === selected) control.setAttribute('aria-current', 'true');
        control.disabled = !!item.unavailable; li.append(control); parent.append(li); return li;
      }
      const all = items(); itemRow(all[0], list);
      for (const [kind, title] of [['shortcut', 'My Shortcuts'], ['modality', 'Modality']]) {
        const group = element('li'), children = element('ul'); children.hidden = collapsed.has(kind);
        const toggle = button(title, () => { collapsed.has(kind) ? collapsed.delete(kind) : collapsed.add(kind); render(); }, 'section:' + kind);
        toggle.setAttribute('aria-expanded', String(!children.hidden)); group.append(toggle, children); list.append(group);
        for (const item of all.filter(item => item.kind === kind)) {
          const li = itemRow(item, children);
          if (kind !== 'shortcut') continue;
          const id = item.shortcutId, at = state.shortcuts.findIndex(shortcut => shortcut.id === id);
          if (at < 0) continue;
          const editor = remember(element('details'), 'editor:' + id), summary = remember(element('summary', 'Edit Shortcut'), 'edit:' + id);
          editor.open = expanded.has('editor:' + id); editor.append(summary);
          const input = remember(element('input'), 'name:' + id); input.value = item.name; input.maxLength = 400;
          const label = element('label', 'Shortcut Name'); label.append(input);
          const up = button('Move Up', () => attempt(() => reorder(id, at - 1)), 'up:' + id); up.disabled = at === 0;
          const down = button('Move Down', () => attempt(() => reorder(id, at + 1)), 'down:' + id); down.disabled = at === state.shortcuts.length - 1;
          editor.append(label, button('Rename', () => attempt(() => rename(id, input.value)), 'rename:' + id),
            button('Remove', () => attempt(() => { remove(id); controls.get('all').focus(); }), 'remove:' + id), up, down);
          li.append(editor);
        }
      }
      const form = element('form'), name = remember(element('input'), 'add-name'), search = remember(element('select'), 'add-search');
      name.required = true; name.maxLength = 400;
      const nameLabel = element('label', 'Shortcut Name'), searchLabel = element('label', 'Saved Search');
      nameLabel.append(name); searchLabel.append(search);
      for (const source of state.searches) { const option = element('option', source.name); option.value = source.id; search.append(option); }
      const submit = remember(element('button', 'Add Shortcut'), 'add'); submit.type = 'submit'; submit.disabled = !state.searches.length;
      form.append(nameLabel, searchLabel, submit);
      form.onsubmit = event => {
        event.preventDefault(); attempt(() => {
          let id = 1; while (state.shortcuts.some(item => item.id === String(id))) ++id;
          add({ id: String(id), name: name.value, searchId: search.value });
          controls.get('add-name').value = '';
        });
      };
      nav.replaceChildren(list, form, status);
      for (const [key, value] of drafts) {
        const node = controls.get(key);
        if (node && (node.tagName !== 'SELECT' || state.searches.some(search => search.id === value))) node.value = value;
      }
      if (focused) controls.get(focused)?.focus();
    }
    state = validate({ rows, loadState, searches, shortcuts });
    host.append(nav); render();
    return { update, snapshot, select, setApplied, add, rename, remove, reorder,
      filter(list) { active(); const item = items().find(item => item.id === selected); return list.filter(row => matches(item, row) === true); },
      destroy() { if (!ended) { ended = true; nav.remove(); controls.clear(); } },
    };
  }
  return { mount, matchesModality, defaultModalities };
});

/* Loaded-list folders and personal shortcut editing, with caller-owned search and persistence. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KinWorklistFolderTree = api;
})(typeof window === 'object' ? window : null, function () {
  'use strict';
  const BASE = ['CT', 'MR', 'CR', 'US', 'SC'];
  let nextMountId = 0;
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
  // IDs are stable, nonblank strings of at most 400 characters without CR/LF. The
  // page adapter must namespace search IDs (own:<id>/shared:<id>), never use names.
  // Invalid searches are omitted individually; the first duplicate ID owns the slot.
  // Adapters capture immutable criteria. Updates never reapply a selection.
  // select(id | ids) replaces it; setApplied(id | ids) aligns it without a callback.
  // Only modalities compose (OR); filter() is applied to the caller's other criteria
  // (AND). [] matches nothing; only explicit 'all' clears the folder constraint.
  // onSelect receives an item for one selection, or {kind:'modality', modalities,
  // selectedIds} for several/none, with the same arrays on a single modality item.
  //
  // onChange emits a detached, complete ordered array of {id,name,searchId}, not a
  // saved acknowledgement. The caller owns owner/revision CAS, serial writes and
  // work-context response gates. Never merge entries from competing tab arrays.
  // On conflict/unknown outcome, retain the draft and block writes until a fresh
  // collection read; update({shortcuts}) can restore an authoritative array silently.
  // Account end must destroy this module. It owns neither storage nor transport.
  function mount({ host, rows = [], loadState = 'unknown', searches = [], shortcuts = [], onSelect, onChange }) {
    if (!host?.ownerDocument || typeof onSelect !== 'function' || typeof onChange !== 'function') {
      throw new Error('폴더 표시 영역과 변경 콜백을 확인해 주세요.');
    }
    const doc = host.ownerDocument;
    const sectionPrefix = 'worklist-folders-' + ++nextMountId;
    let state, selected = ['all'], applied = [{ id: 'all', name: 'All Studies', kind: 'all' }], appliedSearch, ended = false;
    const nav = doc.createElement('nav');
    nav.className = 'worklist-folder-tree'; nav.setAttribute('aria-label', 'Folders');
    const controls = new Map(), collapsed = new Set();
    function validate(next) {
      if (!Array.isArray(next.rows) || next.rows.some(row => !object(row))
        || !['complete', 'partial', 'unknown'].includes(next.loadState)
        || !Array.isArray(next.searches)
        || !Array.isArray(next.shortcuts) || next.shortcuts.length > 200
        || next.shortcuts.some(item => !object(item) || Object.keys(item).sort().join() !== 'id,name,searchId'
          || !text(item.id) || !text(item.name) || !text(item.searchId))
        || new Set(next.shortcuts.map(item => item.id)).size !== next.shortcuts.length) {
        throw new Error('폴더 목록 또는 바로가기 형식을 확인해 주세요.');
      }
      // 저장 검색 하나의 문제로 전체 건수를 잃지 않는다. 중복 ID는 첫 항목만 판단하며,
      // 첫 항목이 사용 불가여도 뒤 항목의 조건으로 대체하지 않는다.
      const seen = new Set();
      const searches = next.searches.filter(search => {
        if (!object(search) || !text(search.id) || seen.has(search.id)) return false;
        seen.add(search.id);
        return typeof search.name === 'string' && search.name.trim().length > 0 && typeof search.matches === 'function';
      }).map(search => ({ ...search }));
      const shortcuts = next.shortcuts.map(item => ({ ...item, name: item.name.trim() }));
      return { rows: [...next.rows], loadState: next.loadState,
        searches, shortcuts };
    }
    // 저장 데이터의 이름 충돌은 적재를 막지 않는다. 이름 정책은 지금 편집하는 항목에만 적용한다.
    function validateName(item) {
      const names = ['All Studies', ...BASE, ...state.shortcuts.filter(other => other.id !== item.id).map(other => other.name)];
      if (names.some(name => name.toUpperCase() === item.name.toUpperCase())) {
        throw new Error('이미 사용 중인 폴더 또는 바로가기 이름입니다. 다른 이름을 입력해 주세요.');
      }
    }
    function availableItems() {
      return [{ id: 'all', name: 'All Studies', kind: 'all' },
        ...state.shortcuts.map(item => ({ ...item, id: 'shortcut:' + item.id, shortcutId: item.id, kind: 'shortcut',
          unavailable: !state.searches.some(search => search.id === item.searchId) })),
        ...defaultModalities(state.rows).map(modality => ({ id: 'modality:' + modality, name: modality, modality, kind: 'modality' }))];
    }
    function items() {
      const result = availableItems();
      for (const item of applied) {
        const at = result.findIndex(candidate => candidate.id === item.id);
        if (at < 0) result.push({ ...item, unavailable: item.kind === 'shortcut' });
        else if (item.kind === 'shortcut' && result[at].searchId !== item.searchId) {
          result[at] = { ...item, unavailable: true };
        }
      }
      return result;
    }
    function matches(item, row) {
      if (item.kind === 'all') return true;
      if (item.kind === 'modality') return matchesModality(row.modality, item.modality);
      if (item.unavailable) return null;
      // A refreshed adapter must not silently replace the doctor's applied criteria.
      const search = selected.includes(item.id) ? appliedSearch : state.searches.find(search => search.id === item.searchId);
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
      return { selectedId: selected.length === 1 ? selected[0] : null, selectedIds: [...selected],
        loadState: state.loadState, shortcuts: state.shortcuts.map(item => ({ ...item })),
        items: items().map(item => ({ ...item, count: count(item), selected: selected.includes(item.id) })) };
    }
    function active() { if (ended) throw new Error('종료된 폴더 목록입니다.'); }
    function choose(value, reason) {
      active();
      const ids = (Array.isArray(value) ? [...value] : [value]).map(id => {
        if (typeof id !== 'string' || !id.startsWith('modality:')) return id;
        const token = id.slice('modality:'.length);
        if (!text(token) || /[,\\]/.test(token)) throw new Error('사용할 수 없는 폴더입니다.');
        return 'modality:' + token.trim().toUpperCase();
      });
      const available = availableItems();
      const next = ids.map(id => {
        const known = available.find(item => item.id === id);
        if (known) return known;
        // Re-login can restore an applied modality before any rows have arrived.
        if (typeof id === 'string' && id.startsWith('modality:')) {
          const modality = id.slice('modality:'.length);
          return { id, name: modality, modality, kind: 'modality' };
        }
      });
      if (new Set(ids).size !== ids.length) throw new Error('같은 폴더를 중복해서 선택할 수 없습니다.');
      if (next.some(item => !item || item.unavailable)) throw new Error('사용할 수 없는 폴더입니다.');
      if (next.length > 1 && next.some(item => item.kind !== 'modality')) {
        throw new Error('Modality만 함께 선택할 수 있습니다.');
      }
      selected = ids; applied = next.map(item => ({ ...item }));
      appliedSearch = state.searches.find(search => search.id === next[0]?.searchId);
      render();
      if (reason) {
        const selection = next.length === 1 ? { ...next[0] } : { kind: 'modality' };
        if (selection.kind === 'modality') {
          selection.modalities = next.map(item => item.modality);
          selection.selectedIds = [...selected];
        }
        onSelect(selection, { mode: 'replace', reason });
      }
    }
    function toggleModality(id) {
      const ids = applied.filter(item => item.kind === 'modality').map(item => item.id);
      choose(ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id], 'user');
    }
    function select(id) { choose(id, 'programmatic'); }
    function setApplied(id) { choose(id, null); }
    function update(patch) {
      active();
      try {
        if (!object(patch) || Object.keys(patch).some(key => !['rows', 'loadState', 'searches', 'shortcuts'].includes(key))) {
          throw new Error('폴더 갱신 형식을 확인해 주세요.');
        }
        state = validate({ ...state, ...patch });
      } catch (error) {
        // 갱신 실패 뒤 이전 건수를 최신 완료 건수로 오인하지 않도록 무효화한다.
        state = { ...state, loadState: 'unknown' };
        status.textContent = error.message;
        render();
        throw error;
      }
      status.textContent = '';
      const current = state.shortcuts.find(item => 'shortcut:' + item.id === selected[0]);
      if (current && current.searchId === applied[0]?.searchId) applied[0].name = current.name;
      render();
    }
    function change(next) { update({ shortcuts: next }); onChange(state.shortcuts.map(item => ({ ...item }))); }
    function add(item) {
      active();
      const next = validate({ ...state, shortcuts: [...state.shortcuts, item] });
      validateName(next.shortcuts[next.shortcuts.length - 1]);
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
      next[at].name = name;
      const valid = validate({ ...state, shortcuts: next });
      validateName(valid.shortcuts[at]);
      change(valid.shortcuts);
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
    const selectionStatus = element('p'); selectionStatus.setAttribute('role', 'status'); selectionStatus.setAttribute('lang', 'ko');
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
        const control = button(label, () => attempt(() => item.kind === 'modality'
          ? toggleModality(item.id) : choose(item.id, 'user')), item.id);
        if (item.kind === 'modality') control.setAttribute('aria-pressed', String(selected.includes(item.id)));
        else if (selected.includes(item.id)) control.setAttribute('aria-current', 'true');
        control.disabled = !!item.unavailable; li.append(control); parent.append(li); return li;
      }
      const all = items(); itemRow(all[0], list);
      for (const [kind, title] of [['shortcut', 'My Shortcuts'], ['modality', 'Modality']]) {
        const group = element('li'), children = element('ul'); children.hidden = collapsed.has(kind);
        const toggle = button(title, () => { collapsed.has(kind) ? collapsed.delete(kind) : collapsed.add(kind); render(); }, 'section:' + kind);
        toggle.setAttribute('id', sectionPrefix + '-' + kind);
        children.setAttribute('aria-labelledby', toggle.getAttribute('id'));
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
      selectionStatus.textContent = selected.length ? '' : '선택된 Modality가 없습니다. All Studies 또는 Modality를 선택해 주세요.';
      nav.replaceChildren(list, form, status, selectionStatus);
      for (const [key, value] of drafts) {
        const node = controls.get(key);
        if (node && (node.tagName !== 'SELECT' || state.searches.some(search => search.id === value))) node.value = value;
      }
      if (focused) controls.get(focused)?.focus();
    }
    state = validate({ rows, loadState, searches, shortcuts });
    host.append(nav); render();
    return { update, snapshot, select, setApplied, add, rename, remove, reorder,
      filter(list) {
        active(); const chosen = items().filter(item => selected.includes(item.id));
        return list.filter(row => chosen.some(item => matches(item, row) === true));
      },
      destroy() { if (!ended) { ended = true; nav.remove(); controls.clear(); } },
    };
  }
  return { mount, matchesModality, defaultModalities };
});

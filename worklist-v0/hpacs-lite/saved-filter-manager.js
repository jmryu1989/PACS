/* Personal saved-search editor. Opening or editing never applies a worklist filter. */
(function () {
  'use strict';
  window.KinSavedFilterManager = { mount };

  function mount(options) {
    const dialog = document.createElement('dialog');
    dialog.id = 'saved-filter-manager';
    dialog.setAttribute('aria-labelledby', 'sfm-title');
    dialog.innerHTML = `
      <header><div><h2 id="sfm-title">저장 검색 관리</h2><p>자주 쓰는 검사 검색을 계정에 저장합니다.</p></div>
        <button type="button" id="sfm-close" aria-label="저장 검색 관리 닫기">닫기</button></header>
      <div class="sfm-body"><aside aria-label="저장 검색 목록">
        <label for="sfm-search">저장 검색 찾기</label><input id="sfm-search" type="search" placeholder="이름·설명·폴더">
        <button type="button" id="sfm-new">현재 조건으로 새 검색</button>
        <div id="sfm-list"></div><button type="button" id="sfm-reload">목록 다시 불러오기</button>
      </aside><form id="sfm-form"><fieldset id="sfm-fields">
        <legend id="sfm-heading">새 검색</legend>
        <label for="sfm-name">검색 이름</label><input id="sfm-name" required>
        <small id="sfm-name-hint">같은 이름을 저장하면 확인 후 해당 검색을 덮어씁니다.</small>
        <label for="sfm-folder">폴더 경로</label><input id="sfm-folder" list="sfm-folders" maxlength="204" placeholder="예: 흉부/추적 검사"><datalist id="sfm-folders"></datalist>
        <small>빈 값은 미분류입니다. /로 구분해 최대 5단계로 묶습니다. 빈 폴더는 별도로 저장하지 않습니다.</small>
        <label for="sfm-description">검색 설명</label><textarea id="sfm-description" rows="2" maxlength="1000"></textarea>
        <label for="sfm-ordinal">폴더 안 표시 순서 (작은 값 먼저)</label><input id="sfm-ordinal" type="number" min="0" max="9999" step="1" required>
        <div class="sfm-grid">
          <label>업무 화면<select id="sfm-mode"><option value="Radiology">판독</option><option value="Technician">촬영</option></select></label>
          <label>검사 날짜<select id="sfm-days"></select></label>
        </div>
        <label for="sfm-quick">환자 ID 또는 이름</label><input id="sfm-quick">
        <div id="sfm-cols" class="sfm-grid"></div>
        <div class="sfm-grid">
          <label>정렬 열<select id="sfm-sort"></select></label>
          <label>정렬 방향<select id="sfm-direction"><option value="0">기본 순서</option><option value="1">오름차순</option><option value="-1">내림차순</option></select></label>
        </div>
        <label class="sfm-default"><input type="checkbox" id="sfm-default"> 로그인할 때 이 검색 적용</label>
        <p id="sfm-count" role="status"></p>
      </fieldset><footer>
        <button type="button" id="sfm-delete">삭제</button>
        <button type="button" id="sfm-apply">저장된 조건 적용</button>
        <button type="submit" id="sfm-save">저장</button>
      </footer></form></div>
      <p id="sfm-status" role="status" aria-live="polite"></p>`;
    document.body.append(dialog);
    const header = dialog.querySelector('header');
    new ResizeObserver(() => dialog.style.setProperty('--sfm-header-height', header.offsetHeight + 'px')).observe(header);
    const $ = id => dialog.querySelector('#sfm-' + id);
    let selected = null, source = {}, baseline = '', busy = false, opener = null, editable = true;
    const collapsed = new Set();
    const copy = value => JSON.parse(JSON.stringify(value));
    const named = name => options.list().find(f => f.name === name);
    const status = (message, error = false) => {
      $('status').textContent = message;
      $('status').classList.toggle('sfm-error', error);
      if (error && dialog.open) $('status').scrollIntoView({ block: 'nearest' });
    };
    function value() {
      // Keep columns from the other worklist mode; changing tabs must not erase them.
      const cols = { ...source.cols };
      dialog.querySelectorAll('[data-col]').forEach(input => { cols[input.dataset.col] = input.value; });
      const sortKey = $('sort').value || null;
      return { name: $('name').value.trim(), mode: $('mode').value, days: Number($('days').value),
        folder: $('folder').value.trim(), description: $('description').value, ordinal: Number($('ordinal').value),
        quick: $('quick').value, cols, sortKey, sortDir: sortKey ? Number($('direction').value) : 0,
        isDefault: $('default').checked };
    }
    const dirty = () => editable && JSON.stringify(value()) !== baseline;
    const mayLeave = () => !busy && (!dirty() || confirm('저장하지 않은 검색 조건 변경을 버릴까요?'));
    function lock(on) {
      busy = on;
      dialog.setAttribute('aria-busy', String(on));
      dialog.querySelectorAll('button, input, select, textarea, fieldset').forEach(el => { el.disabled = on; });
      $('fields').disabled = on || !editable;
      $('save').disabled = on || !editable;
      $('delete').disabled = on || selected === null;
      $('apply').disabled = on || selected === null;
    }
    function choices(select, entries, selectedValue) {
      select.replaceChildren(...entries.map(([key, label]) => {
        const option = document.createElement('option'); option.value = key; option.textContent = label;
        return option;
      }));
      if (selectedValue != null && !entries.some(([key]) => String(key) === String(selectedValue))) {
        const option = document.createElement('option'); option.value = selectedValue;
        option.textContent = String(selectedValue); select.append(option);
      }
      select.value = selectedValue ?? '';
    }
    function columns(filter) {
      const cols = options.columns[$('mode').value];
      $('cols').replaceChildren(...cols.filter(c => c.f).map(c => {
        const label = document.createElement('label'); label.textContent = c.t;
        const input = document.createElement(c.f === 'text' ? 'input' : 'select');
        input.dataset.col = c.k; input.id = 'sfm-col-' + c.k;
        if (c.f !== 'text') choices(input, [['', '전체'], ...c.f.map(v => [v, v])], filter.cols?.[c.k] ?? '');
        else input.value = filter.cols?.[c.k] ?? '';
        label.append(input); return label;
      }));
      const sort = cols.some(c => c.k === filter.sortKey) ? filter.sortKey : '';
      choices($('sort'), [['', '기본 순서'], ...cols.map(c => [c.k, c.t])], sort);
      $('direction').value = sort ? String(filter.sortDir || 0) : '0';
    }
    function count() {
      $('count').textContent = `편집 중 조건: 로드된 목록 기준 ${options.count(value())}건 · 모든 열 조건을 함께 적용합니다.`;
    }
    function edit(filter, isNew = false) {
      // Reject unsupported stored modes instead of presenting an editable substitute.
      if (!filter || !Array.isArray(options.columns[filter.mode])) {
        editable = false; selected = null; $('fields').hidden = true; lock(false); list();
        status('이 검색이 변경됐거나 업무 화면을 확인할 수 없습니다. 목록을 다시 불러오거나 현재 조건으로 새 검색을 만드세요.', true);
        return false;
      }
      editable = true; $('fields').hidden = false;
      source = copy(filter); selected = isNew ? null : filter.name;
      $('heading').textContent = isNew ? '새 검색' : '저장 조건 편집';
      $('name').value = isNew ? '' : filter.name;
      $('name').readOnly = !isNew;
      $('name-hint').textContent = isNew ? '같은 계정에서는 폴더가 달라도 이름이 같으면 기존 검색을 덮어씁니다. 변경하지 않은 분류 정보는 유지합니다.'
        : '기존 검색 이름은 유지됩니다. 조건을 바꾸고 저장하세요.';
      $('quick').value = filter.quick ?? ''; $('mode').value = filter.mode;
      $('folder').value = typeof filter.folder === 'string' ? filter.folder : '';
      $('description').value = typeof filter.description === 'string' ? filter.description : '';
      $('ordinal').value = Number.isInteger(filter.ordinal) ? String(filter.ordinal) : '0';
      choices($('days'), [[-1, '전체 날짜'], [0, '오늘'], [3, '최근 3일'], [7, '최근 7일'],
        [30, '최근 30일'], [60, '최근 60일']], options.days(filter.days));
      $('default').checked = !!filter.isDefault;
      columns(filter); baseline = JSON.stringify(value()); lock(false); count(); list();
      return true;
    }
    function list() {
      const query = $('search').value.trim().toLocaleLowerCase();
      const all = options.list();
      const folderOf = f => typeof f.folder === 'string' ? f.folder : '';
      $('folders').replaceChildren(...[...new Set(all.map(folderOf).filter(Boolean))].sort().map(path => {
        const option = document.createElement('option'); option.value = path; return option;
      }));
      const filters = all.filter(f => [f.name, f.description, folderOf(f)].some(v =>
        typeof v === 'string' && v.toLocaleLowerCase().includes(query)));
      const root = { children: new Map(), filters: [] };
      for (const filter of filters) {
        let node = root;
        for (const part of folderOf(filter).split('/').filter(Boolean).slice(0, 5)) {
          if (!node.children.has(part)) node.children.set(part, { children: new Map(), filters: [] });
          node = node.children.get(part);
        }
        node.filters.push(filter);
      }
      function searchButton(f) {
        const button = document.createElement('button'); button.type = 'button'; button.dataset.name = f.name;
        button.setAttribute('aria-pressed', String(f.name === selected));
        button.setAttribute('aria-label', `${f.isDefault ? '기본 검색 ' : ''}${f.name}`);
        button.textContent = `${f.isDefault ? '⚑ ' : ''}${f.name}`;
        if (typeof f.description === 'string' && f.description) {
          const hint = document.createElement('small'); hint.textContent = f.description; button.append(hint);
        }
        button.addEventListener('click', () => { if (mayLeave() && edit(named(f.name))) { status(''); $('quick').focus(); } });
        return button;
      }
      function branch(node, container, parentPath = '') {
        for (const [name, child] of [...node.children].sort(([a], [b]) => a.localeCompare(b))) {
          const path = parentPath ? parentPath + '/' + name : name;
          const details = document.createElement('details'); details.dataset.folder = path;
          details.open = !!query || !collapsed.has(path);
          details.addEventListener('toggle', () => {
            if (details.isConnected && !$('search').value.trim()) {
              if (details.open) collapsed.delete(path); else collapsed.add(path);
            }
          });
          const summary = document.createElement('summary'); summary.textContent = name;
          details.append(summary); branch(child, details, path); container.append(details);
        }
        node.filters.sort((a, b) => (Number.isInteger(a.ordinal) ? a.ordinal : 0) -
          (Number.isInteger(b.ordinal) ? b.ordinal : 0) || a.name.localeCompare(b.name));
        node.filters.forEach(f => container.append(searchButton(f)));
      }
      $('list').replaceChildren(); branch(root, $('list'));
      if (!filters.length) $('list').textContent = query ? '일치하는 저장 검색이 없습니다.' : '저장한 검색이 없습니다.';
    }
    async function run(action) {
      if (busy) return;
      lock(true); status('처리 중…');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try { await action(controller.signal); }
      catch (error) { status(controller.signal.aborted
        ? '응답 시간이 초과되었습니다. 입력은 유지했습니다. 서버 처리 여부는 목록을 다시 불러와 확인하세요.'
        : error.message || '처리하지 못했습니다. 입력을 유지했습니다.', true); }
      finally { clearTimeout(timeout); lock(false); }
    }
    $('form').addEventListener('submit', e => {
      e.preventDefault(); if (busy || !editable || !$('form').reportValidity()) return;
      const next = value();
      if (!next.name) { status('검색 이름을 입력하세요.', true); $('name').focus(); return; }
      const existing = selected === null ? named(next.name) : null;
      if (existing) {
        // Starting from current criteria must not erase classification merely
        // because the new-search form began with empty metadata defaults.
        const initial = JSON.parse(baseline);
        for (const key of ['folder', 'description', 'ordinal']) {
          if (next[key] === initial[key]) next[key] = existing[key] ?? initial[key];
        }
        if (!confirm(`저장 검색 "${next.name}"을 덮어쓸까요? 검색 조건과 변경한 폴더·설명·순서를 저장합니다.\n저장할 폴더: ${next.folder || '미분류'} · 순서: ${next.ordinal}\n설명: ${next.description || '(없음)'}`)) return;
      }
      run(async signal => {
        const saved = await options.save(next, signal);
        if (edit(saved)) status(`"${saved.name}" 저장 완료. 목록에 적용하려면 ‘저장된 조건 적용’을 누르세요.`);
      });
    });
    $('delete').addEventListener('click', () => {
      if (busy || selected === null) return;
      const filter = named(selected);
      if (!filter) { status('저장 검색이 변경됐습니다. 목록을 다시 불러오세요.', true); list(); return; }
      if (!confirm(`저장 검색 "${filter.name}"을 삭제할까요? 검사와 판독문은 삭제되지 않습니다.`)) return;
      run(async signal => {
        await options.remove(filter, signal); edit(options.snapshot(), true); status('저장 검색을 삭제했습니다.');
      });
    });
    $('apply').addEventListener('click', () => {
      if (selected === null || !mayLeave()) return;
      const filter = named(selected);
      if (!filter) { status('저장 검색이 변경됐습니다. 목록을 다시 불러오세요.', true); return; }
      if (options.apply(filter) === false) { status('저장 검색을 적용하지 못했습니다. 조건을 확인하세요.', true); return; }
      baseline = JSON.stringify(value()); dialog.close();
    });
    $('mode').addEventListener('change', () => { source = value(); columns(source); count(); });
    $('form').addEventListener('input', e => {
      if (!['sfm-name', 'sfm-folder', 'sfm-description', 'sfm-ordinal', 'sfm-default'].includes(e.target.id)) count();
    });
    $('search').addEventListener('input', list);
    $('new').addEventListener('click', () => {
      if (mayLeave()) { edit(options.snapshot(), true); status(''); $('name').focus(); }
    });
    $('reload').addEventListener('click', () => {
      if (!mayLeave()) return;
      run(async signal => {
        await options.reload(signal);
        if (edit(named(selected) || options.snapshot(), !named(selected))) status('저장 검색 목록을 불러왔습니다.');
      });
    });
    $('close').addEventListener('click', () => { if (mayLeave()) dialog.close(); });
    dialog.addEventListener('cancel', e => { e.preventDefault(); if (mayLeave()) dialog.close(); });
    dialog.addEventListener('close', () => opener?.focus());
    window.addEventListener('beforeunload', e => {
      if (dialog.open && (busy || dirty())) { e.preventDefault(); e.returnValue = ''; }
    });
    return { open() {
      if (dialog.open) return;
      opener = document.activeElement; $('search').value = ''; status('');
      edit(options.snapshot(), true); dialog.showModal(); $('search').focus();
    } };
  }
})();

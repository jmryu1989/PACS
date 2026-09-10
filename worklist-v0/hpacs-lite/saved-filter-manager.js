/* Personal saved-search editor. Opening or editing never applies a worklist filter. */
(function () {
  'use strict';
  window.KinSavedFilterManager = { mount };

  function mount(options) {
    const dialog = document.createElement('dialog');
    dialog.id = 'saved-filter-manager';
    dialog.setAttribute('aria-labelledby', 'sfm-title');
    dialog.innerHTML = `
      <header><div><h2 id="sfm-title">Saved Search Manager</h2><p>조건으로 목록을 검색하고 자주 쓰는 검색을 계정에 저장합니다.</p></div>
        <button type="button" id="sfm-close" aria-label="Close Saved Search Manager">Close</button></header>
      <div class="sfm-body"><aside aria-label="Saved searches">
        <label for="sfm-search">Find Saved Search</label><input id="sfm-search" type="search" placeholder="이름·설명·폴더">
        <button type="button" id="sfm-new">New from Current</button>
        <nav class="sfm-navigation" aria-label="Saved search navigation">
          <button type="button" id="sfm-prev" aria-controls="sfm-fields">Previous</button>
          <button type="button" id="sfm-next" aria-controls="sfm-fields">Next</button>
        </nav><p id="sfm-position" role="status" aria-live="polite" tabindex="-1"></p>
        <div id="sfm-list"></div><button type="button" id="sfm-reload">Reload List</button>
        <details id="sfm-organize"><summary>Folders &amp; Bulk Actions</summary>
          <p><small>폴더는 검색이 없어도 보관됩니다. 폴더 작업 전 ‘Load Folders’를 눌러 최신 검색 모음을 확인하세요.</small></p>
          <button type="button" id="sfm-load-folders">Load Folders</button>
          <label for="sfm-folder-path">Folder to Edit</label><input id="sfm-folder-path" list="sfm-folders" maxlength="204">
          <label for="sfm-folder-description">Folder Description</label><textarea id="sfm-folder-description" maxlength="1000" rows="2"></textarea>
          <label for="sfm-folder-order">Folder Order</label><input id="sfm-folder-order" type="number" min="0" max="9999" value="0">
          <button type="button" id="sfm-folder-save">Save Folder</button>
          <label for="sfm-folder-destination">Destination Path</label><input id="sfm-folder-destination" list="sfm-folders" maxlength="204">
          <small>폴더 이동은 새 전체 경로를 입력합니다. 선택 검색 이동에서 빈 값은 미분류입니다.</small>
          <button type="button" id="sfm-folder-move">Move Folder</button>
          <button type="button" id="sfm-folder-remove">Remove Folder</button>
          <p id="sfm-bulk-count" role="status">0 selected</p>
          <button type="button" id="sfm-bulk-clear">Clear Selection</button>
          <button type="button" id="sfm-bulk-move">Move Selected</button>
          <button type="button" id="sfm-bulk-delete">Delete Selected</button>
        </details>
      </aside><form id="sfm-form"><fieldset id="sfm-fields">
        <legend id="sfm-heading">New Search</legend>
        <label for="sfm-name">Search Name</label><input id="sfm-name" required aria-describedby="sfm-name-hint">
        <small id="sfm-name-hint">같은 이름을 저장하면 확인 후 해당 검색을 덮어씁니다.</small>
        <label for="sfm-folder">Folder Path</label><input id="sfm-folder" list="sfm-folders" maxlength="204" placeholder="예: 흉부/추적 검사"><datalist id="sfm-folders"></datalist>
        <small>빈 값은 미분류입니다. /로 구분해 최대 5단계로 묶습니다. ‘Folders &amp; Bulk Actions’에서 빈 폴더도 보관할 수 있습니다.</small>
        <label for="sfm-description">Description</label><textarea id="sfm-description" rows="2" maxlength="1000"></textarea>
        <label for="sfm-ordinal">Folder Order</label><input id="sfm-ordinal" type="number" min="0" max="9999" step="1" required aria-describedby="sfm-order-hint">
        <small id="sfm-order-hint">작은 값부터 표시합니다.</small>
        <div class="sfm-grid">
          <label>Worklist Mode<select id="sfm-mode"><option value="Radiology">Radiology</option><option value="Technician">Technician</option></select></label>
          <label>Study Date<select id="sfm-days"></select></label>
        </div>
        <label for="sfm-quick">Patient ID or Name</label><input id="sfm-quick">
        <div id="sfm-cols" class="sfm-grid"></div>
        <section class="sfm-compound" aria-labelledby="sfm-compound-title">
          <h3 id="sfm-compound-title">Compound Criteria</h3>
          <p><small>위 기본 조건을 모두 만족하는 검사 안에서 아래 조건을 적용합니다. 문자 대소문자는 구분하지 않으며, ‘Is Empty’는 미입력 값입니다. 부정 조건에는 미입력 값이 포함되지 않습니다.</small></p>
          <label>Match Criteria<select id="sfm-join"><option value="and">All (AND)</option><option value="or">Any (OR)</option></select></label>
          <div id="sfm-rules"></div>
          <button type="button" id="sfm-add-rule">Add Rule</button>
          <button type="button" id="sfm-add-group">Add Group</button>
          <button type="button" id="sfm-clear-rules">Clear Criteria</button>
          <small>조건 합계 20개 · 그룹 중첩 5단계 · 빈 그룹은 검색할 수 없습니다. 검색 값은 한 줄이며 날짜 범위는 양 끝을 포함합니다.</small>
          <p><small>‘Search Draft’는 편집 조건을 목록에만 적용합니다. 계정에 보관하려면 검색 이름을 입력하고 ‘Save’를 누르세요. ‘Save &amp; Apply’는 저장에 성공한 조건으로 목록을 검색합니다.</small></p>
        </section>
        <div class="sfm-grid">
          <label>Sort Column<select id="sfm-sort"></select></label>
          <label>Sort Direction<select id="sfm-direction"><option value="0">Default Order</option><option value="1">Ascending</option><option value="-1">Descending</option></select></label>
        </div>
        <label class="sfm-default"><input type="checkbox" id="sfm-default"> Apply on Sign In</label>
        <p id="sfm-count" role="status"></p>
      </fieldset></form></div><footer aria-label="Saved search actions">
        <button type="button" id="sfm-copy">Save As New</button>
        <button type="button" id="sfm-delete">Delete</button>
        <button type="button" id="sfm-preview">Search Draft</button>
        <button type="button" id="sfm-apply">Apply Saved</button>
        <button type="submit" form="sfm-form" id="sfm-save">Save</button>
        <button type="submit" form="sfm-form" id="sfm-save-apply">Save &amp; Apply</button>
      </footer>
      <p id="sfm-status" role="status" aria-live="polite" tabindex="-1"></p>`;
    document.body.append(dialog);
    const $ = id => dialog.querySelector('#sfm-' + id);
    let selected = null, source = {}, baseline = '', busy = false, opener = null, editable = true;
    let copying = false, visibleNames = [], missingName = null, cursor = null;
    const collapsed = new Set();
    const checked = new Set();
    let collection = null, folderBaseline = '';
    const folderValue = () => JSON.stringify(['folder-path', 'folder-description', 'folder-order', 'folder-destination'].map(id => $(id).value));
    const folderDirty = () => folderBaseline && folderValue() !== folderBaseline;
    const copy = value => JSON.parse(JSON.stringify(value));
    const compound = KinCompoundFilter;
    const operatorLabels = { contains: 'Contains', eq: 'Equals', notContains: 'Does Not Contain',
      neq: 'Does Not Equal', empty: 'Is Empty', notEmpty: 'Is Not Empty', gte: 'On or After',
      lte: 'On or Before', between: 'Between (Inclusive)' };
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
      function readRules(container) { return [...container.children].map(row => {
        if (row.classList.contains('sfm-group')) return {
          join: row.querySelector(':scope > .sfm-group-join').value,
          rules: readRules(row.querySelector(':scope > .sfm-group-rules')),
        };
        const rule = { field: row.querySelector('[data-rule-field]').value, op: row.querySelector('[data-rule-op]').value };
        if (!['empty', 'notEmpty'].includes(rule.op)) rule.value = row.querySelector('[data-rule-value]').value;
        if (rule.op === 'between') rule.value2 = row.querySelector('[data-rule-value2]').value;
        return rule;
      }); }
      const rules = readRules($('rules'));
      if (rules.length) cols[compound.KEY] = { version: 1, join: $('join').value, rules };
      else delete cols[compound.KEY];
      const sortKey = $('sort').value || null;
      return { name: $('name').value.trim(), mode: $('mode').value, days: Number($('days').value),
        folder: $('folder').value.trim(), description: $('description').value, ordinal: Number($('ordinal').value),
        quick: $('quick').value, cols, sortKey, sortDir: sortKey ? Number($('direction').value) : 0,
        isDefault: $('default').checked };
    }
    const dirty = () => editable && JSON.stringify(value()) !== baseline;
    const organizerDirty = () => folderDirty() || sharing.dirty();
    const mayLeave = () => !busy && (!(dirty() || organizerDirty()) || confirm('저장하지 않은 검색 조건 또는 폴더 변경을 버릴까요?'));
    function focusAvailable(...targets) {
      if (!dialog.open) return;
      for (const target of targets) {
        if (!target?.isConnected || !dialog.contains(target) || target.matches(':disabled') || !target.getClientRects().length) continue;
        target.focus();
        if (document.activeElement === target) return;
      }
    }
    function lock(on) {
      busy = on;
      dialog.setAttribute('aria-busy', String(on));
      dialog.querySelectorAll('button, input, select, textarea, fieldset').forEach(el => { el.disabled = on; });
      $('fields').disabled = on || !editable;
      $('save').disabled = on || !editable;
      $('save-apply').disabled = on || !editable;
      $('copy').disabled = on || !editable || selected === null;
      $('preview').disabled = on || !editable;
      $('delete').disabled = on || selected === null;
      $('apply').disabled = on || selected === null;
      for (const id of ['folder-save', 'folder-move', 'folder-remove', 'bulk-move', 'bulk-delete']) $(id).disabled = on || !collection;
      sharing.lock(on);
      navigation();
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
        if (c.f !== 'text') choices(input, [['', 'All'], ...c.f.map(v => [v, v])], filter.cols?.[c.k] ?? '');
        else input.value = filter.cols?.[c.k] ?? '';
        label.append(input); return label;
      }));
      const sort = cols.some(c => c.k === filter.sortKey) ? filter.sortKey : '';
      choices($('sort'), [['', 'Default Order'], ...cols.map(c => [c.k, c.t])], sort);
      $('direction').value = sort ? String(filter.sortDir || 0) : '0';
    }
    function ruleRow(rule) {
      const row = document.createElement('div'); row.className = 'sfm-rule';
      const fields = compound.fields(options.columns[$('mode').value]);
      const field = fields.find(f => f.k === rule.field);
      const make = (text, element, key) => {
        const label = document.createElement('label'); label.textContent = text;
        element.dataset[key] = ''; label.append(element); row.append(label); return element;
      };
      const fieldInput = make('Field', document.createElement('select'), 'ruleField');
      choices(fieldInput, fields.map(f => [f.k, f.k === 'date' && f.t === '검사일' ? 'Study Date' : f.t]), rule.field);
      const operator = make('Operator', document.createElement('select'), 'ruleOp');
      choices(operator, field ? compound.operators(field).map(([op]) => [op, operatorLabels[op] || op]) : [[rule.op, rule.op]], rule.op);
      const input = make('Value', document.createElement(field?.type === 'select' ? 'select' : 'input'), 'ruleValue');
      if (field?.type === 'select') choices(input, [['', 'Select Value'], ...field.values.map(v => [v, v])], rule.value ?? '');
      else { input.type = field?.type === 'date' ? 'date' : 'text'; input.maxLength = 1000; input.value = rule.value ?? ''; }
      const end = make('End Date', document.createElement('input'), 'ruleValue2');
      end.type = 'date'; end.value = rule.value2 ?? '';
      const remove = document.createElement('button'); remove.type = 'button'; remove.dataset.ruleRemove = '';
      remove.textContent = 'Remove'; remove.setAttribute('aria-label', 'Remove Rule'); row.append(remove);
      const visibility = () => {
        input.parentElement.hidden = ['empty', 'notEmpty'].includes(operator.value);
        end.parentElement.hidden = operator.value !== 'between';
      };
      visibility();
      operator.addEventListener('change', () => { visibility(); count(); });
      fieldInput.addEventListener('change', () => {
        const nextField = fields.find(f => f.k === fieldInput.value);
        const next = ruleRow({ field: nextField.k, op: compound.operators(nextField)[0][0], value: '' });
        row.replaceWith(next); next.querySelector('[data-rule-field]').focus(); count();
      });
      remove.addEventListener('click', () => { row.remove(); count(); $('add-rule').focus(); });
      return row;
    }
    function rules(filter) {
      const expression = filter.cols?.[compound.KEY];
      $('join').value = expression?.join ?? 'and';
      $('rules').replaceChildren(...(expression?.rules ?? []).map(node => nodeRow(node, 1)));
    }
    function nodeRow(node, depth) {
      if (!Object.prototype.hasOwnProperty.call(node, 'rules')) return ruleRow(node);
      const group = document.createElement('section'); group.className = 'sfm-group';
      group.setAttribute('aria-label', 'Criteria Group, Level ' + depth);
      const join = document.createElement('select'); join.className = 'sfm-group-join'; join.setAttribute('aria-label', 'Match Group Criteria');
      choices(join, [['and','All in Group (AND)'],['or','Any in Group (OR)']], node.join);
      const children = document.createElement('div'); children.className = 'sfm-group-rules';
      children.append(...node.rules.map(child => nodeRow(child, depth + 1)));
      group.append(join, children);
      for (const [action, label] of [['rule','Add Rule'],['group','Add Subgroup'],['remove','Remove Group']]) {
        const button = document.createElement('button'); button.type = 'button'; button.dataset.groupAction = action; button.textContent = label;
        button.addEventListener('click', () => {
          if (busy || !editable) return;
          if (action === 'remove') { group.remove(); count(); $('add-group').focus(); return; }
          addNode(children, action, depth + 1);
        });
        group.append(button);
      }
      return group;
    }
    function addNode(container, kind, depth) {
      if (busy || !editable) return;
      if ($('rules').querySelectorAll('.sfm-rule,.sfm-group').length >= 40
        || (kind === 'rule' && $('rules').querySelectorAll('.sfm-rule').length >= 20)
        || (kind === 'group' && depth > 5)) {
        status('조건 20개·항목/그룹 합계 40개·중첩 5단계 제한을 확인하세요.', true); return;
      }
      const row = nodeRow(kind === 'group' ? { join:'or', rules:[] } : { field:'id', op:'contains', value:'' }, depth);
      container.append(row); row.querySelector('select').focus(); count();
    }
    function count() {
      const filter = value();
      const error = compound.validate(filter.cols[compound.KEY], options.columns[filter.mode]);
      $('count').textContent = error ? '복합 조건 오류: ' + error
        : `편집 중 조건: 로드된 목록 기준 ${options.count(filter)}건 · 기본 조건 AND 복합 조건을 적용합니다.`;
      $('count').classList.toggle('sfm-error', !!error);
    }
    function edit(filter, isNew = false) {
      copying = false; missingName = null;
      // Invalid stored criteria still occupy a list position, but cannot be applied.
      cursor = isNew ? null : filter?.name ?? null;
      // Reject unsupported stored modes instead of presenting an editable substitute.
      if (!filter || !Array.isArray(options.columns[filter.mode])) {
        editable = false; selected = null; $('fields').hidden = true; lock(busy); list();
        status('이 검색이 변경됐거나 업무 화면을 확인할 수 없습니다. ‘Reload List’로 다시 불러오거나 ‘New from Current’로 새 검색을 만드세요.', true);
        return false;
      }
      const error = compound.validate(filter.cols?.[compound.KEY], options.columns[filter.mode]);
      if (error) {
        editable = false; selected = null; $('fields').hidden = true; lock(busy); list();
        status('저장된 복합 조건을 확인할 수 없습니다: ' + error + ' ‘New from Current’로 새 검색을 만들거나 ‘Reload List’로 다시 불러오세요.', true);
        return false;
      }
      editable = true; $('fields').hidden = false;
      source = copy(filter); selected = isNew ? null : filter.name;
      $('heading').textContent = isNew ? 'New Search' : 'Edit Saved Search';
      $('name').value = isNew ? '' : filter.name;
      $('name').readOnly = !isNew;
      $('name-hint').textContent = isNew ? '같은 계정에서는 폴더가 달라도 이름이 같으면 기존 검색을 덮어씁니다. 변경하지 않은 분류 정보는 유지합니다.'
        : '기존 검색 이름은 유지됩니다. 조건을 바꾸고 ‘Save’를 누르세요.';
      $('quick').value = filter.quick ?? ''; $('mode').value = filter.mode;
      $('folder').value = typeof filter.folder === 'string' ? filter.folder : '';
      $('description').value = typeof filter.description === 'string' ? filter.description : '';
      $('ordinal').value = Number.isInteger(filter.ordinal) ? String(filter.ordinal) : '0';
      choices($('days'), [[-1, 'All Dates'], [0, 'Today'], [3, 'Last 3 Days'], [7, 'Last 7 Days'],
        [30, 'Last 30 Days'], [60, 'Last 60 Days']], options.days(filter.days));
      $('default').checked = !!filter.isDefault;
      columns(filter); rules(filter); baseline = JSON.stringify(value()); lock(busy); count(); list();
      return true;
    }
    function list() {
      const query = $('search').value.trim().toLocaleLowerCase();
      const all = options.list();
      const folderOf = f => typeof f.folder === 'string' ? f.folder : '';
      const metadata = new Map((collection?.folders || []).map(folder => [folder.path, folder]));
      $('folders').replaceChildren(...[...new Set([...all.map(folderOf).filter(Boolean), ...metadata.keys()])].sort().map(path => {
        const option = document.createElement('option'); option.value = path; return option;
      }));
      const filters = all.filter(f => [f.name, f.description, folderOf(f)].some(v =>
        typeof v === 'string' && v.toLocaleLowerCase().includes(query)));
      const root = { children: new Map(), filters: [] };
      for (const folder of metadata.values()) {
        if (query && ![folder.path, folder.description].some(text => text.toLocaleLowerCase().includes(query))) continue;
        let node = root;
        for (const part of folder.path.split('/')) {
          if (!node.children.has(part)) node.children.set(part, { children: new Map(), filters: [] });
          node = node.children.get(part);
        }
      }
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
        button.disabled = busy;
        button.setAttribute('aria-pressed', String(f.name === cursor));
        button.setAttribute('aria-label', `${f.isDefault ? 'Default Search: ' : ''}${f.name}`);
        button.textContent = `${f.isDefault ? '⚑ ' : ''}${f.name}`;
        if (typeof f.description === 'string' && f.description) {
          const hint = document.createElement('small'); hint.textContent = f.description; button.append(hint);
        }
        button.addEventListener('click', () => selectSearch(f.name));
        const row = document.createElement('div'); row.className = 'sfm-search-row';
        const check = document.createElement('input'); check.type = 'checkbox'; check.disabled = busy || !Number.isInteger(f.id);
        check.setAttribute('aria-label', 'Select Search: ' + f.name); check.checked = checked.has(f.id);
        check.addEventListener('change', () => {
          if (check.checked) checked.add(f.id); else checked.delete(f.id);
          $('bulk-count').textContent = `${checked.size} selected`;
        });
        row.append(check, button); return row;
      }
      function branch(node, container, parentPath = '') {
        const childPath = name => parentPath ? parentPath + '/' + name : name;
        for (const [name, child] of [...node.children].sort(([a], [b]) =>
          (metadata.get(childPath(a))?.ordinal || 0) - (metadata.get(childPath(b))?.ordinal || 0) || a.localeCompare(b))) {
          const path = parentPath ? parentPath + '/' + name : name;
          const details = document.createElement('details'); details.dataset.folder = path;
          details.open = !!query || !collapsed.has(path);
          details.addEventListener('toggle', () => {
            if (details.isConnected && !$('search').value.trim()) {
              if (details.open) collapsed.delete(path); else collapsed.add(path);
            }
            navigation();
          });
          const summary = document.createElement('summary'); summary.textContent = name;
          if (metadata.get(path)?.description) summary.title = metadata.get(path).description;
          details.append(summary); branch(child, details, path); container.append(details);
        }
        node.filters.sort((a, b) => (Number.isInteger(a.ordinal) ? a.ordinal : 0) -
          (Number.isInteger(b.ordinal) ? b.ordinal : 0) || a.name.localeCompare(b.name));
        node.filters.forEach(f => container.append(searchButton(f)));
      }
      $('list').replaceChildren(); branch(root, $('list'));
      if (!filters.length && !root.children.size) $('list').textContent = query ? '일치하는 저장 검색이 없습니다.' : '저장한 검색이 없습니다.';
      $('bulk-count').textContent = `${checked.size} selected`;
      navigation();
    }
    function navigation() {
      visibleNames = [...$('list').querySelectorAll('button[data-name]')].filter(button => {
        for (let parent = button.parentElement; parent !== $('list'); parent = parent.parentElement) {
          if (parent.tagName === 'DETAILS' && !parent.open) return false;
        }
        return true;
      }).map(button => button.dataset.name);
      const index = visibleNames.indexOf(cursor);
      $('prev').disabled = busy || index <= 0;
      $('next').disabled = busy || index + 1 >= visibleNames.length;
      $('position').textContent = index >= 0 ? `${index + 1} / ${visibleNames.length}`
        : `${cursor === null ? (editable ? 'New Search' : 'No Selection') : 'Not in Results'} · ${visibleNames.length} searches`;
    }
    function selectSearch(name, focusTarget = null) {
      if (!mayLeave()) return;
      const valid = edit(named(name));
      if (valid) status('');
      if (focusTarget) focusAvailable(focusTarget, $('next'), $('prev'), $('position'));
      else if (valid) $('quick').focus();
      else focusAvailable([...$('list').querySelectorAll('button[data-name]')].find(button => button.dataset.name === cursor), $('reload'));
    }
    function moveSelection(direction) {
      if (busy) return;
      const index = visibleNames.indexOf(cursor), target = index + direction;
      if (target >= 0 && target < visibleNames.length) selectSearch(visibleNames[target], direction < 0 ? $('prev') : $('next'));
    }
    async function run(action) {
      if (busy) return;
      const requestFocus = document.activeElement, requestFocusId = requestFocus?.id;
      lock(true); status('처리 중…');
      // Disabling the active control can blur it to the document body. Keep busy
      // keyboard events inside the modal until the original control is available.
      focusAvailable($('status'));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try { await action(controller.signal); }
      catch (error) { status(controller.signal.aborted
        ? '응답 시간이 초과되었습니다. 입력은 유지했습니다. 서버 처리 여부는 목록을 다시 불러와 확인하세요.'
        : error.message || '처리하지 못했습니다. 입력을 유지했습니다.', true); }
      finally {
        clearTimeout(timeout); lock(false);
        focusAvailable(requestFocus, requestFocusId ? document.getElementById(requestFocusId) : null,
          requestFocus === $('delete') ? $('new') : $('save'), $('reload'), $('status'));
      }
    }
    function acceptCollection(snapshot) {
      collection = snapshot;
      for (const id of checked) if (!snapshot.filters.some(filter => filter.id === id)) checked.delete(id);
      // Preserve edited criteria. Only synchronize a folder field the user has not edited.
      if (selected !== null) {
        const saved = named(selected), initial = JSON.parse(baseline);
        if (saved && $('folder').value === initial.folder) {
          $('folder').value = saved.folder || ''; source.folder = saved.folder || '';
          initial.folder = saved.folder || ''; baseline = JSON.stringify(initial);
        } else if (!saved) {
          selected = null; copying = true; $('name').readOnly = false;
          $('heading').textContent = 'Save As New';
          $('name-hint').textContent = '저장된 검색은 삭제됐습니다. 편집 조건은 유지되며 새 검색으로 저장할 수 있습니다.';
        }
      }
      list();
    }
    $('load-folders').addEventListener('click', () => run(async signal => {
      const snapshot = await options.readFolders(signal);
      acceptCollection(snapshot); status('검색 모음을 불러왔습니다. 선택과 편집 내용은 유지했습니다.');
    }));
    $('folder-path').addEventListener('change', () => {
      const initial = JSON.parse(folderBaseline);
      if ($('folder-description').value !== initial[1] || $('folder-order').value !== initial[2]) return;
      const path = $('folder-path').value.trim().split('/').map(part => part.trim()).join('/');
      const folder = collection?.folders.find(folder => folder.path === path);
      $('folder-description').value = folder?.description || ''; $('folder-order').value = String(folder?.ordinal || 0);
      if (folder) {
        initial[0] = $('folder-path').value; initial[1] = $('folder-description').value; initial[2] = $('folder-order').value;
        folderBaseline = JSON.stringify(initial);
      }
    });
    function folderCommand(command, message) {
      if (busy || !collection) return;
      if (!confirm(message)) return;
      const expected = collection;
      run(async signal => {
        const snapshot = await options.writeFolders({ expectedOwner: expected.owner, revision: expected.revision, command }, signal);
        acceptCollection(snapshot);
        const initial = JSON.parse(folderBaseline), current = JSON.parse(folderValue());
        const acknowledged = { 'save-folder': [0,1,2], 'move-folder': [0,3], 'remove-folder': [0],
          'move-searches': [3], 'delete-searches': [] }[command.action];
        for (const index of acknowledged) initial[index] = current[index];
        folderBaseline = JSON.stringify(initial);
        status('검색 모음 변경을 저장했습니다. 현재 목록 조건과 판독문은 유지됩니다.');
      });
    }
    $('folder-save').addEventListener('click', () => folderCommand({ action: 'save-folder', path: $('folder-path').value,
      description: $('folder-description').value, ordinal: Number($('folder-order').value) }, `폴더 "${$('folder-path').value}"의 설명과 순서를 저장할까요?`));
    $('folder-move').addEventListener('click', () => folderCommand({ action: 'move-folder', from: $('folder-path').value,
      to: $('folder-destination').value }, `폴더 "${$('folder-path').value}"와 하위 검색을 "${$('folder-destination').value}"로 이동할까요?`));
    $('folder-remove').addEventListener('click', () => folderCommand({ action: 'remove-folder', path: $('folder-path').value },
      `폴더 "${$('folder-path').value}"와 하위 폴더를 제거할까요? 포함된 검색은 모두 부모 폴더로 옮기며 검색 자체는 삭제하지 않습니다.`));
    function bulk(action) {
      const filters = options.list().filter(filter => checked.has(filter.id));
      if (!filters.length || filters.length > 200) { status('검색을 1~200개 선택하세요.', true); return; }
      const command = { action, ids: filters.map(filter => filter.id) };
      if (action === 'move-searches') command.to = $('folder-destination').value;
      folderCommand(command, `${filters.length}개 검색을 ${action === 'delete-searches' ? '삭제' : '"' + (command.to || '미분류') + '"로 이동'}할까요?\n${filters.map(filter => filter.name).join('\n')}\n검사와 판독문은 변경하지 않습니다.`);
    }
    $('bulk-move').addEventListener('click', () => bulk('move-searches'));
    $('bulk-delete').addEventListener('click', () => bulk('delete-searches'));
    $('bulk-clear').addEventListener('click', () => { checked.clear(); list(); });
    const sharing = KinSharedFilterManager.mount({ host: dialog.querySelector('aside'), api: options, run, status,
      personal: () => collection, acceptPersonal: acceptCollection });
    $('form').addEventListener('submit', e => {
      e.preventDefault(); if (busy || !editable || !$('form').reportValidity()) return;
      const applyAfterSave = e.submitter === $('save-apply');
      if (applyAfterSave && organizerDirty() && !confirm('검색을 적용하고 닫으면 저장하지 않은 폴더 변경은 버립니다. 계속할까요?')) return;
      const next = value();
      const error = compound.validate(next.cols[compound.KEY], options.columns[next.mode]);
      if (error) { status('복합 조건을 저장하지 못했습니다: ' + error, true); return; }
      if (!next.name) { status('검색 이름을 입력하세요.', true); $('name').focus(); return; }
      const existing = selected === null ? named(next.name) : null;
      if (copying && existing) { status('같은 이름의 검색이 있습니다. 다른 이름으로 저장하세요. 원본 검색은 유지됩니다.', true); $('name').focus(); return; }
      if (copying) next.createOnly = true;
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
        if (!applyAfterSave) {
          if (edit(saved)) status(`"${saved.name}" 저장 완료. 목록에 적용하려면 ‘Apply Saved’를 누르세요.`);
          return;
        }
        try {
          if (signal.aborted) throw new Error('응답 시간이 초과되었습니다.');
          if (await options.apply(saved) === false) throw new Error('저장 검색을 적용하지 못했습니다.');
        } catch (error) {
          // Save can merge existing folder metadata. Retry from that acknowledged
          // value so the previous new-search defaults cannot erase it afterward.
          if (edit(saved)) status(`"${saved.name}"은 저장됐지만 목록에 적용하지 못했습니다. ${error.message || ''} 저장된 조건을 유지했습니다. 조건을 확인하고 다시 적용하세요.`, true);
          return;
        }
        baseline = JSON.stringify(value()); dialog.close();
      });
    });
    $('copy').addEventListener('click', () => {
      if (busy || !editable || selected === null) return;
      const original = selected, draft = value();
      // Include edits already in the form, without changing the saved source.
      draft.isDefault = false;
      if (!edit(draft, true)) return;
      copying = true;
      let suffix = 1, candidate = original + ' (Copy)';
      while (named(candidate)) candidate = original + ' (Copy ' + (++suffix) + ')';
      $('name').value = candidate;
      $('heading').textContent = 'Save As New';
      $('name-hint').textContent = '새 이름으로 저장합니다. 원본 검색과 기존 기본 검색은 유지하며, 같은 이름은 덮어쓰지 않습니다.';
      status('편집 중인 조건을 복사했습니다. 이름과 조건을 확인한 뒤 ‘Save’를 누르세요.');
      $('name').focus(); $('name').select();
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
    $('preview').addEventListener('click', () => {
      if (busy || !editable) return;
      if (organizerDirty() && !confirm('검색을 적용하고 닫으면 저장하지 않은 폴더 변경은 버립니다. 계속할까요?')) return;
      const next = value();
      const error = compound.validate(next.cols[compound.KEY], options.columns[next.mode]);
      if (error) { status('복합 조건을 적용하지 못했습니다: ' + error, true); return; }
      if (options.apply(next) === false) { status('검색 조건을 적용하지 못했습니다.', true); return; }
      baseline = JSON.stringify(next); dialog.close();
    });
    $('add-rule').addEventListener('click', () => {
      addNode($('rules'), 'rule', 1);
    });
    $('add-group').addEventListener('click', () => addNode($('rules'), 'group', 1));
    $('clear-rules').addEventListener('click', () => { $('rules').replaceChildren(); count(); });
    $('mode').addEventListener('change', () => { source = value(); columns(source); rules(source); count(); });
    $('form').addEventListener('input', e => {
      if (!['sfm-name', 'sfm-folder', 'sfm-description', 'sfm-ordinal', 'sfm-default'].includes(e.target.id)) count();
    });
    $('search').addEventListener('input', list);
    $('prev').addEventListener('click', () => moveSelection(-1));
    $('next').addEventListener('click', () => moveSelection(1));
    $('new').addEventListener('click', () => {
      if (mayLeave()) { edit(options.snapshot(), true); status(''); $('name').focus(); }
    });
    $('reload').addEventListener('click', () => {
      if (!mayLeave()) return;
      const name = cursor ?? missingName;
      run(async signal => {
        await options.reload(signal);
        if (name !== null && !named(name)) {
          edit(undefined); missingName = name;
          status(`저장 검색 "${name}"을 찾을 수 없습니다. 목록에서 검색을 선택하거나 ‘New from Current’로 새 검색을 만드세요.`, true);
          return;
        }
        if (edit(name === null ? options.snapshot() : named(name), name === null)) status('저장 검색 목록을 불러왔습니다.');
      });
    });
    $('close').addEventListener('click', () => { if (mayLeave()) dialog.close(); });
    dialog.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      // Handle Escape before the browser's repeated-close budget can bypass cancel.
      e.preventDefault(); e.stopPropagation();
      if (!e.repeat && mayLeave()) dialog.close();
    }, true);
    dialog.addEventListener('cancel', e => { e.preventDefault(); if (mayLeave()) dialog.close(); });
    dialog.addEventListener('close', () => {
      if (typeof options.restoreFocus === 'function') options.restoreFocus(opener);
      else opener?.focus();
    });
    window.addEventListener('beforeunload', e => {
      if (dialog.open && (busy || dirty() || organizerDirty())) { e.preventDefault(); e.returnValue = ''; }
    });
    return { open({ name } = {}) {
      if (dialog.open) return;
      opener = document.activeElement; $('search').value = ''; status('');
      collection = null; checked.clear();
      sharing.reset();
      for (const id of ['folder-path', 'folder-description', 'folder-destination']) $(id).value = '';
      $('folder-order').value = '0'; folderBaseline = folderValue();
      const filter = name === undefined ? options.snapshot() : named(name);
      if (filter && name !== undefined) {
        let path = '';
        for (const part of (typeof filter.folder === 'string' ? filter.folder : '').split('/').filter(Boolean)) {
          path = path ? path + '/' + part : part; collapsed.delete(path);
        }
      }
      edit(filter, name === undefined); dialog.showModal();
      if (name !== undefined && !filter) {
        missingName = name;
        status(`저장 검색 "${name}"을 찾을 수 없습니다. ‘Reload List’로 다시 불러오거나 목록에서 검색을 선택하세요.`, true);
      }
      $('search').focus();
    } };
  }
})();

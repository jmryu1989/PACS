/* Institution library contains explicit copies; importing never applies a search. */
(function () {
  'use strict';
  window.KinSharedFilterManager = { mount };
  function mount(options) {
    const work=window.KinWorkContext;
    const panel = document.createElement('details'); panel.id = 'sfm-shared';
    panel.innerHTML = `<summary>Institution Searches</summary>
      <p><small>기관 배포본을 개인 검색으로 복사한 뒤 편집·적용합니다. 복사본은 이후 배포 변경과 별개이며 기본 검색은 유지됩니다.</small></p>
      <button type="button" id="sfs-load">Load Shared Searches</button>
      <p id="sfs-info" role="status">Not Loaded</p><div id="sfs-list"></div>
      <small>기관 검색을 고르면 조건을 읽기 전용으로 보여 줍니다.</small>
      <div id="sfs-preview" role="status" aria-live="polite" aria-label="Shared Search Conditions"></div>
      <label for="sfs-source">Shared Folder</label><input id="sfs-source" list="sfs-paths" maxlength="204"><datalist id="sfs-paths"></datalist>
      <small>빈 원본 경로는 미분류를 포함한 전체 모음입니다.</small>
      <label for="sfs-destination">Destination Folder</label><input id="sfs-destination" maxlength="204">
      <label for="sfs-prefix">Search Name Prefix</label><input id="sfs-prefix" maxlength="80">
      <small>기존 개인 폴더·이름은 덮어쓰지 않습니다. 충돌하면 새 대상 경로나 이름 접두사를 사용하세요.</small>
      <button type="button" id="sfs-copy">Copy to My Searches</button>
      <section id="sfs-admin" hidden aria-label="Institution search administration">
        <h3>Publish &amp; Manage</h3>
        <label for="sfs-personal">Personal Source Folder</label><input id="sfs-personal" list="sfm-folders" maxlength="204">
        <small>빈 원본 경로는 개인 검색 전체입니다. 위 대상 폴더·접두사를 사용하여 배포합니다.</small>
        <label><input type="checkbox" id="sfs-replace"> Replace Existing Shared Names</label>
        <button type="button" id="sfs-publish">Publish Personal Folder</button>
        <label for="sfs-description">Shared Folder Description</label><textarea id="sfs-description" rows="2" maxlength="1000"></textarea>
        <label for="sfs-order">Shared Folder Order</label><input id="sfs-order" type="number" min="0" max="9999" value="0">
        <button type="button" id="sfs-save">Save Shared Folder</button>
        <button type="button" id="sfs-move">Move Shared Folder</button>
        <button type="button" id="sfs-remove">Remove Shared Folder</button>
        <p id="sfs-count" role="status">0 selected</p>
        <button type="button" id="sfs-move-selected">Move Shared Selection</button>
        <button type="button" id="sfs-delete-selected">Delete Shared Selection</button>
      </section>`;
    options.host.append(panel);
    const $ = id => panel.querySelector('#sfs-' + id);
    const checked = new Set();
    let library = null, busy = false, baseline = '';
    const fields = ['source', 'destination', 'prefix', 'personal', 'description', 'order'];
    const value = () => JSON.stringify([...fields.map(id => $(id).value), $('replace').checked]);
    function acknowledge(indices) {
      const initial = JSON.parse(baseline), current = JSON.parse(value());
      for (const index of indices) initial[index] = current[index];
      baseline = JSON.stringify(initial);
    }
    const inside = (path, from) => !from || path === from || path.startsWith(from + '/');
    const canonical = path => path.trim().split('/').map(part => part.trim()).join('/');
    const names = (filters, from) => filters.filter(filter => inside(filter.folder || '', canonical(from))).map(filter => filter.name);
    function lock(on) {
      busy = on;
      panel.querySelectorAll('button,input,textarea').forEach(control => { control.disabled = on; });
      $('copy').disabled = on || !library || !options.personal();
      $('admin').hidden = !library?.canManage;
      $('admin').querySelectorAll('button,input,textarea').forEach(control => { control.disabled = on || !library?.canManage; });
      $('publish').disabled = on || !library?.canManage || !options.personal();
      // Selecting only shows a shared search's conditions (read-only) to everyone; changing the library stays admin-only above.
      panel.querySelectorAll('[data-shared-id]').forEach(control => { control.disabled = on; });
    }
    const ordered = filters => [...filters].sort((a,b) => a.ordinal - b.ordinal || a.name.localeCompare(b.name));
    function conditions(filter) {
      const columns = options.api.columns?.[filter.mode] || [], compound = window.KinCompoundFilter;
      const parts = [String(filter.mode)];
      const days = options.api.days ? options.api.days(filter.days) : filter.days;
      if (days >= 0) parts.push('Study Date ' + (days === 0 ? 'Today' : `Last ${days} Days`));
      if (typeof filter.quick === 'string' && filter.quick.trim()) parts.push('Patient ID or Name ' + filter.quick.trim());
      for (const column of columns) {
        const v = filter.cols?.[column.k];
        if (v === '' || v == null) continue;
        // A stored value this line cannot spell out still restricts the list; say so rather than drop it.
        const readable = Array.isArray(v) ? v.length > 0 && v.every(x => ['string', 'number'].includes(typeof x)) : typeof v !== 'object';
        parts.push(readable ? `${column.t} ${Array.isArray(v) ? v.join(', ') : v}` : `${column.t} (condition cannot be shown)`);
      }
      const rules = compound && filter.cols?.[compound.KEY];
      if (rules !== undefined && compound.validate(rules, columns)) parts.push('Compound Criteria (condition cannot be shown)');
      else if (rules) {
        if (rules.version === 2) parts.push('Patient Search: ' + (rules.quickMatch === 'exact' ? 'Exact' : 'Starts With'));
        if (rules.rules?.length) parts.push('Compound ' + compound.describe(rules, columns));
      }
      const sort = columns.find(c => c.k === filter.sortKey);
      if (sort && filter.sortDir) parts.push(`Sort ${sort.t} ${filter.sortDir > 0 ? 'Ascending' : 'Descending'}`);
      return parts.join(' · ');
    }
    function preview() {
      const chosen = library ? ordered(library.filters.filter(filter => checked.has(filter.id))) : [];
      $('preview').replaceChildren(...chosen.map(filter => {
        const line = document.createElement('p'); line.textContent = `${filter.name}: ${conditions(filter)}`; return line;
      }));
    }
    function accept(snapshot) {
      library = snapshot;
      for (const id of checked) if (!library.filters.some(filter => filter.id === id)) checked.delete(id);
      $('info').textContent = `Revision ${library.revision} · ${library.filters.length} searches`;
      const paths = new Set();
      for (const path of [...library.folders.map(folder => folder.path), ...library.filters.map(filter => filter.folder)]) {
        const parts = path.split('/').filter(Boolean);
        for (let depth = 1; depth <= parts.length; depth++) paths.add(parts.slice(0, depth).join('/'));
      }
      $('paths').replaceChildren(...[...paths].sort().map(path => { const option = document.createElement('option'); option.value = path; return option; }));
      const containers = new Map([['', $('list')]]); $('list').replaceChildren();
      const metadata = new Map(library.folders.map(folder => [folder.path, folder]));
      for (const path of [...paths].sort((a,b) => a.split('/').length - b.split('/').length ||
        (metadata.get(a)?.ordinal || 0) - (metadata.get(b)?.ordinal || 0) || a.localeCompare(b))) {
        const details = document.createElement('details'); details.open = true;
        const summary = document.createElement('summary'); summary.textContent = path.split('/').pop();
        summary.title = metadata.get(path)?.description || ''; details.append(summary);
        const parent = path.split('/').slice(0,-1).join('/'); containers.get(parent).append(details); containers.set(path, details);
      }
      for (const filter of ordered(library.filters)) {
        const label = document.createElement('label'); const check = document.createElement('input'); check.type = 'checkbox';
        check.dataset.sharedId = String(filter.id); check.checked = checked.has(filter.id);
        check.setAttribute('aria-label', 'Select Shared Search: ' + filter.name);
        check.addEventListener('change', () => { if (check.checked) checked.add(filter.id); else checked.delete(filter.id); $('count').textContent = `${checked.size} selected`; preview(); });
        label.append(check, document.createTextNode(filter.name)); label.title = filter.description;
        (containers.get(filter.folder) || $('list')).append(label);
      }
      $('count').textContent = `${checked.size} selected`; preview(); lock(busy);
    }
    $('load').addEventListener('click', () => options.run(async (signal,at) => {
      const personal=await options.api.readFolders(signal,at);
      if(!work.commit(at,()=>options.acceptPersonal(personal)))return;
      const shared=await options.api.readShared(signal,at);work.commit(at,()=>{accept(shared);options.status('개인 폴더와 기관 검색 모음을 불러왔습니다. 편집 내용은 유지했습니다.');});
    }, true));
    $('source').addEventListener('change', () => {
      const initial = JSON.parse(baseline);
      if ($('description').value !== initial[4] || $('order').value !== initial[5]) return;
      const folder = library?.folders.find(folder => folder.path === canonical($('source').value));
      $('description').value = folder?.description || ''; $('order').value = String(folder?.ordinal || 0);
      if (folder) { initial[0] = $('source').value; initial[4] = $('description').value; initial[5] = $('order').value; baseline = JSON.stringify(initial); }
    });
    $('copy').addEventListener('click', () => {
      if (busy || !library || !options.personal()) return;
      const from = $('source').value;
      const body = { expectedOwner: library.owner, revision: library.revision, personalRevision: options.personal().revision,
        from, to: $('destination').value, namePrefix: $('prefix').value };
      options.run(async (signal,at) => {
        const personal=await options.api.copyShared(body, signal,at);
        work.commit(at,()=>{options.acceptPersonal(personal); acknowledge([0,1,2]);
        options.status('개인 검색으로 복사했습니다. 개인 목록에서 검색을 선택해 편집하거나 적용하세요.');});
      });
    });
    function change(command, message) {
      if (busy || !library?.canManage || !confirm(message)) return;
      const body = { expectedOwner: library.owner, revision: library.revision, command };
      options.run(async (signal,at) => {
        const shared=await options.api.writeShared(body, signal,at);
        work.commit(at,()=>{accept(shared);
        acknowledge({ 'publish-folder': [1,2,3,6], 'save-folder': [0,4,5], 'move-folder': [0,1],
          'remove-folder': [0], 'move-searches': [1], 'delete-searches': [] }[command.action]);
        options.status('기관 검색 모음을 갱신했습니다. 기존 개인 복사본은 유지됩니다.');});
      });
    }
    $('publish').addEventListener('click', () => {
      const personal = options.personal(); if (!personal) return;
      const from = $('personal').value, selected = names(personal.filters, from), replace = $('replace').checked;
      change({ action:'publish-folder', sourceRevision: personal.revision, from, to:$('destination').value, namePrefix:$('prefix').value, replace },
        `개인 폴더 "${from || '전체 모음'}"의 검색 ${selected.length}개와 하위·빈 폴더를 기관 "${$('destination').value}"로 배포할까요?\n${selected.join('\n')}\n이름 접두사: ${$('prefix').value || '(없음)'}\n${replace ? '같은 기관 검색 이름과 대상 폴더 메타데이터를 교체합니다.' : '기존 기관 검색과 대상 폴더는 덮어쓰지 않습니다.'}\n개인 원본은 유지됩니다.`);
    });
    $('save').addEventListener('click', () => change({action:'save-folder',path:$('source').value,description:$('description').value,ordinal:Number($('order').value)},`기관 폴더 "${$('source').value}"의 설명과 순서를 저장할까요?`));
    $('move').addEventListener('click', () => change({action:'move-folder',from:$('source').value,to:$('destination').value},`기관 폴더 "${$('source').value}"와 하위 검색을 "${$('destination').value}"로 이동할까요? 기존 개인 복사본은 바뀌지 않습니다.`));
    $('remove').addEventListener('click', () => change({action:'remove-folder',path:$('source').value},`기관 폴더 "${$('source').value}"와 하위 폴더를 제거할까요? 포함된 검색은 부모 폴더로 옮기며 삭제하지 않습니다.`));
    function bulk(action) {
      const selected = library?.filters.filter(filter => checked.has(filter.id)) || [];
      if (!selected.length) { options.status('기관 검색을 선택하세요.', true); return; }
      const command = { action, ids: selected.map(filter => filter.id) };
      if (action === 'move-searches') command.to = $('destination').value;
      change(command, `선택한 기관 검색 ${selected.length}개를 ${action === 'delete-searches' ? '삭제' : '"' + (command.to || '미분류') + '"로 이동'}할까요?\n${selected.map(filter => filter.name).join('\n')}\n기존 개인 복사본·검사·판독문은 유지됩니다.`);
    }
    $('move-selected').addEventListener('click', () => bulk('move-searches'));
    $('delete-selected').addEventListener('click', () => bulk('delete-searches'));
    function reset() {
      library = null; checked.clear(); fields.forEach(id => { $(id).value = id === 'order' ? '0' : ''; });
      $('replace').checked = false; $('list').replaceChildren(); $('paths').replaceChildren(); $('preview').replaceChildren(); $('info').textContent = 'Not Loaded';
      baseline = value(); lock(false);
    }
    reset();
    async function refresh(signal,at){
      if(!library)return;
      const shared=await options.api.readShared(signal,at);work.commit(at,()=>accept(shared));
    }
    return { lock, reset, refresh, dirty: () => value() !== baseline };
  }
})();

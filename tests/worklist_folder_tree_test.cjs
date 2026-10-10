// REQ-WS3/REQ-WS7 -> RISK-WS3/RISK-WS7 -> TEST-WS3/TEST-WS7: public folder behavior with synthetic rows.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const tree = require('../worklist-v0/hpacs-lite/worklist-folder-tree.js');
const compound = require('../worklist-v0/hpacs-lite/compound-filter.js');

// Only platform DOM primitives are doubled; all folder behavior runs in the module.
class Element {
  constructor(tag, doc) { this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this.attributes = {}; this.value = ''; this.textContent = ''; }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children.forEach(node => { node.parent = null; }); this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  focus() { this.ownerDocument.activeElement = this; }
  remove() { this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
  click() { if (!this.disabled) { this.focus(); this.onclick?.({}); } }
}
function nodes(node) { return [node, ...node.children.flatMap(nodes)]; }
function setup(options = {}) {
  const doc = { createElement(tag) { return new Element(tag, this); }, activeElement: null };
  const host = doc.createElement('div'), changes = [], selections = [];
  const api = tree.mount({ host, onSelect: (...args) => selections.push(args), onChange: value => changes.push(value), ...options });
  return { host, doc, api, changes, selections };
}
const searches = [{ id: 'ct', name: 'CT Exact', matches: compound.compile({ version: 1, join: 'and', rules: [{field:'modality',op:'eq',value:'CT'}] }, [{k:'modality',f:['CT','MR']}]) }];
const shortcut = (id, name = id) => ({ id, name, searchId: 'ct' });
const get = (api, id) => api.snapshot().items.find(item => item.id === id);
const button = (host, label) => nodes(host).find(node => node.tagName === 'BUTTON' && node.textContent === label);

test('TEST-WS3-DEFAULTS: base folders plus normalized observed tokens, deduplicated', () => {
  const { api } = setup({ rows: [{modality:'DX'}, {modality:' ct,SR\\mr '}, {modality:'DX'}, {}, {modality:null}] });
  assert.deepEqual(api.snapshot().items.filter(item => item.kind === 'modality').map(item => item.name), ['CT','MR','CR','US','SC','DX','SR']);
  assert.deepEqual(tree.defaultModalities([]), ['CT','MR','CR','US','SC']);
  assert.equal(api.snapshot().selectedId, 'all');
});

test('TEST-WS3-TOKENS: comma/backslash tokens match whole modalities only', () => {
  for (const value of ['CT', 'CT,SR', 'SR\\CT', ' ct ', 'CT,CT']) assert.equal(tree.matchesModality(value, 'CT'), true);
  for (const value of ['CTA', 'SC', '', null, undefined, 0, [], {}]) assert.equal(tree.matchesModality(value, 'CT'), false);
  assert.equal(tree.matchesModality('DX', 'dx'), true);
  assert.equal(tree.matchesModality('UNKNOWN', 'CT'), false);
  assert.equal(tree.matchesModality('', ''), false);
});

// D575: REQ-WS3/WS7 -> RISK-WS3/WS7 -> TEST-WS3-MULTI / TEST-WS7-MULTI.
test('TEST-WS3-MULTI-OR-AND: CT and MR form a union within the other applied criteria', () => {
  const rows = [
    {uid:'ct',modality:'CT',name:'included'}, {uid:'mr',modality:'MR',name:'included'},
    {uid:'both',modality:'ct,MR',name:'included'}, {uid:'us',modality:'US',name:'included'},
    {uid:'excluded',modality:'CT',name:'excluded'}, {uid:'substring',modality:'CTA',name:'included'},
  ];
  const { api, selections } = setup({rows,loadState:'complete'});
  api.select(['modality:CT','modality:MR']);
  const other = compound.compile({version:1,join:'and',rules:[{field:'name',op:'eq',value:'included'}]}, [{k:'name',f:'text'}]);
  assert.deepEqual(api.filter(rows.filter(other)).map(row => row.uid), ['ct','mr','both']);
  assert.deepEqual(api.filter(rows).filter(other).map(row => row.uid), ['ct','mr','both']);
  assert.deepEqual(api.snapshot().selectedIds, ['modality:CT','modality:MR']);
  assert.equal(api.snapshot().selectedId, null);
  assert.deepEqual(selections, [[{kind:'modality',modalities:['CT','MR'],selectedIds:['modality:CT','modality:MR']},
    {mode:'replace',reason:'programmatic'}]]);
  const ids = api.snapshot().selectedIds;
  ids.push('all'); selections[0][0].selectedIds.length = 0; selections[0][0].modalities.push('US');
  assert.deepEqual(api.filter(rows).map(row => row.uid), ['ct','mr','both','excluded']);
  assert.deepEqual(api.snapshot().selectedIds, ['modality:CT','modality:MR']);
});

test('TEST-WS7-MULTI-TOGGLE: native toggle buttons keep focus and announce each selection', () => {
  const rows = [{modality:'CT'},{modality:'MR'},{modality:'US'}];
  const { api, host, doc, selections } = setup({rows,loadState:'complete'});
  button(host,'CT (1)').click(); button(host,'MR (1)').click();
  assert.equal(button(host,'CT (1)').getAttribute('aria-pressed'),'true');
  assert.equal(button(host,'MR (1)').getAttribute('aria-pressed'),'true');
  assert.equal(button(host,'US (1)').getAttribute('aria-pressed'),'false');
  assert.equal(button(host,'All Studies (3)').getAttribute('aria-current'),null);
  assert.equal(doc.activeElement,button(host,'MR (1)'));
  assert.deepEqual(api.filter(rows),rows.slice(0,2));
  assert.deepEqual(selections.at(-1)[0].modalities,['CT','MR']);
  assert.deepEqual(selections.at(-1)[1],{mode:'replace',reason:'user'});
  api.update({loadState:'partial'});
  assert.equal(doc.activeElement,button(host,'MR (1 · Partial)'));
  button(host,'CT (1 · Partial)').click();
  assert.equal(button(host,'CT (1 · Partial)').getAttribute('aria-pressed'),'false');
  assert.deepEqual(api.snapshot().selectedIds,['modality:MR']);
  assert.deepEqual(api.filter(rows),[rows[1]]);
  button(host,'MR (1 · Partial)').click();
  assert.deepEqual(api.snapshot().selectedIds,[]);
  assert.equal(api.snapshot().selectedId,null);
  assert.deepEqual(api.filter(rows),[]);
  assert.deepEqual(selections.at(-1)[0],{kind:'modality',modalities:[],selectedIds:[]});
  api.update({rows,loadState:'complete'});
  assert.deepEqual(api.filter(rows),[]);
  button(host,'All Studies (3)').click();
  assert.deepEqual(api.filter(rows),rows);
  assert.deepEqual(api.snapshot().selectedIds,['all']);
  assert.equal(button(host,'All Studies (3)').getAttribute('aria-current'),'true');
  assert.equal(selections.length,5);
});

test('TEST-WS3-MULTI-REMOVED: each vanished selection survives refresh and load failures without widening', () => {
  const initial = [{modality:'DX'},{modality:'PT'},{modality:'US'}];
  const { api, selections } = setup({rows:initial,loadState:'complete'});
  api.select(['modality:DX','modality:PT']);
  for (const rows of [[{modality:'US'}],[]]) {
    for (const [loadState,count] of [['complete','0'],['partial','0 · Partial'],['unknown','—']]) {
      api.update({rows,loadState});
      assert.deepEqual(api.snapshot().selectedIds,['modality:DX','modality:PT']);
      assert.ok(get(api,'modality:DX'), 'the vanished DX selection remains visible');
      assert.ok(get(api,'modality:PT'), 'the vanished PT selection remains visible');
      assert.equal(get(api,'modality:DX').count,count);
      assert.equal(get(api,'modality:PT').count,count);
      assert.equal(get(api,'modality:DX').selected,true);
      assert.equal(get(api,'modality:PT').selected,true);
      assert.deepEqual(api.filter(rows),[]);
    }
  }
  assert.throws(() => api.update({rows:null}));
  assert.deepEqual(api.snapshot().selectedIds,['modality:DX','modality:PT']);
  api.update({rows:initial,loadState:'complete'});
  assert.deepEqual(api.filter(initial),initial.slice(0,2));
  assert.equal(selections.length,1);
});

test('TEST-WS3-MULTI-BOUNDARIES: replacement, silent alignment, empty and invalid sets are explicit', () => {
  const rows = [{modality:'CT'},{modality:'MR'},{modality:'US'}];
  const { api, host, selections, changes } = setup({rows,searches,shortcuts:[shortcut('a')],loadState:'complete'});
  api.select(['modality:CT','modality:MR']);
  const before = api.snapshot();
  for (const ids of [['all','modality:CT'],['shortcut:a','modality:CT'],['modality:CT','missing'],
    ['modality:CT','modality:CT'],[null],null,{},42]) {
    for (const fn of [api.select,api.setApplied]) {
      assert.throws(() => fn(ids)); assert.deepEqual(api.snapshot(),before);
    }
  }
  assert.equal(selections.length,1);
  api.setApplied(['modality:MR','modality:US']);
  assert.deepEqual(api.filter(rows),rows.slice(1));
  api.setApplied([]); assert.deepEqual(api.filter(rows),[]);
  api.setApplied('all'); assert.deepEqual(api.filter(rows),rows);
  assert.equal(selections.length,1);
  api.select(['modality:CT','modality:MR']);
  button(host,'a (1)').click(); assert.deepEqual(api.filter(rows),[rows[0]]);
  assert.deepEqual(api.snapshot().selectedIds,['shortcut:a']);
  button(host,'MR (1)').click(); assert.deepEqual(api.filter(rows),[rows[1]]);
  assert.deepEqual(api.snapshot().selectedIds,['modality:MR']);
  api.select('modality:US'); assert.deepEqual(api.filter(rows),[rows[2]]);
  api.select([]); assert.deepEqual(api.filter(rows),[]);
  assert.equal(changes.length,0);
  api.destroy();
  for (const fn of [() => api.select([]),() => api.setApplied([]),() => api.filter(rows)]) assert.throws(fn);
});

test('TEST-WS3-SAVE-CONTRACT: edits emit whole detached arrays and an authoritative read restores them silently', () => {
  const rows = [{modality:'CT'},{modality:'MR'}];
  const own = {id:'own:7',name:'Personal',matches:row => row.modality === 'CT'};
  const shared = {id:'shared:7',name:'Shared',matches:row => row.modality === 'MR'};
  const a = {id:'a',name:'Mine',searchId:'own:7'}, b = {id:'b',name:'Team',searchId:'shared:7'};
  const persisted = JSON.parse(JSON.stringify([a,b]));
  const { api, changes, selections } = setup({rows,loadState:'complete',searches:[own,shared],shortcuts:persisted});
  api.select('shortcut:b'); assert.deepEqual(api.filter(rows),[rows[1]]);
  api.update({searches:[{...own,name:'Renamed personal'},{...shared,name:'Renamed shared'}]});
  assert.deepEqual(api.filter(rows),[rows[1]]);
  api.rename('b','Renamed'); api.reorder('b',0); api.remove('a');
  assert.deepEqual(changes,[[a,{...b,name:'Renamed'}],[{...b,name:'Renamed'},a],[{...b,name:'Renamed'}]]);
  assert.deepEqual(persisted,[a,b]);
  for (const batch of changes) for (const item of batch) assert.deepEqual(Object.keys(item).sort(),['id','name','searchId']);
  changes[0][0].name = 'Caller draft'; changes[2].push(a);
  assert.deepEqual(api.snapshot().shortcuts,[{...b,name:'Renamed'}]);
  // CAS/conflict recovery belongs to the caller: replace from its read, without
  // merging the discarded local array or starting another save callback.
  api.update({shortcuts:JSON.parse(JSON.stringify(persisted))});
  assert.deepEqual(api.snapshot().shortcuts,[a,b]);
  assert.equal(changes.length,3); assert.equal(selections.length,1);
  assert.equal(api.snapshot().selectedId,'shortcut:b');
  api.update({searches:[own]});
  assert.deepEqual(api.filter(rows),[]);
  assert.equal(get(api,'shortcut:b').unavailable,true);
  assert.deepEqual(api.snapshot().shortcuts,[a,b]);
  api.update({searches:[own,shared]});
  assert.deepEqual(api.filter(rows),[rows[1]]);
});

test('TEST-WS3-COUNTS: unknown, partial and complete remain distinct, including true zero', () => {
  const rows = [{uid:'a',modality:'CT,SR'}, {uid:'b',modality:'CT'}, {uid:'c',modality:'DX'}];
  const { api } = setup({ rows, searches, shortcuts: [shortcut('one')] });
  assert.equal(get(api, 'modality:CT').count, '—');
  api.update({ loadState: 'partial' });
  assert.equal(get(api, 'modality:CT').count, '2 · Partial');
  api.update({ loadState: 'complete' });
  assert.equal(get(api, 'modality:CT').count, '2');
  assert.equal(get(api, 'modality:MR').count, '0');
  assert.equal(get(api, 'shortcut:one').count, '1');
  api.select('modality:CT');
  assert.deepEqual(api.filter(rows).map(row => row.uid), ['a','b']);
  assert.equal(get(api, 'modality:DX').count, '1');
  api.update({ rows: [], loadState: 'complete' });
  assert.equal(get(api, 'modality:CT').count, '0');
  api.update({ loadState: 'unknown' });
  assert.equal(get(api, 'modality:CT').count, '—');
});

test('TEST-WS3-EDIT: add, rename, reorder, remove notify with isolated data', () => {
  const { api, changes } = setup({ searches });
  api.add(shortcut('a')); api.add(shortcut('b')); api.add(shortcut('c'));
  api.rename('b', 'Renamed'); api.reorder('c', 0); api.remove('a');
  assert.deepEqual(api.snapshot().shortcuts, [shortcut('c'), shortcut('b', 'Renamed')]);
  assert.equal(changes.length, 6);
  assert.deepEqual(changes[4].map(item => item.id), ['c','a','b']);
  changes[5][0].name = 'external';
  assert.equal(api.snapshot().shortcuts[0].name, 'c');
});

test('TEST-WS3-SELECTION: disappearing selected modality stays selected through empty, unknown and recovery', () => {
  const { api, host, selections } = setup({ rows: [{modality:'DX'}, {modality:'CT'}], loadState:'complete' });
  button(host, 'DX (1)').click();
  for (const rows of [[{modality:'CT'}, {modality:'MR'}], []]) {
    for (const [loadState, count] of [['complete','0'], ['partial','0 · Partial'], ['unknown','—']]) {
      api.update({rows, loadState});
      assert.equal(api.snapshot().selectedId, 'modality:DX');
      assert.equal(get(api, 'modality:DX').count, count);
      assert.deepEqual(api.filter(rows), []);
      assert.ok(button(host, `DX (${count})`));
      assert.equal(nodes(host).filter(node => node.getAttribute('aria-pressed') === 'true').length, 1);
    }
  }
  api.update({rows:[{modality:'DX'}], loadState:'complete'});
  assert.equal(get(api,'modality:DX').count, '1');
  assert.deepEqual(api.filter([{modality:'DX'}, {modality:'CT'}]), [{modality:'DX'}]);
  assert.equal(selections.length, 1);
  api.select('all'); api.update({rows:[]});
  assert.equal(get(api, 'modality:DX'), undefined);
});

test('TEST-WS3-REMOVAL: selected shortcut and search disappear without broadening or selection callbacks', () => {
  for (const disappear of [api => api.remove('a'), api => api.update({shortcuts:[]}), api => api.update({searches:[]})]) {
    const rows = [{modality:'CT'}, {modality:'MR'}];
    const { api, selections } = setup({ searches, shortcuts:[shortcut('a')], rows, loadState:'complete' });
    api.select('shortcut:a'); disappear(api);
    for (const loadState of ['complete','partial','unknown']) {
      api.update({loadState});
      assert.equal(api.snapshot().selectedId, 'shortcut:a');
      assert.equal(get(api, 'shortcut:a').unavailable, true);
      assert.equal(get(api, 'shortcut:a').count, '—');
      assert.deepEqual(api.filter(rows), []);
      assert.equal(api.snapshot().items.filter(item => item.selected).length, 1);
    }
    assert.equal(selections.length, 1);
    api.update({searches, shortcuts:[shortcut('a')], loadState:'complete'});
    assert.deepEqual(api.filter(rows), [{modality:'CT'}]);
    assert.equal(selections.length, 1);
  }
});

test('TEST-WS3-EVENTS: user/programmatic reasons, silent updates and external applied-state alignment', () => {
  const rows = [{modality:'CT'}, {modality:'MR'}];
  const { api, host, selections, changes } = setup({ searches, shortcuts:[shortcut('a')], rows, loadState:'complete' });
  button(host, 'a (1)').click();
  assert.deepEqual(selections[0][1], {mode:'replace',reason:'user'});
  api.update({searches:searches.map(search => ({...search}))});
  api.rename('a','Renamed'); api.update({rows:[],loadState:'unknown'});
  assert.equal(selections.length, 1);
  assert.equal(changes.length, 1);
  api.update({searches:[{...searches[0],matches:()=>true}]});
  assert.deepEqual(api.filter(rows), [{modality:'CT'}]);
  assert.equal(selections.length, 1);
  api.select('shortcut:a');
  assert.deepEqual(selections.at(-1)[1], {mode:'replace',reason:'programmatic'});
  assert.deepEqual(api.filter(rows), rows);
  api.setApplied('modality:MR');
  assert.equal(api.snapshot().selectedId,'modality:MR');
  assert.deepEqual(api.filter(rows), [{modality:'MR'}]);
  api.setApplied('all');
  assert.deepEqual(api.filter(rows), rows);
  assert.equal(selections.length, 2); assert.equal(changes.length, 1);
  const before = api.snapshot();
  assert.throws(() => api.setApplied('missing'));
  assert.deepEqual(api.snapshot(), before);
});

test('TEST-WS3-RETARGET: a changed shortcut target requires explicit selection or external alignment', () => {
  const rows = [{modality:'CT'}, {modality:'MR'}];
  const { api, selections } = setup({ searches:[...searches,{id:'any',name:'Any',matches:()=>true}],
    shortcuts:[shortcut('a')],rows,loadState:'complete' });
  api.select('shortcut:a');
  api.update({shortcuts:[{...shortcut('a'),searchId:'any'}]});
  assert.equal(api.snapshot().selectedId,'shortcut:a');
  assert.equal(get(api,'shortcut:a').unavailable,true);
  assert.deepEqual(api.filter(rows),[]);
  assert.equal(selections.length,1);
  api.setApplied('shortcut:a');
  assert.deepEqual(api.filter(rows),rows);
  assert.equal(get(api,'shortcut:a').count,'2');
  assert.equal(selections.length,1);
});

test('TEST-WS3-NAMES: trim and refuse case-insensitive shortcut/default duplicates atomically', () => {
  const { api, host, changes, selections } = setup({ searches, rows:[{modality:'DX'}], shortcuts:[shortcut('a','  Padded  ')] });
  assert.equal(api.snapshot().shortcuts[0].name, 'Padded');
  api.add(shortcut('b','  Other  ')); api.rename('b','  Renamed  ');
  assert.equal(api.snapshot().shortcuts[1].name,'Renamed');
  const before = api.snapshot(), counts = [changes.length,selections.length];
  for (const name of ['Padded',' padded ', 'CT','ct',' mr ', 'US','CR','SC',' all studies ']) {
    for (const action of [() => api.add(shortcut('c',name)), () => api.rename('b',name)]) {
      assert.throws(action, /이미 사용 중인 폴더 또는 바로가기 이름/);
      assert.deepEqual(api.snapshot(), before);
      assert.deepEqual([changes.length,selections.length], counts);
    }
  }
  const form = nodes(host).find(node => node.tagName === 'FORM');
  nodes(form).find(node => node.tagName === 'INPUT').value = '  ct  ';
  nodes(form).find(node => node.tagName === 'SELECT').value = 'ct';
  form.onsubmit({preventDefault(){}});
  assert.match(nodes(host).find(node => node.getAttribute('role') === 'status').textContent, /이미 사용 중인/);
  assert.deepEqual(api.snapshot(), before);
  assert.deepEqual([changes.length,selections.length], counts);
  api.select('shortcut:a'); api.remove('a');
  // 삭제된 선택은 더 이상 저장된 바로가기가 아니므로 이름을 예약하지 않는다.
  api.add(shortcut('c',' padded '));
  assert.equal(api.snapshot().shortcuts.at(-1).name,'padded');
  assert.equal(api.snapshot().selectedId,'shortcut:a');
  assert.equal(get(api,'shortcut:a').unavailable,true);
});

test('TEST-WS3-VALIDATION: invalid edits refuse atomically before callbacks or state changes', () => {
  const { api, changes, selections } = setup({ searches, shortcuts: [shortcut('a')], rows:[{modality:'CT'}], loadState:'complete' });
  const before = api.snapshot();
  for (const action of [() => api.add(shortcut('a')), () => api.add({...shortcut('b'),searchId:'absent'}),
    () => api.add({...shortcut('b'),extra:true}), () => api.rename('a',''), () => api.rename('a','x\ny'),
    () => api.rename('a','x'.repeat(401)), () => api.remove('absent'), () => api.reorder('a',-1),
    () => api.reorder('a',1), () => api.reorder('a',0.5)]) {
    assert.throws(action); assert.deepEqual(api.snapshot(), before);
  }
  assert.equal(changes.length, 0); assert.equal(selections.length, 0);
});

test('TEST-WS3-INCOMING-ROWS: DX shortcut survives a new DX list with fresh counts in both sections', () => {
  const { api, host, changes, selections } = setup({ searches, rows:[{modality:'CT'}], loadState:'complete' });
  api.add(shortcut('dx','DX'));
  const rows = [{modality:'CT'}, {modality:'DX'}, {modality:'DX'}];
  api.update({rows,loadState:'complete'});
  assert.equal(get(api,'all').count,'3');
  assert.equal(get(api,'modality:CT').count,'1');
  assert.equal(get(api,'modality:DX').count,'2');
  assert.equal(get(api,'shortcut:dx').count,'1');
  assert.ok(button(host,'DX (2)')); assert.ok(button(host,'DX (1)'));
  assert.equal(changes.length,1); assert.equal(selections.length,0);
  api.select('shortcut:dx'); assert.deepEqual(api.filter(rows),[rows[0]]);
  api.select('modality:DX'); assert.deepEqual(api.filter(rows),rows.slice(1));
});

test('TEST-WS3-INCOMING-MOUNT: stored observed, base and duplicate names render and remain editable', () => {
  const stored = [shortcut('sr','SR'), shortcut('ct','CT'), shortcut('all','All Studies'), shortcut('dup','sr')];
  const { api, host, changes, selections } = setup({searches,shortcuts:stored,rows:[{modality:'CT'},{modality:'SR'}],loadState:'complete'});
  assert.deepEqual(api.snapshot().shortcuts,stored);
  assert.equal(get(api,'all').count,'2');
  const section = title => button(host,title).parent;
  for (const item of stored) assert.ok(button(section('My Shortcuts'),`${item.name} (1)`));
  assert.ok(button(section('Modality'),'SR (1)'));
  assert.ok(button(section('Modality'),'CT (1)'));
  api.update({rows:[{modality:'SR'}],loadState:'complete'});
  assert.equal(get(api,'shortcut:ct').count,'0');
  // 다른 저장 항목의 중복 이름은 이 항목의 복구 편집을 막지 않는다.
  api.rename('ct','Recovered'); api.add(shortcut('new','New'));
  api.reorder('sr',1); api.remove('all');
  assert.equal(api.snapshot().shortcuts.find(item => item.id === 'ct').name,'Recovered');
  assert.equal(changes.length,4); assert.equal(selections.length,0);
});

test('TEST-WS3-INCOMING-SHORTCUTS: persisted names ignore current rows and vanished selection names', () => {
  const { api, changes, selections } = setup({searches,rows:[{modality:'DX'}],loadState:'complete'});
  api.select('modality:DX'); api.update({rows:[{modality:'CT'}]});
  const stored = [shortcut('dx','DX'),shortcut('base','CT'),shortcut('dup','ct')];
  api.update({shortcuts:stored});
  assert.deepEqual(api.snapshot().shortcuts,stored);
  assert.equal(api.snapshot().selectedId,'modality:DX');
  assert.equal(get(api,'modality:DX').count,'0');
  api.select('shortcut:dx'); api.update({shortcuts:[]});
  api.update({shortcuts:[shortcut('replacement','DX')]});
  assert.equal(api.snapshot().selectedId,'shortcut:dx');
  assert.equal(get(api,'shortcut:dx').unavailable,true);
  assert.equal(get(api,'shortcut:replacement').count,'1');
  assert.equal(changes.length,0); assert.equal(selections.length,2);
});

test('TEST-WS3-EDIT-OBSERVED: observed and vanished modalities do not reserve edit names', () => {
  const { api } = setup({searches,rows:[{modality:'DX'},{modality:'SR'}]});
  api.add(shortcut('a','DX')); api.rename('a','SR');
  api.select('modality:DX'); api.update({rows:[]});
  api.rename('a','DX'); api.add(shortcut('b','SR'));
  assert.deepEqual(api.snapshot().shortcuts,[shortcut('a','DX'),shortcut('b','SR')]);
  assert.equal(api.snapshot().selectedId,'modality:DX');
});

test('TEST-WS3-INCOMING-VALID: full saved capacity, missing searches and indeterminate adapters remain renderable', () => {
  const stored = Array.from({length:200},(_,i)=>shortcut(String(i),'Saved '+i));
  const { api, changes, selections } = setup({shortcuts:stored,rows:[{}, {modality:null}, {modality:'NM,PT'}],loadState:'partial'});
  assert.equal(get(api,'all').count,'3 · Partial');
  assert.equal(get(api,'shortcut:0').unavailable,true);
  assert.throws(() => api.add(shortcut('overflow')));
  assert.deepEqual(api.snapshot().shortcuts,stored);
  for (const matches of [()=>null, ()=>{throw new Error('unavailable');}, ()=>Promise.resolve(true)]) {
    api.update({searches:[{...searches[0],matches}],loadState:'complete'});
    assert.equal(get(api,'all').count,'3');
    assert.equal(get(api,'shortcut:0').count,'—');
  }
  api.update({searches:[]}); api.rename('0','Recover'); api.remove('1');
  assert.equal(changes.length,2); assert.equal(selections.length,0);
});

test('TEST-WS3-INCOMING-SEARCH-NAMES: long and multiline saved names stay usable and render literally', () => {
  const rows = [{modality:'CT'}, {modality:'MR'}];
  for (const name of ['x'.repeat(401), 'Saved\nSearch', '<img src=x onerror=bad()>']) {
    for (const incoming of ['mount', 'update']) {
      const source = {id:'other',name,matches:row => row.modality === 'MR'};
      const options = {searches:[...searches,source],shortcuts:[shortcut('a'),{id:'b',name:'Other',searchId:'other'}],rows,loadState:'complete'};
      const { api, host, changes, selections } = setup(incoming === 'mount' ? options : {searches,rows:[{modality:'CT'}],loadState:'complete'});
      if (incoming === 'update') { api.select('modality:CT'); api.update(options); }
      assert.equal(api.snapshot().loadState,'complete');
      assert.ok(api.snapshot().items.every(item => /^\d+$/.test(item.count)));
      assert.equal(get(api,'all').count,'2');
      assert.equal(get(api,'shortcut:a').count,'1');
      assert.equal(get(api,'shortcut:b').count,'1');
      assert.equal(get(api,'shortcut:b').unavailable,false);
      assert.equal(api.snapshot().selectedId,incoming === 'mount' ? 'all' : 'modality:CT');
      assert.equal(selections.length,incoming === 'mount' ? 0 : 1);
      assert.ok(nodes(host).some(node => node.tagName === 'OPTION' && node.textContent === name));
      assert.equal(nodes(host).some(node => node.tagName === 'IMG'),false);
      api.select('shortcut:b'); assert.deepEqual(api.filter(rows),[rows[1]]);
      assert.equal(changes.length,0);
    }
  }
});

test('TEST-WS3-INCOMING-SEARCH-INVALID: unusable adapters affect only their own shortcut and recover silently', () => {
  const rows = [{modality:'CT'}, {modality:'MR'}];
  const valid = {id:'bad',name:'Recover',matches:row => row.modality === 'MR'};
  for (const bad of [null, [], {}, {id:'bad',name:'Bad'}, {...valid,matches:true},
    {...valid,id:''}, {...valid,id:'x'.repeat(401)}, {...valid,id:'x\ny'},
    {...valid,name:''}, {...valid,name:'   '}, {...valid,name:null}, {...valid,name:42}]) {
    for (const incoming of ['mount','update']) {
      const options = {rows,loadState:'complete',searches:[bad,...searches],
        shortcuts:[shortcut('a'),{id:'b',name:'Other',searchId:'bad'}]};
      let mounted;
      assert.doesNotThrow(() => { mounted = setup(incoming === 'mount' ? options : {...options,searches:[valid,...searches]}); });
      const { api, host, changes, selections } = mounted;
      if (incoming === 'update') { api.select('shortcut:b'); assert.doesNotThrow(() => api.update(options)); }
      assert.equal(api.snapshot().loadState,'complete');
      assert.equal(get(api,'all').count,'2');
      assert.equal(get(api,'shortcut:a').count,'1');
      assert.ok(api.snapshot().items.filter(item => item.id !== 'shortcut:b').every(item => /^\d+$/.test(item.count)));
      assert.equal(get(api,'shortcut:b').unavailable,true);
      assert.equal(get(api,'shortcut:b').count,'—');
      assert.equal(button(host,'Other (—) · Unavailable').disabled,true);
      assert.throws(() => api.select('shortcut:b'));
      if (incoming === 'update') {
        assert.equal(api.snapshot().selectedId,'shortcut:b');
        assert.deepEqual(api.filter(rows),[]);
      }
      assert.equal(nodes(host).find(node => node.getAttribute('role') === 'status').textContent,'');
      api.update({searches:[valid,...searches]});
      assert.equal(get(api,'shortcut:b').count,'1');
      assert.equal(get(api,'shortcut:b').unavailable,false);
      assert.equal(selections.length,incoming === 'mount' ? 0 : 1);
      assert.equal(changes.length,0);
    }
  }
});

test('TEST-WS3-INCOMING-SEARCH-DUPLICATES: first id wins, even when its adapter is unavailable', () => {
  const rows = [{modality:'CT'}, {modality:'MR'}];
  for (const incoming of ['mount','update']) {
    for (const first of [searches[0], {...searches[0],matches:null}]) {
      const options = {rows,loadState:'complete',shortcuts:[shortcut('a')],
        searches:[first,{...searches[0],name:'Later',matches:()=>true}]};
      const { api, host, changes, selections } = setup(incoming === 'mount' ? options : {});
      if (incoming === 'update') api.update(options);
      assert.equal(get(api,'all').count,'2');
      assert.ok(api.snapshot().items.filter(item => item.kind !== 'shortcut').every(item => /^\d+$/.test(item.count)));
      assert.equal(nodes(host).filter(node => node.tagName === 'OPTION').length,first.matches ? 1 : 0);
      if (first.matches) {
        assert.equal(get(api,'shortcut:a').count,'1');
        api.select('shortcut:a'); assert.deepEqual(api.filter(rows),[rows[0]]);
      } else {
        assert.equal(get(api,'shortcut:a').unavailable,true);
        assert.equal(get(api,'shortcut:a').count,'—');
        assert.throws(() => api.select('shortcut:a'));
      }
      assert.equal(changes.length,0); assert.equal(selections.length,first.matches ? 1 : 0);
    }
  }
});

test('TEST-WS3-INCOMING-MALFORMED: malformed calls invalidate counts, preserve criteria and permit recovery', () => {
  const badData = [
    {rows:null}, {rows:[null]}, {rows:[[]]}, {loadState:'loading'},
    {searches:null},
    {shortcuts:null}, {shortcuts:[null]}, {shortcuts:[{...shortcut('a'),extra:true}]},
    {shortcuts:[{...shortcut('a'),id:''}]}, {shortcuts:[{...shortcut('a'),searchId:''}]},
    {shortcuts:[shortcut('a','')]}, {shortcuts:[shortcut('a','x\ny')]}, {shortcuts:[shortcut('a','x'.repeat(401))]},
    {shortcuts:[shortcut('a'),shortcut('a')]}, {shortcuts:Array.from({length:201},(_,i)=>shortcut(String(i)))},
  ];
  for (const patch of badData) assert.throws(() => setup(patch));
  for (const patch of [...badData,null,[],{unexpected:true}]) {
    const rows = [{modality:'CT'}, {modality:'DX'}];
    const { api, host, changes, selections } = setup({searches,shortcuts:[shortcut('a')],rows,loadState:'complete'});
    api.select('shortcut:a');
    assert.throws(() => api.update(patch));
    assert.equal(api.snapshot().loadState,'unknown');
    assert.ok(api.snapshot().items.every(item => item.count === '—'));
    assert.ok(button(host,'All Studies (—)'));
    assert.equal(button(host,'All Studies (2)'),undefined);
    assert.ok(nodes(host).find(node => node.getAttribute('role') === 'status').textContent.length > 0);
    assert.equal(api.snapshot().selectedId,'shortcut:a');
    assert.deepEqual(api.snapshot().shortcuts,[shortcut('a')]);
    assert.deepEqual(api.filter(rows),[rows[0]]);
    assert.equal(changes.length,0); assert.equal(selections.length,1);
    api.update({rows:[{modality:'DX'}],loadState:'complete'});
    assert.equal(get(api,'all').count,'1'); assert.equal(get(api,'shortcut:a').count,'0');
    assert.ok(button(host,'All Studies (1)'));
    assert.equal(nodes(host).find(node => node.getAttribute('role') === 'status').textContent,'');
  }
});

test('TEST-WS3-UNAVAILABLE: missing or indeterminate search never broadens the selected scope', () => {
  const { api } = setup({ searches, shortcuts: [shortcut('a')], rows: [{modality:'CT'}], loadState:'complete' });
  api.select('shortcut:a'); api.update({ searches: [] });
  assert.equal(get(api,'shortcut:a').count, '—');
  assert.equal(get(api,'shortcut:a').unavailable, true);
  assert.deepEqual(api.filter([{modality:'CT'}]), []);
  assert.throws(() => api.select('shortcut:a'));
  for (const matches of [() => null, () => { throw new Error('unavailable'); }, () => Promise.resolve(true)]) {
    api.update({searches:[{id:'ct',name:'Search',matches}]});
    api.select('shortcut:a');
    assert.equal(get(api,'shortcut:a').count, '—');
    assert.deepEqual(api.filter([{modality:'CT'}]), []);
  }
});

test('TEST-WS7-DOM: native buttons, nested lists, English names, pressed selection and focus survive rendering', () => {
  const { api, host, doc, selections } = setup({rows:[{modality:'CT,SR'}],loadState:'complete'});
  assert.equal(nodes(host).find(node => node.tagName === 'NAV').getAttribute('aria-label'), 'Folders');
  assert.ok(nodes(host).filter(node => node.tagName === 'UL').length >= 3);
  assert.equal(nodes(host).some(node => node.getAttribute('role') === 'tree'), false);
  button(host,'CT (1)').click();
  assert.equal(doc.activeElement.textContent, 'CT (1)');
  assert.equal(doc.activeElement.getAttribute('aria-pressed'), 'true');
  assert.equal(nodes(host).filter(node => node.getAttribute('aria-pressed') === 'true').length, 1);
  assert.equal(selections.at(-1)[0].modality, 'CT');
  api.update({ loadState:'partial' });
  assert.equal(doc.activeElement.textContent, 'CT (1 · Partial)');
  button(host,'Modality').click();
  assert.equal(button(host,'Modality').getAttribute('aria-expanded'), 'false');
});

test('TEST-WS7-EDIT-UI: form callbacks, literal names and draft preservation', () => {
  const { api, host, changes } = setup({ searches });
  const form = nodes(host).find(node => node.tagName === 'FORM');
  nodes(form).find(node => node.tagName === 'INPUT').value = '<img src=x onerror=bad()>한글';
  nodes(form).find(node => node.tagName === 'SELECT').value = 'ct';
  form.onsubmit({preventDefault(){}});
  assert.equal(changes.length,1);
  assert.ok(button(host,'<img src=x onerror=bad()>한글 (—)'));
  assert.equal(nodes(host).some(node => node.tagName === 'IMG'),false);
  const details = nodes(host).find(node => node.tagName === 'DETAILS'); details.open = true;
  const input = nodes(details).find(node => node.tagName === 'INPUT'); input.value = 'Draft'; input.focus();
  api.update({rows:[{modality:'CT'}],loadState:'complete'});
  assert.equal(nodes(host).find(node => node.tagName === 'DETAILS').open,true);
  assert.equal(host.ownerDocument.activeElement.value,'Draft');
  button(host,'Rename').click();
  assert.equal(api.snapshot().shortcuts[0].name,'Draft');
  button(host,'Remove').click(); assert.equal(api.snapshot().shortcuts.length,0);
});

test('TEST-WS3-LIFECYCLE: caller data stays intact and destroy removes the owned UI', () => {
  const rows = Object.freeze([Object.freeze({modality:'CT'})]), shortcuts = Object.freeze([Object.freeze(shortcut('a'))]);
  const { api, host } = setup({rows,shortcuts,searches});
  api.snapshot().shortcuts[0].name = 'external'; api.rename('a','Local');
  assert.equal(shortcuts[0].name,'a'); assert.equal(rows[0].modality,'CT');
  api.destroy(); api.destroy(); assert.equal(host.children.length,0);
  assert.throws(() => api.select('all')); assert.throws(() => api.update({rows:[]}));
});

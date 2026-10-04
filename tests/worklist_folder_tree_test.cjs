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
      assert.equal(nodes(host).filter(node => node.getAttribute('aria-current') === 'true').length, 1);
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

test('TEST-WS3-INCOMING-MALFORMED: refusal invalidates visible counts, preserves criteria and permits recovery', () => {
  const badData = [
    {rows:null}, {rows:[null]}, {rows:[[]]}, {loadState:'loading'},
    {searches:null}, {searches:[null]}, {searches:[{id:'x',name:'x'}]},
    {searches:[{...searches[0],id:''}]}, {searches:[{...searches[0],name:'x\ny'}]}, {searches:[...searches,...searches]},
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

test('TEST-WS7-DOM: native buttons, nested lists, English names, current selection and focus survive rendering', () => {
  const { api, host, doc, selections } = setup({rows:[{modality:'CT,SR'}],loadState:'complete'});
  assert.equal(nodes(host).find(node => node.tagName === 'NAV').getAttribute('aria-label'), 'Folders');
  assert.ok(nodes(host).filter(node => node.tagName === 'UL').length >= 3);
  assert.equal(nodes(host).some(node => node.getAttribute('role') === 'tree'), false);
  button(host,'CT (1)').click();
  assert.equal(doc.activeElement.textContent, 'CT (1)');
  assert.equal(doc.activeElement.getAttribute('aria-current'), 'true');
  assert.equal(nodes(host).filter(node => node.getAttribute('aria-current') === 'true').length, 1);
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

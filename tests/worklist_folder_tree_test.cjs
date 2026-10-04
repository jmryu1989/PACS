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
  for (const name of ['Padded',' padded ', 'CT','ct',' mr ', 'US','CR','SC','dx',' all studies ']) {
    for (const action of [() => api.add(shortcut('c',name)), () => api.rename('b',name),
      () => api.update({shortcuts:[shortcut('a','Padded'),shortcut('b',name)]})]) {
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
  assert.throws(() => setup({searches,shortcuts:[shortcut('a','CT')]}), /이미 사용 중인/);
  api.select('shortcut:a'); api.remove('a');
  const removed = api.snapshot(), removedCounts = [changes.length,selections.length];
  assert.throws(() => api.add(shortcut('c',' padded ')), /이미 사용 중인/);
  assert.deepEqual(api.snapshot(),removed);
  assert.deepEqual([changes.length,selections.length],removedCounts);
  api.select('all'); api.add(shortcut('c',' padded '));
  assert.equal(api.snapshot().shortcuts.at(-1).name,'padded');
});

test('TEST-WS3-VALIDATION: invalid input refuses atomically before callbacks or state changes', () => {
  const { api, changes, selections } = setup({ searches, shortcuts: [shortcut('a')] });
  const before = api.snapshot();
  for (const action of [() => api.add(shortcut('a')), () => api.add({...shortcut('b'),searchId:'absent'}),
    () => api.add({...shortcut('b'),extra:true}), () => api.rename('a',''), () => api.rename('a','x\ny'),
    () => api.rename('a','x'.repeat(401)), () => api.remove('absent'), () => api.reorder('a',-1),
    () => api.reorder('a',1), () => api.reorder('a',0.5), () => api.update({loadState:'loading'}),
    () => api.update({rows:[null]}), () => api.update({searches:[{id:'x',name:'x'}]}),
    () => api.update({shortcuts:Array.from({length:201},(_,i)=>shortcut(String(i)))})]) {
    assert.throws(action); assert.deepEqual(api.snapshot(), before);
  }
  assert.equal(changes.length, 0); assert.equal(selections.length, 0);
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

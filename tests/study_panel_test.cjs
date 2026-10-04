// REQ-WS2/WS7 -> RISK-WS2/WS7 -> TEST-WS2/WS7 (D-01/04/05/06/07/10, A-01).
// This stand-in models DOM identity, bubbling and focus; browser geometry remains an integration check.
const test = require('node:test');
const assert = require('node:assert/strict');
const create = require('../worklist-v0/hpacs-lite/study-panel.js');

class Element {
  constructor(doc, tag, type = 1) {
    this.ownerDocument = doc; this.tagName = tag.toUpperCase(); this.nodeType = type;
    this.children = []; this.parentNode = null; this.attributes = new Map(); this.listeners = new Map();
    this.hidden = false; this.inert = false; this.disabled = false; this.style = {};
    this.scrollTop = 0; this.scrollLeft = 0; this.tabIndex = ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(this.tagName) ? 0 : -1;
  }
  get isConnected() { return this === this.ownerDocument.body || !!this.parentNode?.isConnected; }
  get hidden() { return this._hidden; }
  set hidden(value) {
    this._hidden = Boolean(value);
    if (value && this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body;
  }
  contains(el) { return el === this || this.children.some(child => child.contains(el)); }
  append(el) { el.remove(); this.children.push(el); el.parentNode = this; }
  remove() {
    if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
  insertBefore(el, before) {
    el.remove(); const i = this.children.indexOf(before); assert.ok(i >= 0);
    this.children.splice(i, 0, el); el.parentNode = this;
  }
  replaceChild(el, before) { this.insertBefore(el, before); before.remove(); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) {
    if (['hidden', 'inert', 'disabled'].includes(name) && this[name]) return '';
    return this.attributes.get(name) ?? null;
  }
  matches(selector) {
    return selector.split(',').some(part => {
      const simple = part.trim();
      if (/^[a-z][a-z0-9-]*$/i.test(simple)) return this.tagName === simple.toUpperCase();
      const attr = /^\[([\w-]+)(?:\s*=\s*"([^"]*)")?\]$/.exec(simple);
      if (!attr) throw new Error('Unsupported stand-in selector: ' + simple);
      const value = this.getAttribute(attr[1]);
      return attr[2] === undefined ? value !== null : value === attr[2];
    });
  }
  closest(selector) {
    for (let el = this; el; el = el.parentNode) {
      if (el.matches(selector)) return el;
    }
    return null;
  }
  getClientRects() {
    if (!this.isConnected || this.closest('[hidden], [inert]')) return [];
    for (let el = this; el; el = el.parentNode) if (el.style.display === 'none') return [];
    return [{}];
  }
  focus() {
    const visibility = this.ownerDocument.defaultView.getComputedStyle(this).visibility;
    if (this.disabled || !this.getClientRects().length || ['hidden', 'collapse'].includes(visibility)) return;
    if (!['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(this.tagName) && this.tabIndex < 0 && !this.attributes.has('tabindex')) return;
    const previous = this.ownerDocument.activeElement;
    if (previous === this) return;
    previous?.dispatch('focusout', { relatedTarget: this });
    this.ownerDocument.activeElement = this;
    this.dispatch('focusin', { relatedTarget: previous });
  }
  setSelectionRange(start, end, direction) {
    this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  dispatch(type, properties = {}) {
    const event = { type, target: this, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...properties };
    for (let el = this; el; el = el.parentNode) {
      for (const fn of el.listeners.get(type) || []) fn(event);
      if (event.stopped) break;
    }
    return event;
  }
}
function fixture(options = {}) {
  const doc = { createElement: tag => new Element(doc, tag), createComment: () => new Element(doc, '#comment', 8) };
  doc.defaultView = { getComputedStyle(el) {
    for (let at = el; at; at = at.parentNode) if (at.style.visibility) return { visibility: at.style.visibility };
    return { visibility: 'visible' };
  } };
  doc.documentElement = doc.createElement('html'); doc.body = doc.createElement('body');
  doc.documentElement.append(doc.body); doc.activeElement = doc.body;
  const attach = (tag, parent = doc.body) => { const el = doc.createElement(tag); parent.append(el); return el; };
  const opener = attach('textarea'); opener.value = 'KEEP DRAFT'; opener.setSelectionRange(2, 7, 'backward');
  opener.scrollTop = 123; opener.scrollLeft = 9;
  const fallback = attach('button'), original = attach('div'), host = attach('div'); host.id = 'study-tools';
  const content = Object.fromEntries(['images', 'info', 'templates'].map(name => {
    const el = attach('div', original); el.id = name + '-existing'; return [name, el];
  }));
  const input = attach('input', content.templates), changes = [];
  opener.focus();
  const panel = create({ host, content, fallbackFocus: fallback, onChange: value => changes.push(value), ...options });
  const all = el => [el, ...el.children.flatMap(all)];
  const role = name => all(panel.element).filter(el => (el.getAttribute('role') || (el.tagName === 'ASIDE' ? 'complementary' : null)) === name);
  const tab = name => role('tab').find(el => el.textContent === name);
  const close = all(panel.element).find(el => el.tagName === 'BUTTON' && el.textContent === 'Close');
  return { doc, attach, opener, fallback, original, host, content, input, changes, panel, role, tab, close, all };
}
function active(f, label) {
  assert.deepEqual(f.role('tab').filter(el => el.getAttribute('aria-selected') === 'true').map(el => el.textContent), [label]);
  assert.deepEqual(f.role('tab').filter(el => el.tabIndex === 0).map(el => el.textContent), [label]);
  const visible = f.role('tabpanel').filter(el => !el.hidden && !el.inert);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, f.tab(label).getAttribute('aria-controls'));
  assert.equal(visible[0].getAttribute('aria-labelledby'), f.tab(label).id);
}

test('D-01/A-01: 기본 닫힘, 세 탭 중 하나 활성, 열기/닫기와 마지막 탭', () => {
  const f = fixture();
  assert.deepEqual(f.panel.snapshot(), { open: false, tab: 'images' });
  assert.equal(f.panel.element.hidden, true); assert.equal(f.panel.element.inert, true);
  assert.equal(f.panel.element.getAttribute('aria-label'), 'Study Panel');
  assert.equal(f.role('complementary').length, 1);
  assert.equal(f.role('tablist').length, 1); assert.equal(f.role('tab').length, 3); active(f, 'Images');
  assert.equal(f.doc.activeElement, f.opener);
  f.panel.open(); assert.equal(f.panel.element.hidden, false); assert.equal(f.doc.activeElement, f.tab('Images'));
  f.tab('Templates').dispatch('click'); active(f, 'Templates');
  f.close.dispatch('click'); assert.equal(f.panel.element.hidden, true); assert.equal(f.doc.activeElement, f.opener);
  f.panel.toggle(); active(f, 'Templates'); assert.equal(f.doc.activeElement, f.tab('Templates'));
  f.panel.toggle(); assert.equal(f.panel.snapshot().open, false);
  assert.deepEqual(f.changes.map(v => v.open), [true, true, false, true, false]);
});

test('A-01: 좌우 순환, Home/End 자동 활성화, Tab/Shift+Tab 비가로채기', () => {
  const f = fixture(); f.panel.open();
  for (const [key, expected] of [['ArrowLeft', 'Templates'], ['ArrowRight', 'Images'],
    ['ArrowRight', 'Info'], ['End', 'Templates'], ['Home', 'Images']]) {
    const event = f.doc.activeElement.dispatch('keydown', { key });
    assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, true);
    active(f, expected); assert.equal(f.doc.activeElement, f.tab(expected));
  }
  for (const properties of [{ key: 'Tab' }, { key: 'Tab', shiftKey: true }, { key: 'ArrowDown' },
    { key: 'ArrowRight', ctrlKey: true }, { key: 'ArrowRight', isComposing: true }]) {
    const event = f.doc.activeElement.dispatch('keydown', properties);
    assert.equal(event.defaultPrevented, false); active(f, 'Images');
  }
  f.opener.focus(); assert.equal(f.doc.activeElement, f.opener); assert.equal(f.panel.snapshot().open, true);
});

test('D-04: drawer 내부에서 중복 열기/탭 변경 뒤 편집기 선택·스크롤·본문 복원', () => {
  const f = fixture(); f.panel.open('info'); f.panel.open('templates');
  f.opener.setSelectionRange(0, 0, 'none'); f.opener.scrollTop = 0; f.opener.scrollLeft = 0;
  const event = f.doc.activeElement.dispatch('keydown', { key: 'Escape' });
  assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, true);
  assert.equal(f.panel.snapshot().open, false); assert.equal(f.doc.activeElement, f.opener);
  assert.deepEqual([f.opener.selectionStart, f.opener.selectionEnd, f.opener.selectionDirection], [2, 7, 'backward']);
  assert.equal(f.opener.scrollTop, 123); assert.equal(f.opener.scrollLeft, 9); assert.equal(f.opener.value, 'KEEP DRAFT');
});

function editorState(el) {
  return [el.value, el.selectionStart, el.selectionEnd, el.selectionDirection, el.scrollTop, el.scrollLeft];
}
function typeText(el, text) {
  const start = el.selectionStart;
  el.value = el.value.slice(0, start) + text + el.value.slice(el.selectionEnd);
  el.setSelectionRange(start + text.length, start + text.length, 'none');
}
function resumeEditing(f) {
  f.opener.focus(); f.opener.setSelectionRange(10, 10, 'none'); typeText(f.opener, ' typed');
  f.opener.scrollTop = 400; f.opener.scrollLeft = 25;
}

test('W3M-F01: 편집기로 돌아와 입력 후 모든 닫힘 경로에서 최신 본문·caret·선택·스크롤 보존', () => {
  const endings = [f => f.panel.toggle(), f => f.panel.close(),
    f => f.close.dispatch('click'),
    f => { f.close.focus(); f.close.dispatch('click'); },
    f => { f.tab('Info').focus(); f.tab('Info').dispatch('keydown', { key: 'Escape' }); },
    f => f.panel.restore({ open: false, tab: 'images' }), f => f.panel.destroy()];
  for (const end of endings) for (const selection of [false, true]) {
    const f = fixture(); f.panel.open('info'); resumeEditing(f);
    if (selection) f.opener.setSelectionRange(9, 14, 'backward');
    const before = editorState(f.opener); end(f);
    assert.equal(f.panel.snapshot().open, false); assert.equal(f.doc.activeElement, f.opener);
    assert.deepEqual(editorState(f.opener), before);
    if (!selection) { typeText(f.doc.activeElement, '!'); assert.equal(f.opener.value, before[0] + '!'); }
  }
});

test('W3M-F01: 다른 입력란에서 toggle/restore/destroy해도 포커스·선택 유지', () => {
  for (const end of [f => f.panel.toggle(), f => f.panel.restore({ open: false, tab: 'info' }),
    f => f.panel.destroy()]) {
    const f = fixture(), search = f.attach('input');
    search.value = 'query'; search.setSelectionRange(1, 3, 'forward');
    f.panel.open(); search.focus(); const before = editorState(f.opener), searchBefore = editorState(search);
    end(f); assert.equal(f.doc.activeElement, search);
    assert.deepEqual(editorState(f.opener), before); assert.deepEqual(editorState(search), searchBefore);
    // A later open must not reuse the editor record discarded by closing.
    if (f.panel.open()) { f.panel.close(); assert.equal(f.doc.activeElement, search); }
  }
});

test('W3M-F01: 재진입·중복 open·select·restore(open)는 최신 외부 opener를 기록', () => {
  for (const enter of [f => f.tab('Info').focus(), f => f.panel.open('info'),
    f => f.panel.select('templates'), f => f.panel.restore({ open: true, tab: 'templates' })]) {
    const f = fixture(); f.panel.open('info'); resumeEditing(f);
    const before = editorState(f.opener); enter(f); f.panel.close();
    assert.equal(f.doc.activeElement, f.opener); assert.deepEqual(editorState(f.opener), before);
    f.panel.open(); const search = f.attach('input'); search.value = 'search'; search.focus();
    enter(f); f.panel.close(); assert.equal(f.doc.activeElement, search);
  }
  const f = fixture(); f.panel.open();
  f.opener.setSelectionRange(8, 8, 'none'); f.opener.scrollTop = 200;
  const before = editorState(f.opener); f.panel.open('templates'); f.panel.close();
  assert.deepEqual(editorState(f.opener), before);
});

test('W3M-F01/D-12: Templates 삽입 뒤 Esc/Close로 닫아도 다음 입력은 삽입문 뒤에 위치', () => {
  for (const end of [f => { f.tab('Templates').focus(); f.tab('Templates').dispatch('keydown', { key: 'Escape' }); },
    f => { f.close.focus(); f.close.dispatch('click'); }, f => f.panel.toggle()]) {
    const f = fixture(); f.opener.value = 'Findings: no acute abnormality.\n';
    f.opener.setSelectionRange(f.opener.value.length, f.opener.value.length, 'none');
    const insert = f.attach('button', f.content.templates);
    insert.addEventListener('click', () => { f.opener.focus(); typeText(f.opener, 'Impression: normal.\n'); });
    f.panel.open('templates'); insert.focus(); insert.dispatch('click');
    const before = editorState(f.opener); end(f);
    assert.equal(f.doc.activeElement, f.opener); assert.deepEqual(editorState(f.opener), before);
    typeText(f.doc.activeElement, 'Recommendation: none.');
    assert.equal(f.opener.value, 'Findings: no acute abnormality.\nImpression: normal.\nRecommendation: none.');
  }
});

test('W3M-F01: 닫기 전에 이미 body로 떠난 포커스는 빼앗지 않음', () => {
  const f = fixture(); f.panel.open(); f.doc.activeElement = f.doc.body;
  f.panel.close(); assert.equal(f.doc.activeElement, f.doc.body);
});

test('W3M-F02: body/documentElement/null에서 열었으면 안정 fallback으로 복귀', () => {
  for (const empty of ['body', 'documentElement', null]) {
    const f = fixture(); f.doc.activeElement = empty ? f.doc[empty] : null;
    f.panel.open(); f.panel.close(); assert.equal(f.doc.activeElement, f.fallback);
  }
});

test('W3M-F05: 같은 drawer 요소로 정보 없이 복귀 후 Esc는 편집기 caret과 다음 입력 보존', () => {
  for (const source of [null, undefined, 'body', 'documentElement', 'detached', 'comment']) {
    const f = fixture(); f.opener.setSelectionRange(10, 10, 'none');
    const before = editorState(f.opener); f.panel.open('info');
    const tab = f.tab('Info');
    // A reactivation gives no new editor position, even if background work changed it.
    f.opener.setSelectionRange(0, 0, 'none'); f.opener.scrollTop = 0;
    const relatedTarget = source === 'detached' ? f.doc.createElement('input')
      : source === 'comment' ? f.doc.createComment('unknown') : typeof source === 'string' ? f.doc[source] : source;
    tab.dispatch('focusin', { relatedTarget });
    assert.equal(f.doc.activeElement, tab);
    const event = tab.dispatch('keydown', { key: 'Escape' });
    assert.equal(event.defaultPrevented, true); assert.equal(f.doc.activeElement, f.opener);
    assert.deepEqual(editorState(f.opener), before);
    typeText(f.doc.activeElement, '!'); assert.equal(f.opener.value, 'KEEP DRAFT!');
  }
});

test('W3M-F05: API 재진입의 알 수 없는 포커스도 opener·선택을 지우지 않음', () => {
  for (const empty of ['body', 'documentElement', null]) {
    for (const enter of [f => f.panel.open('info'), f => f.panel.select('info'),
      f => f.panel.restore({ open: true, tab: 'info' })]) {
      const f = fixture(), before = editorState(f.opener); f.panel.open('templates');
      f.doc.activeElement = empty ? f.doc[empty] : null; enter(f);
      f.doc.activeElement.dispatch('keydown', { key: 'Escape' });
      assert.equal(f.doc.activeElement, f.opener); assert.deepEqual(editorState(f.opener), before);
    }
  }
});

test('W3M-F05: 같은 opener의 선택·스크롤 정보 누락은 보존하고 새 opener에는 이전 선택을 복사하지 않음', () => {
  for (const missing of [null, undefined, NaN]) {
    const f = fixture(), before = editorState(f.opener); f.panel.open('info');
    f.opener.selectionStart = missing; f.opener.selectionEnd = missing;
    f.opener.selectionDirection = null; f.opener.scrollTop = missing; f.opener.scrollLeft = missing;
    f.panel.open('templates'); f.panel.close();
    assert.equal(f.doc.activeElement, f.opener); assert.deepEqual(editorState(f.opener), before);
  }
  const f = fixture(); f.panel.open('info');
  f.opener.setSelectionRange(4, 8, null); f.panel.open('templates'); f.panel.close();
  assert.deepEqual([f.opener.selectionStart, f.opener.selectionEnd, f.opener.selectionDirection], [4, 8, 'backward']);
  f.panel.open(); const button = f.attach('button'); button.focus(); f.panel.open('info'); f.panel.close();
  assert.equal(f.doc.activeElement, button); assert.equal(button.selectionStart, undefined);
});

test('W3M-F06: Technician 왕복은 저장된 Templates 유지, 표시·포커스만 복귀하고 onChange 없음', () => {
  for (const open of [false, true]) for (const outside of [false, true]) {
    const f = fixture(); f.panel.restore({ open, tab: 'templates' });
    if (open) f.input.focus();
    if (outside) resumeEditing(f);
    const before = editorState(f.opener), count = f.changes.length;
    f.panel.setAvailable(['images', 'info']); active(f, 'Images');
    assert.deepEqual(f.panel.snapshot(), { open, tab: 'templates' });
    f.panel.setAvailable(['images', 'info', 'templates']); active(f, 'Templates');
    assert.deepEqual(f.panel.snapshot(), { open, tab: 'templates' });
    assert.equal(f.changes.length, count);
    assert.equal(f.doc.activeElement, open && !outside ? f.tab('Templates') : f.opener);
    assert.deepEqual(editorState(f.opener), before);
  }
});

test('W3M-F06: 현재 비가용 탭 기록도 복원 수용, 대체 표시 후 선호 탭 재표시·알림 횟수', () => {
  for (const open of [false, true]) {
    const f = fixture({ available: ['images', 'info'] }), record = { open, tab: 'templates' };
    assert.equal(f.panel.restore(record), true); assert.deepEqual(f.panel.snapshot(), record);
    assert.equal(f.panel.element.hidden, !open); active(f, 'Images');
    assert.equal(f.doc.activeElement, open ? f.tab('Images') : f.opener);
    assert.deepEqual(f.changes, [record]);
    assert.equal(f.panel.restore(record), true); assert.equal(f.changes.length, 1);
    for (const tab of [null, undefined, '', 'Templates', 'bad']) {
      assert.equal(f.panel.restore({ open, tab }), false);
      assert.deepEqual(f.panel.snapshot(), record); assert.equal(f.changes.length, 1);
    }
    f.panel.setAvailable(['images', 'info', 'templates']); active(f, 'Templates');
    assert.deepEqual(f.panel.snapshot(), record); assert.equal(f.changes.length, 1);
    assert.equal(f.doc.activeElement, open ? f.tab('Templates') : f.opener);
  }
});

test('W3M-F06: 기본 open/toggle은 선호 유지, 명시 비가용 요청은 거절하고 실제 선택만 저장', () => {
  const calls = [], f = fixture({ available: ['images', 'info'], focusTarget: (tab, panel) => { calls.push([tab, panel]); } });
  f.panel.restore({ open: false, tab: 'templates' });
  assert.equal(f.panel.open(), true); active(f, 'Images');
  assert.equal(calls.at(-1)[0], 'images'); assert.equal(calls.at(-1)[1].hidden, false);
  assert.deepEqual(f.panel.snapshot(), { open: true, tab: 'templates' });
  assert.equal(f.changes.length, 2);
  assert.equal(f.panel.open(), true); assert.equal(f.changes.length, 2);
  for (const tab of ['templates', null, 'bad']) for (const method of ['open', 'select']) {
    assert.equal(f.panel[method](tab), false); assert.equal(f.doc.activeElement, f.tab('Images'));
    assert.deepEqual(f.panel.snapshot(), { open: true, tab: 'templates' }); assert.equal(f.changes.length, 2);
  }
  f.panel.toggle(); f.panel.toggle(); active(f, 'Images'); assert.equal(f.changes.length, 4);
  assert.deepEqual(f.changes.map(value => value.tab), ['templates', 'templates', 'templates', 'templates']);
  f.tab('Images').dispatch('click'); assert.deepEqual(f.changes.at(-1), { open: true, tab: 'images' });
  assert.equal(f.changes.length, 5); f.tab('Images').dispatch('click'); assert.equal(f.changes.length, 5);
  f.panel.setAvailable(['images', 'info', 'templates']); active(f, 'Images'); assert.equal(f.changes.length, 5);
  assert.equal(f.panel.open('info'), true); active(f, 'Info'); assert.equal(f.changes.length, 6);
  assert.deepEqual(f.changes.at(-1), { open: true, tab: 'info' });
});

test('W3M-F03/D-08: 생성 시 가용 탭만 표시·순환하며 사용 불가 탭 API는 부작용 없이 거절', () => {
  const f = fixture({ available: ['images', 'info'] });
  assert.equal(f.tab('Templates').hidden, true); f.panel.open('info');
  for (const [key, expected] of [['ArrowRight', 'Images'], ['ArrowLeft', 'Info'], ['Home', 'Images'], ['End', 'Info']]) {
    f.doc.activeElement.dispatch('keydown', { key }); active(f, expected);
    assert.equal(f.doc.activeElement, f.tab(expected));
  }
  const before = f.panel.snapshot(), count = f.changes.length, focused = f.doc.activeElement;
  for (const call of [() => f.panel.open('templates'), () => f.panel.select('templates')]) {
    assert.equal(call(), false); assert.deepEqual(f.panel.snapshot(), before);
    assert.equal(f.changes.length, count); assert.equal(f.doc.activeElement, focused);
  }
  const info = fixture({ available: ['info'] }); active(info, 'Info'); info.panel.open();
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
    info.doc.activeElement.dispatch('keydown', { key }); active(info, 'Info');
  }
});

test('W3M-F03/F06: 현재 탭 제외 시 첫 가용 탭 표시·저장 알림 없음, 외부 편집 포커스 보존', () => {
  for (const outside of [false, true]) {
    const f = fixture(); f.panel.open('templates'); f.input.focus();
    if (outside) resumeEditing(f);
    const before = editorState(f.opener), count = f.changes.length;
    assert.equal(f.panel.setAvailable(['info', 'images']), true);
    active(f, 'Images'); assert.equal(f.tab('Templates').hidden, true);
    assert.equal(f.changes.length, count); assert.deepEqual(f.panel.snapshot(), { open: true, tab: 'templates' });
    assert.equal(f.doc.activeElement, outside ? f.opener : f.tab('Images'));
    assert.deepEqual(editorState(f.opener), before);
    f.panel.setAvailable(['images', 'info']); assert.equal(f.changes.length, count);
    f.panel.close(); assert.equal(f.doc.activeElement, f.opener);
  }
  const closed = fixture(); closed.panel.select('templates'); const count = closed.changes.length;
  closed.panel.setAvailable(['info']); assert.deepEqual(closed.panel.snapshot(), { open: false, tab: 'templates' });
  assert.equal(closed.changes.length, count); assert.equal(closed.doc.activeElement, closed.opener);
});

test('W3M-F03/F06: 가용 탭 0개는 닫힘·열기 거절, 유효 기록 수용과 선호 보존', () => {
  for (const outside of [false, true]) {
    const f = fixture(); f.panel.open('templates'); if (outside) resumeEditing(f);
    const before = editorState(f.opener), count = f.changes.length;
    f.panel.setAvailable([]); assert.equal(f.changes.length, count + 1);
    assert.equal(f.panel.snapshot().open, false); assert.equal(f.panel.element.hidden, true);
    assert.equal(f.doc.activeElement, f.opener); assert.deepEqual(editorState(f.opener), before);
    assert.ok(f.role('tab').every(tab => tab.hidden && tab.tabIndex === -1 && tab.getAttribute('aria-selected') === 'false'));
    assert.ok(f.role('tabpanel').every(panel => panel.hidden && panel.inert));
    assert.equal(f.panel.open(), false); assert.equal(f.panel.toggle(), false);
    assert.equal(f.panel.restore({ open: true, tab: 'templates' }), true);
    assert.deepEqual(f.panel.snapshot(), { open: false, tab: 'templates' });
    assert.equal(f.changes.length, count + 1);
    f.panel.setAvailable(['info']); active(f, 'Info'); assert.equal(f.panel.open(), true);
    assert.deepEqual(f.panel.snapshot(), { open: true, tab: 'templates' });
    f.panel.setAvailable(['images', 'info', 'templates']); active(f, 'Templates');
    assert.equal(f.changes.length, count + 2);
  }
  const f = fixture({ available: [] }); assert.equal(f.panel.open(), false);
  for (const invalid of [null, 'info', ['bad'], ['images', null]]) {
    assert.equal(f.panel.setAvailable(invalid), false); assert.equal(f.panel.open(), false);
    assert.throws(() => fixture({ available: invalid }), TypeError);
  }
  f.panel.destroy(); assert.equal(f.panel.setAvailable(['info']), false);
});

test('W3M-F04: stand-in selector는 공백·쉼표·개별 closest 호출과 무관한 DOM 속성 판정', () => {
  const f = fixture(), wrap = f.attach('div'), child = f.attach('input', wrap);
  wrap.setAttribute('data-state', 'open'); wrap.hidden = true;
  for (const selector of ['[hidden],[inert]', ' [hidden] , [inert] ', '[hidden]']) assert.equal(child.closest(selector), wrap);
  assert.equal(child.closest('[data-state="open"]'), wrap); assert.equal(child.closest('div'), wrap);
  assert.equal(child.closest('[data-state="closed"]'), null); assert.equal(child.closest('select'), null);
  wrap.setAttribute('aria-expanded', 'true');
  assert.equal(child.closest('select,[aria-expanded="true"]'), wrap);
  assert.equal(child.closest('select') || child.closest('[aria-expanded="true"]'), wrap);
});

test('D-05: opener 제거/숨김/비활성 때 안정된 fallback으로 복귀', () => {
  for (const invalidate of [f => f.opener.remove(), f => { f.opener.hidden = true; },
    f => { f.opener.style.display = 'none'; }, f => { f.opener.style.visibility = 'hidden'; },
    f => { f.opener.disabled = true; }, f => { const wrap = f.attach('div'); wrap.append(f.opener); wrap.inert = true; }]) {
    const f = fixture(); f.panel.open(); invalidate(f); f.close.dispatch('click');
    assert.equal(f.doc.activeElement, f.fallback);
  }
  let fallback;
  const f = fixture({ fallbackFocus: () => fallback }); fallback = f.fallback;
  f.panel.open(); f.opener.remove(); f.panel.close(); assert.equal(f.doc.activeElement, fallback);
});

test('D-06/07: Esc는 외부 포커스·내부 취소·전파중단·IME·native select·popup에 양보', () => {
  const f = fixture(); f.panel.open('templates'); f.opener.focus();
  assert.equal(f.opener.dispatch('keydown', { key: 'Escape' }).defaultPrevented, false);
  const stale = f.input.dispatch('keydown', { key: 'Escape' });
  assert.equal(stale.defaultPrevented, false); assert.equal(f.panel.snapshot().open, true);
  f.input.focus();
  for (const extra of [{ defaultPrevented: true }, { isComposing: true }, { keyCode: 229 }]) {
    f.input.dispatch('keydown', { key: 'Escape', ...extra }); assert.equal(f.panel.snapshot().open, true);
  }
  const stop = event => event.stopPropagation(); f.input.addEventListener('keydown', stop);
  assert.equal(f.input.dispatch('keydown', { key: 'Escape' }).defaultPrevented, false);
  assert.equal(f.panel.snapshot().open, true); f.input.removeEventListener('keydown', stop);
  f.input.dispatch('compositionstart');
  assert.equal(f.input.dispatch('keydown', { key: 'Escape' }).defaultPrevented, false);
  assert.equal(f.panel.snapshot().open, true); f.input.dispatch('compositionend');
  const select = f.attach('select', f.content.templates); select.focus();
  assert.equal(select.dispatch('keydown', { key: 'Escape' }).defaultPrevented, false);
  assert.equal(f.panel.snapshot().open, true);
  f.input.setAttribute('aria-expanded', 'true'); f.input.focus();
  assert.equal(f.input.dispatch('keydown', { key: 'Escape' }).defaultPrevented, false);
  assert.equal(f.panel.snapshot().open, true); f.input.setAttribute('aria-expanded', 'false');
  f.input.dispatch('keydown', { key: 'Escape' }); assert.equal(f.panel.snapshot().open, false);
});

test('D-06/10: 통합 측 Esc 우선권·초기 포커스 확장점', () => {
  let claimed = true, target;
  const f = fixture({ escapeClaimed: () => claimed,
    focusTarget: tab => tab === 'templates' ? target : null });
  target = f.input;
  f.panel.open('templates'); assert.equal(f.doc.activeElement, f.input);
  assert.equal(f.input.dispatch('keydown', { key: 'Escape' }).defaultPrevented, false);
  assert.equal(f.panel.snapshot().open, true); claimed = false;
  f.input.dispatch('keydown', { key: 'Escape' }); assert.equal(f.doc.activeElement, f.opener);
});

test('상태 export/restore는 분리된 값이며 잘못된 입력은 현재 상태 보존', () => {
  const f = fixture(), initial = f.panel.snapshot(); initial.open = true; initial.tab = 'info';
  assert.equal(f.panel.snapshot().tab, 'images');
  assert.equal(f.panel.restore({ open: false, tab: 'info' }), true);
  assert.equal(f.doc.activeElement, f.opener); active(f, 'Info');
  f.panel.toggle(); assert.equal(f.doc.activeElement, f.tab('Info'));
  assert.equal(f.panel.restore({ open: true, tab: 'templates' }), true); active(f, 'Templates');
  const before = f.panel.snapshot();
  for (const invalid of [null, [], {}, { open: 'true', tab: 'images' }, { open: true, tab: 'bad' },
    { open: true, tab: 'info', extra: true }]) {
    assert.equal(f.panel.restore(invalid), false); assert.deepEqual(f.panel.snapshot(), before);
  }
  assert.equal(f.panel.open('bad'), false); assert.equal(f.panel.select('bad'), false);
  assert.deepEqual(f.panel.snapshot(), before);
  f.panel.restore({ open: false, tab: 'images' }); assert.equal(f.doc.activeElement, f.opener);
});

test('기존 content element·id·listener·값 동일성 및 destroy의 원위치 복귀/해제', () => {
  const f = fixture(); let clicks = 0; f.input.value = 'template query';
  f.input.addEventListener('click', () => { clicks++; });
  for (const [name, el] of Object.entries(f.content)) {
    assert.equal(f.panel.element.contains(el), true); assert.equal(el.id, name + '-existing');
    assert.equal(f.original.contains(el), false);
  }
  f.panel.open('templates'); f.input.dispatch('click'); assert.equal(clicks, 1);
  const root = f.panel.element, tab = f.tab('Images'), close = f.close;
  const created = f.all(root).filter(el => !Object.values(f.content).some(content => content.contains(el)));
  f.panel.destroy(); assert.equal(f.doc.activeElement, f.opener); assert.equal(root.isConnected, false);
  assert.deepEqual(f.original.children, Object.values(f.content)); assert.equal(f.input.value, 'template query');
  f.input.dispatch('click'); assert.equal(clicks, 2);
  const count = f.changes.length;
  tab.dispatch('click'); close.dispatch('click'); tab.dispatch('keydown', { key: 'Escape' });
  assert.equal(f.changes.length, count); assert.equal(f.panel.snapshot().open, false);
  for (const el of created) for (const listeners of el.listeners.values()) assert.equal(listeners.size, 0);
  assert.equal(f.panel.open(), false); assert.equal(f.panel.select('info'), false);
  assert.equal(f.panel.restore({ open: true, tab: 'info' }), false); f.panel.destroy();
});

test('content provider는 한 번 평가, 잘못된 content는 이동 전에 거절', () => {
  const f = fixture(); f.panel.destroy(); let calls = 0;
  const provided = Object.fromEntries(Object.entries(f.content).map(([name, el]) => [name, () => { calls++; return el; }]));
  const p = create({ host: f.host, content: provided, fallbackFocus: f.fallback });
  p.open(); p.close(); p.open('info'); assert.equal(calls, 3); p.destroy();
  const original = [...f.original.children];
  for (const content of [{ ...f.content, templates: null }, { ...f.content, info: f.content.images },
    { ...f.content, images: f.doc.body }]) {
    assert.throws(() => create({ host: f.host, content, fallbackFocus: f.fallback }), TypeError);
    assert.deepEqual(f.original.children, original); assert.equal(f.host.children.length, 0);
  }
});
